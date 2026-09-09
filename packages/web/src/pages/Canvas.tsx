import type {
  FileStateMode,
  FlowEdge,
  FlowNode,
  GraphDiff,
  MergeRule,
  NodeKind,
  RunEvent,
  StateDecl,
  StateValueType,
} from "@flowlathe/core";
import { checkUrlSafety, extractTemplateVars, validateGraph } from "@flowlathe/core";
import { DslError, format, parse, print } from "@flowlathe/dsl";
import {
  Alert,
  AppBar,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControlLabel,
  Link,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Snackbar,
  TextField,
  Toolbar,
  Typography,
  useTheme,
} from "@mui/material";
import {
  addEdge,
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  exportFlow,
  getExecution,
  getExecutionState,
  getFlow,
  getFlowDiff,
  getGitDiff,
  getGitHistory,
  getPluginStatuses,
  getStateLineage,
  labelFlowVersion,
  listBranches,
  listFlowPins,
  listFlowVersions,
  listModels,
  listProviders,
  restoreFlowVersion,
  resumeExecution,
  runFlow,
  saveFlowGraph,
  setFlowPin,
  stepBack,
  stepOnce,
  stepStart,
  subscribeFlowInvalidations,
  type BranchRecord,
  type FlowPin,
  type FlowVersionSummary,
  type GitCommitInfo,
  type ModelRecord,
  type PluginStatusEntry,
  type ProviderRecord,
  type StateLineageEdge,
} from "../api.js";
import type { NodeStatus } from "../nodes/NodeCard.js";
import { nodeTypes } from "../nodes/node-types.js";

let nextNodeSeq = 1;

interface LogLine {
  seq: number;
  text: string;
}

interface SuspendedActivation {
  activationKey: string;
  nodeId: string;
  prompt?: string | undefined;
  message?: string | undefined;
}

interface StepSession {
  executionId: string;
  currentBranchId: string;
}

interface HistoryEntry {
  snapshotId: string;
  nodeId: string;
}

const NODE_KIND_OPTIONS: NodeKind[] = [
  "prompt",
  "router",
  "merge",
  "pause",
  "userInput",
  "loop",
  "map",
  "gate",
  "search",
  "fetch",
  "trigger",
];

/** Mirrors @flowlathe/core's `requiredToolsets(graph)` over live xyflow nodes (rather than a
 *  saved FlowGraph) so the workflow-dependency banner reacts to edits immediately, before Save —
 *  Run/Start Stepping always save first, so by the time either fires this always matches what the
 *  server independently re-checks against the just-saved graph. */
function requiredToolsetsFrom(ns: Node[]): string[] {
  const set = new Set<string>();
  for (const n of ns) {
    const data = n.data as Record<string, unknown>;
    const enabled = data["enabledToolsets"];
    if (Array.isArray(enabled)) {
      for (const t of enabled) if (typeof t === "string") set.add(t);
    }
    if (typeof data["toolset"] === "string") set.add(data["toolset"]);
  }
  return [...set].sort();
}

/** A Loop/Map body activation emits a scoped id like `node-2@node-1:0` (see CLAUDE.md) —
 *  status lighting keys on the underlying node id so a body node's box lights up at all. The
 *  raw scoped id is kept in the log text (`describeEvent`), which existing e2e specs assert on. */
function baseNodeId(id: string): string {
  return id.split("@")[0]!;
}

// Simple stacked layout for a Loop/Map body's children, used only when a node is newly assigned
// a parent — existing relative positions are left alone otherwise.
const CHILD_INDENT_X = 40;
const CHILD_TOP_Y = 56;
const CHILD_ROW_HEIGHT = 90;
const CONTAINER_WIDTH = 320;

/** `/api/plugins/status` carries each plugin's own `displayName` (from its `PluginManifest`),
 *  so this is only a fallback for a toolset the status map hasn't reported yet (e.g. right after
 *  a node is given a toolset the server doesn't know about) — no more `mcp:` prefix special-casing. */
function displayName(toolset: string, statuses: Record<string, PluginStatusEntry>): string {
  return statuses[toolset]?.displayName ?? (toolset.charAt(0).toUpperCase() + toolset.slice(1));
}

/** Edit-time half of the `fetch` node's "goes through URL safety twice over"
 *  (PLAN-INTEGRATIONS.md §5.3) — only checkable for a *literal* URL (no `{{vars}}`); a templated
 *  one can only be validated once rendered, which the runtime does on every activation. */
function fetchUrlSafetyError(urlTemplate: string | undefined): string | undefined {
  if (!urlTemplate || extractTemplateVars(urlTemplate).length > 0) return undefined;
  const verdict = checkUrlSafety(urlTemplate);
  return verdict.ok ? undefined : verdict.reason;
}

function defaultDataFor(type: NodeKind, id: string): Record<string, unknown> {
  switch (type) {
    case "prompt":
      return { label: id, template: "", providerId: "mock", modelId: "mock", enableStateTools: false, enabledToolsets: [] };
    case "router":
      return { label: id, routes: ["a", "b"], cases: [{ value: "a", route: "a" }], defaultRoute: "b" };
    case "merge":
      return { label: id };
    case "pause":
      return { label: id, message: "" };
    case "userInput":
      return { label: id, prompt: "Please provide input" };
    case "loop":
      return { label: id, initTemplate: "0", accPortName: "acc", stopValue: "done", maxIterations: 5 };
    case "map":
      return { label: id, itemsTemplate: '["a","b","c"]', itemPortName: "item", maxConcurrency: 3, maxItems: 10 };
    case "gate":
      return { label: id };
    case "search":
      return { label: id, queryTemplate: "{{input}}", toolset: "searxng" };
    case "fetch":
      return { label: id, urlTemplate: "{{input}}", toolset: "firecrawl", format: "markdown" };
    case "trigger":
      return { label: id, source: "manual", testPayload: "" };
  }
}

