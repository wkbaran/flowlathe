# Implementation plan — multi-node (subgraph) Loop/Map bodies

**Status:** implemented — see the Definition of Done checklist at the bottom of this file.
**Read first:** `PLAN.md` (architecture source of truth) and `CLAUDE.md` (surprises log). This
document assumes both.

---

## 1. The problem

A Loop or Map node repeats a **body** once per iteration. Today the body can only be a **single
node** (of any kind). You cannot wire a chain or a branch of several nodes and say "repeat all of
this together each iteration."

This is not a deliberate design constraint — it is an unimplemented case:

- `packages/interpreter/src/run-graph.ts:49,58-61` — `bodyByParent: Map<string, FlowNode>`.
  A second node with the same `parentId` **silently overwrites** the first. Not an error.
- `packages/compiler/src/compile-graph.ts:47-50` — identical single-value map, identical silent
  overwrite.
- `packages/core/src/graph.ts:16` — `parentId: z.string().min(1).optional()`. The schema places
  **no** restriction on how many nodes share a `parentId`. Nothing in the data model forbids this.

Both runtimes also drop every edge that touches a body node:

- interpreter `run-graph.ts:65` — `if (!this.nodesById.has(edge.target)) continue;`
- compiler `compile-graph.ts:52-57` — `outerGraph.edges` keeps only outer→outer edges.

So even if you drew a body-internal edge today, it would be ignored.

The current README entry to be removed at the end of this work: `README.md:121-133`
("Known v1 limitations").

---

## 2. Current behavior, precisely

### Interpreter (`GraphEngine.dispatchLoopOrMap`, `run-graph.ts:235-270`)

```ts
const bodyNode = this.bodyByParent.get(node.id);        // single node
const runBody = async (injected, index) => {
  const key = activationKey(bodyNode.id, [{ loop: node.id, index }]);   // "body@m:0"
  const bodySpec = { id: key, contextNodeId: bodyNode.id, ...bodyData };
  const result = await bodyDescriptor.dispatch!(this.run, bodySpec, injected);
  return firstOutputValue(bodyNode.type, bodySpec, result);
};
```

`injected` is the *entire* inputs object: `{ [accPortName]: acc }` for Loop,
`{ [itemPortName]: item }` for Map. The body node's readiness is never evaluated; any other port
it declares simply isn't passed.

### Compiler (`emitLoopOrMap`, `compile-graph.ts:317-353`)

```ts
const bodyBindings = bodyPorts
  .map((port) => (port === injectedPort ? `${port}: ${"acc"|"item"}` : `${port}: ""`))
  .join(", ");
```

Non-injected ports get `""`. **This already diverges from the interpreter** (which passes nothing
at all) for any body node declaring a second port — untested territory today, and a parity bug
waiting to happen. Section 4.4 closes it.

The scoped id is hand-built as a template literal that mirrors `activationKey`:
`` `${bodyNode.id}@${node.id}:${i}` `` (`compile-graph.ts:348`). CLAUDE.md already flags this
duplication as a manual-parity risk; this work extends the format, so both sides must move
together.

### Canvas (`packages/web/src/pages/Canvas.tsx:989-1005`)

A `Select` labeled `Parent (Loop/Map body of)` sets `node.parentId`. It is per-node and already
lets you point **many** nodes at the same Loop/Map — the UI does not enforce single-node bodies
either. What's missing is (a) any visual grouping, (b) any guard rails, (c) engines that honor it.

`LoopNodeView` / `MapNodeView` (`packages/web/src/nodes/ControlFlowNodeViews.tsx:64-72`) render a
plain `NodeCard` with no handles and no container styling.

---

## 3. Design

### 3.1 Core concept: a **region**

Generalize "the body is a node" to "the body is a region": the set of nodes sharing a `parentId`,
plus the edges whose *both* endpoints are in that set.

- **Top-level region**: `parentId === undefined`. What both runtimes walk today.
- **Body region for loop/map node `L`**: `{ n | n.parentId === L.id }`.

