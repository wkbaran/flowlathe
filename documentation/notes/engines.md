# Interpreter, compiler and parity

The two execution engines and everything that has to move in lockstep between them.

Moved verbatim out of `CLAUDE.md` when that file was split by topic; see it for the
index and for the invariants that apply repo-wide.

- **An execution that throws before any node starts leaves the SSE stream (and the UI log) totally
  silent unless you explicitly emit a failure event.** The interpreter/runtime pipeline only had
  per-node events (`node_started`/`node_finished`/`node_failed`); if `runGraph` itself rejects
  before dispatching anything (e.g. a schema/template error on the very first node), nothing was
  ever emitted and the SSE connection just hung with an empty backlog forever. Fixed by adding a
  `run_failed` `RunEvent` kind that `packages/server/src/executor.ts`'s top-level `.catch()` emits
  (through the same persisted+broadcast `emit` path as node events) before marking the execution
  failed — this is also what made the property-panel bug above diagnosable at all, since the UI log
  went from silently empty to showing the actual missing-template-variable error.
- **Loop/Map bodies are a single node, not an arbitrary subgraph (v1 scope).** A body node is
  linked via `FlowNode.parentId` pointing at the Loop/Map node's id (mirrors xyflow's own
  parent/child node convention). The body's per-iteration input isn't a normal edge — it's
  synthetically injected by the interpreter (Loop: `accPortName`, Map: `itemPortName`), and the
  interpreter rewrites the body's `spec.id` to a scoped activation key
  (`` `${bodyNodeId}@${loopOrMapNodeId}:${index}` ``, via `core`'s `activationKey()`) so
  concurrent/repeated iterations don't collide in logs or in the mock-response table. **The
  compiled-script codegen mirrors this scoped-id convention by hand** (`compile-graph.ts`'s
  `emitLoopOrMap`) rather than importing `activationKey` — if that format ever changes, both
  places need updating or the parity harness's Map/Loop fixtures will silently diverge without
  either side erroring.
- **Compiled-script Router branches now guard to arbitrary depth, including nested routers
  (resolved; was a known v1 gap — see git history for the old one-hop `branchNodeIds` design).**
  `compile-graph.ts` computes each node's `Scope` — the ordered list of router-branch `Guard`s
  that must hold for it to run — via `computeScopes`: one forward pass over topological order,
  where a node's scope is the `commonPrefix` (closest-common-ancestor) of its inputs' scopes,
  plus one more `Guard` if the node is itself a direct router-branch target. This composes
  correctly for nested routers (a router inside another router's branch just inherits that
  branch's guard and appends its own) and reconvergence (a Merge fed by two sibling branches
  gets `commonPrefix` diverging at the router that split them, landing back at the shared
  ancestor scope) with no special-casing for either. `emitSequential`/`emitScope` then hoist
  every conditionally-scoped node's `let` in one flat pre-pass (decoupled from which router
  "owns" it — a per-router hoist walking transitive descendants would double-declare a node
  nested inside two routers) and recursively emit nested `if`/`else if` blocks matching each
  node's scope, to arbitrary depth. The `.`/`?.` decision was deliberately simplified to depend
  only on whether the *source* node has any non-empty scope at all — not a relational
  comparison between reader and source scopes — matching this codebase's existing convention of
  always using `?.` for a hoisted variable even where same-branch safety could be proven; this
  sidesteps needing per-read-site relational reasoning entirely, at the cost of a few
  technically-unnecessary `?.`s in generated code (functionally identical, since `?.` on a
  defined value just returns the value).
  - **Known, deliberately unhandled residual edge cases**: (1) a node fed only by mutually-
    exclusive branches of two *different* routers with no Merge in between lands at scope `[]`
    (unconditional, both inputs optional) — correct as far as it goes, but the compiler has no
    `required`-port metadata (`NodeEmitter.inputPorts` returns bare names, unlike the
    interpreter's `registry[...].inputPorts`) to detect that such a node would actually run with
    `undefined` in a field it needs; this is pre-existing (the 1-hop version of this shape had
    the identical gap) and would need compiler-visible `required` metadata to fix. (2) if a
    single router wires two different routes to the literal same downstream node, the internal
    `branchGuard` map's last-write-wins, so that node's scope reflects only one of the two
    branches — a very unusual, redundant graph shape (the router already encodes the choice),
    left unhandled.
  - Golden fixtures pinning this: `packages/testing/src/golden/router-deep-branch.ts` (a 3-node
    chain inside one branch, deliberately on the branch that ISN'T taken — picking the taken
    branch as the deep one would miss the bug entirely, since the old one-hop code's
    unconditional-but-coincidentally-correct execution only breaks when the deep chain's own
    inputs are genuinely absent) and `router-nested.ts` (a router inside another router's
    branch, with reconvergence at both the inner and outer level). Both were verified to
    actually fail against the pre-fix compiler (not just pass vacuously) before being kept.
- **A step-mode execution must resolve the graph it steps against by the flow's CURRENT (latest-
  saved) version, not the version pinned at `step-start`.** Editing a node's template mid-debug-
  session and clicking Save creates a new `flow_versions` row; the running execution's own
  `flow_version_id` FK still points at the version active when stepping began. `GET/POST
  /api/executions/:id/step` resolves the graph via `getLatestGraphForFlowVersion` (walks
  version → flow_id → latest version), specifically so "step back, edit a prompt, step forward"
  actually picks up the edit. Node identity (ids) has to stay stable across such edits for restored
  snapshots to still line up — this only works because editing a template doesn't change node ids.
