import { Handle, Position, type NodeProps } from "@xyflow/react";

export type NodeStatus = "idle" | "running" | "done" | "failed";

const STATUS_COLOR: Record<NodeStatus, string> = {
  idle: "#9e9e9e",
  running: "#1976d2",
  done: "#2e7d32",
  failed: "#c62828",
};

export interface PromptNodeData extends Record<string, unknown> {
  label?: string;
  template?: string;
  status?: NodeStatus;
}

export function PromptNodeView({ id, data }: NodeProps) {
  const nodeData = data as PromptNodeData;
  const status = nodeData.status ?? "idle";
  return (
    <div
      data-testid={`node-${id}`}
      data-status={status}
      style={{
        border: `2px solid ${STATUS_COLOR[status]}`,
        borderRadius: 8,
        padding: "8px 12px",
        background: "white",
        minWidth: 140,
        boxShadow: status === "running" ? `0 0 8px ${STATUS_COLOR.running}` : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} id="input" />
      <div style={{ fontSize: 13, fontWeight: 600 }}>{nodeData.label ?? id}</div>
      <div style={{ fontSize: 11, color: "#666", marginTop: 4 }}>{status}</div>
      <Handle type="source" position={Position.Right} id="output" />
    </div>
  );
}

export const nodeTypes = { prompt: PromptNodeView };