Each region is an independent DAG with its own topological order, its own router-scope analysis,
and (in the compiler) its own `let`-hoisting pass. The top level and every body are then *the same
kind of thing*, walked by the same code. This is the whole plan in one sentence: **make both
runtimes region-recursive instead of special-casing "the body node."**

### 3.2 Region entry and exit — inferred, not declared

No new schema fields on `LoopNodeData`/`MapNodeData`. Both ends are inferred:

- **Entry (where the per-iteration value is injected).** Every body node that declares an input
  port named exactly `accPortName` (Loop) / `itemPortName` (Map) **and** has no in-region incoming
  edge on that port receives the injected value on that port. Zero or more than one such node is
  fine (a fan-out body is legal); **zero** is an error.
- **Terminal (what the iteration returns).** The unique body node with no outgoing in-region edge.
  Its value is taken via the existing `firstOutputValue` helper (`run-graph.ts:273`).
  - 0 terminals → cycle → error.
  - \>1 terminals → error naming them, with the suggested fix ("join them with a Merge node").

**Why inferred:** it makes today's single-node body a degenerate case that falls out for free
(one node, no in-region edges, so it is both the entry and the terminal), it needs no schema
migration for existing saved flows, and it avoids adding two node-id fields the canvas would then
have to keep referentially correct across node deletion.

**Cost, and accept it:** a body that legitimately fans out to two dead-end leaves must add a Merge.
That is a clear, actionable error, and the interpreter's `Merge` already exists for exactly this.

### 3.3 Body boundary is closed (v1)

An edge with exactly one endpoint inside a body region is a **hard validation error**, in both
directions:

- **body → outer**: not representable. The body runs N times; an outer node consuming it would
  need to run N times too. Genuinely out of scope.
- **outer → body** ("loop-invariant input"): representable and useful, but **deliberately cut from
  this slice** — it requires lifting the dependency onto the owning Loop/Map node in *three*
  places (interpreter `isReady` + `computeTopoRank`, compiler `topoLevels`), each with its own
  ordering subtleties. Today such an edge is *silently ignored* by both runtimes; turning it into
  an explicit error is strictly better and leaves the door open.

The escape hatch that already exists and should be mentioned in the error message: **flow State**.
A body node can `read_state` a value an outer node wrote. That covers most of what an outer→body
edge would be used for.

### 3.4 Nesting is supported

A body node may itself be a Loop or Map with its own body region. This falls out of the recursive
design and is worth having ("refine each document until good enough" = a Loop inside a Map body).

The scope path grows, and `activationKey` (`packages/core/src/activation.ts:10-13`) **already**
handles arbitrary depth:

```ts
activationKey("summarize", [{loop:"m",index:2},{loop:"l",index:0}])  // "summarize@m:2/l:0"
```

The compiler must produce byte-identical keys (see 4.4 and the mandatory unit test in 6.2).

### 3.5 Every declared port needs a real edge (uniformly)

CLAUDE.md already states this rule for the top level:

> Every port a node declares via `inputPorts()` must have a real incoming edge, always.

Extend it verbatim to body regions, with the injected port as the single exception. Concretely:
**remove the compiler's `port: ""` fallback** (`compile-graph.ts:331`) and make it a validation
error instead. This kills the existing interpreter/compiler divergence described in section 2 and
keeps one rule in the reader's head instead of two.

---

## 4. Implementation

Work in this order. Each phase leaves the tree green (`pnpm -w turbo typecheck test`).

### Phase 0 — `@flowlathe/core`: the shared primitive

**New file: `packages/core/src/regions.ts`.** Follow the exact shape of
`packages/core/src/plugin-deps.ts` (`requiredToolsets` / `findMissingToolsets`) — that file is the
established precedent for "one primitive, consumed by UI + interpreter + compiler + server
routes," and CLAUDE.md documents it as the intended pattern.

