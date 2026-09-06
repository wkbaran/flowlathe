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
- **Compiled-script Router branches are exactly one node deep before converging (v1 scope gap,
  interpreter has no such limit).** `compile-graph.ts` only special-cases nodes *directly* targeted
  by a Router edge (guarding them with `if/else if` and declaring them `let ... | undefined`);
  anything further downstream in a branch is emitted as an unconditional call that will throw on
  `undefined.output` at runtime if that branch wasn't taken. The interpreter's PortSlot propagation
  has no such restriction — it handles arbitrarily long/branching chains correctly. Don't add a
  golden parity fixture with a multi-node-deep branch without extending the compiler's guard
  propagation first (a general dominator-frontier walk), or the compiled path will crash where the
  interpreter succeeds.
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
  - **State does not fork across branches.** `state_writes`/`state_reads` carry `branch_id`, but
    `stepBack` (Slice 4) never copies a branch's state rows onto the new fork — a step-mode
    `StateStore` is rebuilt fresh on every `stepOnce` call by replaying only `listStateWritesForBranch`
    for the *current* branch (`packages/runtime/src/state-store.ts`'s `replay` option), so a forked
    branch's state starts empty rather than inheriting pre-fork writes. Port-value forking has no
    such gap (Slice 4 got that right); state does, for now — walking `branches.parent_branch_id` to
    accumulate ancestor writes is the fix, not yet built.
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
