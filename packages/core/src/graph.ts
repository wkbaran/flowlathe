import { z } from "zod";
import { NODE_KINDS } from "./node-kind.js";

export const PositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const FlowNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(NODE_KINDS),
  position: PositionSchema,
  data: z.record(z.string(), z.unknown()),
  /** Loop/Map body membership: this node's activations are scoped under the named node. */
  parentId: z.string().min(1).optional(),
});

export const FlowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
});

export const FlowGraphSchema = z.object({
  nodes: z.array(FlowNodeSchema),
  edges: z.array(FlowEdgeSchema),
});

export type Position = z.infer<typeof PositionSchema>;
export type FlowNode = z.infer<typeof FlowNodeSchema>;
export type FlowEdge = z.infer<typeof FlowEdgeSchema>;
export type FlowGraph = z.infer<typeof FlowGraphSchema>;

export function emptyFlowGraph(): FlowGraph {
  return { nodes: [], edges: [] };
}

export function parseFlowGraph(value: unknown): FlowGraph {
  return FlowGraphSchema.parse(value);
}