- **Found while building the above: a real, pre-existing interpreter concurrency bug.**
  `GraphEngine.remaining()` (`packages/interpreter/src/run-graph.ts`) used to only exclude nodes
  already in `this.outputs`, not ones currently in `this.running` — so if a dispatched node's work
  spanned more than one microtask (any `await`), `runToCompletion`'s loop could re-admit and
  re-dispatch the *same* node a second time before its first dispatch finished. Harmless by
  accident everywhere `dispatchNode` used to resolve within one synchronous tick; `runPrompt`
  gaining a genuine `await maybeCompact(...)` on every call was enough extra latency to expose it
  (surfaced as node output containing its own prior output, e.g. `"user: X\nassistant: X\nuser: X"`).
  Fixed by also excluding `this.running` from `remaining()`.
- **A router branch's untaken side now surfaces as a real `node_skipped` `RunEvent`/UI status
  (resolved; was a known v1 gap — see README).** The graph-analysis part already existed and was
  correct: `GraphEngine.dispatchNode`'s `never`-port detection (`packages/interpreter/src/run-graph.ts`)
  already called a private `skipNode()` that set every output to `neverSlot("upstream_skipped")`;
  it just never told anyone. The web UI's `NodeStatus` already had a `"skipped"` case defined
  (`packages/web/src/nodes/NodeCard.tsx`) and `steps.status`'s TS union already included
  `"skipped"` (`packages/persistence/src/schema.ts`) — both unused until now. Fixing this required
  adding `emit(event: RunEvent): void` to the `Run` interface itself
  (`packages/runtime/src/run.ts`, delegating to `host.emit`) — `GraphEngine` only holds a `Run`,
  not the raw `RuntimeHost`, and every other node kind's `ctx.emit(...)` calls happen inside
  per-node `run.ts` files that *do* receive the raw host. Any code that hand-builds a `Run` object
  (rather than going through `createRun`) now needs an `emit` method too.
