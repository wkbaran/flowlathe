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
