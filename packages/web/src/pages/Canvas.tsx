import type { FlowEdge, FlowNode, RunEvent } from "@flowlathe/core";
import {
  AppBar,
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  List,
  ListItem,
  ListItemText,
  TextField,
  Toolbar,
  Typography,
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
import { exportFlow, getFlow, runFlow, saveFlowGraph } from "../api.js";
import { nodeTypes, type NodeStatus } from "../nodes/PromptNodeView.js";

let nextNodeSeq = 1;

interface LogLine {
  seq: number;
  text: string;
}

export function Canvas() {
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
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!flowId) return;
    getFlow(flowId).then((flow) => {
      setName(flow.name);
      setVersion(flow.version);
      setNodes(flow.graph.nodes as Node[]);
      setEdges(flow.graph.edges as Edge[]);
    });
  }, [flowId, setNodes, setEdges]);

  useEffect(() => () => eventSourceRef.current?.close(), []);

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
        type: "prompt",
        position: { x: 80 + ns.length * 60, y: 80 + ns.length * 40 },
        data: { label: id, template: "", providerId: "mock", modelId: "mock" },
      } as Node,
    ]);
  }

  function updateSelectedNodeData(patch: Record<string, unknown>) {
    if (!selectedNodeId) return;
    setNodes((ns) => ns.map((n) => (n.id === selectedNodeId ? { ...n, data: { ...n.data, ...patch } } : n)));
  }

  async function handleSave() {
    if (!flowId) return;
    setSaving(true);
    try {
      const saved = await saveFlowGraph(flowId, {
        nodes: nodes as FlowNode[],
        edges: edges as FlowEdge[],
      });
      setVersion(saved.version);
    } finally {
      setSaving(false);
    }
  }

  async function handleRun() {
    if (!flowId) return;
    setLog([]);
    setNodeStatus({});
    try {
      await handleSave();
      const { executionId } = await runFlow(flowId);
      eventSourceRef.current?.close();
      const source = new EventSource(`/api/executions/${executionId}/events`);
      eventSourceRef.current = source;

      const onEvent = (kind: RunEvent["kind"]) => (raw: MessageEvent<string>) => {
        const seq = Number(raw.lastEventId);
        const event = JSON.parse(raw.data) as RunEvent;
        setLog((prev) => [...prev, { seq, text: describeEvent(event) }]);
        if (kind === "node_started") {
          setNodeStatus((prev) => ({ ...prev, [(event as { nodeId: string }).nodeId]: "running" }));
        } else if (kind === "node_finished") {
          setNodeStatus((prev) => ({ ...prev, [(event as { nodeId: string }).nodeId]: "done" }));
        } else if (kind === "node_failed") {
          setNodeStatus((prev) => ({ ...prev, [(event as { nodeId: string }).nodeId]: "failed" }));
        } else if (kind === "run_finished" || kind === "run_failed") {
          source.close();
        }
      };

      for (const kind of ["node_started", "token", "node_finished", "node_failed", "run_finished", "run_failed"] as const) {
        source.addEventListener(kind, onEvent(kind) as EventListener);
      }
    } catch (err) {
      setLog((prev) => [...prev, { seq: prev.length + 1, text: `run failed to start: ${(err as Error).message}` }]);
    }
  }

  async function handleExport() {
    if (!flowId) return;
    const { script } = await exportFlow(flowId);
    setExportedScript(script);
  }

  const decoratedNodes = nodes.map((n) => ({ ...n, data: { ...n.data, status: nodeStatus[n.id] ?? "idle" } }));
  const selectedNode = nodes.find((n) => n.id === selectedNodeId);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <AppBar position="static">
        <Toolbar sx={{ gap: 1 }}>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            {name || "flowlathe"}
          </Typography>
          <Typography variant="body2">v{version}</Typography>
          <Button variant="outlined" color="inherit" onClick={addNode}>
            Add Prompt Node
          </Button>
          <Button variant="contained" color="secondary" onClick={handleSave} disabled={saving}>
            Save
          </Button>
          <Button variant="contained" onClick={handleRun}>
            Run
          </Button>
          <Button variant="outlined" color="inherit" onClick={handleExport}>
            Export
          </Button>
        </Toolbar>
      </AppBar>
      <div style={{ flexGrow: 1, display: "flex", minHeight: 0 }}>
        <div style={{ flexGrow: 1 }}>
          <ReactFlow
            nodes={decoratedNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onSelectionChange={({ nodes: selected }) => setSelectedNodeId(selected[0]?.id ?? null)}
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>
        <Box sx={{ width: 320, borderLeft: "1px solid #ddd", display: "flex", flexDirection: "column" }}>
          <Box sx={{ p: 2 }}>
            <Typography variant="subtitle2">Node properties</Typography>
            {selectedNode ? (
              <Box key={selectedNode.id} sx={{ display: "flex", flexDirection: "column", gap: 1, mt: 1 }}>
                <TextField
                  size="small"
                  label="Template"
                  multiline
                  minRows={2}
                  value={(selectedNode.data["template"] as string) ?? ""}
                  onChange={(e) => updateSelectedNodeData({ template: e.target.value })}
                  slotProps={{ htmlInput: { "aria-label": "Template" } }}
                />
                <TextField
                  size="small"
                  label="Provider"
                  value={(selectedNode.data["providerId"] as string) ?? ""}
                  onChange={(e) => updateSelectedNodeData({ providerId: e.target.value })}
                  slotProps={{ htmlInput: { "aria-label": "Provider" } }}
                />
                <TextField
                  size="small"
                  label="Model"
                  value={(selectedNode.data["modelId"] as string) ?? ""}
                  onChange={(e) => updateSelectedNodeData({ modelId: e.target.value })}
                  slotProps={{ htmlInput: { "aria-label": "Model" } }}
                />
              </Box>
            ) : (
              <Typography variant="body2" color="text.secondary">
                Select a node to edit it.
              </Typography>
            )}
          </Box>
          <Divider />
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
    case "run_finished":
      return `run finished`;
    case "run_failed":
      return `run failed: ${event.error}`;
  }
}
