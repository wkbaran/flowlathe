import type { NeverReason, SuspendReason } from "./activation.js";
import type { CompactionMethod, ContextMessage, ContextStore, LlmConfigStore } from "./context.js";
import type { MergeRule, StateStore } from "./state.js";

/** JSON-schema-shaped, loosely typed — just enough for the two providers we implement to
 *  describe a callable tool. `properties` is `Record<string, unknown>` rather than a narrower
 *  per-property shape because an MCP server's `inputSchema` is an arbitrary JSON schema (nested
 *  objects, enums, `$ref`s, ...) that this codebase never validates — providers forward
 *  `parameters` to the model API verbatim (see `packages/providers/src/ollama.ts`'s
 *  `toOllamaTool`), so the TS type only needs to describe the top-level envelope. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolInvokeMeta {
  activationKey: string;
  /** Set when the caller has a real cancellation signal available (currently: never, in this
   *  codebase — see CLAUDE.md's "cancellation is a real gap" note). Threaded through so a
   *  network-backed handler (SearXNG/Firecrawl/Discord) can pass it to `fetch` and check it
   *  between URLs in a batch the moment a producer exists; the built-in state tools ignore it
   *  harmlessly since they do no I/O. */
  signal?: AbortSignal | undefined;
}

/** Ambient, non-user-visible (same family as LlmConfigStore/ContextStore): a set of named tools
 *  grouped into "toolsets" a PromptSpec opts into by name (e.g. "state", "spotify"). Built-in
 *  state tools and plugin-provided tools (e.g. a Spotify integration) register through the same
 *  path — see `createToolRegistry` in @flowlathe/runtime. */
export interface ToolRegistry {
  specsFor(toolsets: string[]): ToolSpec[];
  invoke(name: string, args: Record<string, unknown>, meta: ToolInvokeMeta): Promise<string>;
  /** Which of `required` toolsets aren't actually usable right now (not configured at all, or
   *  configured but reporting itself unavailable) — see `findMissingToolsets` in ./plugin-deps.js
   *  for the shared implementation every `ToolRegistry` delegates to. */
  missingToolsets(required: string[]): MissingToolset[];
}

/** One named tool's contribution to a ToolRegistry, grouped by toolset. Defined here (not in
 *  @flowlathe/runtime, where `createToolRegistry` lives) so a plugin package can describe its
 *  tools without depending on runtime's much heavier transitive closure (every node kind). */
export interface ToolRegistration {
  toolset: string;
  spec: ToolSpec;
  handler: (args: Record<string, unknown>, meta: ToolInvokeMeta) => Promise<string> | string;
  /** Returns a human-readable reason this toolset can't be used right now (e.g. "Spotify is not
   *  connected"), or undefined/omitted when it's ready. A toolset with no external dependency
   *  (e.g. the built-in "state" toolset) simply never sets this. */
  unavailableReason?: () => string | undefined;
  /** How an exported, server-less script can reconstruct this toolset from environment alone.
   *  Absent ⇒ the toolset is server-only (e.g. Spotify's OAuth tokens or an MCP server's config
   *  file live in this server's DB/filesystem) and a compiled script using it refuses to run —
   *  see `@flowlathe/compiler`'s `compileGraph` and PLAN-INTEGRATIONS.md §4.4. */
  standalone?: {
    /** Package the emitted script imports, e.g. "@flowlathe/plugin-searxng". */
    module: string;
    /** Named export the script calls to rebuild this toolset's registrations from `process.env`. */
    factory: string;
    /** Env var names the generated script documents as required — names only, never values. */
    env: string[];
  };
}

export interface MissingToolset {
  toolset: string;
  reason: string;
}

export interface ProviderCallRequest {
  providerId: string;
  modelId: string;
  nodeId: string;
  prompt: string;
  temperature?: number | undefined;
  topK?: number | undefined;
  tools?: ToolSpec[] | undefined;
  signal?: AbortSignal | undefined;
  onToken?: ((token: string) => void) | undefined;
}

export interface ProviderCallResult {
  content: string;
  finishReason: string;
  toolCalls?: ToolCall[] | undefined;
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
}

export interface ProviderAdapter {
  readonly kind: string;
  call(req: ProviderCallRequest): Promise<ProviderCallResult>;
}

export interface Scheduler {
  submit(req: ProviderCallRequest): Promise<ProviderCallResult>;
}

export type RunEvent =
  | { kind: "node_started"; nodeId: string }
  | { kind: "token"; nodeId: string; token: string }
  | {
      kind: "node_finished";
      nodeId: string;
      output: string;
      renderedPrompt: string;
      finishReason: string;
      promptTokens?: number | undefined;
      completionTokens?: number | undefined;
      latencyMs: number;
    }
  | { kind: "node_failed"; nodeId: string; error: string }
  | { kind: "node_skipped"; nodeId: string; reason: NeverReason }
  | { kind: "node_suspended"; nodeId: string; activationKey: string; reason: SuspendReason }
  | {
      kind: "state_write";
      entry: string;
      value: unknown;
      merge: MergeRule;
      seq: number;
      viaTool: boolean;
      activationKey?: string | undefined;
    }
  | { kind: "state_read"; entry: string; seqSeen: number; viaTool: boolean; activationKey?: string | undefined }
  | { kind: "context_appended"; nodeId: string; messageCount: number }
  | {
      kind: "context_compacted";
      nodeId: string;
      method: CompactionMethod;
      beforeMessages: ContextMessage[];
      afterMessages: ContextMessage[];
    }
  | { kind: "llm_config_set"; nodeId: string; patch: Record<string, unknown> }
  | { kind: "run_finished"; outputs: Record<string, unknown> }
  | { kind: "run_failed"; error: string };

export interface BlobStore {
  put(bytes: Uint8Array): string;
  get(sha256: string): Uint8Array | undefined;
}

export interface Clock {
  now(): number;
}

export interface RuntimeHost {
  scheduler: Scheduler;
  blobs: BlobStore;
  emit(event: RunEvent): void;
  clock: Clock;
  /** Registers a pending resume for `key` and resolves once `resolveSuspended` is called with it. */
  suspend(key: string, reason: SuspendReason): Promise<string>;
  resolveSuspended(key: string, value: string): void;
  state: StateStore;
  llmConfig: LlmConfigStore;
  context: ContextStore;
  tools: ToolRegistry;
  /** Outbound HTTP for node kinds that fetch (search/fetch) — injected, never a bare global
   *  `fetch`, so the parity harness, unit tests, and e2e run fully offline against a stub. The
   *  production value is just Node's global `fetch`; this stays a plain type here so `core`
   *  remains isomorphic (no `node:*` import, and the browser has a global `fetch` too). */
  net: { fetch: typeof globalThis.fetch };
}

export interface PromptResult {
  output: string;
  renderedPrompt: string;
  finishReason: string;
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  latencyMs: number;
}

export interface NodeEmitter<Spec> {
  runtimeMethod: string;
  inputPorts(spec: Spec): string[];
  outputPorts(spec: Spec): string[];
}
