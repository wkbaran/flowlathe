import type { FlowGraph, GraphDiff } from "@flowlathe/core";

export interface FlowSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface FlowWithGraph extends FlowSummary {
  version: number;
  graph: FlowGraph;
  /** Null for a version saved without DSL text (shouldn't happen for anything saved through this
   *  API, but a pre-S3 row can still be latest). Sent back as `saveFlowGraph`'s `ifMatch`. */
  contentHash: string | null;
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

export type SaveFlowResult = { ok: true; flow: FlowWithGraph } | { ok: false; conflictText: string };

/** `ifMatch` is the content hash of the version this canvas last loaded — omit it to save
 *  unconditionally (last-write-wins, pre-S3 behavior). A 409 means the file changed on disk
 *  since; the caller gets the current on-disk text back to show the user instead of a thrown
 *  error, since "the file changed externally" is an expected, recoverable outcome, not a bug.
 *  `label`/`message` name this save as a milestone ("Save as version…") — a plain Save omits
 *  them, always producing an unnamed (autosaved) revision. */
export async function saveFlowGraph(
  id: string,
  graph: FlowGraph,
  ifMatch?: string,
  opts?: { label?: string; message?: string },
): Promise<SaveFlowResult> {
  const res = await fetch(`/api/flows/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ graph, ifMatch, ...opts }),
  });
  if (res.status === 409) {
    const body = (await res.json()) as { currentText: string };
    return { ok: false, conflictText: body.currentText };
  }
  return { ok: true, flow: await json<FlowWithGraph>(res) };
}

export interface FlowVersionSummary {
  id: string;
  version: number;
  label: string | null;
  message: string | null;
  contentHash: string | null;
  parentVersionId: string | null;
  createdAt: string;
  isHead: boolean;
  executionCount: number;
}

/** Newest first — PLAN-FLOW-VERSIONING.md §4.5's version-history drawer. */
export function listFlowVersions(flowId: string): Promise<FlowVersionSummary[]> {
  return fetch(`/api/flows/${flowId}/versions`).then((res) => json(res));
}

export interface FlowVersionDetail {
  id: string;
  flowId: string;
  version: number;
  graph: FlowGraph;
  sourceText: string | null;
  contentHash: string | null;
  label: string | null;
  message: string | null;
  parentVersionId: string | null;
  createdAt: string;
}

export function getFlowVersion(flowId: string, versionId: string): Promise<FlowVersionDetail> {
  return fetch(`/api/flows/${flowId}/versions/${versionId}`).then((res) => json(res));
}

/** Names an arbitrary past revision in place — no new row. */
export function labelFlowVersion(flowId: string, versionId: string, label: string, message?: string): Promise<FlowVersionDetail> {
  return fetch(`/api/flows/${flowId}/versions/${versionId}/label`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label, message }),
  }).then((res) => json(res));
}

export function getFlowDiff(flowId: string, from: string, to: string): Promise<{ diff: GraphDiff; isSemanticChange: boolean }> {
  const params = new URLSearchParams({ from, to });
  return fetch(`/api/flows/${flowId}/diff?${params}`).then((res) => json(res));
}

/** Creates a NEW head equal to `versionId`'s graph — history is never rewritten. */
export function restoreFlowVersion(flowId: string, versionId: string): Promise<FlowWithGraph> {
  return fetch(`/api/flows/${flowId}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ versionId }),
  }).then((res) => json(res));
}

export interface FlowPin {
  flowId: string;
  channel: string;
  flowVersionId: string;
  updatedAt: string;
}

/** A named pointer some consumer follows (starting with `"default"`) — never re-resolved to HEAD
 *  on its own (PLAN-FLOW-VERSIONING.md §3/§6). A Discord trigger pins directly via its own row
 *  instead of this table; see `/api/triggers`. */
export function listFlowPins(flowId: string): Promise<FlowPin[]> {
  return fetch(`/api/flows/${flowId}/pins`).then((res) => json(res));
}