```ts
import type { FlowGraph, FlowNode } from "./graph.js";

export interface Region {
  /** undefined for the top-level region. */
  ownerId: string | undefined;
  nodeIds: string[];
  /** Edge ids whose source AND target are both in this region. */
  edgeIds: string[];
}

/** Every region in the graph, keyed by ownerId ("" for the top level). */
export function regions(graph: FlowGraph): Map<string, Region>;

/** Body nodes with no outgoing in-region edge. Exactly one is required at run time. */
export function terminalNodeIds(graph: FlowGraph, ownerId: string): string[];

export interface ValidationOptions {
  /** Declared input port names for a node. Omit to skip the port-level rules (R6, R7). */
  portsOf?: (node: FlowNode) => string[];
}

/** Human-readable problems, empty when the graph is runnable. Order is stable. */
export function validateGraph(graph: FlowGraph, opts?: ValidationOptions): string[];
```

Rules, in this order:

| # | Rule | Needs `portsOf`? |
|---|------|------------------|
| R1 | every `parentId` names an existing node | no |
| R2 | a `parentId` target must be of kind `loop` or `map` | no |
| R3 | every loop/map node has ≥1 body node | no |
| R4 | no edge crosses a body boundary (either direction) — message names the edge and points at flow State as the workaround for the outer→body case | no |
| R5 | each region is acyclic, and has exactly one terminal node | no |
| R6 | each body region has ≥1 entry node declaring the injected port (`accPortName` / `itemPortName`) | **yes** |
| R7 | every declared input port of every node has an incoming in-region edge, except a body entry node's injected port | **yes** |

`portsOf` is a parameter, not a core dependency, because `@flowlathe/core` must stay isomorphic
and has no node-kind registry — port declarations live in `packages/nodes/*` (compiler side) and
`packages/interpreter/src/registry.ts` (interpreter side). Callers supply their own:

- `Canvas.tsx` omits it → gets R1–R5, which are exactly the mistakes a user makes by *drawing*.
- interpreter passes `(n) => registry[n.type].inputPorts(spec).map(p => p.name)`.
- compiler passes `(n) => emitTable[n.type].inputPorts(parsedData)`.

Export from `packages/core/src/index.ts`.

**Tests:** `packages/core/src/regions.test.ts` — one case per rule, plus the happy paths
(single-node body still valid; nested regions; a router+merge body).

### Phase 1 — interpreter

`packages/interpreter/src/run-graph.ts`.

**Constructor becomes region-scoped.** Replace `bodyByParent` entirely.

```ts
export interface EngineOptions {
  /** Which region this engine walks. undefined = top level. */
  ownerId?: string | undefined;
  /** Enclosing Loop/Map iterations, for activation keys. */
  scopePath?: ScopePath;
  /** The per-iteration value injected into this region's entry ports. */
  injected?: { port: string; value: string } | undefined;
  initialOutputs?: Map<string, Record<string, PortSlot>>;
}

constructor(graph: FlowGraph, run: Run, opts: EngineOptions = {}) {
  this.nodesById = new Map(
    graph.nodes.filter((n) => (n.parentId ?? undefined) === opts.ownerId).map((n) => [n.id, n]),
  );
  // edges: keep only those with BOTH endpoints in this region
  ...
}
```

Changes, one by one:

1. **`parseSpec` becomes scope-aware.** Today `{ id: node.id, ...data }`. Now:
   ```ts
   const id = activationKey(node.id, this.scopePath);
   return this.scopePath.length === 0
     ? { id, ...data }
     : { id, contextNodeId: node.id, ...data };
   ```
   This generalizes the `contextNodeId` handling that today is hardcoded for the single body node
   (`run-graph.ts:256`). CLAUDE.md explains why it must stay the *unscoped* id: a Loop/Map body's
   conversation memory would reset every iteration otherwise.

   ⚠️ `contextNodeId` is a `PromptSpec` field but is set unconditionally today for whatever kind
   the body node is; keep that (harmless extra property — specs are built after `schema.parse`,
   so nothing strips it).

2. **`portSlot` honors injection.** When a port has no in-region edge and its name matches
   `this.injected?.port`, return `valueSlot(this.injected.value)` instead of `{ kind: "empty" }`.

