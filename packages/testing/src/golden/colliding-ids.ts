import type { FlowGraph } from "@flowlathe/core";
import { mockResponseKey } from "@flowlathe/providers";

const promptData = (template: string) => ({ template, providerId: "mock", modelId: "m" });

/**
 * A top-level prompt node "x_y" and a Map-body prompt node "x-y" whose sanitized generated names
 * both collide onto "n_x_y" (`nodeId.replace(/[^a-zA-Z0-9_]/g, "_")` maps both to "x_y") — see
 * PLAN-COMPILER-VARNAME.md §1.2(c), the silent failure shape. No edge connects the two nodes; the
 * collision is purely in generated identifiers, not graph structure, which is exactly what let it
 * slip past every earlier fixture. Before the fix, the compiled script's global spec table `N`
 * had a duplicate object-literal key for "n_x_y" — legal JS, last-wins — so the body node ran
 * with the top-level node's spec/template ("TOP") instead of its own ("BODY {{item}}"), rendering
 * the wrong prompt while still exiting 0 with no warning.
 */
export const collidingIdsGraph: FlowGraph = {
  // Order matters for reproducing the pre-fix failure as a SILENT trace mismatch rather than a
  // crash: the global spec table's duplicate "n_x_y" key resolves to whichever node.data was
  // written last, JS object-literal semantics. With "x_y" (the unconstrained "TOP" template)
  // declared last, BOTH the top-level node and the map body's node silently run with "TOP" (the
  // body's own {{item}}-requiring template is shadowed entirely) — both render fine, no crash,
  // just the wrong prompt for the body node. Declaring them in the other order instead makes the
  // body's template win globally, which crashes the top-level call with a missing-template-var
  // error the moment it's compiled with no `item` binding — a real, but differently-shaped, pre-
  // fix failure than the one this fixture is pinning (see PLAN-COMPILER-VARNAME.md §4.3(a)).
  nodes: [
    {
      id: "m",
      type: "map",
      position: { x: 1, y: 0 },
      data: { itemsTemplate: '["x"]', itemPortName: "item", maxConcurrency: 1, maxItems: 10 },
    },
    { id: "x-y", type: "prompt", position: { x: 2, y: 0 }, data: promptData("BODY {{item}}"), parentId: "m" },
    { id: "x_y", type: "prompt", position: { x: 0, y: 0 }, data: promptData("TOP") },
  ],
  edges: [],
  state: [],
};

export const collidingIdsResponses = new Map([
  [mockResponseKey("x_y", "TOP"), "TOP_RESULT"],
  // Correct (post-fix / interpreter-always) rendering: the body gets its OWN template.
  [mockResponseKey("x-y@m:0", "BODY x"), "BODY_RESULT"],
  // Wrong (pre-fix compiled-script) rendering: the body silently ran with the top-level node's
  // spec instead of its own, so it rendered "TOP" too. Registered so the pre-fix compiled script
  // fails as a genuine trace MISMATCH (renderedPrompt "TOP" where the interpreter's is "BODY x"),
  // not as a MockProviderAdapter "no response registered" crash — see this file's graph comment.
  [mockResponseKey("x-y@m:0", "TOP"), "WRONG_TOP_RESULT"],
]);
