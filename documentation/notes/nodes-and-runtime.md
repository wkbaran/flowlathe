# Node kinds and runtime stores

Per-node semantics and the ambient stores (State, Context, LlmConfig) that live outside the port graph.

Moved verbatim out of `CLAUDE.md` when that file was split by topic; see it for the
index and for the invariants that apply repo-wide.

- **`PromptNodeView`'s target handle is a single hardcoded `id="input"`, regardless of the
  template's actual `{{varName}}`.** Every prompt-consuming edge in this codebase names its
  template variable `input` for exactly this reason — the interpreter/compiler both resolve ports
  by matching `extractTemplateVars(template)` against `edge.targetHandle`, so a template like
  `{{ctx}}` wired via the canvas's one visual handle produces an edge with `targetHandle: "input"`
  that never satisfies the `ctx` port, and the node hangs forever ("cycle detected or missing
  upstream node"). Wire a PromptNode from anything using `{{input}}` as the template variable
  name, not a descriptive one.
- **A "State declaration UI, merge rules, the built-in read_state/write_state tool" slice landed
  with these scope decisions, each documented because a future agent extending State could get
  bitten:**
  - **Tool-calling exists only for the two built-in State tools, not as a general mechanism.**
    `ProviderCallRequest.tools`/`ProviderCallResult.toolCalls` are real (both `MockProviderAdapter`
    and `OllamaProviderAdapter` support them — Ollama by switching to `/api/chat`, since `/api/generate`
    has no `tools` param, untested against a live model), but `runPrompt`'s tool-loop only knows
    `read_state`/`write_state` by name. General tool/MCP support is still Slice 6.
  - **`MockProviderAdapter` simulates "the model decided to call a tool" via a literal sentinel in
    the prompt text**: `CALL_TOOL: <name> <jsonArgs>` on its own line, honored once (suppressed by
    checking for a `[tool calls]` marker the tool-loop appends to the follow-up prompt, so it
    doesn't refire forever). This is a testing convention, not how a real model's tool-calling
    works — it exists because the default (no-table) mock mode is a pure echo with no reasoning of
    its own, and parity/e2e tests need a deterministic way to exercise the tool-loop.
  - **Every port a node declares via `inputPorts()` must have a real incoming edge, always** — the
    interpreter's `isReady()` requires ALL declared ports (even ones marked `required: false`) to be
    non-`empty`, and a port with zero edges stays `empty` forever. "Optional" only ever meant
    "allowed to resolve to `never`," never "allowed to have no edge." Merge's `in1`/`in2` already
    relied on this; Gate's single `input` port does too.
  - **State now forks across branches (resolved; was a known v1 gap).** `stepBack`
    (`packages/server/src/stepper.ts`) seeds the new branch's own `state_writes` rows at fork
    time — via `getStateSnapshotAsOf(db, originalBranchId, forkStepIndex)`
    (`packages/persistence/src/state.ts`), which resolves each entry's last-write-wins value
    *as of* the fork's `stepIndex` (bounded by `steps.stepIndex`, joined via `state_writes.stepId`)
    — mirroring the existing snapshot-`payload` copy, not a live ancestor-chain walk at read
    time (a naive `parent_branch_id` walk would leak the parent's *post*-fork writes into the
    child, since the parent keeps stepping forward independently after the fork). A write with
    no owning step (no activation key) can't be bounded by step order, so it's always carried
    forward. `listStateWritesForBranch`/`state-store.ts`'s `replay` option are otherwise
    unchanged — they still only ever look at one branch's own rows; the fork's rows now simply
    already include its inheritance.
  - **"Dashed lineage edges" render an observed, not a static, dependency.** State reads/writes
    have no graph edge between writer and reader node, so nothing can be inferred from the graph
    alone — the canvas fetches `/api/executions/:id/state-lineage` (joins `state_writes`/`state_reads`
    by `entry` + `seq`/`seqSeen`, resolving each side's owning node via `step_id -> steps.node_id`)
    after a run/step/branch-switch and overlays synthetic dashed `Edge` objects, never merged into
    the saved graph.
- **Context isn't a node a flow author wires — it's ambient, per-prompt-node memory, replacing an
  earlier ContextTransform-node design this codebase briefly had and then removed.** Every
  `PromptNode` call automatically appends its own turn (`{role:"user", content: renderedPrompt}` +
  `{role:"assistant", content: result.content}`) to a context keyed by **the node's own flow-graph
  id** (`packages/runtime/src/context-store.ts`), flattened as `role: content` lines and prepended
  to the next call's prompt — so a node that's only ever dispatched once behaves exactly as if
  context didn't exist (empty context in, nothing to prepend), and only a repeatedly-dispatched
  node (a Loop/Map body) actually accumulates anything. This is why `contextNodeId` exists on
  `PromptSpec`: a Loop/Map body's `id` gets rewritten to a *scoped* activation key per iteration
  (`body@loop:0`, `body@loop:1`, …) for logging, but its **context** must stay keyed by the one
  static node id across iterations or "memory" would reset every iteration — the interpreter's
  `dispatchLoopOrMap` and the compiler's `emitLoopOrMap` both set `contextNodeId` to the body's
  unscoped id alongside the scoped `id`, and both must be kept in sync if that convention changes
  (same class of manual-parity risk as the scoped-activation-key convention above).
- **A "Gate" node overrides ambient LLM settings for everything wired downstream, and always wins
  over a node's own local setting.** It's a diamond-shaped (`NodeCard`'s `shape="diamond"` via
  `clip-path`), single-input/single-output pass-through node (`packages/nodes/gate`) whose only
  real job is a side effect: writing into an ambient `LlmConfigStore` (`temperature`, `topK`,
  `compactionMethod`, `compactionThreshold`) that `runPrompt` reads before every call, preferring
  the ambient value over the node's own (`ambient.temperature ?? spec.temperature`). `LlmConfigStore`
  and `ContextStore` (above) are deliberately separate from `StateStore` — same shape of problem
  (ambient, mutable, read/written outside the port graph) but a different, non-user-visible channel;
  they don't appear in the State declaration panel and aren't merge-rule-configurable.
- **Compaction only fires when a Gate has configured it, and the methods are deliberately
  parameter-free** (`drop-oldest-half` / `summarize-oldest-half` — see `packages/core/src/context.ts`),
  unlike the removed ContextTransform node's explicit indices/role lists. A Gate only decides
  *whether* (via `compactionThreshold`: a fixed token count, or a percentage of a context window
  the author copies in as a literal number — no live DB lookup at runtime, keeping compiled scripts
  parity-safe) and *which* policy runs; `runPrompt`'s `maybeCompact` checks the threshold against
  `estimateTokenCount` (a crude ~4-chars/token heuristic, not a real tokenizer) before building
  each call. `system`-role messages are never cut by either method.
- **PLAN-STATE-FILES.md landed file-backed State entries (`type: "file"`), replacing
  `PLAN-FILE-TOOL.md`'s generic `fs` toolset design before that plan was ever implemented** (it
  has its own superseded banner now). A flow author picks a specific file at design time — no
  arbitrary path from a model, ever. Things worth knowing before touching this area again:
  - **A declared state entry's name can now satisfy a Prompt node's template variable with no
    wired edge at all** — the second such exception after Loop/Map's injected-port convention,
    and deliberately type-agnostic (works for any `StateValueType`, not just `file`) even though
    file-backed entries are what motivated it. Implemented at the three call sites that interpret
    `NodeEmitter.inputPorts`'s result as "needs an edge" (`validateGraph`'s R7 in
    `packages/core/src/regions.ts`, `run-graph.ts`'s new `requiredPortsFor`, and
    `compile-graph.ts`'s `bindPort`) — never inside `NodeEmitter.inputPorts` itself, and scoped to
    `node.type === "prompt"` only. Verified to be a genuine two-sided parity risk, not a
    theoretical one: temporarily reverting only the `compile-graph.ts` side made
    `packages/testing/src/golden/file-state-node.ts` fail with a real "no incoming edge bound to
    input" error from the compiled script, not a vacuous pass.
  - **The golden parity fixture for this deliberately does NOT use `type: "file"`** — it uses a
    plain `string` entry with an `initial` value instead. A compiled script has no
    `FLOWLATHE_STATE_FILES_ROOT` pipeline (see below), so a `type: "file"` entry would make the
    compiled script refuse to run at all, which would defeat a parity fixture that needs to
    compare a real execution trace across both engines. The ambient-binding mechanism under test
    is identical either way — `file` vs `string` only changes how `state.read(...)` resolves its
    value, not whether the port gets an edge.
  - **A compiled script explicitly refuses to run (not crash) if the flow declares any
    `type: "file"` state entry** — `compile-graph.ts` embeds `REQUIRED_FILE_STATE_ENTRIES` (the
    list of such entries' names) and `main()` checks it before touching the scheduler, mirroring
    the existing `REQUIRED_PLUGIN_TOOLSETS` exported-script-refusal pattern exactly. Building a
    real standalone-script equivalent of `FLOWLATHE_STATE_FILES_ROOT` was out of scope for this
    pass.
  - **`createStateStore` throwing synchronously at construction (when a flow declares a
    `type: "file"` entry but no `fileConfig` was supplied) surfaced a real, pre-existing structural
    gap**: `buildHostAndRun` is called *outside* the async `runGraph()`/`GraphEngine` boundary in
    both `executor.ts`'s `runFlow` and `stepper.ts`'s `stepOnce`, so a synchronous throw from it
    used to propagate as an uncaught exception instead of going through the ordinary
    `run_failed`/`finishExecution("failed")` path every other run-start/run-time failure uses —
    leaving the execution row stuck at `"running"` forever. Fixed generally (not just for this one
    new throw) by wrapping `buildHostAndRun`'s call in both files and routing a construction
    failure through a new shared `failExecutionAtStart` (`host-builder.ts`), which does the same
    `appendRunEvent("run_failed")` + `hub.publish` + `finishExecution` sequence `emit({kind:
    "run_failed", ...})` normally does — built without an `emit` closure, since construction
    failing is exactly why one was never created. Any future code that can throw synchronously
    from inside `buildHostAndRun` should rely on this same path rather than reintroducing an
    unguarded call.
  - **Versioned mode's template document must already exist before first access, not just before
    a read-only entry's read** — `resolveFor` (`state-store.ts`) requires `mustExist` whenever
    `fileMode === "read-only"` **or** `versioned === true`, not only for read-only as a literal
    reading of the plan's own sketch would suggest. A versioned entry's first access (read OR
    write) mints a copy by `readFileSync`-ing the template — without this, an unset/non-existent
    seed document would crash inside `mintVersionedCopy` with a confusing `ENOENT` instead of
    `resolveWithinRoot`'s clear "path does not exist" error.
  - **`resolveWithinRoot` lives in `@flowlathe/runtime`, not a new plugin package** — this design
    has no separate `fs` toolset for it to belong to (unlike `PLAN-FILE-TOOL.md`'s original home
    for it), so it was ported there directly as `state-file-io.ts`. If `PLAN-FILE-TOOL.md`'s
    generic tool is ever built later, it should import this copy.
  - **DSL (`.flow` text) round-tripping of `filePath`/`fileMode`/`versioned` was NOT something
    this plan could defer** — unlike most "flagged as a real gap, check during implementation"
    notes, this one would have silently corrupted data: every save writes the `.flow` file via
    `@flowlathe/dsl`'s `print()` (`flow-store.ts`'s `canonicalTextFor`), and a file later re-synced
    from disk is re-`parse()`d back into the DB. Had `printStateDecl`/`parseStateDecl` not been
    extended for the three new fields, every save-then-reload cycle would have silently dropped a
    file-backed entry's path/mode/versioning. Fixed in `packages/dsl/src/print.ts` and `parse.ts`;
    `fileMode`'s hyphenated values (`read-only`/`read-write`) tokenize fine as a single `ident`
    because the lexer already allows an internal hyphen followed by an ident-part character (the
    same rule that lets `error-on-conflict` work as a merge-rule identifier).
  - **File-type decl shape (filePath/fileMode present, merge restricted to `replace`/`append`) is
    validated in TWO independent places, and both are load-bearing.** `StateDeclSchema`'s own
    `superRefine` (`packages/core/src/state.ts`) catches it for every caller that actually goes
    through `parseFlowGraph`/`FlowGraphSchema.parse` — which turns out to be only `PUT /api/flows/
    :id`'s 400-on-save path. **The DSL parser does NOT call `StateDeclSchema.parse` at all**
    (`packages/dsl/src/parse.ts`'s `parseStateDecl` hand-builds a `StateDecl` object field by
    field) — so a `.flow` file pasted via `/api/flows/import`, or one synced straight off disk by
    `flow-store.ts`'s `syncFlowFile`/`watchFlowsDir` (which never calls `validateGraph` either, by
    existing design — see its own doc comment), would have reached `createStateStore` with a
    missing `filePath` and crashed confusingly at first run instead of failing clearly. Closed by
    adding R8 to `validateGraph` itself (`packages/core/src/regions.ts`) — the same check,
    duplicated in the `problems: string[]` idiom, but reachable from every `validateGraph` call
    site (the interpreter's `GraphEngine` constructor, the compiler, and both the `/run`/
    `/step-start`/`/import` route handlers), which is the actual safety net for anything that
    bypassed the schema on the way into the DB.
  - **Branch-fork isolation for file-backed entries remains unbuilt, on purpose** — confirmed
    safe-by-omission: `stepBack`'s `getStateSnapshotAsOf` only ever iterates `state_writes` rows,
    and a file-backed entry never produces any (it bypasses `state_writes`/blob persistence
    entirely, by design). Forking a branch mid-run leaves a file-backed entry's on-disk file
    shared across every branch of that execution, last-write-wins — a real, known gap for a user
    who forks specifically to try two different notes-taking paths side by side.
