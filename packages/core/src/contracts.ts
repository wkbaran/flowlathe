import type { SuspendReason } from "./activation.js";
import type { ContextMessage, ContextTransformKind } from "./context.js";
import type { MergeRule, StateStore } from "./state.js";

/** JSON-schema-shaped, loosely typed — just enough for the two providers we implement to
 *  describe a callable tool. Kept minimal deliberately: full tool/MCP support is Slice 6. */
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

export interface ProviderCallRequest {
  providerId: string;
  modelId: string;
  nodeId: string;
  prompt: string;
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
  | {
      kind: "context_transform";
      nodeId: string;
      transformKind: ContextTransformKind;
      sourceMessages: ContextMessage[];
      resultMessages: ContextMessage[];
      providerId?: string | undefined;
      modelId?: string | undefined;
    }
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
