# PLAN-LOOPMAP-BRANCH-SKIP — a Loop/Map on an untaken router branch must be skipped, not run

Source: `FIX-LOOPMAP-BRANCH-SKIP.md` (security/bug audit finding #9).

Status: not started. Small interpreter change; the parity fixtures are the real work.

## 1. Problem

`GraphEngine.dispatchNode` (`packages/interpreter/src/run-graph.ts:294`) short-circuits into
`dispatchLoopOrMap` **before** the never-slot skip checks at `:305` and `:310`:

```ts
private async dispatchNode(node: FlowNode): Promise<void> {
  if (node.type === "loop" || node.type === "map") {
    await this.dispatchLoopOrMap(node);   // <-- returns here
    return;
  }
  ...
  const requiredNever = ports.find((p) => p.required && isNever(slots[p.name]!));
  if (requiredNever) { this.skipNode(...); return; }
  if (ports.length > 0 && ports.every((p) => isNever(slots[p.name]!))) { this.skipNode(...); return; }
```

`dispatchLoopOrMap` (`:337`) then coerces any non-value slot — `never` included — to the empty
string:

```ts
return [p.name, isValue(slot) ? slot.value : ""];
```

So a Loop/Map fed from a router branch that wasn't taken runs anyway, with `""` substituted for
every input its template needed. Every other node kind on that branch is correctly skipped with a
`node_skipped` event.

## 2. Facts verified against the tree before writing this plan

Everything in this section was checked directly, not assumed.

- **Both Loop's and Map's input ports are `required: true`, unconditionally.**
  `packages/interpreter/src/registry.ts:70-78` derives them from
  `extractTemplateVars(initTemplate)` / `extractTemplateVars(itemsTemplate)` and maps each to
  `{ name, required: true }`. There is no optional-port case to worry about, which is what makes
  the fix as simple as a reorder.
- **`skipNode` (`:329`) is already fully generic** — it calls
  `registry[node.type].outputPorts(spec)` and writes `neverSlot("upstream_skipped")` into each.
  `registry.loop.outputPorts` returns `["result"]` and `registry.map.outputPorts` returns
  `["results"]` (`registry.ts:72,78`), so a skipped Loop/Map's downstream propagation works with
  no change to `skipNode`. It also emits with `(spec as {id:string}).id`, i.e. the *scoped*
  activation key, which is correct for a Loop/Map nested inside another body.
- **The compiler is already correct — confirmed structurally, not assumed.** `emitLoopOrMap` is
  called from *inside* `emitScope` (`packages/compiler/src/compile-graph.ts:405-408`), so a
  Loop/Map node gets a `Scope` from `computeScopes` like any other node and is emitted inside the
  matching `if` block. `emitRegion`'s hoist pre-pass (`:357-362`) also covers Loop/Map — it keys
  off `emitTable[type].runtimeMethod`, with no node-kind exclusion — and `emitLoopOrMap` honours
  the resulting `isHoisted` flag (`:471`). **So the two engines disagree today and no fixture
  covers the shape.** The fix aligns the interpreter to the compiler; the compiler should need no
  change. §5.1 says how to prove that rather than trusting this paragraph.
- **The two failure modes are different, and only one of them is a crash.**
  - **Map**: `itemsTemplate: "{{input}}"` renders `""`, `JSON.parse("")` throws, and
    `run.map` (`packages/runtime/src/run.ts:105`) raises `map "m" itemsTemplate did not render
    valid JSON:` — which kills the whole run. This is the repro in the FIX doc.
  - **Loop**: `initTemplate: "{{input}}"` renders `""` and the loop simply *runs* with an empty
    accumulator (`loopUntil`, `packages/runtime/src/combinators.ts`). It either terminates
    normally (if the body's output happens to hit `stopValue`) or throws `LoopLimitExceeded`. The
    terminating case is the more dangerous one: a run that completes, with the untaken branch's
    body having really executed and emitted events.
  - A Map whose template is `["{{input}}"]` rather than `"{{input}}"` behaves like the Loop case:
    it renders `[""]`, parses fine, and maps over one garbage item. **The bug is not "Map
    crashes"; it is "the node runs at all".** Fixtures should pin the silent-wrong-behaviour
    shape, not only the crash (see §5.2).
- **`MockProviderAdapter` throws `MissingMockResponse` on an unregistered key
  (`packages/providers/src/mock.ts:9,17`) but ignores unused entries.** A response-table entry that
  only the *pre-fix* code path would ever consume is therefore harmless post-fix — which is what
  lets a fixture fail pre-fix by trace divergence rather than by exception (§5.2).
- **`isReady` (`:253`) admits a node once every port is non-`empty`.** A `never` slot is not
  `empty`, so a Loop/Map on an untaken branch is admitted and dispatched — the reorder is the
  whole fix, there is no readiness change to make.
- **Adding a golden fixture touches four places, not one.** `packages/testing/src/golden/<slug>.ts`
  (the graph + response map), a committed `packages/testing/src/golden/<slug>.flow` sibling, an
  entry in `packages/testing/src/parity.test.ts`, and an entry in the `GOLDEN` array in
  `packages/testing/src/dsl-roundtrip.test.ts`. The `.flow` file is asserted byte-for-byte against
  `print(file)`, so it must be generated, not hand-written.
- **The parity harness compares `node_finished` events only** (`traceFromEvents`,
  `packages/testing/src/parity.ts`) — never `runGraph`'s `outputs`, and never `node_skipped`. That
  is enough for this bug (pre-fix the interpreter emits `node_finished` for nodes the compiled
  script never runs), but it means the fixture cannot assert the skip *event* itself; the unit
  tests in §6 do that.

## 3. Fix

In `dispatchNode`, move the never-detection above the Loop/Map branch, and hand the
already-computed spec and inputs down rather than recomputing them.

Target shape:

```ts
private async dispatchNode(node: FlowNode): Promise<void> {
  const descriptor = registry[node.type];
  const spec = this.parseSpec(node);
  const ports = descriptor.inputPorts(spec);
  const slots = Object.fromEntries(ports.map((p) => [p.name, this.portSlot(node.id, p.name)]));

  const requiredNever = ports.find((p) => p.required && isNever(slots[p.name]!));
  if (requiredNever) { this.skipNode(node, spec, ...); return; }
  if (ports.length > 0 && ports.every((p) => isNever(slots[p.name]!))) { this.skipNode(node, spec, ...); return; }

  const inputs = /* unchanged: value slots only */;

  if (node.type === "loop" || node.type === "map") {
    await this.dispatchLoopOrMap(node, spec, inputs);
    return;
  }
  ...
}
```

Notes on the three points the FIX doc flags:

1. **A Loop/Map with no input ports at all must still run.** A literal `itemsTemplate` with no
   `{{vars}}` yields `ports.length === 0`; the existing `ports.length > 0 && ...` guard already
   handles that, and `requiredNever` is `undefined` over an empty array. The reorder preserves
   both. `map-fanout.ts` (`itemsTemplate: '["x","y","z"]'`) is the existing fixture that would
   break instantly if this were got wrong — it must keep passing untouched.
2. **`isValue(slot) ? slot.value : ""` becomes dead for Loop/Map.** After the reorder, every port
   reaching `dispatchLoopOrMap` is a value: `isReady` excludes `empty`, and — because Loop/Map
   ports are all `required: true` (§2) — `requiredNever` excludes `never`. Passing the
   already-filtered `inputs` down (as above) deletes the coercion rather than leaving an
   unreachable branch, and produces an identical map. If the implementer prefers to keep
   `dispatchLoopOrMap` self-contained, leave the expression but add a comment saying it is now
   unreachable — do not silently leave it looking load-bearing.
3. **`regionResult` (`:224`) is a different case and stays as-is.** It throws when a *body's*
   terminal node was skipped — the body ran, but every path through it was pruned. That is
   correct, and the compiled script mirrors the same message deliberately
   (`compile-graph.ts:457`). Do not conflate it with this fix.

Also confirm the reorder does not change behaviour for the `trigger` node's seeded path: a seeded
node is written straight into `outputs` at construction and is never dispatched
(`RunGraphOptions.seed` doc comment, `run-graph.ts:25-30`), so `dispatchNode` is not on that path
at all.

## 4. Non-goals

- **No compiler change.** §5.1 verifies the compiler; if it turns out to be wrong, that is a
  separate finding and should be written up rather than folded in here.
- **No new `NeverReason`.** A skipped Loop/Map reports `upstream_skipped`, like every other kind.
- **No change to `regionResult`**, to `validateGraph`, or to the web UI — `NodeCard`'s `skipped`
  status and `Canvas.tsx`'s base-id-stripped `nodeStatus` map already handle a `node_skipped`
  event for any node kind, including a scoped one.

## 5. Fixtures

### 5.1 First: prove the compiler is already right

Before writing anything, compile a router-with-untaken-Map graph and read the emitted source (or
run it). Expected: the `rt.map(...)` statement sits inside the `else if (n_router.route === "b")`
block and `let n_m: ... | undefined;` appears in `main()`'s preamble. If instead it is emitted
unconditionally, this plan's premise is wrong — stop and re-scope.

### 5.2 Two golden fixtures, both on the **untaken** branch

Follow the precedent `CLAUDE.md` records for `router-deep-branch.ts`: putting the interesting node
on the *taken* branch lets a broken implementation pass coincidentally. The Loop/Map must be on
the side the router does **not** pick.

Two fixtures rather than one combined graph, matching the existing one-shape-per-fixture
convention (`map-fanout` and `loop-router-body` are already separate):

- **`router-untaken-map`** — `seed(prompt) -> router`, route `a` -> a plain prompt (taken), route
  `b` -> a `map` whose `itemsTemplate` is **`["{{input}}"]`**, with a single prompt body node
  (`parentId` = the map's id). Deliberately *not* the bare `"{{input}}"` crash form: with
  `["{{input}}"]` the pre-fix interpreter *completes* and emits `node_finished` for both the map
  and `body@m:0`, so the pre-fix failure is a genuine trace divergence against the compiled script
  rather than an exception. That pins the post-fix semantics ("these nodes must not run"), which a
  crash does not. Register the pre-fix-only mock response (key `mockResponseKey("body@m:0",
  ...)`), with a comment saying it exists to make the pre-fix run reach completion and is expected
  to go unused post-fix.
- **`router-untaken-loop`** — same shape with a `loop` whose `initTemplate` is `"{{input}}"`, a
  prompt body, and a `stopValue` the body's (mock-registered) pre-fix output matches, so the
  pre-fix run terminates instead of hitting `LoopLimitExceeded`. Same comment on the
  pre-fix-only response entry.

For each: add the graph + response map to `packages/testing/src/golden/`, generate the `.flow`
sibling with `print({name: slug, graph, comments: {}})` (see the regeneration note at the top of
`dsl-roundtrip.test.ts`) and commit it, add the slug to `dsl-roundtrip.test.ts`'s `GOLDEN` array,
and add a parity case to `parity.test.ts` asserting both `expect(viaCompiled).toEqual(viaInterpreter)`
**and** an explicit `expect(nodeIds).not.toContain(...)` for the map/loop node and its body's
scoped activation key — the second assertion is what stops the test from passing vacuously if both
engines ever regress together.

### 5.3 Verify each fixture actually fails pre-fix

Non-negotiable; this repo has been bitten by vacuously-passing fixtures and `CLAUDE.md` says so.
Add the fixtures first, run them against the unfixed interpreter, record the failure output in the
commit message or PR description, then apply §3 and confirm they go green. If a fixture passes
pre-fix, it is testing the wrong shape.

## 6. Unit tests (`packages/interpreter/src/run-graph.test.ts`)

Alongside the existing "skips a node whose only required input traces to the never branch" case
(`:148`):

1. **Map on an untaken branch is skipped.** Assert `events` contains
   `{ kind: "node_skipped", nodeId: "m", reason: "upstream_skipped" }`, that `outputs["m"]` is
   `undefined`, that the body node produced no `node_finished`, and that `runGraph` **resolves**.
   Use the crash form (`itemsTemplate: "{{input}}"`) here — the pre-fix behaviour is a rejection,
   so this test doubles as a regression guard on the exact reported symptom.
2. **Loop on an untaken branch is skipped**, same assertions with `initTemplate: "{{input}}"` and
   `nodeId: "l"`.
3. **A Loop/Map with no input ports still runs** when it is not on any branch — cheap insurance
   for §3 note 1, even though `map-fanout` covers it at the parity level.
4. **Cover the `requiredNever` branch, which is currently untested.** Verified by mutation:
   deleting `dispatchNode:305-309` leaves the whole suite green, because the existing skip test
   exercises only the `ports.every(isNever)` fallback. Add a node with **one required-never port
   and one port carrying a value** — e.g. a prompt `"{{a}}|{{b}}"` where `a` comes from an untaken
   router branch and `b` from a node that always runs. Without the `requiredNever` branch, the
   `every` fallback does not fire (`b` is a value), the node dispatches with only `b` bound, and
   `renderTemplate` throws on the missing variable — so the test fails when the branch is deleted,
   which is the point.

## 7. Definition of done

- The interpreter emits `node_skipped` for a Loop/Map whose required inputs all trace to a never
  branch, and the run completes normally.
- Two golden parity fixtures (`router-untaken-map`, `router-untaken-loop`) pin interpreter/compiler
  agreement, each **proven to fail pre-fix** with the failure recorded.
- `.flow` siblings generated and committed; both slugs added to `dsl-roundtrip.test.ts`'s `GOLDEN`.
- The four unit tests in §6 pass, and §6.4's case is confirmed to fail when `dispatchNode`'s
  `requiredNever` branch is deleted.
- `map-fanout`, `loop-router-body`, `nested-map-in-loop`, and `map-multinode-body` all still pass
  unchanged — the no-input-ports and body-region paths are untouched.
- The compiler is unchanged, with §5.1's verification noted.
- Full `pnpm test` and `pnpm typecheck` green; `pnpm e2e` unaffected (no UI change).
- `CLAUDE.md` gains a short entry: the interpreter's never-detection must stay **above** the
  Loop/Map short-circuit in `dispatchNode`, the compiler has always got this right via
  `emitScope`, and Loop/Map input ports are all `required: true` (which is why the `requiredNever`
  branch, not the `every` fallback, is the one that catches this).
