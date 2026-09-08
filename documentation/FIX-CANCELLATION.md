# FIX-CANCELLATION — stop a failed or abandoned run from continuing in the background

Status: not started. Own session. Touches the interpreter concurrency core.

Source: security/bug audit, finding #13.

## 1. The problem

`GraphEngine.runToCompletion` (`packages/interpreter/src/run-graph.ts:176`):

```ts
while (this.remaining().length > 0 || this.running.size > 0) {
  const ready = this.readyNodeIds();
  for (const id of ready) this.admit(id);
  if (this.running.size === 0) { throw new Error(`cycle detected ...`); }
  await Promise.race(this.running.values());
}
```

When one node in a fan-out level rejects, `Promise.race` rejects and the error propagates
immediately — while every sibling node admitted in that same level is **still in flight**. Those
nodes keep going: they finish their provider calls, invoke tools (Discord sends, Firecrawl
scrapes, MCP tool calls — all with real external side effects), write into `this.outputs`, and
emit events through `hostEmit`, which persists them and publishes to SSE.

Meanwhile `executor.ts:47` has already caught the rejection, emitted `run_failed`, and called
`finishExecution(db, executionId, "failed")`. So the UI shows a failed run that keeps producing
node events afterwards, and the database accumulates steps and responses belonging to an execution
already marked terminal.

**This is not an unhandled-rejection crash.** `Promise.race` does subscribe to every promise in
the iterable, so a second failing sibling is handled and will not take the process down. The
problem is purely that nothing stops the work.

## 2. Why this is bigger than it looks

The contracts are already shaped for cancellation, but **nothing anywhere produces a signal.**
Verified:

- `ProviderCallRequest.signal?: AbortSignal` exists (`packages/core/src/contracts.ts:88`).
- `ToolInvokeMeta.signal?: AbortSignal` exists (`contracts.ts:34`), with the comment:
  *"Set when the caller has a real cancellation signal available (currently: never, in this
  codebase — see CLAUDE.md's 'cancellation is a real gap' note)."*
- The only consumers are `packages/providers/src/ollama.ts:50,104` and
  `openai-compat.ts:45` (`signal: req.signal ?? null`).
- The only *producers* are: none. Grep for `signal:` outside type declarations returns only those
  three adapter lines.

So this is not "wire up the existing signal" — it is building the entire producer half. The
consumer half being pre-shaped is genuine help, but it also means the plumbing is already
committed to an `AbortSignal`-per-call design, and you should confirm that's still the right shape
before threading an execution-scoped controller through it.

Incidental finding: **the `CLAUDE.md` note that comment references does not exist.** Grep for
"cancellation" in `CLAUDE.md` returns nothing. Either write it or fix the reference.

## 3. Decisions to make

1. **Abort siblings, or await them before propagating?** Aborting is what users expect and stops
   external side effects. Awaiting is far simpler and at least makes the failure *ordered* (no
   events after `run_failed`). Aborting is the better answer but the larger change; awaiting may
   be a defensible first step if it is documented as such rather than left ambiguous.
2. **Where does the controller live?** Per-execution in `executor.ts`/`stepper.ts`, or owned by
   `GraphEngine`? A Loop/Map body spins up a sub-`GraphEngine` (`dispatchLoopOrMap`), so the
   signal has to reach nested engines too — which argues for threading it through `Run`, not
   through `GraphEngine`'s constructor options.
3. **Does `dispatch` get the signal, or does `Run`?** `registry[kind].dispatch(this.run, spec,
   inputs)` has no signal parameter today. `runPrompt` already accepts an optional `signal` as its
   fourth argument but nothing passes it. Decide whether to widen the `dispatch` signature (touches
   every node package) or hang the signal off `Run` (narrower, but makes it ambient).
4. **What does step mode do?** `stepOnce` dispatches exactly one node and awaits it, so it has no
   sibling problem — but it does have an abandonment problem (a user who closes the tab mid-step).
   Decide whether that's in scope; it probably isn't for a first pass.
5. **What should a cancelled node record?** A new `node_cancelled` event kind, or reuse
   `node_failed`? Note the precedent: `node_skipped` was added as its own kind for exactly this
   kind of "the UI needs to distinguish this" reason, and the `steps.status` union and
   `NodeCard`'s `NodeStatus` both had to learn it.

## 4. Design traps

- **`Run.emit` is on the `Run` interface** (added for `node_skipped`). Any code that hand-builds a
  `Run` rather than going through `createRun` needs whatever you add here too. Check
  `packages/testing` and every `makeRun()` helper in test files.
- **The compiled script is a second implementation.** `compile-graph.ts` emits its own scheduler
  loop with `Promise.all` for fan-out levels. `Promise.all` has the *same* problem — it rejects on
  the first failure while siblings run on. Whatever semantics you choose, the parity harness will
  hold you to matching them in both engines, and a golden fixture that exercises a failing
  fan-out sibling does not currently exist.
- **`Promise.race` on a growing map.** `this.running` is mutated inside the loop; make sure any
  restructuring doesn't reintroduce the re-admission bug that `remaining()`'s `!this.running.has(id)`
  check exists to prevent (see `CLAUDE.md`).

## 5. Definition of done

- A failing node stops its in-flight siblings (or provably precedes them), with a test asserting
  no `node_*` event is persisted for an execution after its `run_failed`.
- Interpreter and compiled script agree, pinned by a parity fixture with a deliberately failing
  fan-out sibling — verified to fail against the pre-fix code before being kept.
- `contracts.ts`'s "currently: never" comments updated, and the missing `CLAUDE.md` cancellation
  note written.
