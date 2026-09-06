import { Handle, Position, type NodeProps } from "@xyflow/react";
import { NodeCard, type NodeStatus } from "./NodeCard.js";

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

/** Loop/Map: no handles of their own in v1 — their init/items templates are static literals, and
 *  their body node (parentId-linked) gets its per-iteration value injected synthetically. */
export function LoopNodeView({ id, data }: NodeProps) {
  const nodeData = data as BaseData;
  return <NodeCard id={id} status={nodeData.status ?? "idle"} label={nodeData.label ?? id} />;
}

export function MapNodeView({ id, data }: NodeProps) {
  const nodeData = data as BaseData;
  return <NodeCard id={id} status={nodeData.status ?? "idle"} label={nodeData.label ?? id} />;
}

interface ContextTransformData extends BaseData {
  startsNewContext?: boolean;
}

export function ContextTransformNodeView({ id, data }: NodeProps) {
  const nodeData = data as ContextTransformData;
  return (
    <NodeCard id={id} status={nodeData.status ?? "idle"} label={nodeData.label ?? id}>
      {!nodeData.startsNewContext && <Handle type="target" position={Position.Left} id="context" />}
      <Handle type="source" position={Position.Right} id="output" style={{ top: "35%" }} />
      <Handle type="source" position={Position.Right} id="context" style={{ top: "65%" }} />
    </NodeCard>
  );
}
