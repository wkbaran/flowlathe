import { validateGraph, type FlowGraph, type FlowNode } from "@flowlathe/core";
import { registry } from "@flowlathe/interpreter";

/** Same rationale/shape as `packages/server/src/routes/flows.ts`'s own `portsOf` helper: a
 *  node's declared input ports depend on its (validated, defaulted) data, e.g. a Prompt's ports
 *  come from `extractTemplateVars(template)`. */
export function portsOf(node: FlowNode): string[] {
  const data = registry[node.type].schema.parse(node.data) as Record<string, unknown>;
  return registry[node.type].inputPorts({ id: node.id, ...data }).map((p) => p.name);
}

export interface CheckProblem {
  message: string;
  nodeId?: string;
}

/** Parse-level structure is already guaranteed by `@flowlathe/dsl`'s `parse` (it always produces
 *  a `FlowGraphSchema`-shaped value); this is the *semantic* layer `flowlathe check` adds on top
 *  — per-kind schema validation (a node's `data` against its own zod schema) and `validateGraph`
 *  (regions, cycles, ports) — the same two passes the canvas and interpreter both rely on. */
export function checkGraph(graph: FlowGraph): CheckProblem[] {
  const problems: CheckProblem[] = [];
  for (const node of graph.nodes) {
    const result = registry[node.type].schema.safeParse(node.data);
    if (!result.success) {
      problems.push({ nodeId: node.id, message: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    }
  }
  if (problems.length > 0) return problems; // per-kind schema errors first — validateGraph's portsOf assumes valid data
  for (const message of validateGraph(graph, { portsOf })) {
    problems.push({ message });
  }
  return problems;
}
