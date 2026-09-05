import type { FlowEdge, FlowNode } from "@flowlathe/core";
import { AppBar, Button, Toolbar, Typography } from "@mui/material";
import {
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getFlow, saveFlowGraph } from "../api.js";

export function Canvas() {
  const { flowId } = useParams<{ flowId: string }>();
  const [name, setName] = useState<string>("");
  const [version, setVersion] = useState<number>(0);
  const [saving, setSaving] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    if (!flowId) return;
    getFlow(flowId).then((flow) => {
      setName(flow.name);
      setVersion(flow.version);
      setNodes(flow.graph.nodes as Node[]);
      setEdges(flow.graph.edges as Edge[]);
    });
  }, [flowId, setNodes, setEdges]);

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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <AppBar position="static">
        <Toolbar sx={{ gap: 2 }}>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            {name || "flowlathe"}
          </Typography>
          <Typography variant="body2">v{version}</Typography>
          <Button variant="contained" color="secondary" onClick={handleSave} disabled={saving}>
            Save
          </Button>
        </Toolbar>
      </AppBar>
      <div style={{ flexGrow: 1 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          fitView
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}