3. **`dispatchLoopOrMap` spawns a sub-engine per iteration:**
   ```ts
   const runBody = async (port: string, value: string, index: number): Promise<string> => {
     const sub = new GraphEngine(this.graph, this.run, {
       ownerId: node.id,
       scopePath: [...this.scopePath, { loop: node.id, index }],
       injected: { port, value },
     });
     await sub.runToCompletion();
     return sub.regionResult();
   };
   ```
   `regionResult()` = terminal node's first non-absent output, via the existing `firstOutputValue`.
   If the terminal node's outputs are all `never` (it sat on an untaken router branch), throw a
   clear error: `"loop body's terminal node \"x\" was skipped — every path through the body must
   reach it"`. The compiler must emit an equivalent throw (4.3) or parity breaks.

   Nesting is now free: the sub-engine's own `dispatchLoopOrMap` recurses with a longer
   `scopePath`.

4. **Validation, once, at the top.** In the constructor, gate on `opts.ownerId === undefined` so
   sub-engines don't repeat it (same guard for the existing `missingToolsets` check at
   `run-graph.ts:84-89`, which currently runs on every `GraphEngine.restore`):
   ```ts
   if (opts.ownerId === undefined) {
     const problems = validateGraph(graph, { portsOf });
     if (problems.length) throw new Error(`invalid flow graph: ${problems.join("; ")}`);
     // ...existing missingToolsets check...
   }
   ```
   Keep the toolset check where it is (it must still re-run on every step-mode restore — see
   CLAUDE.md). Graph validation re-running per restore is also fine and desirable for the same
   reason: an edit mid-debug-session gets caught on the next step.

5. **`this.graph`** must now be retained as a field (sub-engines need it).

**What does not change:** `EngineSnapshot` / step mode. Sub-engines are created and discarded
inside one `dispatchNode` call, so "a whole Loop/Map is one step" stays true and no snapshot
format change is needed. Do not try to make body nodes individually steppable in this slice.

**Tests** (`packages/interpreter/src/run-graph.test.ts`, follow the existing `node()` helper):

- map with a 2-node chain body (`a → b`), asserting per-iteration scoped keys `a@m:0`, `b@m:0`, …
- loop with a router+merge body (branch pruning works *inside* an iteration)
- map-of-loop nesting, asserting a `x@m:1/l:0`-shaped key
- each of R3/R4/R5/R6/R7 produces its error before any node dispatches
- the existing single-node body tests must pass **unchanged** (regression guard on the degenerate
  case)

### Phase 2 — compiler

`packages/compiler/src/compile-graph.ts`.

**Extract a region emitter.** Today `compileGraph` inlines the top-level walk (lines 52-87) and
`emitSequential`/`emitScope` assume one region. Refactor to:

```ts
interface RegionCtx {
  nodeIds: string[];                                  // this region's nodes, topo-ordered
  incoming: Map<string, Map<string, IncomingEdge>>;   // in-region edges only
  routerBranches: Map<string, RouterBranch[]>;
  injected?: { port: string; expr: string } | undefined;  // e.g. { port: "item", expr: "item" }
  loopStack: Array<{ loopId: string; indexVar: string }>;
  indent: string;
}

function emitRegion(ctx: RegionCtx, shared: EmitCtx): string[];
```

`emitRegion` does, per region, what `compileGraph` + `emitSequential` do today: `topoLevels` →
`computeScopes` → hoist `let`s → `emitScope`. The `hasControlFlow` fast path (`Promise.all` levels)
should be decided **per region**, so a fan-out body still compiles to a `Promise.all`.

`emitLoopOrMap` then becomes:

```ts
const n_L = await rt.loop(N.n_L, { ...ownBindings }, async (acc, i) => {
  <emitRegion(bodyRegion, indent + "  ")>
  return <terminalAccessor>;
});
```

Four things to get right:

