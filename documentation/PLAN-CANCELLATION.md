# PLAN-CANCELLATION — stop a failed or abandoned run from continuing in the background

Source: `FIX-CANCELLATION.md` (security/bug audit finding #13).

## 1. Problem

`GraphEngine.runToCompletion` (`packages/interpreter/src/run-graph.ts:176`) rejects the moment
`Promise.race(this.running.values())` sees its first rejection — while every sibling admitted in
that same fan-out level is still in flight. Those siblings keep going: they finish provider calls,
invoke tools with real external side effects (Discord sends, Firecrawl scrapes, MCP calls), write
into `this.outputs`, and emit through `hostEmit`, which persists a `run_events` row and publishes
to SSE. `executor.ts` has meanwhile already emitted `run_failed` and called
`finishExecution(db, executionId, "failed")`, so the UI shows a failed run that keeps producing
node events afterwards and the DB accumulates steps and responses belonging to a terminal
execution.

This is not an unhandled-rejection crash — `Promise.race` subscribes to every promise in the
iterable, so a second failing sibling is handled. The problem is purely that nothing stops the work.

### 1.1 Facts that shape the design

Everything below was verified against the tree before this plan was written.

- **The consumer half of cancellation exists; the producer half does not.**
  `ProviderCallRequest.signal` (`packages/core/src/contracts.ts:88`) and `ToolInvokeMeta.signal`
  (`:34`) are declared and read by `packages/providers/src/ollama.ts:50,104` and
  `openai-compat.ts:45`. Nothing anywhere constructs an `AbortController`. The one function that
  even accepts a signal — `runPrompt`'s dead 4th parameter — **never forwards it to
  `ctx.scheduler.submit`** either, only to `ctx.tools.invoke`. So even wiring a producer to
  `runPrompt` would not have aborted a provider call.
- **Every `Run` in this repo goes through `createRun`.** Grepped: `packages/server/src/host-builder.ts:121`,
  `packages/cli/src/commands/run.ts:53`, the emitted script (`compile-graph.ts:205`),
  `packages/testing/src/parity.ts`, and `packages/interpreter/src/run-graph.test.ts` (three call
  sites). There are **no** hand-built `Run` object literals. `FIX-CANCELLATION.md`'s design trap
  about `makeRun()` helpers does not apply — the test helper of that name wraps `createRun`.
- **`RuntimeHost` is the only thing every node runner already receives.** `runPrompt`, `runSearch`,
  `runFetch`, `runRouter`, … all take `ctx: RuntimeHost` as their first argument.
  `DispatchFn` (`packages/interpreter/src/registry.ts:21`) has no signal parameter and threading
  one through would touch every node package's dispatch entry.
- **`steps.status` already includes `"cancelled"`** (`packages/persistence/src/schema.ts:149`) and
  **`executions.status` already includes `"cancelled"`** (`:111`). Both are unused today — the
  identical situation `node_skipped` was in before it was wired up. `NodeStatus`
  (`packages/web/src/nodes/NodeCard.tsx:4`) does *not* have a `cancelled` case; it does have
  `skipped`.
- **There are three concurrent fan-out sites, not one.**
  1. `GraphEngine.runToCompletion`'s `Promise.race` (interpreter).
  2. `mapConcurrent`'s `Promise.all(workers)` (`packages/runtime/src/combinators.ts`) — shared by
     *both* engines, since the compiled script calls `rt.map`.
  3. `emitLevel`'s emitted `await Promise.all([...])` (`compile-graph.ts:373`) — compiled script only.
  Site 2 means **step mode has the sibling problem too**: `stepOnce` dispatches one node, but that
  node can be a Map whose body fans out inside that single step.
- **`createSuspendRegistry`'s promise never rejects.** `suspend(key)` resolves only when
  `resolveSuspended(key, value)` is called. A fan-out where one sibling fails while another sits
  in a `pause`/`userInput` node currently leaks that promise forever; under any design that
  *awaits* siblings before propagating, it becomes a hard hang. This is the single most likely way
  to turn a visible bug into an invisible one.
- **`SimpleScheduler.submit` (`packages/providers/src/scheduler.ts:46`) awaits a semaphore before
  calling the adapter.** A node queued behind a full semaphore would start a brand-new external
  request *after* cancellation unless `submit` checks the signal on both sides of the acquire.
- **The compiled script emits no `run_failed` event.** `main().catch` prints to stderr and sets
  `process.exitCode = 1`. `flowlathe run` (CLI) *does* emit `run_failed`. Parity between the two
  engines can therefore only be asserted over `node_*` events, never over a terminal run event.
- **`traceViaCompiledScript` throws on a non-zero exit** (`packages/testing/src/parity.ts:87`), so
  the parity harness cannot express a deliberately-failing fixture at all today.
- **`MockProviderAdapter` has no delay and ignores `req.signal`.** It already has one prompt-text
  sentinel convention (`CALL_TOOL: <name> <jsonArgs>`) used to make tool-calling deterministic.
- **No full-text snapshot of generated script output exists.** `compile-graph.test.ts` and
  `compile-graph-control-flow.test.ts` assert with `toContain` only, so changing `emitLevel`'s
  output is a one-line test update, not a golden-file regeneration.

## 2. Locked decisions

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | **Abort *and* await — not either/or.** On the first rejection, cancel the run, then await every in-flight sibling's settlement, then rethrow the original error. | `FIX-CANCELLATION.md` §3.1 framed these as alternatives. Abort alone still lets a node that ignores its signal emit after `run_failed`; await alone leaves external side effects running. Together they give an unconditional ordering guarantee (nothing after `run_failed`) plus best-effort side-effect suppression. |
| D2 | **One `RunControl` per execution, carried on `RuntimeHost.cancellation`,** mirrored as `Run.cancellation`. | `RuntimeHost` is the one object every node runner already has, so no runner signature and no `DispatchFn` signature changes. Same ambient-field family as `state`/`llmConfig`/`context`/`tools`. |
| D3 | **The engine cancels; the caller owns the controller.** `buildHostAndRun` constructs it and returns it on `BuiltHost`. | Leaves an external cancel (a `POST /executions/:id/cancel`, an SSE-client-gone hook) as a route-only addition later, with no further plumbing. |
| D4 | **Cancellation is cooperative and a node that never awaits still completes.** A synchronous node (Merge) finishes and emits `node_finished` after the abort. | Ordering (D1) is the guarantee; instantaneous stopping is not. Pretending otherwise would mean killing work mid-write. |
| D5 | **`node_cancelled` is a new `RunEvent` kind**, with `steps.status = "cancelled"` and a `NodeStatus` case. | Exactly the `node_skipped` precedent, and both DB unions already carry the value. Reusing `node_failed` paints a wall of red for nodes that merely got stopped, hiding the one node that actually failed. |
| D6 | **`executions.status = "cancelled"` stays unused.** A failure-driven cancellation still ends the execution as `"failed"`. | The execution *did* fail. `"cancelled"` is reserved for the future operator-initiated cancel (§7). |
| D7 | **`allOrCancel` is the single shared fan-out primitive**, used by the interpreter's drain, `mapConcurrent`, and the emitted script. | The `plugin-deps.ts` / `regions.ts` precedent: one primitive, consumed by every engine, rather than three hand-rolled loops that drift. |
| D8 | **When several siblings fail, the reported error is deterministic in the compiled script (lowest array index) and non-deterministic in the interpreter (whichever `Promise.race` saw first).** Fixtures pin the single-failure case only. | §8. Making the interpreter match would mean ranking failures after the drain, for a case no user-visible behavior depends on. |
| D9 | **The mock provider gets two new prompt-text sentinels, `FAIL:` and `DELAY_MS:`,** the latter honoring `req.signal`. | Mirrors the existing `CALL_TOOL:` convention, works identically in the interpreter, the compiled script (which the harness string-patches), *and* the real server (which builds `new MockProviderAdapter()` with no response table), so one fixture shape serves unit, parity, and e2e tests. |
| D10 | **Step-mode abandonment (a user closing the tab mid-step) is out of scope.** | §7. `stepOnce` builds a fresh host per call, so its control is correctly per-step; nothing outside the process can reach it yet. |

## 3. Files

| File | Change |
| --- | --- |
| `packages/core/src/cancellation.ts` | **NEW** — `RunControl`, `createRunControl`, `RunCancelled`, `isCancellation`, `nodeFailureEvent`, `allOrCancel` |
| `packages/core/src/contracts.ts` | `RuntimeHost.cancellation`; `node_cancelled` `RunEvent`; drop the "currently: never" wording on `ToolInvokeMeta.signal` |
| `packages/core/src/index.ts` | export the new module |
| `packages/runtime/src/run.ts` | `Run.cancellation`; pass the control into `mapConcurrent`/`loopUntil`; drop `runPrompt`'s dead signal argument |
| `packages/runtime/src/combinators.ts` | `mapConcurrent` via `allOrCancel` + stop pulling items once aborted; `loopUntil` checks between iterations |
| `packages/runtime/src/suspend-registry.ts` | reject pending suspends on abort |
| `packages/interpreter/src/run-graph.ts` | cancel-then-drain in `runToCompletion` |
| `packages/providers/src/scheduler.ts` | `throwIfAborted` on both sides of the semaphore acquire |
| `packages/providers/src/mock.ts` | `FAIL:` / `DELAY_MS:` sentinels; honor `req.signal` |
| `packages/nodes/*/src/run.ts` | `ctx.emit(nodeFailureEvent(...))` in every catch; prompt forwards the signal to `scheduler.submit` and `tools.invoke`; search/fetch forward it to their clients |
| `packages/compiler/src/compile-graph.ts` | `emitLevel` emits `allOrCancel(rt.cancellation, [...])`; merge `allOrCancel` into the emitted `@flowlathe/core` import |
| `packages/compiler/src/compile-graph.test.ts` | update the one `Promise.all` assertion |
| `packages/server/src/host-builder.ts` | build the control; expose it on `BuiltHost`; `node_cancelled` → `finishStep(..., "cancelled")` |
| `packages/cli/src/commands/run.ts` | build the control into its host |
| `packages/testing/src/parity.ts` | failure-mode tracing for both engines |
| `packages/testing/src/golden/failing-fan-out.{ts,flow}` | **NEW** fixture |
| `packages/testing/src/{parity,dsl-roundtrip}.test.ts` | register the fixture |
| `packages/server/src/executor.test.ts` | **NEW** — the event-ordering test |
| `packages/web/src/nodes/NodeCard.tsx`, `packages/web/src/pages/Canvas.tsx` | `cancelled` status + SSE listener + `describeEvent` |
| `playwright/tests/slice10-cancellation.spec.ts` | **NEW** |
| `CLAUDE.md` | §9 |

## 4. Implementation

### S1 — `packages/core/src/cancellation.ts`

Everything here is isomorphic (`AbortController`/`AbortSignal` exist in both environments), so it
belongs in `core` under the same rule as `url-safety.ts` — no `node:*`, no `Buffer`.

```ts
/** One execution's cancellation channel. Ambient on `RuntimeHost` (same family as `state`/
 *  `context`/`tools`) so every node runner reaches it without a signature change. `cancel` is
 *  idempotent: a nested Loop/Map sub-engine cancels first, then the outer engine cancels again
 *  when the Loop/Map node's own promise rejects. */
export interface RunControl {
  readonly signal: AbortSignal;
  cancel(reason: unknown): void;
}

/** Thrown into everything still in flight when a run is cancelled. Carries the original failure
 *  as `cause` so an operator can still see *why* the run stopped, while `message` makes clear
 *  this node did not itself fail. */
export class RunCancelled extends Error {
  constructor(reason: unknown) { ... name = "RunCancelled"; cause = reason; }
}

/** True for our own cancellation and for a platform abort (`fetch` rejects with the
 *  `AbortController.abort(reason)` argument on Node, but a timeout or a nested `AbortSignal`
 *  can still surface a bare `AbortError` DOMException). */
export function isCancellation(err: unknown): boolean;

/** The event a node runner's catch block emits: `node_cancelled` when the error is a
 *  cancellation, `node_failed` otherwise. One policy, one place — every runner's catch becomes
 *  `ctx.emit(nodeFailureEvent(spec.id, err)); throw err;`. */
export function nodeFailureEvent(nodeId: string, err: unknown): RunEvent;

export function createRunControl(): RunControl;

/** `Promise.all` with D1 semantics: on the first rejection, cancel the run, then wait for every
 *  other promise to settle, then throw. The reported error is the lowest-index rejection, not
 *  the first by time, so two engines running the same graph report the same one. */
export async function allOrCancel<T>(control: RunControl, promises: Promise<T>[]): Promise<T[]>;
```

`allOrCancel`'s body is the whole design in five lines — attach the cancel *per promise* so it
fires at rejection time rather than after `allSettled` resolves:

```ts
const settled = await Promise.allSettled(
  promises.map((p) => p.catch((err) => { control.cancel(err); throw err; })),
);
const failure = settled.find((s) => s.status === "rejected");
if (failure) throw failure.reason;
return settled.map((s) => (s as PromiseFulfilledResult<T>).value);
```

`createRunControl` wraps `AbortController` and wraps the reason once:
`cancel: (reason) => { if (!c.signal.aborted) c.abort(reason instanceof RunCancelled ? reason : new RunCancelled(reason)); }`.
Wrapping matters — abort the *raw* failure and every cancelled sibling reports the failing node's
error as its own, which is exactly the confusing outcome D5 exists to avoid.

Add to `contracts.ts`:

```ts
| { kind: "node_cancelled"; nodeId: string; reason: string }
```

and `cancellation: RunControl` on `RuntimeHost`. Update `ToolInvokeMeta.signal`'s doc comment —
its "currently: never, in this codebase" claim, and its reference to a `CLAUDE.md` note that
**does not exist** (grep for "cancellation" in `CLAUDE.md` returns nothing), both stop being true
in this plan; §9 writes the note it points at.

### S2 — thread the control through every host

Five construction sites, each gaining two lines:

```ts
const cancellation = createRunControl();
const run = createRun({ host: { ..., cancellation, ...createSuspendRegistry(cancellation) } });
```

- `packages/server/src/host-builder.ts` — also return `cancellation` on `BuiltHost` (D3). Neither
  `executor.ts` nor `stepper.ts` needs any other change: both already go through this function.
- `packages/cli/src/commands/run.ts`.
- `packages/compiler/src/compile-graph.ts`'s emitted host literal.
- `packages/testing/src/parity.ts`'s `traceViaInterpreter`.
- `packages/interpreter/src/run-graph.test.ts` (three `createRun` calls).

`Run` gains `readonly cancellation: RunControl`, delegated as `cancellation: host.cancellation`.

**`createSuspendRegistry(control)`** now takes the control and rejects pending suspends on abort —
without this, D1's drain hangs forever on a fan-out where one sibling fails and another is parked
in a `pause` node:

```ts
suspend(key, _reason) {
  return new Promise<string>((resolve, reject) => {
    if (control.signal.aborted) { reject(control.signal.reason); return; }
    const onAbort = () => { pending.delete(key); reject(control.signal.reason); };
    control.signal.addEventListener("abort", onAbort, { once: true });
    pending.set(key, (value) => { control.signal.removeEventListener("abort", onAbort); resolve(value); });
  });
}
```

Remove the listener on the resolve path too — a long-running flow suspends many times against one
signal, and `{ once: true }` alone only cleans up the abort case.

### S3 — interpreter: cancel, drain, rethrow

```ts
async runToCompletion(): Promise<RunGraphResult> {
  try {
    while (this.remaining().length > 0 || this.running.size > 0) {
      const ready = this.readyNodeIds();
      for (const id of ready) this.admit(id);
      if (this.running.size === 0) {
        throw new Error(`cycle detected or missing upstream node among: ${this.remaining().join(", ")}`);
      }
      await Promise.race(this.running.values());
    }
  } catch (err) {
    this.run.cancellation.cancel(err);
    await Promise.allSettled([...this.running.values()]);   // snapshot: `running` mutates as they settle
    throw err;
  }
  return { outputs: this.collectOutputs() };
}
```

Three things to get right, in the order they will bite:

- **Snapshot `this.running.values()` into an array before awaiting.** `admit` registers
  `dispatchNode(...).finally(() => this.running.delete(nodeId))`, and that `finally` runs *before*
  the promise `Promise.race` is watching settles — so the rejecting node is already gone from the
  map by the time the catch runs, and the remaining entries delete themselves as the drain
  proceeds. Iterating the live map while it mutates is the bug this line avoids.
- **The drain cannot re-admit.** `admit` is only ever called from the loop, which has exited. This
  is also why the drain does not reintroduce the re-admission bug that `remaining()`'s
  `!this.running.has(id)` check exists to prevent (see `CLAUDE.md`) — but do not "simplify"
  `remaining()` while restructuring this method.
- **Nested engines need nothing.** `dispatchLoopOrMap` builds its sub-engine with `this.run`, so
  the sub-engine's `runToCompletion` cancels the same shared control; the outer engine then sees
  the Loop/Map node's promise reject and cancels again, which `createRunControl` makes a no-op.

`step()` is unchanged — it dispatches one node and awaits it. Its Map-body fan-out is covered by S4.

### S4 — `mapConcurrent` and `loopUntil`

`mapConcurrent(items, { concurrency, control }, body)`:

- `Promise.all(workers)` → `allOrCancel(control, workers)`.
- The worker's `for(;;)` loop returns early once `control.signal.aborted`, so a cancelled Map stops
  *starting* new iterations rather than only failing the ones already running. Without this a
  50-item map keeps dispatching after the first iteration fails.

`loopUntil` is sequential; it just checks `control.signal.throwIfAborted()` at the top of each
iteration. Both are called from `createRun`'s `loop`/`map` wrappers, which have `host.cancellation`.

`combinators.test.ts` gains a control argument in every existing call.

### S5 — make the signal actually reach the work

- **`SimpleScheduler.submit`** — `req.signal?.throwIfAborted()` before `semaphore.acquire()` *and*
  again after it. The second check is the important one: a node queued behind a full semaphore
  would otherwise fire a brand-new provider request after cancellation.
- **`runPrompt`** — delete the dead 4th `signal?: AbortSignal` parameter (nothing passes it) and
  read `ctx.cancellation.signal` instead. Forward it to **`ctx.scheduler.submit({ ..., signal })`**
  (the omission noted in §1.1) and to `ctx.tools.invoke(..., { activationKey, signal })`. Add
  `signal.throwIfAborted()` at the top of each tool round. The tool-result `Promise.all` needs no
  `allOrCancel`: `createToolRegistry`'s `invoke` catches everything and returns an error *string*,
  so those promises never reject.
- **`runSearch` / `runFetch`** — pass `ctx.cancellation.signal` as the trailing `signal` argument
  their clients already accept (`SearxngClient.search`, `FirecrawlClient.scrapeOne`/`map`).
  `FirecrawlClient`'s crawl poller already checks `signal?.aborted` between polls.
- **Every node runner's catch block** becomes `ctx.emit(nodeFailureEvent(spec.id, err)); throw err;`
  — prompt, router, merge, pause, gate, search, fetch, trigger, userInput, plus `createRun`'s own
  `loop`/`map` wrappers, which have the same `node_failed` catch inline.

### S6 — compiler

`emitLevel`'s multi-node branch:

```ts
return `${indent}const [${decls}] = await allOrCancel(rt.cancellation, [\n${calls}\n${indent}]);`;
```

The single-node branch is untouched (nothing concurrent to cancel). Add `allOrCancel` to the
emitted script's existing `@flowlathe/core` import, unconditionally — it is currently a type-only
import of `RunEvent`, so this becomes a normal value import. Emitting it unconditionally (rather
than only when some level has >1 node) keeps the preamble a fixed literal; an unused named import
is inert under `tsx`, which does not typecheck the generated file.

`compile-graph.test.ts:32`'s `expect(script).toContain("await Promise.all([")` becomes
`toContain("await allOrCancel(rt.cancellation, [")`. `compile-graph-control-flow.test.ts:42`'s
`not.toContain("Promise.all")` still holds.

### S7 — persistence and UI

- `host-builder.ts`: a `node_cancelled` branch alongside `node_failed` — look up the step id (every
  runner emits `node_started` first, so it exists), `finishStep(db, stepId, "cancelled")`. Unlike
  `node_failed` it records **no** `responses` row: there is no response, and a failed-response row
  for a node that was merely stopped is exactly the noise D5 avoids.
- `NodeCard.tsx`: add `cancelled` to `NodeStatus` and to `statusColorOf` — `theme.palette.warning.main`,
  distinct from `failed`'s red and `skipped`'s disabled grey.
- `Canvas.tsx`: add `"node_cancelled"` to the SSE listener list and to the `onEvent` chain
  (`setNodeStatus(... "cancelled")`, remembering `baseNodeId()` for scoped Loop/Map activation keys),
  and a `describeEvent` case: `` `${event.nodeId}: cancelled (${event.reason})` ``.

## 5. Testing

### 5.1 The fixture

`packages/testing/src/golden/failing-fan-out.{ts,flow}` — two prompt nodes, no edges, so both land
in one fan-out level in both engines:

| node | template |
| --- | --- |
| `boom` | `FAIL: boom node exploded` |
| `slow` | `DELAY_MS: 2000 slow node` |

Determinism comes from the gap between the two: `boom` rejects within the first few microtasks
(after the semaphore acquire), while `slow` is parked in an interruptible 2s sleep. Expected in
**both** engines: `node_started` for both, `node_failed` for `boom`, `node_cancelled` for `slow`,
no `node_finished` at all.

**The mock must honor `req.signal`** or this fixture silently tests nothing: an unaborted `slow`
completes normally, emits `node_finished` before `run_failed` (correctly ordered, so the ordering
test still passes) and the fixture would just be pinning the await half of D1. The `node_cancelled`
expectation is what proves the abort actually reached the provider adapter — i.e. the entire
producer half this plan exists to build.

`MockProviderAdapter` (D9), sentinels checked in the same place `CALL_TOOL:` already is:

- `FAIL: <message>` → `throw new Error(message)`.
- `DELAY_MS: <n>` → `await` an interruptible sleep that rejects with `signal.reason` on abort,
  then fall through to the ordinary response lookup / echo.

Add the `.flow` sibling and register the fixture in `dsl-roundtrip.test.ts`'s `GOLDEN` list, per
the existing one-`.flow`-per-golden convention.

### 5.2 Parity harness

`traceViaCompiledScript` throws on a non-zero exit, so add a failure mode rather than bending it:

```ts
export interface FailureTrace {
  finished: TraceEntry[];                          // sorted by nodeId, as today
  failed: { nodeId: string; error: string }[];      // sorted by nodeId
  cancelled: string[];                             // node ids, sorted
}
export async function failureTraceViaInterpreter(graph, responses, netTable?): Promise<FailureTrace>;
export function failureTraceViaCompiledScript(graph, responses, netTable?, env?): FailureTrace;
```

The interpreter version asserts `runGraph` rejects; the compiled version asserts `status === 1` and
parses stdout as usual. **Compare only the three arrays.** The terminal error is not comparable:
the interpreter's caller emits `run_failed`, the compiled script only writes a stack to stderr
(§1.1). The per-node `failed[].error` strings are the parity anchor and are identical in both.

### 5.3 Cases

| # | Where | Case |
| --- | --- | --- |
| 1 | `core/cancellation.test.ts` | `allOrCancel` cancels on first rejection, still awaits every promise, and throws the **lowest-index** rejection when two fail |
| 2 | `core/cancellation.test.ts` | `nodeFailureEvent` maps `RunCancelled` and a bare `AbortError` to `node_cancelled`, anything else to `node_failed` |
| 3 | `core/cancellation.test.ts` | `cancel` is idempotent; a second call does not replace the first reason |
| 4 | `interpreter/run-graph.test.ts` | failing fan-out: the sibling's promise is settled before `runToCompletion` rejects (assert on event order, not timers) |
| 5 | `interpreter/run-graph.test.ts` | a fan-out where the surviving sibling is parked in `suspend` — must reject, not hang. **Give this test an explicit timeout**; the failure mode it guards is a hang, which otherwise looks like a stuck suite |
| 6 | `runtime/combinators.test.ts` | `mapConcurrent` stops pulling new items once cancelled (count `body` invocations) |
| 7 | `runtime/suspend-registry.test.ts` | pending suspend rejects on abort; resolving normally removes its abort listener |
| 8 | `providers/scheduler.test.ts` | a call queued behind a full semaphore never reaches the adapter once aborted |
| 9 | `testing/parity.test.ts` | `failing-fan-out` matches across both engines |
| 10 | `server/executor.test.ts` **(new)** | **the definition-of-done test** — run `failing-fan-out` through `runFlow` against a real DB, poll until the execution row is `failed`, then read `run_events` ordered by `seq` and assert `run_failed` is the **last** row and no `node_*` row follows it; and that `slow` recorded `node_cancelled` with `steps.status = "cancelled"` and no `responses` row |
| 11 | `playwright/tests/slice10-cancellation.spec.ts` **(new)** | build the two-node graph on the canvas, Run, assert the log shows `boom: failed`, `slow: cancelled`, `run failed`, and that `slow`'s node card is not green |

Case 10 deliberately asserts on `node_cancelled` rather than on elapsed time. A timing assertion
("finished in well under 2s, so it must have aborted") is the tempting version and is flaky on a
loaded machine; `node_cancelled` can only be reached through the abort path, so it is the stronger
claim and a stable one.

Every one of cases 4, 9, 10 and 11 must be **verified to fail against the pre-fix code** before
being kept — the same bar `router-deep-branch` was held to.

The e2e is genuinely buildable here, unlike the plugin-shaped slices this repo has repeatedly
skipped: the server registers `new MockProviderAdapter()` with no response table
(`packages/server/src/scheduler-registry.ts:17`), and the sentinels are prompt-text driven, so they
work in echo mode with no `playwright.config.ts` env changes at all.

## 6. Ordering

S1 → S2 before anything else: the type changes break every host construction site, and doing them
first turns the rest of the work into compiler-guided edits. S3–S6 are then independent. S7 and the
tests come last, since S7's `node_cancelled` handling has nothing to receive until S5 emits it.

## 7. Scope: what is deliberately not built

- **No operator-initiated cancel.** No `POST /api/executions/:id/cancel`, no Stop button, no
  cancel-on-SSE-disconnect. D3 leaves the controller on `BuiltHost`, so adding the route later is
  route code plus a map from execution id to control, with no changes to anything in §4.
- **No step-mode abandonment handling** (D10). `stepOnce` builds a fresh host per call and returns
  when its one node settles; a user who closes the tab mid-step leaves a suspended activation, which
  is a resumption problem, not a cancellation one.
- **No SIGINT handling** in `flowlathe run` or the exported script. Both would be a few lines on top
  of this plan's primitives, but a compiled script's behavior on interrupt is a user-visible contract
  change that deserves its own decision.
- **No timeouts.** Per-node or per-run deadlines are the obvious second producer of a cancellation
  signal and now cost almost nothing to add, but they are a policy question (what default? per node
  kind? configurable on the Gate?) this plan does not answer.
- **`executions.status = "cancelled"`** stays unused (D6).

## 8. Known, deliberately unhandled

- **Multi-failure error selection differs between engines** (D8). The compiled script's
  `allOrCancel` throws the lowest-index rejection; the interpreter throws whatever `Promise.race`
  observed first. Identical for one failing node, which is what every fixture pins. Making these
  agree would mean the interpreter collecting all rejections during the drain and ranking them by
  `(topological rank, node id)` to match the compiled script's level ordering — real work for a
  difference no user-visible behavior depends on.
- **A node with no await point still completes after cancellation** (D4) and records
  `node_finished`. Ordering relative to `run_failed` is still guaranteed by the drain.
- **A tool handler that ignores `meta.signal` runs to completion.** The signal is now genuinely
  produced and threaded to every handler, but honoring it is per-plugin. Spotify's and Discord's
  handlers do not currently pass it to their `fetch` calls; SearXNG's and Firecrawl's do.
- **The abort does not reach a provider adapter's retry loop** beyond the `fetch` it is passed to.
  `retryAfterMsFromHeader`-driven backoff sleeps are not interruptible.

## 9. `CLAUDE.md` notes (definition-of-done)

`FIX-CANCELLATION.md` §5 requires the missing note to be written; `contracts.ts:30` already points
at it. Add one entry covering:

- **Cancellation is produced by the engine, carried on `RuntimeHost.cancellation`, and is
  cooperative** — the shape (D1: cancel *and* drain), why the control lives on the host rather than
  in `DispatchFn`'s signature (every runner already takes `ctx`), and that `Run.cancellation` is how
  the emitted script reaches the same object.
- **`createSuspendRegistry` must reject on abort or the drain hangs** — the non-obvious coupling
  between a `pause` node and a failing sibling, which is invisible until someone writes a fan-out
  with both.
- **`allOrCancel` is the only correct way to fan out in either engine.** A future `Promise.all` in
  the compiled script's emitter, in `combinators.ts`, or in a new node kind reintroduces the exact
  bug this plan closes, silently. Name the three sites.
- **The mock provider's `FAIL:` / `DELAY_MS:` sentinels are a testing convention**, alongside the
  existing `CALL_TOOL:` note, including that `DELAY_MS:` honoring `signal` is load-bearing for the
  `failing-fan-out` fixture rather than a convenience.
- Correct the stale claim in `contracts.ts:29-34` while editing it.

## 10. Definition of done

- A failing node stops its in-flight siblings, pinned by a test asserting no `node_*` event is
  persisted for an execution after its `run_failed` (case 10).
- Interpreter and compiled script agree on a deliberately failing fan-out, pinned by
  `failing-fan-out` through the new parity failure mode (case 9), verified to fail against the
  pre-fix compiler and interpreter before being kept.
- A cancelled sibling reports `node_cancelled` / `steps.status = "cancelled"` / a warning-coloured
  node card — not red, and not a `responses` row.
- A fan-out with a suspended sibling rejects rather than hanging (case 5).
- `contracts.ts`'s "currently: never" comment and its dangling `CLAUDE.md` reference are both
  corrected, and the note it points at exists (§9).
- `pnpm -r typecheck`, `pnpm -r test`, and `pnpm e2e` from the repo root are green
  (`node_modules/.bin/playwright test --config=playwright/playwright.config.ts` — never
  `cd playwright && pnpm exec playwright test`, per `CLAUDE.md`).
