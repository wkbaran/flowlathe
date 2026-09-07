# flowlathe — agent notes

Read PLAN.md first; it is the implementation plan and source of truth for architecture decisions.
This file only records things that surprised an implementing agent, so the next one doesn't
rediscover them the hard way.

## Surprises / things that aren't what you'd expect

- **TypeScript 7 exists and is `latest` on npm as of 2026-09.** It's the Go-based native-compiler
  rewrite ("tsgo"), not an incremental bump of 5.x. The monorepo deliberately pins
  `typescript@5.9.3` (the last 5.x release) instead of `latest`, because the surrounding toolchain
  (drizzle-kit, vite, vitest, tsx) was not verified against TS7's CLI/API surface and this is a
  foundational scaffold where a toolchain mismatch would be expensive to debug. Don't bump to a
  `7.x` line without deliberately re-verifying the whole toolchain.
- **No `tsc -b` project references.** `tsconfig.base.json` intentionally has no `composite`, so
  each package's `typecheck` script (`tsc --noEmit`) works standalone — `composite` and `--noEmit`
  are mutually exclusive in tsc. Cross-package imports resolve via pnpm workspace symlinks +
  `moduleResolution: "Bundler"`, not via TS project references.
- **Relative imports use an explicit `.js` extension even though the source is `.ts`/`.tsx`**
  (e.g. `import { emptyFlowGraph } from "./graph.js"`). This is standard TS practice for
  `Bundler`/`NodeNext` resolution modes — the specifier is resolved back to the `.ts`/`.tsx` file
  at compile time. It looks wrong on first read; it isn't.
- **`packages/web` never imports `@flowlathe/persistence`.** That package pulls in
  `better-sqlite3` (a native addon) and `node:crypto`; importing it from browser code would break
  the Vite bundle. Wire-format types the browser needs (e.g. flow API shapes) are either declared
  in `@flowlathe/core` (zero-I/O, isomorphic) or duplicated as plain interfaces in
  `packages/web/src/api.ts`. Don't "simplify" by importing persistence types directly into web.
- **The server serves a pre-built SPA, not a Vite dev server.** `packages/server/src/index.ts`
  points `@fastify/static` at `packages/web/dist`. For manual dev-loop work with HMR you'd run
  `vite` separately (it proxies `/api` to the fastify server per `vite.config.ts`), but the
  Playwright e2e suite always runs `vite build` then starts the fastify server against the built
  output — that's the path that has to stay green.
- **`packages/persistence/src/schema.ts` implements the full schema from PLAN.md's "Persistence
  schema" section up front**, not just the tables slice 0 touches. That schema was already fully
  specified in the plan (not something this agent designed), and SQLite/drizzle migrations make
  incremental `ALTER TABLE` additions more painful than just generating the whole thing once via
  `drizzle-kit generate`. Tables like `branches`/`snapshots` have a circular FK relationship
  (`branches.forked_from_snapshot_id → snapshots.id`, `snapshots.branch_id → branches.id`); SQLite
  is fine with this since it doesn't validate FK targets at `CREATE TABLE` time.
- **`@flowlathe/core` must stay genuinely isomorphic — no `Buffer`, no `node:*` imports,
  anywhere in it.** Workspace packages resolve to raw `.ts` source (not built `.d.ts`), so
  `tsc --noEmit` in `packages/web` pulls in *all* of core's source transitively through
  `export *`, even parts web never imports — `skipLibCheck` doesn't shield source files, only
  `.d.ts`. A `BlobStore` interface typed with `Buffer` broke `web`'s typecheck even though web
  never touches blobs. Fix: use `Uint8Array` in shared contracts (works in both environments);
  concrete Node-side implementations (`Buffer` extends `Uint8Array`) satisfy it for free.
- **Playwright is pinned to `1.54.1`** (not registry `latest`) to match the browsers already
  cached at `~/.cache/ms-playwright` on this machine — bumping the version would trigger a browser
  download.
- **A controlled MUI field bound to "whichever node is selected" needs a `key` on the currently-
  selected node's id**, not just a `value` prop. `packages/web/src/pages/Canvas.tsx`'s node
  properties panel re-renders the same `Template`/`Provider`/`Model` `TextField`s across node
  selections; without `key={selectedNode.id}` on their wrapping element, React reuses the same
  underlying `<input>` DOM node across a selection change, and a fast automated `.fill()` right
  after clicking a different node could land while the field still reflected the *previous* node's
  identity — the edit silently applied in the wrong place. Reproduced only under Playwright's fast,
  no-delay interaction, not under a human (or MCP-driven) session with natural pauses between
  actions — that gap is exactly why it went undetected in manual smoke testing.
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
- **`pnpm exec playwright test` run from inside `playwright/` (which has no `package.json` — it's
  not a workspace package) intermittently crashes every worker with `TypeError: Cannot redefine
  property: Symbol($$jest-matchers-object)`, even at `--list`, before any test file loads.** Root
  cause not fully isolated (this machine also has a stray global `@playwright/test@1.54.2` install
  under `~/.local/share/fnm/.../lib/node_modules` that could be shadowing something via a `pnpm
  exec` resolution quirk from a non-package cwd), but the fix that reliably works is: run it from
  the repo root against the explicit config, via the locally pinned binary —
  `node_modules/.bin/playwright test --config=playwright/playwright.config.ts` — which is also
  exactly what the root `e2e` npm script does. Don't `cd playwright && pnpm exec playwright test`.
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
- **Found while building the above: a real, pre-existing interpreter concurrency bug.**
  `GraphEngine.remaining()` (`packages/interpreter/src/run-graph.ts`) used to only exclude nodes
  already in `this.outputs`, not ones currently in `this.running` — so if a dispatched node's work
  spanned more than one microtask (any `await`), `runToCompletion`'s loop could re-admit and
  re-dispatch the *same* node a second time before its first dispatch finished. Harmless by
  accident everywhere `dispatchNode` used to resolve within one synchronous tick; `runPrompt`
  gaining a genuine `await maybeCompact(...)` on every call was enough extra latency to expose it
  (surfaced as node output containing its own prior output, e.g. `"user: X\nassistant: X\nuser: X"`).
  Fixed by also excluding `this.running` from `remaining()`.
