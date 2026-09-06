import { useTheme } from "@mui/material";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { NodeCard, statusColorOf, type NodeStatus } from "./NodeCard.js";

interface BaseData extends Record<string, unknown> {
  label?: string;
  status?: NodeStatus;
}

export function PauseNodeView({ id, data }: NodeProps) {
  const nodeData = data as BaseData;
  return (
    <NodeCard id={id} status={nodeData.status ?? "idle"} label={nodeData.label ?? id}>
      <Handle type="target" position={Position.Left} id="input" />
      <Handle type="source" position={Position.Right} id="output" />
    </NodeCard>
  );
}

export function UserInputNodeView({ id, data }: NodeProps) {
  const nodeData = data as BaseData;
  return (
    <NodeCard id={id} status={nodeData.status ?? "idle"} label={nodeData.label ?? id}>
      <Handle type="source" position={Position.Right} id="output" />
    </NodeCard>
  );
}

export function MergeNodeView({ id, data }: NodeProps) {
  const nodeData = data as BaseData;
  return (
    <NodeCard id={id} status={nodeData.status ?? "idle"} label={nodeData.label ?? id}>
      <Handle type="target" position={Position.Left} id="in1" style={{ top: "35%" }} />
      <Handle type="target" position={Position.Left} id="in2" style={{ top: "65%" }} />
      <Handle type="source" position={Position.Right} id="output" />
    </NodeCard>
  );
}

interface RouterData extends BaseData {
  routes?: string[];
}

export function RouterNodeView({ id, data }: NodeProps) {
  const nodeData = data as RouterData;
  const routes = nodeData.routes ?? [];
  return (
    <NodeCard id={id} status={nodeData.status ?? "idle"} label={nodeData.label ?? id}>
      <Handle type="target" position={Position.Left} id="input" />
      {routes.map((route, i) => (
        <Handle
          key={route}
          type="source"
          position={Position.Right}
          id={route}
          style={{ top: `${((i + 1) / (routes.length + 1)) * 100}%` }}
        />
      ))}
    </NodeCard>
  );
}

/**
 * Loop/Map: no handles of their own — their init/items templates are static literals, and their
 * body (one or more nodes linked via `parentId`, an arbitrary subgraph as of
 * PLAN-SUBGRAPH-BODIES.md) gets its per-iteration value injected synthetically. xyflow renders a
 * `parentId`-bearing node as a real subflow container sized by this node's own `style` (set in
 * Canvas.tsx, big enough to hold however many body nodes it has) — so this renders as a labeled,
 * dashed group box filling that space, rather than a small idle-looking rectangle, whenever it
 * actually has children. A childless Loop/Map (default `style`, no dimensions set) just renders
 * at its natural small size with the same look.
 */
function ContainerNodeView(props: { id: string; data: BaseData; kind: "Loop" | "Map" }) {
  const theme = useTheme();
  const status = props.data.status ?? "idle";
  const statusColor = statusColorOf(theme, status);
  return (
    <div
      data-testid={`node-${props.id}`}
      data-status={status}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minWidth: 140,
        minHeight: 56,
        boxSizing: "border-box",
        border: `2px dashed ${statusColor}`,
        borderRadius: 8,
        background: theme.palette.action.hover,
      }}
    >
      <div style={{ padding: "4px 8px", fontSize: 12, fontWeight: 600, color: theme.palette.text.primary }}>
        {props.kind}: {props.data.label ?? props.id}
      </div>
      <div style={{ padding: "0 8px", fontSize: 11, color: theme.palette.text.secondary }}>{status}</div>
    </div>
  );
}

export function LoopNodeView({ id, data }: NodeProps) {
  return <ContainerNodeView id={id} data={data as BaseData} kind="Loop" />;
}

export function MapNodeView({ id, data }: NodeProps) {
  return <ContainerNodeView id={id} data={data as BaseData} kind="Map" />;
}

export function GateNodeView({ id, data }: NodeProps) {
  const nodeData = data as BaseData;
  return (
    <NodeCard id={id} status={nodeData.status ?? "idle"} label={nodeData.label ?? id} shape="diamond">
      <Handle type="target" position={Position.Left} id="input" />
      <Handle type="source" position={Position.Right} id="output" />
    </NodeCard>
  );
}