export function Canvas() {
  const theme = useTheme();
  const { flowId } = useParams<{ flowId: string }>();
  const [name, setName] = useState<string>("");
  const [version, setVersion] = useState<number>(0);
  const [saving, setSaving] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeStatus, setNodeStatus] = useState<Record<string, NodeStatus>>({});
  const [log, setLog] = useState<LogLine[]>([]);
  const [exportedScript, setExportedScript] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ModelRecord[]>>({});
  const [pluginStatuses, setPluginStatuses] = useState<Record<string, PluginStatusEntry>>({});
  const [newNodeKind, setNewNodeKind] = useState<NodeKind>("prompt");
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [suspended, setSuspended] = useState<SuspendedActivation[]>([]);
  const [resumeDraft, setResumeDraft] = useState<Record<string, string>>({});
  const [stepSession, setStepSession] = useState<StepSession | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [branches, setBranches] = useState<BranchRecord[]>([]);
  const [stateDecls, setStateDecls] = useState<StateDecl[]>([]);
  const [stateValues, setStateValues] = useState<Record<string, unknown>>({});
  const [stateLineage, setStateLineage] = useState<StateLineageEdge[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);

  // PLAN-FLOW-DSL.md S4: live DSL text view, save conflicts, external-change reload, node rename.
  const [contentHash, setContentHash] = useState<string | null>(null);
  const [textView, setTextView] = useState(false);
  const [dslDraft, setDslDraft] = useState("");
  const [dslError, setDslError] = useState<string | null>(null);
  const [conflictText, setConflictText] = useState<string | null>(null);
  const [externalChangeNotice, setExternalChangeNotice] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);

  // PLAN-FLOW-VERSIONING.md S3: version history, diff, restore, execution provenance.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<FlowVersionSummary[]>([]);
  const [pins, setPins] = useState<FlowPin[]>([]);
  const [gitCommits, setGitCommits] = useState<GitCommitInfo[]>([]);
  const [gitDiffResult, setGitDiffResult] = useState<{ diff: GraphDiff; isSemanticChange: boolean } | null>(null);
  const [saveAsVersionOpen, setSaveAsVersionOpen] = useState(false);
  const [versionLabelDraft, setVersionLabelDraft] = useState("");
  const [versionMessageDraft, setVersionMessageDraft] = useState("");
  const [renameVersionId, setRenameVersionId] = useState<string | null>(null);
  const [diffPick, setDiffPick] = useState<{ from?: string; to?: string }>({});
  const [diffResult, setDiffResult] = useState<{ diff: GraphDiff; isSemanticChange: boolean } | null>(null);
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<{
    flowVersion?: { id: string; version: number; label: string | null };
    changedSinceRun?: { semantic: boolean; nodesChanged: number; currentVersionId: string };
  } | null>(null);

  function loadFlow(id: string) {
    return getFlow(id).then((flow) => {
      setName(flow.name);
      setVersion(flow.version);
      setNodes(flow.graph.nodes as Node[]);
      setEdges(flow.graph.edges as Edge[]);
      setStateDecls(flow.graph.state ?? []);
      setContentHash(flow.contentHash);
      setExternalChangeNotice(false);
      return flow;
    });
  }

  useEffect(() => {
    if (!flowId) return;
    void loadFlow(flowId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId, setNodes, setEdges]);

  // External-change reload prompt (§4.1): a `.flow` file changing on disk — an editor, `git
  // checkout`, `flowlathe fmt` — broadcasts here. Re-fetching and comparing hashes (rather than
  // trusting every event blindly) is what keeps this from firing on the canvas's OWN save, which
  // publishes to the exact same topic.
  useEffect(() => {
    if (!flowId) return;
    return subscribeFlowInvalidations((slug) => {
      if (slug !== flowId) return;
      getFlow(flowId).then((flow) => {
        if (flow.contentHash !== contentHash) setExternalChangeNotice(true);
      });
    });
  }, [flowId, contentHash]);

  useEffect(() => {
    listProviders().then(async (list) => {
      setProviders(list);
      const entries = await Promise.all(list.map(async (p) => [p.id, await listModels(p.id)] as const));
      setModelsByProvider(Object.fromEntries(entries));
    });
    void getPluginStatuses().then(setPluginStatuses);
  }, []);

  useEffect(() => () => eventSourceRef.current?.close(), []);

  useEffect(() => {
    setRenameDraft(selectedNodeId ?? "");
    setRenameError(null);
  }, [selectedNodeId]);

  const onConnect = useCallback(
    (connection: Connection) =>
      setEdges((eds) =>
        addEdge({ ...connection, id: `${connection.source}-${connection.target}-${Date.now()}` }, eds),
      ),
    [setEdges],
  );

  function addNode() {
    const id = `node-${nextNodeSeq++}`;
    setNodes((ns) => [
      ...ns,
      {
        id,
        type: newNodeKind,
        // wide enough that even the largest node (the diamond Gate) never lands overlapping
        // the previous one
        position: { x: 80 + ns.length * 260, y: 80 + ns.length * 40 },
        data: defaultDataFor(newNodeKind, id),
      } as Node,
    ]);
  }

  function updateSelectedNodeData(patch: Record<string, unknown>) {
    if (!selectedNodeId) return;
    setNodes((ns) => ns.map((n) => (n.id === selectedNodeId ? { ...n, data: { ...n.data, ...patch } } : n)));
  }

  function updateSelectedNodeParent(parentId: string) {
    if (!selectedNodeId) return;
    setNodes((ns) => {
      const siblingCount = parentId
        ? ns.filter((n) => n.id !== selectedNodeId && n.parentId === parentId).length
        : 0;
      return ns.map((n) =>
        n.id === selectedNodeId
          ? {
              ...n,
              parentId: parentId || undefined,
              extent: parentId ? ("parent" as const) : undefined,
              // Only a freshly-assigned parent gets an auto-placed position — xyflow treats a
              // child's position as parent-relative, so this stacks new body members instead of
              // leaving them at their old (now nonsensical, since the coordinate space changed)
              // canvas-absolute spot.
              position: parentId ? { x: CHILD_INDENT_X, y: CHILD_TOP_Y + siblingCount * CHILD_ROW_HEIGHT } : n.position,
            }
          : n,
      ) as Node[];
    });
  }

  /** Renaming a node is a rename of its id — PLAN-FLOW-DSL.md §3.4: the DSL's name-as-id choice
   *  means past executions keep referring to it by the old id (`steps.node_id`, snapshot
   *  payloads, `state_writes` provenance are never rewritten), which is why this is a distinct,
   *  warned-about action rather than just another editable property. Node ids stay stable across
   *  every OTHER edit (CLAUDE.md's step-mode note depends on that), so this is the one place that
   *  invariant is deliberately broken, on purpose, with the user's explicit action. */
  function renameSelectedNode() {
    if (!selectedNodeId) return;
    const next = renameDraft.trim();
    if (next === selectedNodeId) {
      setRenameError(null);
      return;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(next)) {
      setRenameError("must start with a letter or underscore, then letters/digits/underscore/hyphen only");
      return;
    }
    if (nodes.some((n) => n.id === next)) {
      setRenameError(`"${next}" is already used by another node in this flow`);
      return;
    }
    const oldId = selectedNodeId;
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id === oldId) return { ...n, id: next };
        if (n.parentId === oldId) return { ...n, parentId: next };
        return n;
      }),
    );
    setEdges((es) =>
      es.map((e) => ({
        ...e,
        source: e.source === oldId ? next : e.source,
        target: e.target === oldId ? next : e.target,
      })),
    );
    setSelectedNodeId(next);
    setRenameError(null);
  }

  function openTextView() {
    setDslDraft(
      print({ name, graph: { nodes: nodes as FlowNode[], edges: edges as FlowEdge[], state: stateDecls }, comments: {} }),
    );
    setDslError(null);
    setTextView(true);
  }

  /** "parse-on-blur" (§7 S4): a syntax error leaves the graph untouched and just shows the
   *  message — never partially applies a broken edit. A successful parse also reformats the
   *  draft to its canonical form, so what's shown always matches what `Save` would write to
   *  disk. */
  function handleDslBlur() {
    try {
      const parsed = parse(dslDraft);
      setName(parsed.name);
      setNodes(parsed.graph.nodes as Node[]);
      setEdges(parsed.graph.edges as Edge[]);
      setStateDecls(parsed.graph.state);
      setDslDraft(format(dslDraft));
      setDslError(null);
    } catch (err) {
      setDslError(err instanceof DslError ? err.message : (err as Error).message);
    }
  }

  function addStateDecl() {
    setStateDecls((prev) => [
      ...prev,
      { name: `entry${prev.length + 1}`, type: "file", merge: "replace", fileMode: "read-write" },
    ]);
  }

  function updateStateDecl(index: number, patch: Partial<StateDecl>) {
    setStateDecls((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }

  function removeStateDecl(index: number) {
    setStateDecls((prev) => prev.filter((_, i) => i !== index));
  }

  /** Returns whether the save actually went through — false on an ifMatch conflict, which shows
   *  `conflictText` instead of throwing (a conflicting external edit is an expected outcome, not
   *  an error the caller should have to catch). `handleRun`/`handleStep` check this and bail
   *  rather than run against a graph the server never actually saved. `opts.label` names this save
   *  as a milestone ("Save as version…" — see `handleSaveAsVersion`). */
  async function handleSave(opts?: { label?: string; message?: string }): Promise<boolean> {
    if (!flowId) return false;
    setSaving(true);
    try {
      const result = await saveFlowGraph(
        flowId,
        { nodes: nodes as FlowNode[], edges: edges as FlowEdge[], state: stateDecls },
        contentHash ?? undefined,
        opts,
      );
      if (!result.ok) {
        setConflictText(result.conflictText);
        return false;
      }
      setVersion(result.flow.version);
      setContentHash(result.flow.contentHash);
      // A live run/step session's flow_version_id is pinned at start, but stepping deliberately
      // keeps following HEAD (CLAUDE.md) — this save is exactly the moment that can drift them
      // apart, so re-check right here rather than waiting for the next unrelated refresh.
      if (executionId && activeBranchId) void refreshExecutionProvenance(executionId, activeBranchId);
      return true;
    } finally {
      setSaving(false);
    }
  }

  function openHistory() {
    if (!flowId) return;
    setHistoryOpen(true);
    setDiffPick({});
    setDiffResult(null);
    setGitDiffResult(null);
    void listFlowVersions(flowId).then(setVersions);
    void listFlowPins(flowId).then(setPins);
    void getGitHistory(flowId).then((h) => setGitCommits(h.available ? h.commits : []));
  }

  async function handlePin(versionId: string) {
    if (!flowId) return;
    await setFlowPin(flowId, "default", versionId);
    void listFlowPins(flowId).then(setPins);
  }

  async function handleShowGitDiff(sha: string) {
    if (!flowId) return;
    setGitDiffResult(await getGitDiff(flowId, sha));
  }

  async function handleSaveAsVersion() {
    const message = versionMessageDraft.trim();
    if (!(await handleSave({ label: versionLabelDraft.trim(), ...(message ? { message } : {}) }))) return;
    setSaveAsVersionOpen(false);
    setVersionLabelDraft("");
    setVersionMessageDraft("");
    if (historyOpen && flowId) void listFlowVersions(flowId).then(setVersions);
  }

  async function handleLabelVersion(versionId: string) {
    if (!flowId) return;
    await labelFlowVersion(flowId, versionId, versionLabelDraft.trim(), versionMessageDraft.trim() || undefined);
    setRenameVersionId(null);
    setVersionLabelDraft("");
    setVersionMessageDraft("");
    void listFlowVersions(flowId).then(setVersions);
  }

  async function handleRestore(versionId: string) {
    if (!flowId) return;
    await restoreFlowVersion(flowId, versionId);
    await loadFlow(flowId);
    void listFlowVersions(flowId).then(setVersions);
    setDiffResult(null);
  }

  async function handleShowDiff(from: string, to: string) {
    if (!flowId) return;
    setDiffResult(await getFlowDiff(flowId, from, to));
  }

  function handleOverwriteConflict() {
    setConflictText(null);
    setContentHash(null); // clears ifMatch, so the retry below always wins
    void handleSave();
  }

  function handleReloadFromDisk() {
    setConflictText(null);
    if (flowId) void loadFlow(flowId);
  }

  function refreshState(execId: string, branchId: string) {
    getExecutionState(execId, branchId).then(setStateValues);
    getStateLineage(execId, branchId).then(setStateLineage);
  }

  /** Refreshes which flow version this execution ran and whether the flow's HEAD has moved on
   *  since — the honest surface for step mode's deliberate HEAD-following (PLAN-FLOW-VERSIONING.md
   *  §4.6), also shown for a plain Run. Called right after a run/step starts (baseline) and after
   *  every save while a session is live (the actual moment drift can occur). */
  async function refreshExecutionProvenance(execId: string, branchId: string) {
    const status = await getExecution(execId, branchId);
    setProvenance({
      ...(status.flowVersion ? { flowVersion: status.flowVersion } : {}),
      ...(status.changedSinceRun ? { changedSinceRun: status.changedSinceRun } : {}),
    });
    return status;
  }

  function subscribeToExecution(execId: string, branchId: string) {
    eventSourceRef.current?.close();
    const source = new EventSource(`/api/executions/${execId}/events`);
    eventSourceRef.current = source;

    const onEvent = (kind: RunEvent["kind"]) => (raw: MessageEvent<string>) => {
      const seq = Number(raw.lastEventId);
      const event = JSON.parse(raw.data) as RunEvent;
      setLog((prev) => [...prev, { seq, text: describeEvent(event) }]);
      if (kind === "node_started") {
        setNodeStatus((prev) => ({ ...prev, [baseNodeId((event as { nodeId: string }).nodeId)]: "running" }));
      } else if (kind === "node_finished") {
        setNodeStatus((prev) => ({ ...prev, [baseNodeId((event as { nodeId: string }).nodeId)]: "done" }));
        setSuspended((prev) => prev.filter((s) => s.nodeId !== (event as { nodeId: string }).nodeId));
      } else if (kind === "node_failed") {
        setNodeStatus((prev) => ({ ...prev, [baseNodeId((event as { nodeId: string }).nodeId)]: "failed" }));
      } else if (kind === "node_cancelled") {
        setNodeStatus((prev) => ({ ...prev, [baseNodeId((event as { nodeId: string }).nodeId)]: "cancelled" }));
      } else if (kind === "node_skipped") {
        setNodeStatus((prev) => ({ ...prev, [baseNodeId((event as { nodeId: string }).nodeId)]: "skipped" }));
      } else if (kind === "node_suspended") {
        const e = event as Extract<RunEvent, { kind: "node_suspended" }>;
        setNodeStatus((prev) => ({ ...prev, [baseNodeId(e.nodeId)]: "suspended" }));
        setSuspended((prev) => [
          ...prev,
          {
            activationKey: e.activationKey,
            nodeId: e.nodeId,
            prompt: e.reason.type === "user_input" ? e.reason.prompt : undefined,
            message: e.reason.type === "pause" ? e.reason.message : undefined,
          },
        ]);
      } else if (kind === "run_finished" || kind === "run_failed") {
        source.close();
        refreshState(execId, branchId);
      } else if (kind === "state_write" || kind === "state_read") {
        refreshState(execId, branchId);
      }
    };

    for (const kind of [
      "node_started",
      "token",
      "node_finished",
      "node_failed",
      "node_cancelled",
      "node_skipped",
      "node_suspended",
      "state_write",
      "state_read",
      "context_appended",
      "context_compacted",
      "llm_config_set",
      "run_finished",
      "run_failed",
    ] as const) {
      source.addEventListener(kind, onEvent(kind) as EventListener);
    }
  }

  async function handleRun() {
    if (!flowId) return;
    setLog([]);
    setNodeStatus({});
    setSuspended([]);
    setStepSession(null);
    setStateValues({});
    setStateLineage([]);
    setProvenance(null);
    try {
      if (!(await handleSave())) return;
      const { executionId: newExecutionId, branchId } = await runFlow(flowId);
      setExecutionId(newExecutionId);
      setActiveBranchId(branchId);
      subscribeToExecution(newExecutionId, branchId);
      void refreshExecutionProvenance(newExecutionId, branchId);
    } catch (err) {
      setLog((prev) => [...prev, { seq: prev.length + 1, text: `run failed to start: ${(err as Error).message}` }]);
    }
  }

  async function handleStep() {
    if (!flowId) return;
    try {
      if (!stepSession) {
        if (!(await handleSave())) return;
        setLog([]);
        setNodeStatus({});
        setSuspended([]);
        setProvenance(null);
        const started = await stepStart(flowId);
        setExecutionId(started.executionId);
        setActiveBranchId(started.branchId);
        subscribeToExecution(started.executionId, started.branchId);
        setStepSession({ executionId: started.executionId, currentBranchId: started.branchId });
        setBranches(await listBranches(started.executionId));
        setHistory([]);
        setStateValues({});
        setStateLineage([]);
        void refreshExecutionProvenance(started.executionId, started.branchId);
        return;
      }
      const outcome = await stepOnce(stepSession.executionId, stepSession.currentBranchId);
      if (!outcome.done && outcome.nodeId && outcome.snapshotId) {
        setHistory((prev) => [...prev, { snapshotId: outcome.snapshotId!, nodeId: outcome.nodeId! }]);
      }
      refreshState(stepSession.executionId, stepSession.currentBranchId);
    } catch (err) {
      setLog((prev) => [...prev, { seq: prev.length + 1, text: `step failed: ${(err as Error).message}` }]);
    }
  }

  async function handleStepBack(snapshotId: string) {
    if (!stepSession) return;
    const forked = await stepBack(stepSession.executionId, snapshotId);
    setStepSession({ executionId: stepSession.executionId, currentBranchId: forked.branchId });
    setActiveBranchId(forked.branchId);
    setBranches(await listBranches(stepSession.executionId));
    const cutIdx = history.findIndex((h) => h.snapshotId === snapshotId);
    const truncated = cutIdx === -1 ? [] : history.slice(0, cutIdx + 1);
    setHistory(truncated);
    setNodeStatus(Object.fromEntries(truncated.map((h) => [h.nodeId, "done"])));
    const status = await refreshExecutionProvenance(stepSession.executionId, forked.branchId);
    setLog(status.responses.map((r, i) => ({ seq: i, text: `${r.nodeId}: finished` })));
    refreshState(stepSession.executionId, forked.branchId);
  }

  async function handleSwitchBranch(branchId: string) {
    if (!stepSession) return;
    setStepSession({ ...stepSession, currentBranchId: branchId });
    setActiveBranchId(branchId);
    setHistory([]);
    const status = await refreshExecutionProvenance(stepSession.executionId, branchId);
    setLog(status.responses.map((r, i) => ({ seq: i, text: `${r.nodeId}: finished` })));
    refreshState(stepSession.executionId, branchId);
  }

  async function handleResume(activationKey: string) {
    if (!executionId) return;
    await resumeExecution(executionId, activationKey, resumeDraft[activationKey] ?? "");
  }

  async function handleExport() {
    if (!flowId) return;
    const { script } = await exportFlow(flowId);
    setExportedScript(script);
  }

  const childCounts = new Map<string, number>();
  for (const n of nodes) {
    if (n.parentId) childCounts.set(n.parentId, (childCounts.get(n.parentId) ?? 0) + 1);
  }
  const decoratedNodes = nodes.map((n) => {
    const childCount = childCounts.get(n.id) ?? 0;
    // xyflow renders a parentId-bearing node as a real subflow container, sized by its own
    // `style` — not auto-fit to children — so a Loop/Map with a multi-node body needs an
    // explicit box big enough to hold them, stacked by updateSelectedNodeParent above.
    const containerStyle =
      (n.type === "loop" || n.type === "map") && childCount > 0
        ? { style: { width: CONTAINER_WIDTH, height: CHILD_TOP_Y + childCount * CHILD_ROW_HEIGHT + 16 } }
        : {};
    return { ...n, data: { ...n.data, status: nodeStatus[n.id] ?? "idle" }, ...containerStyle };
  });
  const selectedNode = nodes.find((n) => n.id === selectedNodeId);

  // State reads/writes have no graph edge between the writer and reader node — render the
  // observed dependency as a dashed "lineage" line so it's not an invisible footgun (PLAN.md
  // design trap #3). These are purely visual: never part of the saved graph.
  const lineageEdges: Edge[] = stateLineage.map((l, i) => ({
    id: `lineage-${l.entry}-${l.writerNodeId}-${l.readerNodeId}-${i}`,
    source: l.writerNodeId,
    target: l.readerNodeId,
    label: `state: ${l.entry}`,
    style: { strokeDasharray: "6 4", stroke: theme.palette.warning.main },
    animated: false,
    data: { kind: "state-lineage" },
  }));
  const decoratedEdges = [...edges, ...lineageEdges];

  const missingDeps = requiredToolsetsFrom(nodes).flatMap((toolset) => {
    const status = pluginStatuses[toolset];
    if (!status?.configured) return [`${displayName(toolset, pluginStatuses)} plugin is not configured on the server`];
    if (!status.connected) {
      return toolset.startsWith("mcp:")
        ? [`${displayName(toolset, pluginStatuses)} MCP server is not reachable — check its config and restart the server`]
        : [`${displayName(toolset, pluginStatuses)} is not connected — connect it from Providers`];
    }
    return [];
  });

  // Live (pre-Save) structural validation — the same checks the server/interpreter run at
  // execution time (@flowlathe/core's validateGraph), minus the port-level R6/R7 rules (which
  // need each node kind's port declarations, only known server-side): exactly the mistakes a
  // user can make by *drawing* a graph. Safe to check against live rather than saved state
  // because handleRun/handleStep both call handleSave() first, so live and saved state agree by
  // the time either fires.
  const graphProblems = validateGraph({ nodes: nodes as FlowNode[], edges: edges as FlowEdge[], state: stateDecls });
  const canRun = missingDeps.length === 0 && graphProblems.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <AppBar position="static">
        <Toolbar sx={{ gap: 1 }}>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            {name || "flowlathe"}
          </Typography>
          <Typography variant="body2">v{version}</Typography>
          <Select
            size="small"
            value={newNodeKind}
            onChange={(e) => setNewNodeKind(e.target.value as NodeKind)}
            inputProps={{ "aria-label": "New node kind" }}
          >
            {NODE_KIND_OPTIONS.map((k) => (
              <MenuItem key={k} value={k}>
                {k}
              </MenuItem>
            ))}
          </Select>
          <Button variant="outlined" color="inherit" onClick={addNode}>
            Add Node
          </Button>
          <Button variant="contained" color="secondary" onClick={() => void handleSave()} disabled={saving}>
            Save
          </Button>
          <Button variant="outlined" color="inherit" onClick={() => setSaveAsVersionOpen(true)} disabled={saving} data-testid="open-name-version">
            Name version…
          </Button>
          <Button variant="outlined" color="inherit" onClick={openHistory} data-testid="open-history">
            History
          </Button>
          <Button variant="contained" onClick={handleRun} disabled={!canRun}>
            Run
          </Button>
          <Button
            variant="contained"
            color="warning"
            onClick={() => void handleStep()}
            disabled={!stepSession && !canRun}
          >
            {stepSession ? "Step" : "Start Stepping"}
          </Button>
          <Button variant="outlined" color="inherit" onClick={handleExport}>
            Export
          </Button>
          <Button
            variant="outlined"
            color="inherit"
            onClick={() => (textView ? setTextView(false) : openTextView())}
            data-testid="toggle-text-view"
          >
            {textView ? "Graph" : "Text"}
          </Button>
        </Toolbar>
      </AppBar>
      {graphProblems.length > 0 && (
        <Alert severity="error" data-testid="workflow-validation-alert">
          Workflow is invalid: {graphProblems.join("; ")}.
        </Alert>
      )}
      {missingDeps.length > 0 && (
        <Alert severity="warning" data-testid="workflow-dependency-alert">
          Workflow missing dependency: {missingDeps.join("; ")}. Fix this from{" "}
          <Link href="/providers">Providers</Link> before running.
        </Alert>
      )}
      <Snackbar
        open={externalChangeNotice}
        message="This flow changed on disk"
        action={
          <Button color="inherit" size="small" onClick={() => flowId && void loadFlow(flowId)} data-testid="reload-flow-button">
            Reload
          </Button>
        }
      />
      <Dialog open={conflictText !== null} onClose={() => setConflictText(null)}>
        <DialogTitle>Flow changed on disk</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This flow's file was edited outside the canvas since it was loaded. Reload to see the current version, or
            overwrite it with what's open here.
          </DialogContentText>
          <TextField
            fullWidth
            multiline
            minRows={4}
            maxRows={12}
            value={conflictText ?? ""}
            slotProps={{ htmlInput: { readOnly: true, "aria-label": "Current file contents" } }}
            sx={{ mt: 2, fontFamily: "monospace" }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleReloadFromDisk} data-testid="conflict-reload">
            Reload from disk
          </Button>
          <Button color="warning" onClick={handleOverwriteConflict} data-testid="conflict-overwrite">
            Overwrite anyway
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={saveAsVersionOpen} onClose={() => setSaveAsVersionOpen(false)}>
        <DialogTitle>Save as version</DialogTitle>
        <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 360, pt: 1 }}>
          <TextField
            label="Label"
            autoFocus
            value={versionLabelDraft}
            onChange={(e) => setVersionLabelDraft(e.target.value)}
            slotProps={{ htmlInput: { "data-testid": "save-version-label" } }}
          />
          <TextField
            label="Message (optional)"
            multiline
            minRows={2}
            value={versionMessageDraft}
            onChange={(e) => setVersionMessageDraft(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSaveAsVersionOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={versionLabelDraft.trim().length === 0}
            onClick={() => void handleSaveAsVersion()}
            data-testid="save-version-confirm"
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={historyOpen} onClose={() => setHistoryOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>Version history</DialogTitle>
        <DialogContent>
          <Typography variant="caption" color="text.secondary">
            Pick two rows (From / To) to diff them. Newest first.
          </Typography>
          <List dense data-testid="version-history-list">
            {versions.map((v) => (
              <ListItem
                key={v.id}
                divider
                secondaryAction={
                  <Box sx={{ display: "flex", gap: 0.5 }}>
                    <Button
                      size="small"
                      variant={diffPick.from === v.id ? "contained" : "outlined"}
                      onClick={() => setDiffPick((prev) => ({ ...prev, from: v.id }))}
                      data-testid={`version-pick-from-${v.version}`}
                    >
                      From
                    </Button>
                    <Button
                      size="small"
                      variant={diffPick.to === v.id ? "contained" : "outlined"}
                      onClick={() => setDiffPick((prev) => ({ ...prev, to: v.id }))}
                      data-testid={`version-pick-to-${v.version}`}
                    >
                      To
                    </Button>
                    <Button
                      size="small"
                      onClick={() => {
                        setRenameVersionId(v.id);
                        setVersionLabelDraft(v.label ?? "");
                        setVersionMessageDraft(v.message ?? "");
                      }}
                    >
                      Label
                    </Button>
                    <Button size="small" color="warning" disabled={v.isHead} onClick={() => void handleRestore(v.id)} data-testid={`version-restore-${v.version}`}>
                      Restore
                    </Button>
                    <Button size="small" onClick={() => void handlePin(v.id)} data-testid={`version-pin-${v.version}`}>
                      Pin
                    </Button>
                  </Box>
                }
              >
                <ListItemText
                  primary={
                    <>
                      v{v.version} {v.label && <strong>— {v.label}</strong>} {v.isHead && <em>(HEAD)</em>}{" "}
                      {pins
                        .filter((p) => p.flowVersionId === v.id)
                        .map((p) => (
                          <em key={p.channel}> 📌 {p.channel}</em>
                        ))}
                    </>
                  }
                  secondary={`${new Date(v.createdAt).toLocaleString()} · ${v.executionCount} execution${v.executionCount === 1 ? "" : "s"}${v.message ? ` · ${v.message}` : ""}`}
                />
              </ListItem>
            ))}
          </List>
          {renameVersionId && (
            <Box sx={{ display: "flex", gap: 1, alignItems: "center", mt: 1 }}>
              <TextField size="small" label="Label" value={versionLabelDraft} onChange={(e) => setVersionLabelDraft(e.target.value)} />
              <TextField size="small" label="Message" value={versionMessageDraft} onChange={(e) => setVersionMessageDraft(e.target.value)} />
              <Button size="small" variant="contained" onClick={() => void handleLabelVersion(renameVersionId)}>
                Save label
              </Button>
              <Button size="small" onClick={() => setRenameVersionId(null)}>
                Cancel
              </Button>
            </Box>
          )}
          <Box sx={{ mt: 2 }}>
            <Button
              variant="contained"
              disabled={!diffPick.from || !diffPick.to}
              onClick={() => diffPick.from && diffPick.to && void handleShowDiff(diffPick.from, diffPick.to)}
              data-testid="compare-versions"
            >
              Compare
            </Button>
          </Box>
          {diffResult && <Box sx={{ mt: 2 }} data-testid="version-diff">{renderGraphDiff(diffResult)}</Box>}
          {gitCommits.length > 0 && (
            <>
              <Divider sx={{ my: 2 }} />
              <Typography variant="subtitle2">Git history (read-only)</Typography>
              <Typography variant="caption" color="text.secondary">
                This flow's `.flow` file is tracked in git. flowlathe never writes to your repo — this is `git log`/`git show`, read-only.
              </Typography>
              <List dense data-testid="git-history-list">
                {gitCommits.map((c) => (
                  <ListItem
                    key={c.sha}
                    divider
                    secondaryAction={
                      <Button size="small" onClick={() => void handleShowGitDiff(c.sha)} data-testid={`git-diff-${c.sha.slice(0, 7)}`}>
                        Diff vs current
                      </Button>
                    }
                  >
                    <ListItemText
                      primary={`${c.sha.slice(0, 7)} — ${c.message}`}
                      secondary={new Date(c.date).toLocaleString()}
                    />
                  </ListItem>
                ))}
              </List>
              {gitDiffResult && <Box sx={{ mt: 2 }} data-testid="git-diff-result">{renderGraphDiff(gitDiffResult)}</Box>}
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setHistoryOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
      {theme.palette.mode === "dark" && (
        <style>{`
          .react-flow__controls-button {
            background: ${theme.palette.background.paper};
            border-bottom-color: ${theme.palette.divider};
            fill: ${theme.palette.text.primary};
          }
          .react-flow__controls-button:hover { background: ${theme.palette.action.hover}; }
          .react-flow__controls-button svg { fill: ${theme.palette.text.primary}; }
          .react-flow__attribution { background: transparent; color: ${theme.palette.text.secondary}; }
        `}</style>
      )}
      <div style={{ flexGrow: 1, display: "flex", minHeight: 0 }}>
        {textView ? (
          <Box sx={{ flexGrow: 1, display: "flex", flexDirection: "column", p: 2, gap: 1, minWidth: 0 }} data-testid="dsl-text-view">
            <Typography variant="caption" color="text.secondary">
              Live DSL for this flow — edits apply on blur. Reformats to canonical form on a successful parse.
            </Typography>
            <TextField
              multiline
              fullWidth
              value={dslDraft}
              onChange={(e) => setDslDraft(e.target.value)}
              onBlur={handleDslBlur}
              slotProps={{
                htmlInput: { "aria-label": "Flow DSL text", spellCheck: false },
                input: { sx: { height: "100%", alignItems: "flex-start" } },
              }}
              sx={{ flexGrow: 1, fontFamily: "monospace", "& textarea": { fontFamily: "monospace", height: "100% !important" } }}
            />
            {dslError && (
              <Alert severity="error" data-testid="dsl-parse-error">
                {dslError}
              </Alert>
            )}
          </Box>
        ) : (
          <div style={{ flexGrow: 1 }}>
            <ReactFlow
              nodes={decoratedNodes}
              edges={decoratedEdges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onSelectionChange={({ nodes: selected }) => setSelectedNodeId(selected[0]?.id ?? null)}
              fitView
            >
              <Background bgColor={theme.palette.background.default} color={theme.palette.divider} />
              <Controls />
            </ReactFlow>
          </div>
        )}
        <Box sx={{ width: 340, borderLeft: 1, borderColor: "divider", display: "flex", flexDirection: "column" }}>
          <Box sx={{ p: 2 }}>
            <Typography variant="subtitle2">Node properties</Typography>
            {selectedNode ? (
              <Box key={selectedNode.id} sx={{ display: "flex", flexDirection: "column", gap: 1, mt: 1 }}>
                <Box sx={{ display: "flex", gap: 0.5, alignItems: "flex-start" }}>
                  <TextField
                    size="small"
                    label="Node ID"
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    slotProps={{ htmlInput: { "aria-label": "Node ID" } }}
                  />
                  <Button size="small" onClick={renameSelectedNode} disabled={renameDraft.trim() === selectedNode.id}>
                    Rename
                  </Button>
                </Box>
                {renameError ? (
                  <Typography variant="caption" color="error">
                    {renameError}
                  </Typography>
                ) : (
                  <Typography variant="caption" color="text.secondary">
                    Renaming changes the node's id — past executions will keep referring to it by "{selectedNode.id}".
                  </Typography>
                )}
                <NodeProperties
                  node={selectedNode}
                  providers={providers}
                  modelsByProvider={modelsByProvider}
                  otherNodes={nodes.filter((n) => n.id !== selectedNode.id)}
                  pluginStatuses={pluginStatuses}
                  onChange={updateSelectedNodeData}
                  onParentChange={updateSelectedNodeParent}
                />
              </Box>
            ) : (
              <Typography variant="body2" color="text.secondary">
                Select a node to edit it.
              </Typography>
            )}
          </Box>
          <Divider />
          <Box sx={{ p: 2 }} data-testid="state-panel">
            <Typography variant="subtitle2">State</Typography>
            <List dense data-testid="state-decl-list">
              {stateDecls.map((decl, i) => (
                <ListItem
                  key={i}
                  disablePadding
                  sx={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 0.5, mb: 1 }}
                >
                  <Box sx={{ display: "flex", gap: 0.5 }}>
                    <TextField
                      size="small"
                      label="Name"
                      value={decl.name}
                      onChange={(e) => updateStateDecl(i, { name: e.target.value })}
                      slotProps={{ htmlInput: { "aria-label": `State entry ${i} name` } }}
                    />
                    <Select
                      size="small"
                      value={decl.type}
                      onChange={(e) => {
                        const type = e.target.value as StateValueType;
                        if (type === "file") {
                          updateStateDecl(i, {
                            type,
                            fileMode: decl.fileMode ?? "read-write",
                            merge: decl.merge === "append" ? "append" : "replace",
                          });
                        } else {
                          updateStateDecl(i, { type });
                        }
                      }}
                      inputProps={{ "aria-label": `State entry ${i} type` }}
                    >
                      {(["file", "string", "number", "boolean", "array", "object"] as StateValueType[]).map((t) => (
                        <MenuItem key={t} value={t}>
                          {t}
                        </MenuItem>
                      ))}
                    </Select>
                    <Select
                      size="small"
                      value={decl.merge}
                      onChange={(e) => updateStateDecl(i, { merge: e.target.value as MergeRule })}
                      inputProps={{ "aria-label": `State entry ${i} merge rule` }}
                    >
                      {(
                        (decl.type === "file"
                          ? ["replace", "append"]
                          : ["replace", "append", "numeric-add", "set-union", "error-on-conflict"]) as MergeRule[]
                      ).map((m) => (
                        <MenuItem key={m} value={m}>
                          {m}
                        </MenuItem>
                      ))}
                    </Select>
                    <Button size="small" onClick={() => removeStateDecl(i)}>
                      Remove
                    </Button>
                  </Box>
                  {decl.type === "file" && (
                    <Box sx={{ display: "flex", gap: 0.5 }}>
                      <TextField
                        size="small"
                        label="File path (relative to state files root)"
                        value={decl.filePath ?? ""}
                        onChange={(e) => updateStateDecl(i, { filePath: e.target.value })}
                        sx={{ flexGrow: 1 }}
                        slotProps={{ htmlInput: { "aria-label": `State entry ${i} file path` } }}
                      />
                      <Select
                        size="small"
                        value={decl.fileMode ?? "read-write"}
                        onChange={(e) => updateStateDecl(i, { fileMode: e.target.value as FileStateMode })}
                        inputProps={{ "aria-label": `State entry ${i} file mode` }}
                      >
                        {(["read-write", "read-only"] as FileStateMode[]).map((m) => (
                          <MenuItem key={m} value={m}>
                            {m}
                          </MenuItem>
                        ))}
                      </Select>
                      {decl.fileMode !== "read-only" && (
                        <FormControlLabel
                          control={
                            <Checkbox
                              size="small"
                              checked={decl.versioned ?? false}
                              onChange={(e) => updateStateDecl(i, { versioned: e.target.checked })}
                            />
                          }
                          label="Versioned"
                        />
                      )}
                    </Box>
                  )}
                  {stateValues[decl.name] !== undefined && (
                    <Typography variant="caption" color="text.secondary">
                      current: {JSON.stringify(stateValues[decl.name])}
                    </Typography>
                  )}
                </ListItem>
              ))}
            </List>
            <Button size="small" onClick={addStateDecl}>
              Add state entry
            </Button>
          </Box>
          <Divider />
          {suspended.length > 0 && (
            <>
              <Box sx={{ p: 2 }}>
                <Typography variant="subtitle2">Awaiting input</Typography>
                {suspended.map((s) => (
                  <Paper key={s.activationKey} sx={{ p: 1, mt: 1 }} variant="outlined">
                    <Typography variant="body2">{s.prompt ?? s.message ?? `${s.nodeId} is paused`}</Typography>
                    <Box sx={{ display: "flex", gap: 1, mt: 1 }}>
                      <TextField
                        size="small"
                        label="Answer"
                        value={resumeDraft[s.activationKey] ?? ""}
                        onChange={(e) => setResumeDraft((prev) => ({ ...prev, [s.activationKey]: e.target.value }))}
                      />
                      <Button size="small" variant="contained" onClick={() => void handleResume(s.activationKey)}>
                        Resume
                      </Button>
                    </Box>
                  </Paper>
                ))}
              </Box>
              <Divider />
            </>
          )}
          {stepSession && (
            <>
              <Box sx={{ p: 2 }} data-testid="step-debug-panel">
                <Typography variant="subtitle2">Step debugging</Typography>
                <Typography variant="caption" color="text.secondary">
                  branch: {stepSession.currentBranchId.slice(0, 8)}
                </Typography>
                {provenance?.changedSinceRun?.semantic && provenance.flowVersion && (
                  <Alert severity="info" sx={{ mt: 1 }} data-testid="stepping-stale-chip">
                    Stepping against the current graph — {provenance.changedSinceRun.nodesChanged} node
                    {provenance.changedSinceRun.nodesChanged === 1 ? "" : "s"} changed since this session started.{" "}
                    <Link
                      component="button"
                      onClick={() => {
                        openHistory();
                        void handleShowDiff(provenance.flowVersion!.id, provenance.changedSinceRun!.currentVersionId);
                      }}
                    >
                      view diff
                    </Link>
                  </Alert>
                )}
                <List dense data-testid="step-history">
                  {history.map((h) => (
                    <ListItem
                      key={h.snapshotId}
                      secondaryAction={
                        <Button size="small" onClick={() => void handleStepBack(h.snapshotId)}>
                          Step back to here
                        </Button>
                      }
                    >
                      <ListItemText primary={h.nodeId} />
                    </ListItem>
                  ))}
                </List>
                {branches.length > 1 && (
                  <>
                    <Typography variant="caption" color="text.secondary">
                      Branches
                    </Typography>
                    <List dense data-testid="branch-list">
                      {branches.map((b) => (
                        <ListItem key={b.id} disablePadding>
                          <Button
                            size="small"
                            variant={b.id === stepSession.currentBranchId ? "contained" : "text"}
                            onClick={() => void handleSwitchBranch(b.id)}
                            data-testid={`branch-${b.id}`}
                          >
                            {b.id === stepSession.currentBranchId ? "● " : ""}
                            {b.label ?? b.id.slice(0, 8)}
                          </Button>
                        </ListItem>
                      ))}
                    </List>
                  </>
                )}
              </Box>
              <Divider />
            </>
          )}
          <Box sx={{ p: 2, flexGrow: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <Typography variant="subtitle2">Execution log</Typography>
            {provenance?.flowVersion && (
              <Typography variant="caption" color="text.secondary" data-testid="execution-provenance">
                ran {provenance.flowVersion.label ?? `v${provenance.flowVersion.version}`}
                {!stepSession && provenance.changedSinceRun?.semantic && (
                  <>
                    {" — flow has changed since this run ("}
                    {provenance.changedSinceRun.nodesChanged} node{provenance.changedSinceRun.nodesChanged === 1 ? "" : "s"}
                    {"). "}
                    <Link
                      component="button"
                      onClick={() => {
                        openHistory();
                        void handleShowDiff(provenance.flowVersion!.id, provenance.changedSinceRun!.currentVersionId);
                      }}
                    >
                      view diff
                    </Link>
                  </>
                )}
              </Typography>
            )}
            <List dense sx={{ overflowY: "auto", flexGrow: 1 }} data-testid="execution-log">
              {log.map((line) => (
                <ListItem key={line.seq} disablePadding>
                  <ListItemText primary={line.text} />
                </ListItem>
              ))}
            </List>
          </Box>
        </Box>
      </div>
      <Dialog open={exportedScript !== null} onClose={() => setExportedScript(null)} maxWidth="md" fullWidth>
        <DialogTitle>Exported script</DialogTitle>
        <DialogContent>
          <pre data-testid="exported-script" style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
            {exportedScript}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NodeProperties(props: {
  node: Node;
  providers: ProviderRecord[];
  modelsByProvider: Record<string, ModelRecord[]>;
  otherNodes: Node[];
  pluginStatuses: Record<string, PluginStatusEntry>;
  onChange: (patch: Record<string, unknown>) => void;
  onParentChange: (parentId: string) => void;
}) {
  const { node, providers, modelsByProvider, otherNodes, pluginStatuses, onChange, onParentChange } = props;
  const data = node.data as Record<string, unknown>;
  const type = node.type as NodeKind;

  return (
    <>
      {type === "prompt" && (
        <>
          <TextField
            size="small"
            label="Template"
            multiline
            minRows={2}
            value={(data["template"] as string) ?? ""}
            onChange={(e) => onChange({ template: e.target.value })}
            slotProps={{ htmlInput: { "aria-label": "Template" } }}
          />
          <Select
            size="small"
            displayEmpty
            value={(data["providerId"] as string) ?? ""}
            onChange={(e) => onChange({ providerId: e.target.value, modelId: "" })}
            inputProps={{ "aria-label": "Provider" }}
          >
            {providers.map((p) => (
              <MenuItem key={p.id} value={p.id}>
                {p.name}
              </MenuItem>
            ))}
          </Select>
          <Select
            size="small"
            displayEmpty
            value={(data["modelId"] as string) ?? ""}
            onChange={(e) => onChange({ modelId: e.target.value })}
            inputProps={{ "aria-label": "Model" }}
          >
            {(modelsByProvider[data["providerId"] as string] ?? []).map((m) => (
              <MenuItem key={m.id} value={m.modelName}>
                {m.modelName}
              </MenuItem>
            ))}
          </Select>
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={(data["enableStateTools"] as boolean) ?? false}
                onChange={(e) => onChange({ enableStateTools: e.target.checked })}
              />
            }
            label="Enable read_state/write_state tool"
          />
          {Object.keys(pluginStatuses)
            .sort()
            .map((toolset) => (
              <FormControlLabel
                key={toolset}
                control={
                  <Checkbox
                    size="small"
                    checked={((data["enabledToolsets"] as string[] | undefined) ?? []).includes(toolset)}
                    onChange={(e) => {
                      const current = (data["enabledToolsets"] as string[] | undefined) ?? [];
                      onChange({
                        enabledToolsets: e.target.checked
                          ? [...current, toolset]
                          : current.filter((t) => t !== toolset),
                      });
                    }}
                  />
                }
                label={`Enable ${displayName(toolset, pluginStatuses)} tools`}
              />
            ))}
          <TextField
            size="small"
            type="number"
            label="Temperature (default)"
            slotProps={{ htmlInput: { step: 0.1, min: 0, max: 2 } }}
            value={(data["temperature"] as number | undefined) ?? ""}
            onChange={(e) => onChange({ temperature: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
          <TextField
            size="small"
            type="number"
            label="Top K (default)"
            value={(data["topK"] as number | undefined) ?? ""}
            onChange={(e) => onChange({ topK: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
        </>
      )}

      {type === "router" && (
        <>
          <TextField
            size="small"
            label="Routes (comma-separated)"
            value={((data["routes"] as string[]) ?? []).join(",")}
            onChange={(e) => onChange({ routes: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
          />
          <TextField
            size="small"
            label="Cases (JSON)"
            multiline
            minRows={2}
            value={JSON.stringify(data["cases"] ?? [])}
            onChange={(e) => {
              try {
                onChange({ cases: JSON.parse(e.target.value) });
              } catch {
                /* ignore invalid JSON until it parses */
              }
            }}
          />
          <TextField
            size="small"
            label="Default route"
            value={(data["defaultRoute"] as string) ?? ""}
            onChange={(e) => onChange({ defaultRoute: e.target.value })}
          />
        </>
      )}

      {type === "merge" && (
        <Typography variant="body2" color="text.secondary">
          No configurable properties — picks whichever of in1/in2 is connected.
        </Typography>
      )}

      {type === "pause" && (
        <TextField
          size="small"
          label="Message"
          value={(data["message"] as string) ?? ""}
          onChange={(e) => onChange({ message: e.target.value })}
        />
      )}

      {type === "userInput" && (
        <TextField
          size="small"
          label="Prompt"
          value={(data["prompt"] as string) ?? ""}
          onChange={(e) => onChange({ prompt: e.target.value })}
        />
      )}

      {type === "loop" && (
        <>
          <TextField
            size="small"
            label="Init template"
            value={(data["initTemplate"] as string) ?? ""}
            onChange={(e) => onChange({ initTemplate: e.target.value })}
          />
          <TextField
            size="small"
            label="Accumulator port name"
            value={(data["accPortName"] as string) ?? ""}
            onChange={(e) => onChange({ accPortName: e.target.value })}
          />
          <TextField
            size="small"
            label="Stop value"
            value={(data["stopValue"] as string) ?? ""}
            onChange={(e) => onChange({ stopValue: e.target.value })}
          />
          <TextField
            size="small"
            type="number"
            label="Max iterations"
            value={(data["maxIterations"] as number) ?? 1}
            onChange={(e) => onChange({ maxIterations: Number(e.target.value) })}
          />
        </>
      )}

      {type === "map" && (
        <>
          <TextField
            size="small"
            label="Items template (JSON array)"
            value={(data["itemsTemplate"] as string) ?? ""}
            onChange={(e) => onChange({ itemsTemplate: e.target.value })}
          />
          <TextField
            size="small"
            label="Item port name"
            value={(data["itemPortName"] as string) ?? ""}
            onChange={(e) => onChange({ itemPortName: e.target.value })}
          />
          <TextField
            size="small"
            type="number"
            label="Max concurrency"
            value={(data["maxConcurrency"] as number) ?? 1}
            onChange={(e) => onChange({ maxConcurrency: Number(e.target.value) })}
          />
          <TextField
            size="small"
            type="number"
            label="Max items"
            value={(data["maxItems"] as number) ?? 1}
            onChange={(e) => onChange({ maxItems: Number(e.target.value) })}
          />
        </>
      )}

      {type === "gate" && (
        <>
          <Typography variant="caption" color="text.secondary">
            Overrides ambient LLM settings for every node downstream, from the moment execution
            passes through this gate. Leave a field blank to not touch it.
          </Typography>
          <TextField
            size="small"
            type="number"
            label="Temperature"
            slotProps={{ htmlInput: { step: 0.1, min: 0, max: 2 } }}
            value={(data["temperature"] as number | undefined) ?? ""}
            onChange={(e) => onChange({ temperature: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
          <TextField
            size="small"
            type="number"
            label="Top K"
            value={(data["topK"] as number | undefined) ?? ""}
            onChange={(e) => onChange({ topK: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
          <Select
            size="small"
            displayEmpty
            value={(data["compactionMethod"] as string) ?? ""}
            onChange={(e) => onChange({ compactionMethod: e.target.value || undefined })}
            inputProps={{ "aria-label": "Compaction method" }}
          >
            <MenuItem value="">(no compaction)</MenuItem>
            <MenuItem value="drop-oldest-half">drop-oldest-half</MenuItem>
            <MenuItem value="summarize-oldest-half">summarize-oldest-half</MenuItem>
          </Select>

          {data["compactionMethod"] && (
            <>
              <Select
                size="small"
                value={(data["compactionThreshold"] as { kind?: string } | undefined)?.kind ?? "fixed"}
                onChange={(e) =>
                  onChange({
                    compactionThreshold:
                      e.target.value === "fixed" ? { kind: "fixed", tokens: 4000 } : { kind: "percentage", percent: 80, contextWindowTokens: 8192 },
                  })
                }
                inputProps={{ "aria-label": "Threshold kind" }}
              >
                <MenuItem value="fixed">fixed token count</MenuItem>
                <MenuItem value="percentage">percentage of context window</MenuItem>
              </Select>

              {(data["compactionThreshold"] as { kind?: string } | undefined)?.kind === "percentage" ? (
                <>
                  <TextField
                    size="small"
                    type="number"
                    label="Threshold %"
                    value={(data["compactionThreshold"] as { percent?: number })?.percent ?? 80}
                    onChange={(e) =>
                      onChange({
                        compactionThreshold: {
                          ...(data["compactionThreshold"] as object),
                          kind: "percentage",
                          percent: Number(e.target.value),
                        },
                      })
                    }
                  />
                  <TextField
                    size="small"
                    type="number"
                    label="Model context window (tokens)"
                    value={(data["compactionThreshold"] as { contextWindowTokens?: number })?.contextWindowTokens ?? 8192}
                    onChange={(e) =>
                      onChange({
                        compactionThreshold: {
                          ...(data["compactionThreshold"] as object),
                          kind: "percentage",
                          contextWindowTokens: Number(e.target.value),
                        },
                      })
                    }
                  />
                </>
              ) : (
                <TextField
                  size="small"
                  type="number"
                  label="Threshold (tokens)"
                  value={(data["compactionThreshold"] as { tokens?: number })?.tokens ?? 4000}
                  onChange={(e) =>
                    onChange({ compactionThreshold: { kind: "fixed", tokens: Number(e.target.value) } })
                  }
                />
              )}
            </>
          )}
        </>
      )}

      {type === "search" && (
        <>
          <TextField
            size="small"
            label="Query template"
            value={(data["queryTemplate"] as string) ?? ""}
            onChange={(e) => onChange({ queryTemplate: e.target.value })}
            slotProps={{ htmlInput: { "aria-label": "Query template" } }}
          />
          <TextField
            size="small"
            label="Categories (comma-separated)"
            value={(data["categories"] as string) ?? ""}
            onChange={(e) => onChange({ categories: e.target.value || undefined })}
          />
          <TextField
            size="small"
            label="Engines (comma-separated)"
            value={(data["engines"] as string) ?? ""}
            onChange={(e) => onChange({ engines: e.target.value || undefined })}
          />
          <TextField
            size="small"
            type="number"
            label="Limit (max 20)"
            value={(data["limit"] as number | undefined) ?? ""}
            onChange={(e) => onChange({ limit: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
        </>
      )}

      {type === "fetch" && (
        <>
          <TextField
            size="small"
            label="URL template"
            value={(data["urlTemplate"] as string) ?? ""}
            onChange={(e) => onChange({ urlTemplate: e.target.value })}
            slotProps={{ htmlInput: { "aria-label": "URL template" } }}
            error={Boolean(fetchUrlSafetyError(data["urlTemplate"] as string | undefined))}
            helperText={fetchUrlSafetyError(data["urlTemplate"] as string | undefined)}
          />
          <Select
            size="small"
            value={(data["format"] as string) ?? "markdown"}
            onChange={(e) => onChange({ format: e.target.value })}
            inputProps={{ "aria-label": "Format" }}
          >
            <MenuItem value="markdown">markdown</MenuItem>
            <MenuItem value="html">html</MenuItem>
          </Select>
          <TextField
            size="small"
            type="number"
            label="Max characters"
            value={(data["maxChars"] as number | undefined) ?? ""}
            onChange={(e) => onChange({ maxChars: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
        </>
      )}

      {type === "trigger" && (
        <>
          <Select
            size="small"
            value={(data["source"] as string) ?? "manual"}
            onChange={(e) => onChange({ source: e.target.value })}
            inputProps={{ "aria-label": "Trigger source" }}
          >
            <MenuItem value="manual">manual (canvas only)</MenuItem>
            <MenuItem value="discord">discord</MenuItem>
          </Select>
          <TextField
            size="small"
            label="Test payload (used when run from the canvas)"
            multiline
            minRows={2}
            value={(data["testPayload"] as string) ?? ""}
            onChange={(e) => onChange({ testPayload: e.target.value })}
          />
          <Typography variant="caption" color="text.secondary">
            When started by a real Discord trigger (not the canvas), this node&apos;s outputs are
            filled from the actual message instead of the test payload above.
          </Typography>
        </>
      )}

      <Divider sx={{ my: 1 }} />
      <Select
        size="small"
        displayEmpty
        value={node.parentId ?? ""}
        onChange={(e) => onParentChange(e.target.value)}
        inputProps={{ "aria-label": "Parent (Loop/Map body of)" }}
      >
        <MenuItem value="">(top-level — not a loop/map body)</MenuItem>
        {otherNodes
          .filter((n) => n.type === "loop" || n.type === "map")
          .map((n) => (
            <MenuItem key={n.id} value={n.id}>
              body of {(n.data["label"] as string) ?? n.id}
            </MenuItem>
          ))}
      </Select>
    </>
  );
}

function describeEvent(event: RunEvent): string {
  switch (event.kind) {
    case "node_started":
      return `${event.nodeId}: started`;
    case "token":
      return `${event.nodeId}: token "${event.token}"`;
    case "node_finished":
      return `${event.nodeId}: finished -> ${event.output}`;
    case "node_failed":
      return `${event.nodeId}: failed (${event.error})`;
    case "node_cancelled":
      return `${event.nodeId}: cancelled (${event.reason})`;
    case "node_skipped":
      return `${event.nodeId}: skipped (${event.reason})`;
    case "node_suspended":
      return `${event.nodeId}: suspended (${event.reason.type})`;
    case "state_write":
      return `state[${event.entry}] <- ${JSON.stringify(event.value)} (${event.merge}${event.viaTool ? ", via tool" : ""})`;
    case "state_read":
      return `state[${event.entry}] read (seq ${event.seqSeen}${event.viaTool ? ", via tool" : ""})`;
    case "context_appended":
      return `${event.nodeId}: context now ${event.messageCount} messages`;
    case "context_compacted":
      return `${event.nodeId}: context ${event.method} (${event.beforeMessages.length} -> ${event.afterMessages.length} messages)`;
    case "llm_config_set":
      return `${event.nodeId}: gate set ${JSON.stringify(event.patch)}`;
    case "run_finished":
      return `run finished`;
    case "run_failed":
      return `run failed: ${event.error}`;
  }
}

function describeReparent(r: { from?: string; to?: string }): string {
  if (r.from && r.to) return `moved from body "${r.from}" into body "${r.to}"`;
  if (r.to) return `moved into body "${r.to}"`;
  if (r.from) return `moved out of body "${r.from}" (now top-level)`;
  return "reparented";
}

/** PLAN-FLOW-VERSIONING.md §4.4/§4.5's structural diff, rendered read-only. Multi-line string
 *  fields (prompt templates, the main payload of a real change) get a per-line +/- view instead of
 *  the raw before/after values. */
function renderGraphDiff({ diff, isSemanticChange }: { diff: GraphDiff; isSemanticChange: boolean }) {
  const nothingChanged =
    diff.nodes.added.length === 0 &&
    diff.nodes.removed.length === 0 &&
    diff.nodes.changed.length === 0 &&
    diff.edges.added.length === 0 &&
    diff.edges.removed.length === 0 &&
    diff.state.added.length === 0 &&
    diff.state.removed.length === 0 &&
    diff.state.changed.length === 0;

  if (nothingChanged) return <Typography variant="body2">No differences.</Typography>;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
      {!isSemanticChange && <Alert severity="info">Layout only — no change to the flow's behavior.</Alert>}
      {diff.nodes.added.map((n) => (
        <Alert key={`added-${n.id}`} severity="success" icon={false}>
          + node "{n.id}" ({n.type})
        </Alert>
      ))}
      {diff.nodes.removed.map((n) => (
        <Alert key={`removed-${n.id}`} severity="error" icon={false}>
          − node "{n.id}" ({n.type})
        </Alert>
      ))}
      {diff.nodes.changed.map((c) => (
        <Paper key={c.id} variant="outlined" sx={{ p: 1.5 }}>
          <Typography variant="subtitle2">
            node "{c.id}" ({c.kind})
          </Typography>
          {c.reparented && (
            <Typography variant="body2" color="warning.main">
              {describeReparent(c.reparented)}
            </Typography>
          )}
          {c.movedTo && (
            <Typography variant="caption" color="text.secondary">
              position only: moved to ({c.movedTo.x}, {c.movedTo.y})
            </Typography>
          )}
          {c.fields.map((f) => (
            <Box key={f.path} sx={{ mt: 0.5 }}>
              <Typography variant="body2" sx={{ fontWeight: "bold" }}>
                {f.path}
              </Typography>
              {f.lineDiff ? (
                <Box component="pre" sx={{ m: 0, fontFamily: "monospace", fontSize: 12, whiteSpace: "pre-wrap" }}>
                  {f.lineDiff.map((entry, i) => (
                    <div
                      key={i}
                      style={{
                        color: entry.kind === "added" ? "green" : entry.kind === "removed" ? "crimson" : undefined,
                      }}
                    >
                      {entry.kind === "added" ? "+ " : entry.kind === "removed" ? "− " : "  "}
                      {entry.line}
                    </div>
                  ))}
                </Box>
              ) : (
                <Typography variant="caption" sx={{ fontFamily: "monospace" }}>
                  {JSON.stringify(f.before)} → {JSON.stringify(f.after)}
                </Typography>
              )}
            </Box>
          ))}
        </Paper>
      ))}
      {diff.edges.added.map((e, i) => (
        <Alert key={`edge-added-${i}`} severity="success" icon={false}>
          + edge {e.source}.{e.sourceHandle ?? "output"} → {e.target}.{e.targetHandle ?? "input"}
        </Alert>
      ))}
      {diff.edges.removed.map((e, i) => (
        <Alert key={`edge-removed-${i}`} severity="error" icon={false}>
          − edge {e.source}.{e.sourceHandle ?? "output"} → {e.target}.{e.targetHandle ?? "input"}
        </Alert>
      ))}
      {diff.state.added.map((s) => (
        <Alert key={`state-added-${s.name}`} severity="success" icon={false}>
          + state "{s.name}"
        </Alert>
      ))}
      {diff.state.removed.map((s) => (
        <Alert key={`state-removed-${s.name}`} severity="error" icon={false}>
          − state "{s.name}"
        </Alert>
      ))}
      {diff.state.changed.map((c) => (
        <Paper key={c.name} variant="outlined" sx={{ p: 1.5 }}>
          <Typography variant="subtitle2">state "{c.name}"</Typography>
          {c.fields.map((f) => (
            <Typography key={f.path} variant="caption" sx={{ display: "block", fontFamily: "monospace" }}>
              {f.path}: {JSON.stringify(f.before)} → {JSON.stringify(f.after)}
            </Typography>
          ))}
        </Paper>
      ))}
    </Box>
  );
}
