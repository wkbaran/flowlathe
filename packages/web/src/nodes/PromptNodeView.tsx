import { useTheme } from "@mui/material";
import { Handle, Position, type NodeProps } from "@xyflow/react";

export type NodeStatus = "idle" | "running" | "done" | "failed";

export interface PromptNodeData extends Record<string, unknown> {
  label?: string;
  template?: string;
  status?: NodeStatus;
}

export function PromptNodeView({ id, data }: NodeProps) {
  const theme = useTheme();
  const nodeData = data as PromptNodeData;
  const status = nodeData.status ?? "idle";
  const statusColor = {
    idle: theme.palette.text.disabled,
    running: theme.palette.info.main,
    done: theme.palette.success.main,
    failed: theme.palette.error.main,
  }[status];

  return (
    <div
      data-testid={`node-${id}`}
      data-status={status}
      style={{
        border: `2px solid ${statusColor}`,
        borderRadius: 8,
        padding: "8px 12px",
        background: theme.palette.background.paper,
        color: theme.palette.text.primary,
        minWidth: 140,
        boxShadow: status === "running" ? `0 0 8px ${statusColor}` : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} id="input" />
      <div style={{ fontSize: 13, fontWeight: 600 }}>{nodeData.label ?? id}</div>
      <div style={{ fontSize: 11, color: theme.palette.text.secondary, marginTop: 4 }}>{status}</div>
      <Handle type="source" position={Position.Right} id="output" />
    </div>
  );
}

export const nodeTypes = { prompt: PromptNodeView };