- **Loop/Map bodies became an arbitrary multi-node subgraph (resolved; was a known v1 gap — see
  git history / README, per PLAN-SUBGRAPH-BODIES.md), by making both engines "region-recursive"
  instead of special-casing "the body node."** A region is the top-level graph (`ownerId:
  undefined`) or one Loop/Map node's body (`ownerId`: that node's id); `@flowlathe/core`'s
  `regions.ts` (`regions()`, `terminalNodeIds()`, `validateGraph()`) is the shared primitive,
  following the `plugin-deps.ts` precedent ("one primitive, consumed by UI + interpreter +
  compiler + server routes"). Scope decisions worth knowing before touching this again:
  - **A body's entry port(s) and its one terminal node are inferred from graph shape, never
    declared fields.** Entry: any body node declaring an input port named exactly
    `accPortName`/`itemPortName` with no in-region incoming edge on that port receives the
    injected per-iteration value there (zero or more such nodes is fine — a fan-out body is
    legal). Terminal: the region's one node with no outgoing in-region edge (`validateGraph`'s R5
    requires exactly one, erroring "join them with a Merge node" otherwise). This makes a
    single-node body a degenerate case that falls out for free, needs no schema migration, and
    avoids two node-id fields the canvas would have to keep referentially correct across
    deletion.
  - **The body boundary is closed, deliberately, both directions** (`validateGraph`'s R4): an
    edge with exactly one endpoint inside a body is a hard error, in either direction. An
    outer→body edge ("loop-invariant input") is real, useful, and cut from this slice on purpose
    — flow State (`read_state`/`write_state`) is the documented workaround, named directly in the
    error message.
  - **A Loop/Map body's `let`-hoisted variables must be declared *inside* the arrow function**
    (`compile-graph.ts`'s `emitRegion`/`emitLoopOrMap`), not in `main()`'s top-level preamble like
    the top-level region's own hoists. Getting this wrong means a router branch not taken on
    iteration 2 silently reads iteration 1's value — the single most likely correctness bug in
    this kind of change, per the plan; pinned by `loop-router-body`'s golden fixture and a direct
    string-position compiler test.
  - **The scoped activation-key format is now `/`-joined for arbitrary nesting depth**
    (`nodeId@outer:0/inner:2`, matching `activationKey`'s own format in
    `packages/core/src/activation.ts`), and **`compile-graph.ts` still mirrors it by hand**
    (`scopedIdExpr`, building the template literal from generated index-variable names like `i`,
    `i1`, `i2` rather than importing `activationKey`) — this is the same manual-parity risk
    CLAUDE.md already flagged once for the single-level case; both sides must move together if
    the format ever changes again. A **new** wrinkle this slice added: a Loop/Map node's own spec
    (not just its body's nodes) now needs the same scoped-`id`/`contextNodeId` treatment whenever
    the Loop/Map node is itself nested inside another body — easy to miss since the top-level
    case never needed it.
  - **A region's terminal node compiles to the fixed local name `bodyResult`, regardless of node
    count** (`compile-graph.ts`'s `emitName`) — every other body node uses the ordinary `n_<id>`
    convention. This was necessary (not just cosmetic) to keep the pre-existing single-node-body
    compiled output the same shape as before, while still generalizing correctly to a multi-node
    body's terminal, which can be any node kind — the old code's hardcoded `bodyResult.output`
    assumed a Prompt-shaped result, which happened to be right by coincidence, not by design.
    **Correction (PLAN-COMPILER-VARNAME.md audit):** this used to claim "a real regression test
    asserts this" [byte-identical output] — untrue at the time (verified: no snapshot mechanism
    existed anywhere in the repo, and every compiler test was an exact-line `toContain`, which
    pins individual lines, not the whole output). What now actually enforces it: the `toContain`
    assertions in `compile-graph-control-flow.test.ts`, plus whole-output snapshots added by that
    plan (`compile-graph-snapshot.test.ts`, `toMatchFileSnapshot` — the first use of vitest
    snapshots in this repo).
  - **xyflow (`@xyflow/react` 12.x) treats `Node.parentId` as real subflow containment** — a
    child's `position` is parent-relative, and the parent's own rendered box is sized by its
    `style`, never auto-fit to children. This was already true before this slice (Canvas.tsx's
    "Parent (Loop/Map body of)" selector already set `parentId`), just never mattered visually
    with only one child. `Canvas.tsx` now computes an explicit `style: {width, height}` for a
    Loop/Map with children (sized to fit them, stacked by `updateSelectedNodeParent`) and gives
    every body node `extent: "parent"` so a drag can't escape the box; `ContainerNodeView`
    (`ControlFlowNodeViews.tsx`) renders Loop/Map as a labeled, dashed group box instead of a
    small idle-looking rectangle once it actually has children.
  - **`nodeStatus` (Canvas.tsx) is keyed by the *base* node id, stripped of any `@scope` suffix,
    on the write side** (`nodeId.split("@")[0]`, applied in `subscribeToExecution`'s event
    handlers) — a body activation's events carry a scoped id like `node-2@node-1:0`, and without
    stripping it a body node's box would never light up during a run. The raw scoped id is kept
    in the log text (`describeEvent`), which `slice3-map-fanout.spec.ts` already asserts on.
- **PLAN-CANCELLATION.md landed the producer half of cancellation** (`@flowlathe/core`'s
  `cancellation.ts`: `RunControl`/`createRunControl`/`RunCancelled`/`isCancellation`/
  `nodeFailureEvent`/`allOrCancel`) — the consumer half (`ProviderCallRequest.signal`/
  `ToolInvokeMeta.signal`, read by the provider adapters) already existed but nothing ever
  constructed or forwarded a real signal. Scope and non-obvious points for whoever touches this
  next:
  - **Cancellation is produced by the engine, not the caller, and is cooperative — cancel *and*
    drain, never either alone.** `GraphEngine.runToCompletion` (`packages/interpreter/src/
    run-graph.ts`) catches the first sibling rejection, calls `this.run.cancellation.cancel(err)`,
    then `await`s every other in-flight sibling's settlement (snapshotting `this.running.values()`
    into an array first — see the pre-existing `remaining()` re-admission note this file already
    had) before rethrowing the original error. Aborting alone would still let a node that ignores
    its signal emit an event after `run_failed`; draining alone leaves external side effects
    (Discord sends, Firecrawl scrapes) running in the background. Together they guarantee nothing
    persists or emits after the caller observes the rejection, while a synchronous node with no
    await point (Merge) still completes and emits `node_finished` — ordering is guaranteed,
    instantaneous stopping is not.
  - **The control lives on `RuntimeHost.cancellation` (mirrored as `Run.cancellation`), not on
    `DispatchFn`'s signature**, because `RuntimeHost`/`Run` is the one object every node runner and
    the emitted script's `rt` already receive — same ambient-field family as `state`/`context`/
    `tools`/`llmConfig`. Widening `DispatchFn` would have touched every node package's dispatch
    entry for no benefit. `buildHostAndRun` (`packages/server/src/host-builder.ts`) constructs one
    `RunControl` per execution and returns it on `BuiltHost` (unused today — no operator-initiated
    cancel route exists yet — but this is exactly where a future `POST /executions/:id/cancel`
    would reach in).
  - **`createSuspendRegistry` now takes the `RunControl` and rejects every pending suspend on
    abort** (`packages/runtime/src/suspend-registry.ts`) — without this, the drain above hangs
    forever the moment a fan-out has one sibling failing and another parked in a `pause`/
    `userInput` node, since nothing else would ever settle that node's promise. This is the single
    easiest way to turn the visible "siblings keep running after failure" bug into an invisible
    hang instead — pinned by `run-graph.test.ts`'s "rejects rather than hanging when the surviving
    sibling is parked in a suspend" test (give a test like this an explicit timeout; the failure
    mode it guards is a hang, which otherwise just looks like a stuck suite).
  - **`allOrCancel` (`@flowlathe/core`) is the *only* correct way to fan out concurrent work in
    either engine — a bare `Promise.all` anywhere in this path silently reintroduces the exact bug
    this plan closes.** The three sites: `packages/runtime/src/combinators.ts`'s `mapConcurrent`
    (used by both engines' Loop/Map dispatch — `createRun`'s `loop`/`map` wrappers pass
    `host.cancellation` through), and `packages/compiler/src/compile-graph.ts`'s `emitLevel` (the
    compiled script's per-region fan-out level). `GraphEngine.runToCompletion`'s own top-level
    admission loop deliberately does **not** use `allOrCancel` — it keeps `Promise.race` for
    admission and a plain `Promise.allSettled` for the post-failure drain, rethrowing the original
    `Promise.race` error directly. This is why the interpreter's multi-failure error selection is
    non-deterministic (whichever `Promise.race` observed first) while the compiled script's
    (`allOrCancel`, used per fan-out level) is deterministic (lowest array index) — a real,
    deliberately-accepted engine difference for the case where *two* siblings fail at once; every
    fixture only pins the single-failure case, where both agree.
  - **A real, previously-latent compiled-script bug surfaced switching `emitLevel` from
    `Promise.all` to `allOrCancel`.** `callExpr` has always prefixed its generated call with
    `await` (every *other* call site — a single-node level, a router branch, a loop/map body node
    — wants a sequential await), so a multi-node fan-out level used to emit
    `Promise.all([await rt.prompt(...), await rt.prompt(...)])` — each array element's `await`
    evaluates and fully waits for that call *before* the next element is even constructed, making
    "concurrent" fan-out levels in every compiled script silently sequential all along. This was
    invisible under `Promise.all` (it tolerates plain resolved values, not just Promises), but
    `allOrCancel` calls `.catch` on each element and crashes with `p.catch is not a function` the
    moment it receives an already-resolved value instead of a live Promise. Fixed by stripping the
    leading `await ` from each element specifically inside `emitLevel`'s multi-node branch
    (`.replace(/^await /, "")`) so `allOrCancel` receives genuine unsettled Promises — this also
    means compiled-script fan-out levels are now *actually* concurrent for the first time, not
    just cosmetically labeled as such. No existing test asserted on the array-element text, so
    this needed no test updates, only the fix itself.
  - **The mock provider's `FAIL:`/`DELAY_MS:` prompt-text sentinels are a testing convention**,
    alongside the pre-existing `CALL_TOOL:` one (`packages/providers/src/mock.ts`): `FAIL: <msg>`
    throws synchronously-ish (after the scheduler's semaphore acquire), `DELAY_MS: <n>` awaits an
    interruptible sleep that rejects with `signal.reason` the moment `req.signal` aborts, then
    falls through to the ordinary response lookup/echo. **`DELAY_MS:` actually honoring `signal`
    is load-bearing, not a convenience** — it's what makes `packages/testing/src/golden/
    failing-fan-out.ts` (one `FAIL:` node, one `DELAY_MS: 2000` node, no edges between them) prove
    the abort genuinely reached the provider adapter: without it, the "slow" sibling would just
    complete normally after 2s and emit `node_finished` (correctly ordered, so the drain-half of
    the fix would still look correct), silently failing to test the abort half at all.
  - **`SimpleScheduler.submit` checks `req.signal` on *both* sides of the semaphore acquire**
    (`packages/providers/src/scheduler.ts`) — the second check is the one that matters: a call
    queued behind a full semaphore must not fire a brand-new provider request after the run was
    cancelled while it waited. `AffinityScheduler` (the real production scheduler, used by
    `SchedulerRegistry` against live Ollama/OpenAI-compat providers) was **not** given the same
    treatment — every test, the CLI, and the parity harness all construct `SimpleScheduler`
    directly with `MockProviderAdapter`, so that's the scheduler this plan's tests actually
    exercise; a production run against a real provider queued behind `AffinityScheduler`'s ticket
    queue can still fire after cancellation. Flagged here as a real, tracked gap — not silently
    dropped, just out of this plan's stated scope (`packages/providers/src/scheduler.ts` is the
    only scheduler file it names).
  - **`contracts.ts`'s `ToolInvokeMeta.signal` doc comment used to claim "currently: never, in
    this codebase" and pointed at a CLAUDE.md cancellation note that didn't exist yet** — both are
    now stale-corrected in place (this is that note). A tool handler that ignores `meta.signal`
    still runs to completion regardless — SearXNG's and Firecrawl's handlers pass it to `fetch`,
    Spotify's and Discord's don't (pre-existing, unrelated to this plan).
  - **No operator-initiated cancel, no per-node/per-run timeouts, and `executions.status =
    "cancelled"` all remain deliberately unbuilt** (a failure-driven cancellation still ends the
    execution as `"failed"` — `"cancelled"` is reserved for a future operator-initiated cancel).
    `BuiltHost.cancellation` and the `node_cancelled` event/`steps.status = "cancelled"` plumbing
    are what a future cancel route or timeout policy would hang off of, with no further plumbing
    needed in the interpreter, compiler, or node packages.
- **PLAN-LOOPMAP-BRANCH-SKIP.md: `dispatchNode`'s never-detection must stay ABOVE the Loop/Map
  short-circuit.** `GraphEngine.dispatchNode` (`packages/interpreter/src/run-graph.ts`) used to
  branch into `dispatchLoopOrMap` before the `requiredNever`/`ports.every(isNever)` skip checks,
  so a Loop/Map fed only from an untaken router branch ran anyway — `dispatchLoopOrMap` coerced
  the missing (`never`) port to `""` rather than skipping. Map crashed outright (`itemsTemplate`
  rendered `""`, `JSON.parse` threw); Loop was worse — it just ran with an empty accumulator and
  could complete normally, with the untaken branch's body having really executed. Fixed by
  reordering: `dispatchNode` now computes `spec`/`ports`/`slots` once, runs both never-checks, and
  only then branches to `dispatchLoopOrMap` (now passed the already-filtered `spec`/`inputs`
  rather than recomputing them, since every port reaching it is guaranteed a value post-reorder).
  **The compiler already got this right** — `emitLoopOrMap` is called from inside `emitScope`
  (`packages/compiler/src/compile-graph.ts`), so a Loop/Map gets a `Scope` like any other node and
  is emitted inside the matching `if`/`else if` block; confirmed by reading the actual emitted
  source for a router-guarded Map, not just by inspecting the code. No compiler change was needed.
  **Loop/Map input ports are all `required: true`** (derived from `extractTemplateVars` over
  `initTemplate`/`itemsTemplate`, `packages/interpreter/src/registry.ts`), which is why the
  `requiredNever` branch — not the `ports.every(isNever)` fallback — is the one that actually
  catches this shape; a node with one never port and one value-carrying sibling port only trips
  `requiredNever`. Golden fixtures `router-untaken-map`/`router-untaken-loop`
  (`packages/testing/src/golden/`) pin this, each verified to actually fail pre-fix (a JSON-parse
  crash and a `LoopLimitExceeded`, respectively) before the fix made them pass.
- **PLAN-COMPILER-VARNAME.md fixed a non-injective identifier-generation bug in the compiler:
  `compile-graph.ts`'s old free-standing `varName(nodeId)` (`` `n_${id.replace(/[^a-zA-Z0-9_]/g,
  "_")}` ``) mapped many distinct node ids onto one generated name — `a-b`, `a.b`, `a_b` and
  `a b` all sanitized to `n_a_b`.** Both authoring surfaces actively permit the colliding shapes
  (Canvas rename allows hyphens; the DSL lexer admits internal hyphens for merge-rule names), so
  this was reachable through the product, not just synthetic API input.
  - **Three failure shapes, one of them completely silent.** Same-region collisions were loud: a
    fan-out level's destructuring produced a duplicate binding (`SyntaxError`), and a sequential
    chain produced a duplicate `const` (`SyntaxError`, and the second node's own binding read from
    itself). The dangerous one was cross-region: two nodes in different lexical scopes (a
    top-level node and a Loop/Map body node) produce no duplicate *declaration* at all — only the
    global spec table `N`'s object-literal key collides, which is legal ES2015+, last-one-wins.
    The shadowed node then silently ran with the OTHER node's spec (wrong template, wrong
    `providerId`, everything), exited 0, and emitted a plausible-looking `node_finished` event —
    no crash, no warning. The interpreter was never affected (it keys everything by the real node
    id); this was a pure compiler-side divergence.
  - **Fix: `buildVarNames(nodes)` replaces `varName`, building one map globally over
    `graph.nodes`** (never per-region — a per-region map would leave the silent cross-region
    shape completely unfixed while making every loud same-region shape go away, i.e. it would
    look like a complete fix and be the exact opposite of one). A sanitized base claimed by
    exactly one node keeps the plain `n_<base>` name (so a graph with no collision compiles to
    byte-identical output as before — verified via whole-output snapshots, see the corrected
    `bodyResult` entry above); a base claimed by ≥2 nodes gives **every** claimant a hash suffix
    (`` `${base}__${sha256(id).slice(0,8)}` ``), never "first one keeps the plain name" — that
    would make emitted names depend on `graph.nodes` array order (a canvas drag or DSL reformat
    reordering nodes would then churn every downstream name in the diff for no semantic reason).
    The map is threaded through `RegionCtx.varNames` (built once in `compileGraph`, passed
    unchanged into every child region `buildLoopOrMap` constructs) rather than recomputed, so
    there is exactly one source of truth for every node's generated name across all six call
    sites that used to call the free `varName` function directly.
  - **A residual collision (a node id that happens to equal another's disambiguated name) is a
    loud compile-time throw, not a silent fallback** — `buildVarNames` asserts its output map's
    values are all distinct before returning. Astronomically unlikely in practice, but three lines
    to convert into an actionable error rather than reintroducing exactly the bug class this fix
    removes.
  - **`node:crypto` in `@flowlathe/compiler` is fine and deliberate, not an exception to the
    isomorphic rule** — that rule (see the `@flowlathe/core` entry above) is scoped to `core`.
    `@flowlathe/compiler` is Node-only: verified `packages/web` never imports it, and nothing in
    `core`/`web`'s transitive source graph reaches it either. Its actual consumers (`cli`,
    `server`, `testing`) are all Node processes.
  - **The colliding-ids golden parity fixture (`packages/testing/src/golden/colliding-ids.ts`) is
    order-sensitive in its node array on purpose**, to reproduce the silent (not crashing) pre-fix
    failure: the global spec table's last-wins semantics mean whichever colliding node is declared
    *last* in `graph.nodes` determines which template BOTH nodes silently ran with pre-fix.
    Declaring them in the other order instead crashes the pre-fix compiler with a missing-
    template-variable error the moment the wrong node's template needs a binding the caller never
    supplied — a real pre-fix bug too, but a differently-shaped (loud) one than this fixture is
    pinning. The fixture's mock-response table deliberately registers a *third* entry (the wrong
    node's actual pre-fix rendered prompt) precisely so the pre-fix compiled script fails as a
    genuine `renderedPrompt` **mismatch** against the interpreter, rather than crashing with "no
    mock response registered" — matching this repo's established practice (`router-deep-branch`/
    `router-nested` were verified the same way) of confirming a regression fixture actually
    exercises the bug it claims to, before trusting it.
  - **`adapterCtor`'s identical sanitize-and-collide pattern on `providerId` (`` `FLOWLATHE_APIKEY_
    ${providerId.replace(/[^a-zA-Z0-9_]/g,"_").toUpperCase()}` ``) is a related but explicitly
    out-of-scope bug**, left as-is: `open-ai` and `open_ai` collide onto one env var name. Lower
    severity (an operator-facing env var name, not a program identifier — it degrades to "wrong
    key used," not "wrong node executed") and a different threat model (provider ids come from a
    small operator-curated set, not from flow authors), so don't re-file this as new if a future
    audit rediscovers it.
  - **Test-suite convention note: this plan introduced `toMatchFileSnapshot` as this repo's first
    use of vitest snapshots** (`compile-graph-snapshot.test.ts`) — previously zero snapshot files
    existed anywhere in the monorepo, and every existing compiler test was an exact-line
    `toContain` assertion. Two graphs are pinned this way (a single-node Map body, a nested-router
    graph), deliberately not more — a snapshot per shape becomes reviewer-fatigue churn on every
    legitimate compiler change, and the existing `toContain` assertions already cover
    shape-specific details. Expect to run with `-u` and review the diff on any future intentional
    change to `compile-graph.ts`'s emitted output.
