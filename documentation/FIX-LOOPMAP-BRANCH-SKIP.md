# FIX-LOOPMAP-BRANCH-SKIP — a Loop/Map on an untaken router branch must be skipped, not run

Status: not started. Own session. Small code change; the parity fixture is the actual work.

Source: security/bug audit, finding #9.

## 1. The bug

`GraphEngine.dispatchNode` (`packages/interpreter/src/run-graph.ts:280`) short-circuits into
`dispatchLoopOrMap` **before** the never-slot skip checks:

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

`dispatchLoopOrMap` then coerces a `never` slot to the empty string (line 329):

```ts
return [p.name, isValue(slot) ? slot.value : ""];
```

So a Map whose `itemsTemplate` is `{{input}}`, fed from a router branch that wasn't taken, renders
`""`, fails to parse as JSON, and **kills the entire run**. Every other node kind on that branch
is correctly skipped with a `node_skipped` event.

Reproduced:

```
src → router →(a) taken
            →(b) map(itemsTemplate: "{{input}}", body: prompt)
router takes "a"

ERROR   = map "m" itemsTemplate did not render valid JSON: 
OUTPUTS = undefined
SKIPPED = []
```

## 2. The interpreter is the one that's wrong — the compiler already does this correctly

Verified: `emitLoopOrMap` is called from *inside* `emitScope`
(`packages/compiler/src/compile-graph.ts:399`), so a Loop/Map node gets a `Scope` from
`computeScopes` like any other node and is emitted inside the corresponding `if` block. A compiled
script therefore already prunes a Loop/Map on an untaken branch correctly, simply by not executing
the statement.

**So the two engines currently disagree, and no golden fixture covers the shape.** The fix aligns
the interpreter to the behaviour the compiler already has — which also means the compiler side
should need no change at all. Confirm that rather than assuming it.

## 3. The fix

Move the never-detection above the loop/map branch in `dispatchNode`. `skipNode` already handles
output ports generically via `registry[node.type].outputPorts(spec)`, so a skipped Loop's `result`
and a skipped Map's `results` port both get `neverSlot("upstream_skipped")` for free — verify that
against the registry rather than trusting it.

Points to check while doing it:

- A Loop/Map with **no** input ports at all (a literal `itemsTemplate` with no `{{vars}}`) must
  still run. The existing guard is `ports.length > 0 && ports.every(...)`, which handles this — make
  sure the reordering preserves it.
- `dispatchLoopOrMap`'s `isValue(slot) ? slot.value : ""` coercion still has a legitimate job for
  a port that is `empty` rather than `never`. Decide whether to leave it or tighten it now that
  the `never` case is handled upstream.
- `regionResult` throws when a body's terminal node was skipped. That's a *different* case (the
  body ran but every path through it was pruned) and is correct as-is; don't conflate the two.

## 4. The real work: a parity fixture

Add a golden fixture under `packages/testing/src/golden/` covering a Map (and ideally a Loop) on
the branch that is **not** taken. Follow the precedent `CLAUDE.md` records for
`router-deep-branch.ts`: putting the interesting node on the *taken* branch would let a broken
implementation pass coincidentally, so the fixture must put it on the untaken side.

**Verify the fixture actually fails against the current, unfixed interpreter before keeping it.**
This repo has been bitten by vacuously-passing fixtures before and the notes say so explicitly.

## 5. Definition of done

- The interpreter emits `node_skipped` for a Loop/Map whose required inputs all trace to a never
  branch, and the run completes normally.
- A golden parity fixture pins interpreter/compiler agreement, proven to fail pre-fix.
- A unit test in `packages/interpreter/src/run-graph.test.ts` for the Loop case as well as Map.
- While you're here: the `requiredNever` branch in `dispatchNode` is **currently untested**
  (verified by mutation — deleting it leaves the whole suite green, because the existing skip test
  at `run-graph.test.ts:148` exercises only the `ports.every(isNever)` fallback). Add a case with a
  node that has one required-never port *and* one port carrying a value, so the branch is covered.