1. **`let` hoisting must happen *inside* the arrow function.** `emitSequential` currently hoists
   every conditionally-scoped node's `let` in one flat pass at the top of `main()`
   (`compile-graph.ts:266-272`). For a body region the hoist must be the first lines inside the
   arrow body — otherwise a body node's variable persists across iterations and a router branch
   not taken on iteration 2 silently reads iteration 1's value. This is the single most likely
   correctness bug in this phase; write the test for it (6.1).

2. **Injected port binding.** `callExpr` (`compile-graph.ts:355`) resolves each port to an incoming
   edge and throws if there is none. Give it the region's `injected` so a port with no in-region
   edge whose name matches binds to `acc` / `item`. **Delete the `port: ""` fallback** at
   `compile-graph.ts:331` (see 3.5) — an unbound, non-injected port is now a compile-time throw,
   matching `validateGraph`'s R7.

3. **Terminal return, guarded.** If the terminal node is conditionally scoped it was `let`-hoisted
   and may be `undefined`:
   ```ts
   if (n_term === undefined) throw new Error('loop body\'s terminal node "term" was skipped ...');
   return n_term.output;
   ```
   Message must match the interpreter's (Phase 1, item 3) closely enough that a parity trace of a
   *failing* run agrees. Use `accessorExpr` for the value expression so Loop/Map/Router terminals
   are read correctly.

4. **Scoped id for arbitrary depth.** Replace the hardcoded
   `` "`" + bodyNode.id + "@" + node.id + ":${i}`" `` (`compile-graph.ts:348`) with a helper built
   from `loopStack`, mirroring `activationKey`'s `@` + `/`-joined format:
   ```ts
   function scopedIdExpr(nodeId: string, loopStack: Array<{loopId: string; indexVar: string}>): string {
     if (loopStack.length === 0) return JSON.stringify(nodeId);
     const parts = loopStack.map((f) => `${f.loopId}:\${${f.indexVar}}`).join("/");
     return "`" + nodeId + "@" + parts + "`";
   }
   ```
   **Index variable naming:** keep `i` at depth 0 (avoids churning
   `compile-graph-control-flow.test.ts:63`, which asserts `async (item, i) => {`); use `i1`, `i2`,
   … at deeper levels.

**Validation.** `compileGraph` should call `validateGraph(graph, { portsOf })` up front and throw,
same as the interpreter, so an invalid graph fails at export rather than producing a script that
crashes.

**Tests** (`packages/compiler/src/compile-graph-control-flow.test.ts`): assert the emitted source
for a 2-node body, for a router-in-body (`let` inside the arrow), and for a nested loop's scoped
id. Existing map assertions at lines 61-70 must still pass.

### Phase 3 — parity fixtures (the important part)

This project's core discipline is that the interpreter and the compiled script produce identical
normalized traces. CLAUDE.md records two separate incidents where a hand-mirrored convention drifted.
Three new golden fixtures in `packages/testing/src/golden/`, each wired into
`packages/testing/src/parity.test.ts` following the existing pattern:

| fixture | shape | what it pins |
|---|---|---|
| `map-multinode-body.ts` | Map over 3 items, body = `a → b` prompt chain | the basic feature; per-iteration scoped keys for **both** body nodes |
| `loop-router-body.ts` | Loop whose body is `router → {x, y} → merge` | per-region scope analysis + `let` hoisting inside the arrow function |
| `nested-map-in-loop.ts` | Loop whose body node is a Map with its own body | the `/`-joined multi-level activation key format |

Mock response tables key on `mockResponseKey(scopedNodeId, renderedPrompt)`
(`packages/providers/src/mock.ts:4`) — e.g. `mockResponseKey("a@m:0", "got: x")`. A key format
mismatch between the two runtimes surfaces as `MissingMockResponse`, which is exactly the
"regression shows up as a missing key, not a different answer" property PLAN.md asks for.

**Before keeping each fixture, verify it actually fails against the pre-change compiler** — the
same discipline applied to `router-deep-branch.ts` (see CLAUDE.md). A fixture that passes vacuously
pins nothing.

### Phase 4 — server routes

