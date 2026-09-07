import type { FlowGraph } from "@flowlathe/core";

/**
 * `parse`/`print` in PLAN-FLOW-DSL.md §3.1 are described as `string <-> FlowGraph`, but the
 * surface syntax's `flow "name" { ... }` header carries a display name that `FlowGraph` itself
 * has no field for (adding one would mean every non-DSL caller of `FlowGraphSchema` — the
 * canvas, the interpreter, the compiler — has to carry it too, for a value only the DSL and the
 * file store need). `FlowFile` is the DSL package's own wrapper carrying exactly that one extra
 * piece of metadata, plus the leading-comment side-channel from §3.5.
 */
export interface FlowFile {
  name: string;
  graph: FlowGraph;
  /** Comments attached to the line immediately above a node/state/edge declaration, keyed by
   *  "node:<id>" | "state:<name>" | "edge:<canonicalEdgeId>". Anything else (free-floating
   *  comments, blank-line grouping) is dropped on parse — see PLAN-FLOW-DSL.md §3.5. */
  comments: Record<string, string>;
}