- **Two Playwright e2e gotchas found writing the Gate spec:** (1) `.fill()` on a React-controlled
  `type="number"` MUI field is flaky specifically under fast/no-delay automation (passes reliably
  via a human or MCP-paced session, same class of issue as the stale-DOM entry above) — use
  `.pressSequentially()` for numeric fields instead. (2) Default node-add positions are spaced far
  enough apart (see below) that a 3rd node can land outside the initial viewport with a stale/wrong
  `boundingBox()`, silently dropping a drag-to-wire gesture — click "Fit View" before wiring nodes
  that were just added. Relatedly, `Canvas.tsx`'s `addNode()` position formula was widened
  (`x: 80 + ns.length * 260`, was `* 60`) so the diamond Gate — visually wider than a rect node —
  never lands overlapping the previous node by default.
- **Tool-calling was generalized from a hardcoded `read_state`/`write_state` if/else into a real
  `ToolRegistry` (`ToolRegistry`/`ToolRegistration` in `packages/core/src/contracts.ts`,
  `createToolRegistry`/`stateToolset` in `packages/runtime/src/tool-registry.ts`), and the first
  third-party plugin (`@flowlathe/plugin-spotify`) was built on top of it. Scope decisions a future
  agent extending this could get bitten by:**
  - **`ToolRegistration` (the `{toolset, spec, handler}` shape a plugin contributes) lives in
    `@flowlathe/core`, not `@flowlathe/runtime` where `createToolRegistry` itself lives.** Runtime's
    transitive closure pulls in every node kind (`run.ts` imports all of them); a plugin package
    only needs the plain data shape, not that whole graph, so it depends on `core` alone.
  - **Plugins are monorepo-internal packages under `packages/plugins/*` (a new pnpm-workspace glob),
    registered by a short static list in `packages/server/src/index.ts` — not discovered or loaded
    dynamically at runtime.** This matches the existing node-kind extension style (compile-time,
    single-author) and deliberately avoids the arbitrary-code-loading surface a real plugin
    directory (Hermes-style) would need; add a new plugin by adding a workspace package and one
    `if (ENV_VAR) { ... }` block in `index.ts`, not by writing a loader.
  - **`PromptSpec.enabledToolsets: string[]` sits alongside the older `enableStateTools: boolean`
    rather than replacing it** — changing the latter would have meant touching the Slice-5 e2e spec
    and every existing test fixture's literal for no behavioral gain. `runPrompt` just ORs them:
    `[...(enableStateTools ? ["state"] : []), ...enabledToolsets]`.
  - **A schema field with a Zod `.default()` (like `enabledToolsets`) reaches the interpreter path
    for free** (`registry[kind].schema.parse(node.data)` in `run-graph.ts` already applies it) **but
    NOT the compiled-script path**, which used to serialize `node.data` raw
    (`JSON.stringify({ id: node.id, ...node.data })` in `compile-graph.ts`). Adding `enabledToolsets`
    exposed this: the interpreter saw `[]`, the compiled script saw `undefined`, and
    `[...undefined]` threw at runtime — a parity bug that only fires for a *new* schema field with a
    default, so it's easy to reintroduce. Fixed generally (not just for this one field) by adding a
    `schemaTable: Record<NodeKind, ZodTypeAny>` next to `emitTable` and calling
    `schemaTable[node.type].parse(node.data)` before serializing. Any future schema default is now
    covered automatically; don't revert this to raw `node.data` serialization.
  - **A plugin's OAuth token storage reuses `providers.secretEnc`'s exact encryption scheme** (AES-
    256-GCM via `packages/persistence/src/credentials.ts`'s `encryptSecret`/`decryptSecret`) through
    a new, deliberately generic `plugin_credentials` table (`pluginId` → one opaque encrypted
    string) rather than a Spotify-specific table — the payload's shape is the plugin's own business.
  - **`SpotifyClient`'s access-token refresh must be routed through the same overridable `fetchImpl`
    its API calls use**, not the plain global `fetch` — `@flowlathe/plugin-spotify`'s `oauth.ts`
    functions (`exchangeCodeForToken`/`refreshAccessToken`) take `fetchImpl` as a parameter
    (defaulting to global `fetch`) specifically so `SpotifyClient` can pass its own `this.fetchImpl`
    through. Missing this the first time made client tests silently hit the real Spotify token
    endpoint and fail with a real "invalid_client" error instead of using the mock.
  - **The PKCE `state`/verifier map for the Spotify OAuth dance lives in server memory, not the
    DB** (`packages/server/src/routes/plugins-spotify.ts`), consumed exactly once and TTL'd at 10
    minutes — acceptable because this is a single-user local server; a server restart mid-flow just
    means the user clicks "Connect" again.
  - **An unconfigured plugin (no `SPOTIFY_CLIENT_ID`) registers zero tool specs**, rather than
    Hermes's "visible but gated" pattern (tool always listed, dispatch blocked until auth). Simpler,
    at the cost of a model never being told the tool exists at all until an operator sets the env
    var — a deliberate v1 tradeoff, revisit if a flow author needs to *discover* a tool before an
    operator configures it.
  - **A *configured-but-not-connected* plugin (env var set, OAuth never completed) still has its
    tool specs registered and reaching the model in `tools` — only invocation fails, with a
    `SpotifyAuthRequiredError` message handed back as the tool result.** Silently including a
    broken tool in a prompt's context was flagged as a bug, but the fix isn't to hide the tool —
    see the workflow-dependency-gate note below.
  - **Toolset enable/disable is deliberately per-prompt-node (`PromptSpec.enabledToolsets`), never
    workflow-level.** Confirmed as the intended design, not just an implementation shortcut: this
    project's whole premise is precise, per-step control over what reaches a given call's context
    (see PLAN.md's "Debuggability at the step level"), and a workflow-wide plugin toggle would cut
    against that — a later node in the same flow might legitimately want a different toolset (or
    none) than an earlier one.
  - **A workflow-level "missing plugin dependency" check now gates every place a flow can run —
    UI, interpreter, and compiled script — using one shared primitive rather than three separate
    ad hoc checks.** `requiredToolsets(graph)` (`packages/core/src/plugin-deps.ts`) scans every
    node's `enabledToolsets` (union, "state" never appears there since it's a separate field with
    no external dependency); `findMissingToolsets(registrations, required)` (same file) cross-
    references that against whatever `ToolRegistration[]` is actually available, using each
    registration's optional `unavailableReason(): string | undefined` (Spotify's three tools all
    delegate to one `client.isConnected()` check, wrapped once in `createSpotifyToolset` rather
    than repeated per tool). `ToolRegistry.missingToolsets(required)` is a thin per-registry
    wrapper over the same function, for callers (the interpreter) that already have a live
    registry rather than a raw list.
    - **UI**: `Canvas.tsx` computes required toolsets from live (possibly unsaved) node state —
      not the saved graph — against `/api/plugins/status` (a generic, toolset-keyed aggregate;
      currently just `{spotify: {...}}`, meant to gain a row per plugin rather than move to a real
      registry until a second plugin actually exists). Shows one workflow-level `Alert` banner
      (not per-node — a per-node version shipped first and was explicitly rejected: "the UI ...
      should show 'workflow missing dependency'") and disables Run / Start Stepping. Safe to check
      against live state because `handleRun`/`handleStep`'s first step both call `handleSave()`
      before hitting the server, so live and saved state agree by the time either fires.
    - **Interpreter**: `GraphEngine`'s constructor (`packages/interpreter/src/run-graph.ts`) — hit
      by both a fresh `runGraph()` call and every `GraphEngine.restore()` in step mode — throws
      immediately, before any node dispatches, if `run.tools.missingToolsets(requiredToolsets(graph))`
      is non-empty. Needed `tools: ToolRegistry` added to the `Run` interface
      (`packages/runtime/src/run.ts`) to reach it. Re-checked on every step-mode restore rather
      than once at step-start, so a plugin disconnected mid-session is caught on the very next
      step, not just at the start.
    - **Server routes** (`routes/flows.ts`): `/run` and `/step-start` both hard-gate with a 409 and
      a `missing` list before calling `runFlow`/`startStepExecution` at all — belt-and-suspenders
      with the interpreter check, since the interpreter's throw alone would still create an
      execution row that immediately flips to "failed" (via the existing `run_failed` fast-fail
      path) rather than refusing the request outright.
    - **Compiled script**: this surfaced a real, previously-undetected bug — `compile-graph.ts`'s
      emitted runtime host was missing a `tools` field *entirely* (no golden fixture had ever
      exercised `enableStateTools`/`enabledToolsets` through the compiled-script path), so any
      compiled flow using either would crash with `Cannot read properties of undefined (reading
      'specsFor')`. Fixed generally: the compiled script now emits
      `tools: createToolRegistry(stateToolset(state))`, so `enableStateTools` actually works
      standalone (covered by a new `state-tools` golden parity fixture). Plugin toolsets are a
      separate story: a standalone script has no server/DB/credential store to source a plugin's
      OAuth state from, so compiled-script plugin support isn't implemented at all yet. Rather than
      silently misbehave, `compileGraph` computes `requiredToolsets(graph)` at compile time and
      embeds it as `REQUIRED_PLUGIN_TOOLSETS`; if non-empty, `main()` prints a clear "not supported
      in exported scripts" message and exits 1 before touching the scheduler — the flow still
      exports (the script is a faithful record of the graph), it just refuses to run. Covered by
      `packages/testing/src/plugin-gate.test.ts`, which actually spawns the compiled script rather
      than only asserting on the generated source string.
- **Slice 6 (Tools and MCP) landed as `@flowlathe/plugin-mcp`, an MCP client (stdio/SSE/
  Streamable HTTP) built on `@modelcontextprotocol/sdk@1.30.0`, following the tool-registry
  path Spotify already established.** Scope decisions and non-obvious pitfalls found building it:
  - **Config is a JSON file, not a DB table.** `MCP_SERVERS_CONFIG_PATH` points at a file shaped
    like `{"mcpServers": {"<name>": {...}}}` — the exact shape Claude Desktop/Code use for their
    own MCP config, chosen so an operator can often point at a file they already have. This
    mirrors Spotify's operator-configured-at-boot pattern (`packages/server/src/index.ts`), not
    a DB-backed CRUD UI — deliberately: MCP servers are read once at boot
    (`packages/server/src/mcp-config.ts`'s `discoverMcpToolsets`), same as Spotify's toolset is
    built once. A live "add a server from the UI without restarting" flow is future work, same
    category of cut as Spotify's "add a plugin by editing `index.ts`."
  - **Discovery happens once, at boot — not per-run, not live.** `createMcpToolset`
    (`packages/plugins/mcp/src/toolset.ts`) connects once to list a server's tools and builds
    static `ToolRegistration`s from that snapshot; only *invoking* a tool reconnects. This means
    a server added/fixed after boot needs a server restart to be picked up, and — sharper —
    a server that fails discovery contributes **zero** tool registrations, which
    `findMissingToolsets` (`@flowlathe/core`) can't distinguish from "never configured at all":
    both report the generic "not configured on this server" message rather than the specific
    connection error. The specific error *is* captured (`McpBootstrapResult.statuses`, surfaced
    via `/api/plugins/status`'s `mcp:<name>.connected`), just not threaded into
    `findMissingToolsets`'s reasoning the way Spotify's live `unavailableReason()` check is.
    Fixing this properly means re-discovering per-run (or on a timer) instead of once at boot.
  - **The stdio security model is deliberately narrower than Flowise's `MCPToolkit`
    (`packages/plugins/mcp/src/security.ts`, ported/trimmed).** flowlathe is a single-user local server — the
    `MCP_SERVERS_CONFIG_PATH` file is written by the same operator who runs the server, unlike
    Flowise where a less-trusted workspace member might configure a node's MCP settings. Kept:
    a command allowlist (`MCP_ALLOWED_COMMANDS`, empty/unset = nothing runs, mirroring
    `SPOTIFY_CLIENT_ID`'s secure-default gating), the per-command dangerous-flag table (blocks
    `npx -c`, `node -e`, etc. even for an allowed command), shell-metacharacter/chaining
    rejection in args, no `cwd` override, and a null-byte check on env values. Dropped: Flowise's
    separate env-var-*name* allowlist and its absolute-script-path allowlist (both exist there to
    guard against a less-trusted config author than flowlathe has) and its SSRF `checkDenyList`/
    `secureFetch` for the HTTP/SSE path (aimed at a hosted multi-tenant threat model — less
    relevant when the operator configured the URL themselves).
  - **`ToolSpec.parameters.properties` (`@flowlathe/core`) widened from a narrow per-property
    shape to `Record<string, unknown>`** — an MCP server's `inputSchema` is an arbitrary JSON
    schema (nested objects, enums, `$ref`s) that no provider adapter actually validates against;
    both `toOllamaTool` and the OpenAI-compat adapter forward `parameters` verbatim to the model
    API. The old narrow type only ever existed to describe flowlathe's own two hand-written tool
    specs (`READ_STATE_TOOL`/`WRITE_STATE_TOOL`) plus Spotify's — MCP is the first source of tool
    specs flowlathe doesn't author itself.
  - **The MCP SDK's own transport classes don't typecheck against `exactOptionalPropertyTypes`.**
    `StreamableHTTPClientTransport`/`SSEClientTransport`/`InMemoryTransport` all declare a
    `sessionId?: string` field whose getter returns `string | undefined` — under this repo's
    `exactOptionalPropertyTypes`, an optional property must be *either* absent *or* exactly
    `string`, never explicitly `undefined`, so passing any of these classes where the SDK's own
    `Transport` interface is expected fails to typecheck. Not a bug in flowlathe's code — the SDK
    itself presumably isn't built with this flag. Routed around with a narrow, documented
    `asTransport()` cast (`packages/plugins/mcp/src/client.ts`, duplicated in
    `packages/plugins/mcp/src/toolset.test.ts` for the server-side transport classes, which have
    the identical issue). Any *new* code constructing one of these transport classes directly will
    hit the same error and need the same cast.
  - **A `StreamableHTTPServerTransport` in stateful mode can only run ONE session per instance —
    a second independent client `connect()` against a *shared* transport instance fails with
    `"Invalid Request: Server already initialized"`.** Found writing `toolset.test.ts`'s HTTP
    fixture server: `McpClient` opens a fresh `Client`/session per call (`listTools()` and each
    `callTool()` are independent connections, not one held-open session — see `client.ts`'s
    class doc comment), so a naive single-`McpServer`-instance test server broke on the second
    call. The SDK's own "stateless" mode (`sessionIdGenerator: undefined`) takes this further —
    it expects a **brand-new** `McpServer` + transport for literally every HTTP request, including
    the `initialize` and `notifications/initialized` pair within one client's own connect
    sequence, which doesn't model a session at all. The fix, and the pattern a real
    Streamable-HTTP server needs: a session-id-keyed map of `{server, transport}` pairs, a new
    pair created only when a request arrives with no known `mcp-session-id` header, registered
    into the map via the transport's `onsessioninitialized` callback once the SDK assigns the id
    (see `createSessionedMcpHttpServer` in `toolset.test.ts`).
  - **Canvas.tsx's per-node toolset checkboxes are no longer hardcoded to Spotify.** They're now
    rendered by mapping over whatever keys `/api/plugins/status` returns (`spotify`, `mcp:<name>`
    per configured server, ...) — the same generalization the missing-dependency banner already
    had. `displayName()` special-cases an `mcp:` prefix into `"<name> (MCP)"`; anything else is
    just capitalized. A third plugin type needs no Canvas.tsx changes to get a working checkbox.
  - **`packages/server/src/index.ts`'s bootstrap is now `await`-ing at the top level** (tool
    discovery is inherently async), which is fine under this repo's ESM/Node 22 setup but is a
    change in kind from every other top-level statement there being synchronous — don't
    reintroduce a synchronous assumption (e.g. a test that imports `index.ts` for its side
    effects) without accounting for this.
  - **Unrelated pre-existing inaccuracy noticed while manually smoke-testing this slice**:
    `README.md`'s quickstart says `node packages/server/dist/index.js`, but
    `packages/server/package.json` has no `build` script at all — `start`/`dev` both run
    `src/index.ts` directly via `tsx`. Not caused by or fixed as part of this slice; flagged here
    so the next agent doesn't waste time looking for a `dist/` that was never going to exist.
  - **No Playwright e2e spec for this slice**, unlike every prior slice (PLAN.md's verification
    section: "every slice adds a spec"). Coverage instead comes from `@flowlathe/plugin-mcp`'s
    own tests, which exercise real transports (a spawned stdio subprocess, a real local HTTP
    server) end to end, plus a manual smoke test through the actual running server/API/tool-loop
    during development. An e2e spec would need a bundled fixture MCP server file and a
    `MCP_SERVERS_CONFIG_PATH` wired into `playwright/playwright.config.ts`'s `webServer` env —
    not done here; a real gap if a future agent is asked to hardening-pass this feature.
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
    compiled output byte-identical (a real regression test asserts this), while still
    generalizing correctly to a multi-node body's terminal, which can be any node kind — the old
    code's hardcoded `bodyResult.output` assumed a Prompt-shaped result, which happened to be
    right by coincidence, not by design.
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
- **PLAN-INTEGRATIONS.md Phase A landed `PluginManifest` (`@flowlathe/core`) and split
  `routes/plugins-spotify.ts`'s generic `/api/plugins/status` aggregate into its own
  `routes/plugins.ts` (`registerPluginRoutes`).** One thing worth knowing before adding a fifth
  plugin: `configured`/`connected` in that route are derived **uniformly** from
  `pluginToolsets` — `configured` is "this toolset has at least one live `ToolRegistration`",
  `connected` is "and none of them report `unavailableReason()`" — with **zero** per-plugin
  special-casing, including for Spotify. That only works because every plugin (Spotify included)
  already follows the "unset env var/config ⇒ zero tool registrations" locked decision from
  `packages/server/src/index.ts`; a future plugin that registers unconditionally (tools present
  but always failing `unavailableReason()`) would silently read as "configured" when it isn't.
  MCP is the one deliberate exception (`mcpStatuses`, folded in separately) since its discovery
  can fail and still contribute zero registrations, indistinguishable from "never configured" —
  see the existing MCP scope-cut note above.
- **`@flowlathe/plugin-common` (`packages/plugins/_common`) now holds the shared tool-plugin
  helpers**: `toolOk`/`toolFail` (one JSON envelope, `{ok, data}` / `{ok, error}` — key order
  matters, it reaches the model as JSON text), `guarded`/`httpGetJson`/`requestJson` (one
  error-classification taxonomy: `PluginHttpError` for a non-2xx response, `PluginNetworkError`
  for an unreachable host, `SyntaxError` for unparseable JSON), argument coercion
  (`requireString`/`asStringArray`/`clampLimit`, moved out of `@flowlathe/plugin-spotify`), and
  `sanitizeUntrustedText` (generalized from `@flowlathe/plugin-mcp`'s tool-description sanitizer,
  which now delegates to it). **`guarded`'s classifier intentionally does NOT re-prefix a
  `PluginHttpError`/`PluginNetworkError`'s own message with `${vendor} ${kind} failed:`** — those
  two error types already carry a caller-supplied `label` (from `httpGetJson`'s first argument),
  so re-prefixing would double up the context (e.g. "searxng search failed: SearXNG search:
  could not reach ..."). The `vendor`/`kind` prefix is reserved for errors with no such built-in
  context (a bare `Error`, a `SyntaxError`, an `AbortError`). Any new plugin composing
  `guarded(vendor, kind, () => httpGetJson(label, ...))` should give `label` and
  `vendor`/`kind` compatible, non-redundant wording.
- **`@flowlathe/plugin-searxng`'s `unavailableReason` can't do a live network probe synchronously**
  (`findMissingToolsets` runs on `/run`, `/step-start`, and every `GraphEngine` construction
  including step-mode restores — none of which can block on I/O), so `CachedLivenessProbe`
  (`packages/plugins/searxng/src/liveness.ts`) is optimistic before its first probe resolves
  (reports reachable) and only re-probes once a 60s TTL elapses, kicking off the refresh
  fire-and-forget rather than awaiting it. A newly-registered SearXNG toolset can therefore
  briefly report itself usable for a moment even if the instance is actually down — an
  intentional tradeoff (never block a request-path check on a network round trip), not a bug.
- **No Playwright e2e spec was added for Phase A (SearXNG), despite PLAN-INTEGRATIONS.md §8
  asking for "one spec per phase."** `playwright/tests/` currently has no spec at all for
  Spotify, Gate, or MCP either — despite CLAUDE.md's own Gate/Slice-6 entries above describing
  Playwright gotchas as if such specs exist, the actual spec files were apparently never
  committed (or were later removed) for any plugin-shaped slice; only the core numbered
  slice0–slice7 flow specs are present. Given that pattern, Phase A's unit-test coverage
  (`client.test.ts`/`tools.test.ts`/`liveness.test.ts`/`env.test.ts`, all offline against an
  injected `fetchImpl`) was prioritized over writing the first-ever plugin e2e spec from
  scratch, which would also need a fixture SearXNG HTTP server wired into
  `playwright/playwright.config.ts`'s `webServer.env` (the same gap this file already flags as
  *not done* for MCP). Left as a real, tracked gap for whoever picks up e2e coverage for the
  plugin surface generally — not SearXNG-specific.
- **PLAN-INTEGRATIONS.md Phase B added `packages/core/src/url-safety.ts` and
  `@flowlathe/plugin-firecrawl`, plus `ToolRegistration.standalone` for exported-script support.**
  A few things worth knowing:
  - **The platform `URL` class already closes most of the SSRF-bypass-encoding surface for free.**
    `new URL("http://2130706433/").hostname` comes back as `"127.0.0.1"` — decimal, octal, hex,
    and shorthand IPv4 encodings all canonicalize to dotted-decimal during parsing (verified
    against Node's implementation before writing any bypass-specific detection code). `url-
    safety.ts`'s private-range check is therefore just plain octet/prefix comparison on
    `url.hostname` — no need to hand-roll decimal/hex parsing.
  - **A `::ffff:127.0.0.1`-shaped IPv4-mapped IPv6 address canonicalizes to a *hex* form**
    (`::ffff:7f00:1`, not the dotted-quad form some other languages produce) — `url-safety.ts`'s
    `ipv4MappedOctets` matches that hex shape specifically, not the more commonly-documented
    dotted form.
  - **`ToolRegistration.standalone` is a data field on each registration**, not a separate
    lookup table — `compileGraph` (`packages/compiler/src/compile-graph.ts`) partitions
    `requiredToolsets(graph)` by checking each required toolset's own registrations (passed in as
    the new `CompileOptions.toolsets`) for a `standalone` descriptor. A toolset with *some*
    registrations carrying `standalone` and others not would silently use whichever registration
    happens to match first (`.find()`) — not a real risk today since `createSearxngToolset`/
    `createFirecrawlToolset` set the identical `standalone` object on every registration they
    return, but a future plugin should keep that convention (one shared `standalone` object,
    spread onto every registration) rather than authoring it per-tool.
  - **The generated script's tool registry construction changed from
    `createToolRegistry(stateToolset(state))` to `createToolRegistry([...stateToolset(state),
    ...anyStandaloneFactory()])`** — every hand-authored compiled-script fixture or golden file
    that pattern-matches on that exact line (none currently do — checked before this change)
    would need updating if one is added later.
  - **`FirecrawlClient` has no health-check endpoint to hit for `unavailableReason`**, unlike
    SearXNG's `/config` — it reuses the same `CachedLivenessProbe` (now generalized into
    `@flowlathe/plugin-common`, since SearXNG's version was SearXNG-specific until this phase)
    around a cheap `POST /v2/map` call as a combined reachability *and* auth probe (a bad API key
    401s the same as an unreachable host would fail differently, but both correctly resolve to
    "unavailable").
  - **Firecrawl's crawl-completion polling interval is a constructor option
    (`crawlPollIntervalMs`, default 1000ms), not hardcoded**, specifically so tests can set it to
    1ms and exercise multi-poll and timeout paths without a real 1-second-per-iteration wait.
- **PLAN-INTEGRATIONS.md Phase C added the `search`/`fetch` node kinds
  (`@flowlathe/node-search`/`@flowlathe/node-fetch`) — a design question the plan left open was
  resolved here and is worth recording:**
  - **`search`/`fetch` reconstruct their plugin client from `process.env` directly inside
    `runSearch`/`runFetch`** (`SEARXNG_BASE_URL`/`FIRECRAWL_API_KEY` etc., via a `fetchImpl:
    ctx.net.fetch`-configured `SearxngClient`/`FirecrawlClient` — the exact same client class the
    `searxng_search`/`firecrawl_*` tools use, per §5.4's "different front end to the same client,
    not a fork of it"), rather than threading plugin config through a new `RuntimeHost` field or
    going through `ctx.tools.invoke(...)`. This works because this node package is imported by
    *both* the interpreter and the compiled script (via `@flowlathe/runtime`'s `createRun`, the
    existing "one implementation, two callers" pattern) — both run as Node processes with the
    relevant env var already set, exactly like the `standalone` exported-script path added in
    Phase B. The alternative (routing through `ctx.tools.invoke`) would have reused the tool's
    own URL-safety/truncation/sanitization for free, but would have made `RuntimeHost.net`
    pointless (the plan explicitly asks for it, precisely so the parity harness can stub outbound
    HTTP the same way it stubs the mock provider) — reading env directly is what actually
    exercises `ctx.net.fetch`.
  - **`accessorExpr` (`compile-graph.ts`) needed two new cases for `search`/`fetch`**, not
    mentioned explicitly in the plan's checklist: every existing node kind's single output port
    happens to be literally named `"output"`, which is what `finishBindings`'s terminal-node
    fallback (no reading edge) defaults to — `search`'s port is `"results"` and `fetch`'s is
    `"content"`, so a search/fetch node used as a flow's terminal output needed the same kind of
    override router/loop/map already have. A node *read by* a downstream edge is unaffected
    (the edge's own `sourceHandle` already carries the right name).
  - **`summarizeSearxngResults` was promoted from a private helper in `plugin-searxng`'s
    `tools.ts` to an exported one**, specifically so `@flowlathe/node-search`'s `runSearch` uses
    the identical trimming/sanitization the `searxng_search` tool uses — avoiding a second,
    silently-diverging implementation of "what a search result looks like once it reaches
    context."
  - **Only a `search`-node golden parity fixture was added** (`packages/testing/src/golden/
    search-node.ts`, plus `net-stub.ts`'s `netStubFetch`/`injectNetStubTable`, mirroring the mock
    provider's `injectResponseTable` pattern). A `fetch`-node fixture was deliberately deferred:
    Firecrawl's REST shape is POST-based against a handful of fixed paths (`/v2/scrape`,
    `/v2/map`, `/v2/crawl`) reused across different calls (e.g. `isAuthorized`'s probe and a real
    `firecrawl_map` call both hit `/v2/map`), so a URL-only stub table (sufficient for SearXNG's
    GET-with-query-string shape) would collide. Doing this properly needs the fuller `(nodeId,
    sha256(renderedUrlOrQuery))`-keyed design PLAN.md's design trap 8 actually describes — left
    as a real, tracked gap rather than a hidden one.
  - **No Playwright e2e spec was added for this phase either**, for the same reason recorded
    above for SearXNG/Firecrawl's tool-shaped e2e coverage: this codebase currently has no
    plugin-shaped e2e spec at all to extend, and building the first one (a fixture SearXNG/
    Firecrawl HTTP server wired into `playwright/playwright.config.ts`) is a separable piece of
    work from getting the node kinds themselves correct and unit/parity-tested.
- **PLAN-INTEGRATIONS.md Phase D added `@flowlathe/plugin-discord` (outbound tools only —
  `discord_send_message`/`discord_read_messages`/`discord_react`).** One deliberate scope
  narrowing from the plan's own §6: the plan describes a bot token "configured by
  `DISCORD_BOT_TOKEN` at boot **or entered in the UI**", mirroring Spotify's env-or-stored-
  credential split. This implementation only does the env var path — `discordClientFromEnv`
  reads `process.env["DISCORD_BOT_TOKEN"]` directly, with no `plugin_credentials` row and no UI
  form to enter one, matching the simpler pattern SearXNG/Firecrawl already established (their
  own manifests have no `connect` field either) rather than partially replicating Spotify's
  OAuth-shaped storage for a credential that isn't OAuth. If a UI credential-entry form is wanted
  later, `packages/persistence/src/plugin-credentials.ts`'s generic `pluginId -> encrypted
  string` storage (pluginId `"discord"`) is already there and needs no schema change — only a
  route + a `getPluginCredential` fallback in `discordClientFromEnv`.
  - **429 handling reads `retry_after` from the JSON body as a fallback to the `Retry-After`
    header** — Discord always includes `retry_after` (seconds) in a rate-limit response body,
    but the header is not guaranteed on every route, so `DiscordClient`'s `request()` tries the
    header first (via `@flowlathe/providers`'s `retryAfterMsFromHeader`, reused rather than
    duplicated per the plan's explicit instruction) and falls back to parsing the body.
  - **`allowed_mentions` is computed once in the constructor and attached to every `sendMessage`
    call**, never accepted as a per-call tool argument — this is the whole point of the
    "hermes-agent incident" precedent the plan cites: a per-call parameter is one missed call
    site away from a model that just read a hostile page pinging the whole server.
  - **No `unavailableReason` network probe** (unlike SearXNG's `/config` or Firecrawl's `/v2/map`
    auth check) — Discord has no cheap, side-effect-free health endpoint worth polling on every
    dependency check. Instead `createDiscordToolset`'s `unavailableReason` reports unavailable
    whenever the channel allowlist is empty, since every tool call would fail that check anyway;
    a bad bot token is only discovered on first real use, surfaced through the ordinary
    `guarded()`-classified tool-result error, not through the workflow-dependency banner.
  - **No `standalone` field** — Discord is explicitly server-only per the plan's Locked
    Decisions table, so a compiled script using this toolset refuses to run (same
    `REQUIRED_PLUGIN_TOOLSETS` path as Spotify/MCP). Nothing extra was needed in `compileGraph`
    for this; the Phase B `standalone`-partitioning logic already treats "no `standalone` field
    on any registration for this toolset" as the server-only case by default.
- **PLAN-INTEGRATIONS.md Phase E added the `trigger` node kind, `GraphEngine`'s `seed` option,
  and `TriggerRegistry`/`DiscordTriggerSource`/`/api/triggers`.** The largest phase; scope
  decisions worth knowing before touching this again:
  - **`RunGraphOptions.seed` writes directly into `GraphEngine`'s internal `outputs` map at
    construction, before the first readiness pass** — a seeded node is therefore never dispatched
    at all (it's already "settled" by the time `remaining()` is computed), not dispatched-then-
    overridden. This is why `runTrigger` (the ordinary, unseeded dispatch path, used only for a
    canvas-started run) never runs when a flow is started by a real trigger: the trigger node's
    `dispatch` function in `registry.ts` is simply never called for that node id. Snapshot/restore
    needs **no shape change** at all: `EngineSnapshot.outputs` already captures whatever's in the
    map, seeded or not, and `GraphEngine.restore` already re-validates the top-level graph and
    toolset gate on every restore (a pre-existing behavior, not new to this phase). For step mode,
    `startStepExecution` bakes the seed into stepIndex 0's persisted snapshot directly (via the
    same `serializeSnapshot`/`putBlob` path every other snapshot uses) rather than reusing
    `GraphEngine`'s constructor-time seeding — there's no `Run` object available yet at that call
    site (host-building is deferred to the first `stepOnce`), so building the snapshot payload by
    hand was simpler than manufacturing a throwaway host just to seed one.
  - **A trigger node's real base-URL-equivalent (which flow-graph node ids to seed) is resolved by
    `TriggerRegistry`, not stored on the `triggers` DB row.** `admitMessage` re-resolves the
    trigger's pinned graph (`getGraphForFlowVersion` — the exact version, deliberately NOT
    `getLatestGraphForFlowVersion`, which step sessions use on purpose to reflect live edits; a
    trigger must never do that) on every single message and seeds *every* node with `type ===
    "trigger" && data.source === "discord"` identically. Registration validation guarantees at
    least one exists; nothing stops an author wiring more than one, and all get the same message
    — an unusual but harmless graph shape, left unhandled the same way the compiler's router-edge-
    reuse edge case is (see the router-branch entry above).
  - **The dedupe claim/check race is resolved with a deliberately asymmetric design**: a *live*
    gateway message only ever gets the fast, non-claiming `executionTriggerExistsForExternalId`
    check before `admitMessage` starts a real execution and then claims via
    `claimExecutionTrigger`'s `UNIQUE(external_id)` insert. If the claim itself loses a race
    (vanishingly rare — it would need the recovery scan and a live event for the *same* message to
    both pass the pre-check in the same instant), the execution that already started is simply
    left to run; it's logged, not rolled back. Getting this fully atomic would mean claiming
    *before* starting the run, but the claim's `execution_id` is a real FK to `executions.id`,
    so the execution has to exist first — closing this completely would need a two-phase
    reservation (claim a bare row, then backfill `execution_id`), judged not worth the complexity
    for a single-user local server.
  - **The self-message loop guard compares against the bot's own user id specifically (learned
    from the gateway's `ready` event), not "any message where `author.bot` is true"** — matching
    the plan's explicit instruction to keep other bots as an opt-in case, not a blanket ignore.
    Before `ready` fires (a brief window right after `login()`), `botUserId` is `undefined` and the
    guard is a no-op — a message from the bot's own account in that narrow window would not be
    filtered. Not observed in testing (the fake-gateway tests fire `ready` synchronously inside
    `login()`), but worth knowing if a real connection's `ready` timing ever matters.
  - **Privileged-intents detection is a message-text heuristic** (`/intent|disallowed/i` against
    the error message), not a check against a stable discord.js error code — discord.js does not
    expose one consistently across versions for this failure mode. False negatives (a real intents
    problem whose error text doesn't match) just fall back to printing the bare error, same as
    before this existed.
  - **Recovery's "how far back to scan" uses the Snowflake id's embedded timestamp**
    (`snowflakeTimestampMs`: the top 42 bits of a Discord message id, shifted, plus the Discord
    epoch) rather than reading each message's `timestamp` field — avoids a second per-message
    field access and matches how Discord's own API documents deriving creation time from an id.
  - **`DiscordClient.readMessages`'s signature changed from `(channelId, limit?, before?)` to
    `(channelId, { limit?, before?, after? })`** to add `after` (needed for the recovery scan's
    forward-from-cursor read; the outbound `discord_read_messages` tool only ever used `before`).
    Every existing call site (the tool, its tests) was updated in the same change — a breaking
    signature change to a function with exactly one internal consumer at the time, not a
    backwards-compatible overload, since there's no external caller to preserve compatibility for.
  - **No web UI for creating/managing triggers** — `/api/triggers` (POST/GET/DELETE/repin) is
    fully functional and covered by route-level tests, but there's no canvas affordance to call
    it yet. A deliberate cut: the plan's own checklist for this phase is entirely about the
    subsystem (node kind, seed, registry, gateway, tables, recovery), and a management UI is a
    separable, later piece of work — same category of cut as Spotify's Connect button being the
    only plugin with dedicated UI beyond the generic manifest-driven surfaces.
  - **No e2e spec** (Playwright can't drive a real Discord gateway) — coverage instead comes from
    `packages/server/src/triggers/registry.test.ts`, which drives `DiscordTriggerSource` through
    an injected fake `DiscordGateway` end to end (admission, channel allowlist, self-message
    guard, dedupe-on-redelivery, and the recovery scan's cursor/window/reverse-ordering logic),
    plus `routes/triggers.test.ts` for the HTTP-layer registration gate. This matches
    PLAN-INTEGRATIONS.md §8's own instruction for this phase exactly ("Drive DiscordTriggerSource
    through an injected event emitter").
- **PLAN-FLOW-DSL.md landed in full (S1–S5): `@flowlathe/dsl`, `@flowlathe/cli`, the file-backed
  flow store, and canvas integration.** Flows now live as `.flow` text (`FLOWLATHE_FLOWS_DIR`,
  default `./flows`); SQLite still owns everything about running one. Things that surprised the
  implementing agent:
  - **A `.flow` file's edges have no textual representation for their id, and only an explicit
    representation for handles.** `a.port -> b.port` always shows both handles (§3.3's explicit-
    handles decision), so `parse(print(g))` can't reproduce an original edge whose `sourceHandle`/
    `targetHandle` was `undefined` (defaulted) or whose `id` was some arbitrary pre-existing
    string — both get canonicalized (`@flowlathe/dsl`'s `canonicalEdgeId`, derived from the four
    endpoint fields; missing handles filled with `"output"`/`"input"`). This is the *correct*
    behavior for a hand-authored file (there's nothing else for these to canonicalize to), but it
    means the round-trip property test can't assert literal deep-equality against an arbitrary
    pre-DSL `FlowGraph` — it has to normalize both sides first (`normalizeForRoundTrip`, exported
    for exactly this). Golden-fixture graphs with an omitted `sourceHandle` (there are several)
    would otherwise look like round-trip failures that aren't.
  - **A TypeScript function typed to return `never` does NOT reliably narrow control flow in this
    codebase's strictness config when called as a bare statement** (`if (cond) error(msg);` — a
    small helper throwing `DslError`) — the code after it still gets flagged "used before being
    assigned" / union-not-narrowed, contrary to the commonly-cited TS behavior for never-returning
    calls. Two workarounds that do work reliably: use it as one arm of a ternary (`cond ? value :
    error(msg)`, since ternary type inference just drops the `never` arm), or an actual `return
    error(msg)` statement (a genuine `return` is always understood as terminating, regardless of
    what's returned). `packages/dsl/src/parse.ts` uses both, depending on whether bailing out of
    the *whole* enclosing function is acceptable at that point.
  - **`flowlathe`'s bin can't `module.register("tsx/esm", ...)` in-process** — tsx's own loader
    refuses that path at runtime ("tsx must be loaded with --import instead of --loader"). The
    fix, `packages/cli/bin/flowlathe.js`: resolve tsx's loader file via `import.meta.resolve("tsx")`
    (not the bare specifier `"tsx"`, which resolves against the *child* process's cwd and fails
    unless that happens to be this package) and re-exec as `node --import <resolved path> <cli
    entry> ...args` via `spawnSync`, explicitly *not* changing the child's cwd — the whole point
    is that relative file arguments on the command line should resolve where the user actually
    ran `flowlathe` from, not inside `packages/cli`.
  - **`flows.id` now defaults to a slugified form of the flow's name instead of a `randomUUID()`**
    (`createFlow`, `@flowlathe/persistence`) — required for "the file's basename is the flow's
    stable identifier" (§4.1) to hold for anything created after this change. Flows that already
    existed before S3 keep their UUID ids untouched (`flow_versions` rows are never rewritten);
    `flowlathe flows export`/the boot-time auto-export mint a *fresh* slug-named file for such a
    flow, so re-syncing that file back creates a second, separate flow row rather than reconciling
    with the original UUID one. A real, deliberately unresolved migration gap — see
    `exportAllFlowsToDir`'s doc comment in `packages/server/src/flow-store.ts`.
  - **A playwright config module gets evaluated independently per Node process** (the main CLI
    process that starts `webServer`, and each worker process that then imports the config to run
    a spec file) — `export const flowsDir = join(tmpdir(), \`...${randomUUID()}\`)` computed once
    at module scope produced two *different* directories, because `randomUUID()` reran in each
    process. Fixed by stashing the resolved value in `process.env` on first evaluation and reading
    it back on the next: workers inherit their parent's env, so this is a real "compute once,
    others see it," even though there is no shared module cache to rely on for it. Any future
    e2e-config value a spec file needs to match against something in `webServer.env` will hit the
    same trap.
  - **fs.watch-on-WSL2 unreliability (design trap 4) was not verified inside this environment** —
    no interactive editor session was available in-sandbox to reproduce the failure mode the plan
    warns about (an editor's atomic-rename write). `packages/server/src/flow-store.ts`'s
    `watchFlowsDir` was built and tested (including a real, non-mocked `fs.watch` smoke test
    against a manually booted server) only against plain `writeFile` on this machine's actual
    filesystem, where it worked correctly. Test the real editing workflow — not just `writeFile`
    — before trusting this on WSL2, per the plan's own instruction.