`packages/server/src/routes/flows.ts`. `/run` and `/step-start` already hard-gate on missing plugin
toolsets with a 409 before calling `runFlow`/`startStepExecution`. Add the graph-validation gate in
the same place, same shape (409 + a `problems: string[]` body). Rationale is identical to the
plugin case (CLAUDE.md): the interpreter's throw alone would still create an execution row that
immediately flips to `failed`, rather than refusing the request outright.

### Phase 5 — canvas

`packages/web/src/pages/Canvas.tsx`, `packages/web/src/nodes/ControlFlowNodeViews.tsx`.

The `Parent (Loop/Map body of)` select (`Canvas.tsx:989-1005`) already supports assigning several
nodes to one parent, and `onConnect` already allows body-internal edges. So the feature is
*drawable* the moment the engines land. What's missing is legibility and guard rails.

1. **Visual grouping.** ⚠️ **Verify this first:** `nodes` are handed to `<ReactFlow>` essentially
   raw (`Canvas.tsx:393,484`), and xyflow 12 interprets `Node.parentId` as **subflow containment**
   — including treating a child's `position` as **parent-relative**. Establish empirically what
   xyflow currently does with a `parentId`-tagged node before designing around it; the answer
   changes the work substantially:
   - If xyflow already nests them, Loop/Map need real container styling (explicit
     `style: { width, height }`, a header label, `NodeCard` rendering as a group box) and
     `addNode()` (`Canvas.tsx:197-210`) must place a body node using parent-relative coordinates.
   - If it does not, the cheapest legible option is a dashed group outline drawn behind the
     children plus a `parentId` badge on each body node.

   Either way, add `extent: "parent"` on body nodes so dragging one out of the box isn't silently
   meaningless.

2. **Validation banner.** Reuse the exact pattern of the existing workflow-dependency `Alert`
   (`Canvas.tsx:410-419, 463-468`): compute `validateGraph({nodes, edges, state})` from **live**
   node state (not the saved graph, so it reacts before Save — safe because `handleRun`/`handleStep`
   both call `handleSave()` first), render one workflow-level Alert, and disable Run / Start
   Stepping. Give it `data-testid="workflow-validation-alert"`. **Workflow-level, not per-node** —
   memory records this as a settled preference.

3. **Body-node status lighting.** `nodeStatus` is keyed by raw node id (`Canvas.tsx:265-273`), but
   body activations emit scoped ids (`node-2@node-1:0`). Today a body node therefore never lights
   up. With multi-node bodies that's a real usability hole. Fix: key `nodeStatus` on
   `nodeId.split("@")[0]`. Keep the raw scoped id in the log text (`describeEvent`), which the
   slice-3 e2e spec asserts on (`playwright/tests/slice3-map-fanout.spec.ts:41`).

4. Update the `Parent (Loop/Map body of)` select's empty-option label — "(top-level — not a
   loop/map body)" is still accurate, no change needed, but the menu items should not exclude
   loop/map nodes that already have children.

### Phase 6 — e2e + docs

**`playwright/tests/slice7-multinode-loop-body.spec.ts`** — PLAN.md's verification section requires
a spec per slice; the MCP slice skipped it and CLAUDE.md records that as a real gap. Don't repeat it.

Model it on `slice3-map-fanout.spec.ts`. Build a Map with a **two-node** body in the UI, wire the
body edge, run, and assert: both body nodes produce scoped activations per item, the map joins in
input order, and the run finishes. Heed the recorded Playwright gotchas:

- click **Fit View** before wiring nodes that were just added — default spacing
  (`x: 80 + ns.length * 260`) can push a third node outside the viewport and silently drop a drag
  gesture (CLAUDE.md).
- use `pressSequentially()` for MUI numeric fields, not `.fill()`.
- run from the repo root: `node_modules/.bin/playwright test --config=playwright/playwright.config.ts`
  (the root `e2e` script). **Never** `cd playwright && pnpm exec playwright test`.
- a `PromptNode`'s only target handle is hardcoded `id="input"`, so every body-internal prompt edge
  must use `{{input}}` as its template variable (CLAUDE.md).

