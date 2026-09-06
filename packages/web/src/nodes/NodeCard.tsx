import { useTheme, type Theme } from "@mui/material";
import type { ReactNode } from "react";

export type NodeStatus = "idle" | "running" | "done" | "failed" | "skipped" | "suspended";

export function statusColorOf(theme: Theme, status: NodeStatus): string {
  return {
    idle: theme.palette.text.disabled,
    running: theme.palette.info.main,
    done: theme.palette.success.main,
    failed: theme.palette.error.main,
    skipped: theme.palette.text.disabled,
    suspended: theme.palette.warning.main,
  }[status];
}

export function NodeCard(props: { id: string; status: NodeStatus; label: string; children?: ReactNode }) {
  const theme = useTheme();
  const statusColor = statusColorOf(theme, props.status);
  return (
    <div
      data-testid={`node-${props.id}`}
      data-status={props.status}
      style={{
        position: "relative",
        border: `2px solid ${statusColor}`,
        borderRadius: 8,
        padding: "8px 12px",
        background: theme.palette.background.paper,
        color: theme.palette.text.primary,
        minWidth: 140,
        boxShadow: props.status === "running" ? `0 0 8px ${statusColor}` : undefined,
      }}
    >
      {props.children}
      <div style={{ fontSize: 13, fontWeight: 600 }}>{props.label}</div>
      <div style={{ fontSize: 11, color: theme.palette.text.secondary, marginTop: 4 }}>{props.status}</div>
    </div>
  );
}
