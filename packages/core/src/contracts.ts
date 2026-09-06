import type { SuspendReason } from "./activation.js";

export interface ProviderCallRequest {
  providerId: string;
  modelId: string;
  nodeId: string;
  prompt: string;
  signal?: AbortSignal;
  onToken?: (token: string) => void;
}

export interface ProviderCallResult {
  content: string;
  finishReason: string;
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