export function setFlowPin(flowId: string, channel: string, flowVersionId: string): Promise<FlowPin> {
  return fetch(`/api/flows/${flowId}/pins/${encodeURIComponent(channel)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ flowVersionId }),
  }).then((res) => json(res));
}

export interface GitCommitInfo {
  sha: string;
  date: string;
  message: string;
}

/** Absent (or outside) a git work tree, `available` is false and the git tab simply shouldn't
 *  render (PLAN-FLOW-VERSIONING.md §5) — never an error. */
export function getGitHistory(flowId: string): Promise<{ available: boolean; commits: GitCommitInfo[] }> {
  return fetch(`/api/flows/${flowId}/git-history`).then((res) => json(res));
}

/** `to` omitted diffs `from` against the flow's current graph. */
export function getGitDiff(flowId: string, from: string, to?: string): Promise<{ diff: GraphDiff; isSemanticChange: boolean }> {
  const params = new URLSearchParams({ from, ...(to ? { to } : {}) });
  return fetch(`/api/flows/${flowId}/git-diff?${params}`).then((res) => json(res));
}

/** Paste-to-import (PLAN-FLOW-DSL.md S4): creates a new flow, or saves a new version of an
 *  existing one whose `flow "name" { ... }` header matches — see routes/flows.ts. */
export function importFlowText(text: string): Promise<FlowWithGraph> {
  return fetch("/api/flows/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  }).then((res) => json(res));
}

/** `/api/flows/events` SSE: fires whenever any flow's `.flow` file changes on disk (the file
 *  watcher, or another save). Returns an unsubscribe function. */
export function subscribeFlowInvalidations(onInvalidated: (slug: string) => void): () => void {
  const source = new EventSource("/api/flows/events");
  source.addEventListener("invalidated", (raw: MessageEvent<string>) => {
    const event = JSON.parse(raw.data) as { slug: string };
    onInvalidated(event.slug);
  });
  return () => source.close();
}

export function runFlow(id: string): Promise<{ executionId: string; branchId: string }> {
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
  execution: { id: string; status: string; startedAt: string; endedAt: string | null; rootBranchId: string | null };
  responses: ResponseLogEntry[];
  /** Which flow version this execution ran, by label when it has one. Absent only if the version
   *  row itself is somehow gone. */
  flowVersion?: { id: string; version: number; label: string | null; flowId: string };
  /** Present only when the flow's current HEAD has moved on since this execution ran
   *  (PLAN-FLOW-VERSIONING.md §4.5/§4.6) — the same signal drives step mode's staleness chip. */
  changedSinceRun?: { semantic: boolean; nodesChanged: number; currentVersionId: string };
}

export function getExecution(executionId: string, branchId?: string): Promise<ExecutionStatus> {
  const query = branchId ? `?branchId=${encodeURIComponent(branchId)}` : "";
  return fetch(`/api/executions/${executionId}${query}`).then((res) => json(res));
}

export function resumeExecution(executionId: string, activationKey: string, value: string): Promise<void> {
  return fetch(`/api/executions/${executionId}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ activationKey, value }),
  }).then(() => undefined);
}

export interface BranchRecord {
  id: string;
  executionId: string;
  parentBranchId: string | null;
  forkedFromSnapshotId: string | null;
  label: string | null;
  createdAt: string;
}

export function stepStart(flowId: string): Promise<{ executionId: string; branchId: string; snapshotId: string }> {
  return fetch(`/api/flows/${flowId}/step-start`, { method: "POST" }).then((res) => json(res));
}

export interface StepOutcome {
  done: boolean;
  nodeId?: string;
  snapshotId?: string;
}

export function stepOnce(executionId: string, branchId: string): Promise<StepOutcome> {
  return fetch(`/api/executions/${executionId}/step`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ branchId }),
  }).then((res) => json(res));
}

export function stepBack(
  executionId: string,
  snapshotId: string,
  label?: string,
): Promise<{ branchId: string; snapshotId: string }> {
  return fetch(`/api/executions/${executionId}/step-back`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotId, label }),
  }).then((res) => json(res));
}

export function listBranches(executionId: string): Promise<BranchRecord[]> {
  return fetch(`/api/executions/${executionId}/branches`).then((res) => json(res));
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

export function getExecutionState(executionId: string, branchId: string): Promise<Record<string, unknown>> {
  return fetch(`/api/executions/${executionId}/state?branchId=${encodeURIComponent(branchId)}`).then((res) => json(res));
}

export interface StateLineageEdge {
  entry: string;
  writerNodeId: string;
  writerSeq: number;
  readerNodeId: string;
}

export function getStateLineage(executionId: string, branchId: string): Promise<StateLineageEdge[]> {
  return fetch(`/api/executions/${executionId}/state-lineage?branchId=${encodeURIComponent(branchId)}`).then((res) =>
    json(res),
  );
}

export interface PluginStatus {
  configured: boolean;
  connected: boolean;
}

export function getSpotifyStatus(): Promise<PluginStatus> {
  return fetch("/api/plugins/spotify/status").then((res) => json(res));
}

export function disconnectSpotify(): Promise<void> {
  return fetch("/api/plugins/spotify/disconnect", { method: "POST" }).then(() => undefined);
}

/** The generic, manifest-backed aggregate (see @flowlathe/core's PluginManifest and the server's
 *  routes/plugins.ts) — `displayName`/`description` come from the plugin's own manifest, so the
 *  UI never special-cases a toolset name (e.g. the old `mcp:` prefix check) to render one. */
export interface PluginStatusEntry extends PluginStatus {
  displayName: string;
  description: string;
}

/** Keyed by toolset name (e.g. "spotify", "mcp:<name>") — the workflow-level dependency check in
 *  Canvas.tsx reads this to decide which of a flow's `enabledToolsets` are actually usable,
 *  without needing to know about any specific plugin. */
export function getPluginStatuses(): Promise<Record<string, PluginStatusEntry>> {
  return fetch("/api/plugins/status").then((res) => json(res));
}
