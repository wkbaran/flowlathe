import { nodeFailureEvent, type RuntimeHost } from "@flowlathe/core";
import type { RouterSpec } from "./schema.js";

export interface RouterResult {
  route: string;
  passthrough: string;
}

/**
 * A deterministic, rule-based router: compares `input` against declared cases and picks the
 * first matching route (falling back to `defaultRoute`). The chosen route's value is the
 * router's own input, echoed through — routing which branch runs is graph-structural (only
 * the edge whose sourceHandle matches the chosen route carries a value; the rest go `never`),
 * decided by the interpreter, not by this function.
 */
export async function runRouter(
  ctx: RuntimeHost,
  spec: RouterSpec,
  inputs: Record<string, string>,
): Promise<RouterResult> {
  ctx.emit({ kind: "node_started", nodeId: spec.id });
  const input = inputs["input"] ?? "";
  const match = spec.cases.find((c) => c.value === input);
  const route = match?.route ?? spec.defaultRoute;
  if (!route) {
    const err = new Error(`router "${spec.id}" has no matching case for input "${input}" and no defaultRoute`);
    ctx.emit(nodeFailureEvent(spec.id, err));
    throw err;
  }
  ctx.emit({
    kind: "node_finished",
    nodeId: spec.id,
    output: route,
    renderedPrompt: input,
    finishReason: "stop",
    latencyMs: 0,
  });
  return { route, passthrough: input };
}
