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
