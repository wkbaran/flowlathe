import { Handle, Position, type NodeProps } from "@xyflow/react";
import { NodeCard, type NodeStatus } from "./NodeCard.js";

export type { NodeStatus };

export interface PromptNodeData extends Record<string, unknown> {
  label?: string;
  template?: string;
  status?: NodeStatus;
}

export function PromptNodeView({ id, data }: NodeProps) {
  const nodeData = data as PromptNodeData;
  return (
    <NodeCard id={id} status={nodeData.status ?? "idle"} label={nodeData.label ?? id}>
      <Handle type="target" position={Position.Left} id="input" />
      <Handle type="source" position={Position.Right} id="output" />
    </NodeCard>
  );
}
