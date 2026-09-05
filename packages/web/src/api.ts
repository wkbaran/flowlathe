import type { FlowGraph } from "@flowlathe/core";

export interface FlowSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface FlowWithGraph extends FlowSummary {
  version: number;
  graph: FlowGraph;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.error === "string" ? body.error : `request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function listFlows(): Promise<FlowSummary[]> {
  return fetch("/api/flows").then((res) => json(res));
}

export function createFlow(name: string): Promise<FlowWithGraph> {
  return fetch("/api/flows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  }).then((res) => json(res));
}

export function getFlow(id: string): Promise<FlowWithGraph> {
  return fetch(`/api/flows/${id}`).then((res) => json(res));
}

export function saveFlowGraph(id: string, graph: FlowGraph): Promise<FlowWithGraph> {
  return fetch(`/api/flows/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ graph }),
  }).then((res) => json(res));
}

export function runFlow(id: string): Promise<{ executionId: string }> {
  return fetch(`/api/flows/${id}/run`, { method: "POST" }).then((res) => json(res));
}

export function exportFlow(id: string): Promise<{ script: string }> {
  return fetch(`/api/flows/${id}/export`).then((res) => json(res));
}

export interface ResponseLogEntry {
  id: string;
  nodeId: string;
  finishReason: string | null;
  latencyMs: number | null;
  createdAt: string;
  errorJson: unknown;
}

export interface ExecutionStatus {
  execution: { id: string; status: string; startedAt: string; endedAt: string | null };
  responses: ResponseLogEntry[];
}

export function getExecution(executionId: string): Promise<ExecutionStatus> {
  return fetch(`/api/executions/${executionId}`).then((res) => json(res));
}

export type ProviderKind = "mock" | "ollama" | "openai-compat";

export interface ProviderRecord {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string | null;
  hasSecret: boolean;
  maxParallel: number;
  rpm: number | null;
  tpm: number | null;
  swapCostMs: number | null;
  residentModels: number;
}

export interface ProviderInput {
  name: string;
  kind: ProviderKind;
  baseUrl?: string | undefined;
  secret?: string | undefined;
  maxParallel?: number | undefined;
  rpm?: number | undefined;
  tpm?: number | undefined;
  swapCostMs?: number | undefined;
  residentModels?: number | undefined;
}

export function listProviders(): Promise<ProviderRecord[]> {
  return fetch("/api/providers").then((res) => json(res));
}

export function createProvider(input: ProviderInput): Promise<ProviderRecord> {
  return fetch("/api/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }).then((res) => json(res));
}

export function updateProvider(id: string, patch: Partial<ProviderInput>): Promise<ProviderRecord> {
  return fetch(`/api/providers/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).then((res) => json(res));
}

export function deleteProvider(id: string): Promise<void> {
  return fetch(`/api/providers/${id}`, { method: "DELETE" }).then(() => undefined);
}

export interface ModelRecord {
  id: string;
  providerId: string;
  modelName: string;
  contextWindow: number | null;
}

export function listModels(providerId: string): Promise<ModelRecord[]> {
  return fetch(`/api/providers/${providerId}/models`).then((res) => json(res));
}

export function createModel(providerId: string, modelName: string): Promise<ModelRecord> {
  return fetch(`/api/providers/${providerId}/models`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ modelName }),
  }).then((res) => json(res));
}

export function deleteModel(id: string): Promise<void> {
  return fetch(`/api/models/${id}`, { method: "DELETE" }).then(() => undefined);
}

export interface ModelStats {
  queueDepth: number;
  waitMsP50: number;
  waitMsP95: number;
  tokensPerSecond: number;
}

export interface SchedulerStats {
  currentModel?: string;
  swapCount: number;
  models: Record<string, ModelStats>;
}

export function getSchedulerStats(): Promise<Record<string, SchedulerStats>> {
  return fetch("/api/scheduler/stats").then((res) => json(res));
}
