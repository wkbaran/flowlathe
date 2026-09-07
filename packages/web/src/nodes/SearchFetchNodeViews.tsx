import { extractTemplateVars } from "@flowlathe/core";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { NodeCard, type NodeStatus } from "./NodeCard.js";

export interface SearchNodeData extends Record<string, unknown> {
  label?: string;
  queryTemplate?: string;
  status?: NodeStatus;
}

export interface FetchNodeData extends Record<string, unknown> {
  label?: string;
  urlTemplate?: string;
  status?: NodeStatus;
}

/** Lays out one target handle per `{{var}}` extracted from `template`, stacked down the left
 *  edge — unlike `PromptNodeView`'s hardcoded single `id="input"` handle (a known footgun, see
 *  CLAUDE.md), a new node view with no legacy fixtures to preserve renders a real handle per
 *  variable, matching what the interpreter/compiler actually bind by (`extractTemplateVars`). */
function VariableHandles({ template }: { template: string }) {
  const vars = extractTemplateVars(template);
  return (
    <>
      {vars.map((name, i) => (
        <Handle
          key={name}
          type="target"
          position={Position.Left}
          id={name}
          style={{ top: `${((i + 1) / (vars.length + 1)) * 100}%` }}
        />
      ))}
    </>
  );
}

export function SearchNodeView({ id, data }: NodeProps) {
  const nodeData = data as SearchNodeData;
  return (
    <NodeCard id={id} status={nodeData.status ?? "idle"} label={nodeData.label ?? id}>
      <VariableHandles template={nodeData.queryTemplate ?? ""} />
      <Handle type="source" position={Position.Right} id="results" />
    </NodeCard>
  );
}

export function FetchNodeView({ id, data }: NodeProps) {
  const nodeData = data as FetchNodeData;
  return (
    <NodeCard id={id} status={nodeData.status ?? "idle"} label={nodeData.label ?? id}>
      <VariableHandles template={nodeData.urlTemplate ?? ""} />
      <Handle type="source" position={Position.Right} id="content" />
    </NodeCard>
  );
}