**Docs:**

- `README.md:121-133` — delete the "Loop/Map bodies are a single node" limitation; replace with a
  short description of subgraph bodies and the two remaining restrictions (closed boundary;
  one terminal per body).
- `CLAUDE.md` — add a bullet in the established style covering: the region model; inferred
  entry/terminal and why not declared fields; the closed body boundary and that flow State is the
  intended workaround for loop-invariant input; the `let`-must-hoist-inside-the-arrow trap; the
  now-`/`-joined scoped key format and that `compile-graph.ts` still mirrors `activationKey` by
  hand; and whatever xyflow parent-relative-position surprise Phase 5 turns up.
- `PLAN.md` needs no change — its scope-tree codegen description (lines 338-343) already describes
  the design being implemented here; this work makes the code match the plan.

---

## 5. Risks and traps

| Risk | Mitigation |
|---|---|
| Interpreter/compiler activation-key drift (has happened twice, per CLAUDE.md) | `nested-map-in-loop` golden fixture + the direct unit test in 6.2 |
| Body `let`s hoisted outside the arrow function → state leaks across iterations | `loop-router-body` golden fixture; assert on emitted source in the compiler unit test |
| xyflow's parent-relative coordinates silently relocating existing saved flows' body nodes | Verify xyflow's current handling **before** writing Phase 5; if positions change meaning, decide explicitly whether existing graphs need a migration |
| `contextNodeId` regression resetting a body prompt's memory each iteration | Existing behavior must be preserved by `parseSpec`; add an interpreter test asserting a repeated body node accumulates context across iterations |
| Removing the compiler's `port: ""` fallback breaks a saved flow | It only fires for a body node with a second declared port — impossible to have run correctly before. The new error is better than the old silent `""`. |

---

## 6. Two tests worth calling out specifically

**6.1 — hoisting inside the arrow.** A compiler unit test asserting the emitted source has the
body's `let` declarations *after* the `async (item, i) => {` line and before the body statements,
not in `main()`'s preamble. String-position assertion is fine and is the cheapest way to pin it.

**6.2 — key format, asserted against `activationKey` itself.** In
`packages/compiler/src/compile-graph-control-flow.test.ts`, import `activationKey` from
`@flowlathe/core`, compute the expected key for a concrete index, and assert the generated source
contains the template literal that produces it. This converts the hand-mirrored convention from
"two places that must be kept in sync by a human reading CLAUDE.md" into a test failure.

---

## 7. Definition of done

- [x] `packages/core/src/regions.ts` + tests; exported from core's index
- [x] Interpreter walks regions recursively; multi-node and nested bodies run; validation throws
      before any dispatch; all pre-existing interpreter tests pass unchanged
- [x] Compiler emits per-region statements with correct in-arrow hoisting and depth-correct scoped
      ids; validation throws at compile time
- [x] Three new golden parity fixtures. Not verified against a literal pre-change compiler build
      (the compiler was rewritten in place, not staged), but each exercises a code path that
      provably didn't exist before this slice — multi-node bodies (`bodyByParent`/`emitLoopOrMap`
      only ever handled one node per parent) and loop-of-map/map-of-loop nesting (the old body
      dispatch called `bodyDescriptor.dispatch!`, which is `undefined` for the "loop"/"map" kinds
      in `registry`/`emitTable`, so a body node that was itself a Loop/Map would have thrown or
      produced no code at all) — so a regression back to the old behavior would fail these loudly.
- [x] `/run` and `/step-start` return 409 with `problems` for an invalid graph
- [x] Canvas renders body membership legibly, shows one workflow-level validation Alert, disables
      Run/Step while invalid, and lights up body nodes' status
- [x] `slice7-multinode-loop-body.spec.ts` green via the root `e2e` script
- [x] `README.md` limitation removed; `CLAUDE.md` bullet added
- [x] `pnpm -w turbo typecheck test` green; committed (per repo convention: no Claude/Anthropic
      mentions in the commit message)
