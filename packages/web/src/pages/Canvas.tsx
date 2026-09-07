import type { FlowEdge, FlowNode, MergeRule, NodeKind, RunEvent, StateDecl, StateValueType } from "@flowlathe/core";
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
  getPluginStatuses,
  getStateLineage,
  listBranches,
  listModels,
  listProviders,
  resumeExecution,
  runFlow,
  saveFlowGraph,
  stepBack,
  stepOnce,
  stepStart,
  subscribeFlowInvalidations,
  type BranchRecord,
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
    setStateDecls((prev) => [...prev, { name: `entry${prev.length + 1}`, type: "string", merge: "replace" }]);
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
   *  rather than run against a graph the server never actually saved. */
  async function handleSave(): Promise<boolean> {
    if (!flowId) return false;
    setSaving(true);
    try {
      const result = await saveFlowGraph(
        flowId,
        { nodes: nodes as FlowNode[], edges: edges as FlowEdge[], state: stateDecls },
        contentHash ?? undefined,
      );
      if (!result.ok) {
        setConflictText(result.conflictText);
        return false;
      }
      setVersion(result.flow.version);
      setContentHash(result.flow.contentHash);
      return true;
    } finally {
      setSaving(false);
    }
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
    try {
      if (!(await handleSave())) return;
      const { executionId: newExecutionId, branchId } = await runFlow(flowId);
      setExecutionId(newExecutionId);
      subscribeToExecution(newExecutionId, branchId);
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
        const started = await stepStart(flowId);
        setExecutionId(started.executionId);
        subscribeToExecution(started.executionId, started.branchId);
        setStepSession({ executionId: started.executionId, currentBranchId: started.branchId });
        setBranches(await listBranches(started.executionId));
        setHistory([]);
        setStateValues({});
        setStateLineage([]);
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
    setBranches(await listBranches(stepSession.executionId));
    const cutIdx = history.findIndex((h) => h.snapshotId === snapshotId);
    const truncated = cutIdx === -1 ? [] : history.slice(0, cutIdx + 1);
    setHistory(truncated);
    setNodeStatus(Object.fromEntries(truncated.map((h) => [h.nodeId, "done"])));
    const status = await getExecution(stepSession.executionId, forked.branchId);
    setLog(status.responses.map((r, i) => ({ seq: i, text: `${r.nodeId}: finished` })));
    refreshState(stepSession.executionId, forked.branchId);
  }

  async function handleSwitchBranch(branchId: string) {
    if (!stepSession) return;
    setStepSession({ ...stepSession, currentBranchId: branchId });
    setHistory([]);
    const status = await getExecution(stepSession.executionId, branchId);
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
          <Button variant="contained" color="secondary" onClick={handleSave} disabled={saving}>
            Save
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
                      value={decl.merge}
                      onChange={(e) => updateStateDecl(i, { merge: e.target.value as MergeRule })}
                      inputProps={{ "aria-label": `State entry ${i} merge rule` }}
                    >
                      {(["replace", "append", "numeric-add", "set-union", "error-on-conflict"] as MergeRule[]).map((m) => (
                        <MenuItem key={m} value={m}>
                          {m}
                        </MenuItem>
                      ))}
                    </Select>
                    <Select
                      size="small"
                      value={decl.type}
                      onChange={(e) => updateStateDecl(i, { type: e.target.value as StateValueType })}
                      inputProps={{ "aria-label": `State entry ${i} type` }}
                    >
                      {(["string", "number", "boolean", "array", "object"] as StateValueType[]).map((t) => (
                        <MenuItem key={t} value={t}>
                          {t}
                        </MenuItem>
                      ))}
                    </Select>
                    <Button size="small" onClick={() => removeStateDecl(i)}>
                      Remove
                    </Button>
                  </Box>
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
