import { Handle, Position, type NodeProps } from "@xyflow/react";
import { NodeCard, type NodeStatus } from "./NodeCard.js";

export interface TriggerNodeData extends Record<string, unknown> {
  label?: string;
  status?: NodeStatus;
}

const OUTPUT_PORTS = ["content", "authorId", "channelId", "messageId"];

/** No target handles — a trigger has zero input ports by design (PLAN-INTEGRATIONS.md §7.1),
 *  same shape as `userInput`. Its four fixed output ports get one source handle each, stacked
 *  down the right edge like `RouterNodeView`'s dynamic route handles. */
export function TriggerNodeView({ id, data }: NodeProps) {
  const nodeData = data as TriggerNodeData;
  return (
    <NodeCard id={id} status={nodeData.status ?? "idle"} label={nodeData.label ?? id}>
      {OUTPUT_PORTS.map((port, i) => (
        <Handle
          key={port}
          type="source"
          position={Position.Right}
          id={port}
          style={{ top: `${((i + 1) / (OUTPUT_PORTS.length + 1)) * 100}%` }}
        />
      ))}
    </NodeCard>
  );
}
