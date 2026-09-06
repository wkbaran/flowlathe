import type { SuspendReason } from "./activation.js";
import type { CompactionMethod, ContextMessage, ContextStore, LlmConfigStore } from "./context.js";
import type { MergeRule, StateStore } from "./state.js";

/** JSON-schema-shaped, loosely typed — just enough for the two providers we implement to
 *  describe a callable tool. Kept minimal deliberately: general MCP support is still future work. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
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
