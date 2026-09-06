<!--
Handoff document. Written for an implementing agent picking this up cold.

- "Locked decisions" were settled with the project owner. Don't relitigate them.
- Build in phase order. Each phase ends runnable, tested, and e2e-green before the next begins.
- Read PLAN.md (architecture source of truth) and CLAUDE.md (surprises log) first; this document
  assumes both, and leans especially hard on CLAUDE.md's Slice-6 / tool-registry entries.
- Dependency versions are NOT pinned here. Verify each against the npm registry at implementation
  time and record the pin, per the TS-7 lesson in CLAUDE.md.
-->

# Implementation plan — SearXNG, Firecrawl, and Discord integrations

**Status:** not started.
**Depends on:** nothing outstanding. The tool-registry path (Slice 6) is complete and is the
substrate for all of this.
**Related:** `PLAN-FLOW-VERSIONING.md` (Phase E's triggers must run a *pinned* flow version, not
HEAD), `PLAN-FLOW-DSL.md` (a triggered flow is a headless run of a file-backed flow).

---

## 1. Locked decisions

| Decision | Choice | Why |
|---|---|---|
| SearXNG / Firecrawl surface | **Tools first, then deterministic node kinds** | The tool path is nearly free (Spotify precedent). But a visual flow builder whose premise is per-step debuggability wants "scrape this URL" to be a wired, inspectable step with ports — not something a model may or may not decide to do |
| Discord scope | **Outbound tools, then inbound triggers** | Tools are the Spotify shape again. Triggers are a genuinely new subsystem (flowlathe has no way to start an execution except the canvas) and get their own phase |
| Plugin packaging | **`packages/plugins/<name>`, registered by a static list in `packages/server/src/index.ts`** | Unchanged from Spotify/MCP. No dynamic loading, no arbitrary-code surface |
| Secure default | **Unset env var ⇒ zero tool registrations** | Mirrors `SPOTIFY_CLIENT_ID` and `MCP_ALLOWED_COMMANDS` |
| Network access in nodes | **Injected through `RuntimeHost`, never a bare global `fetch`** | The parity harness must stay deterministic and offline. Same lesson as `SpotifyClient`'s `fetchImpl` (CLAUDE.md) |
| Compiled-script support | **SearXNG/Firecrawl toolsets become standalone-capable; Discord does not** | A stateless HTTP tool configured by one env var is reconstructible in an exported script. An OAuth/gateway plugin is not — see §4.4 |

---

## 2. What already exists to build on

Read these before writing anything; every piece below is already in place and generic.

- **`ToolRegistration`** (`packages/core/src/contracts.ts:47`) — `{toolset, spec, handler, unavailableReason?}`.
  Lives in `core` (not `runtime`) precisely so a plugin package depends on `@flowlathe/core` alone;
  copy `packages/plugins/spotify/package.json` verbatim for a new plugin's manifest.
- **`createToolRegistry` / `stateToolset`** (`packages/runtime/src/tool-registry.ts`) — the registry a
  `PromptSpec` opts into by name via `enabledToolsets`.
- **Workflow dependency gate** — `requiredToolsets(graph)` / `findMissingToolsets(regs, required)`
  (`packages/core/src/plugin-deps.ts`), enforced in four places already: the canvas banner
  (`packages/web/src/pages/Canvas.tsx:455`), `GraphEngine`'s constructor, `/run` + `/step-start`
  (409, `packages/server/src/routes/flows.ts:69,91`), and the compiled script's
  `REQUIRED_PLUGIN_TOOLSETS` guard (`packages/compiler/src/compile-graph.ts:121`).
  **A new toolset inherits all four for free.** Do not add a parallel check.
- **`/api/plugins/status`** (`packages/server/src/routes/plugins-spotify.ts:46`) — toolset-keyed
  aggregate `{[toolset]: {configured, connected}}`. The canvas maps over its keys for both the
  banner and the per-node toolset checkboxes (`Canvas.tsx:801`), so **a new toolset needs zero
  Canvas.tsx changes to get a working checkbox.**
- **Credential storage** — `plugin_credentials` (pluginId → one opaque AES-256-GCM string,
  `packages/persistence/src/plugin-credentials.ts`). Deliberately generic; a Discord bot token or a
  Firecrawl API key fits it without a new table.

**Rename note.** `registerSpotifyPluginRoutes` (`packages/server/src/routes/plugins-spotify.ts`) now
owns the generic `/api/plugins/status` route plus MCP statuses. Phase A should rename that module to
`routes/plugins.ts` / `registerPluginRoutes` and move Spotify's OAuth routes into their own
`routes/plugins-spotify.ts` — the file's own comment already flags this as due "if a third [plugin]
needs the same treatment." Three more are arriving.

---

## 3. Phase A — SearXNG toolset

SearXNG is a self-hosted metasearch engine with a JSON API. It is the easiest possible first
integration: one base URL, no auth, no state.

**Package:** `packages/plugins/searxng` → `@flowlathe/plugin-searxng`, depending on `@flowlathe/core`
only.

```
src/client.ts    SearxngClient  { baseUrl, fetchImpl }  — one method: search(query, opts)
src/tools.ts     createSearxngToolset(client): ToolRegistration[]
src/index.ts     export * from both
```

**Config:** `SEARXNG_BASE_URL` (required — unset ⇒ no registrations). Optional
`SEARXNG_ENGINES`, `SEARXNG_LANGUAGE`, `SEARXNG_SAFESEARCH` defaults.

**Tool:** one tool, `searxng_search`, following `SPOTIFY_SEARCH_TOOL`'s shape
(`packages/plugins/spotify/src/tools.ts:62`):

```ts
{ query: string, categories?: string, engines?: string, limit?: number, timeRange?: string }
```

Return a compact JSON array of `{title, url, snippet, engine}` — not the raw response. Spotify's
`summarizeSearchResults` is the model to follow: **a tool result is prompt context, so trim it.**
Reuse `asStringArray`/`clampLimit`-style argument coercion; models are inconsistent about list
arguments (that helper's comment says why).

**`unavailableReason`:** a cached liveness probe. `GET {baseUrl}/config` at registration time and on
a 60 s TTL; report `"SearXNG at <baseUrl> is not reachable"` when it fails. Unlike Spotify's
`isConnected()` (a pure local check on a stored refresh token) this touches the network, so it must
be non-blocking and cached — `findMissingToolsets` is called on a request path (`/run`) and on every
`GraphEngine` construction, including every step-mode restore.

**Untrusted output.** Search results are attacker-influenceable text landing in a model's context —
the same threat class as an MCP tool description. Reuse the sanitizer already written for that:
`packages/plugins/mcp/src/sanitize.ts`. If its current API only covers tool names/descriptions,
generalize it into a shared `sanitizeUntrustedText` there and import it; do not write a second one.

**Tests:** `client.test.ts` against an injected `fetchImpl` (never the network — the
`SpotifyClient` refresh-token bug in CLAUDE.md is exactly this mistake), `tools.test.ts` for
argument coercion, result trimming, and the error-to-string path.

---

## 4. Phase B — Firecrawl toolset

**Package:** `packages/plugins/firecrawl` → `@flowlathe/plugin-firecrawl`.

**Config:** `FIRECRAWL_API_KEY` (required), `FIRECRAWL_BASE_URL` (optional — self-hosted
Firecrawl is a first-class case and fits flowlathe's local-first premise). The key is a real secret:
store it via `plugin_credentials` if entered through the UI, or read it from env at boot. **It must
never reach a compiled script as a literal** — see §4.4.

**Tools (three, mirroring the API's three useful shapes):**

| Tool | Args | Returns |
|---|---|---|
| `firecrawl_scrape` | `url`, `formats?` (`markdown`\|`html`), `onlyMainContent?` | page content, truncated to a `maxChars` cap |
| `firecrawl_crawl` | `url`, `limit?`, `maxDepth?`, `includePaths?` | list of `{url, title, content}` |
| `firecrawl_map` | `url`, `search?` | list of discovered URLs (cheap; good for a "which pages exist" step) |

Firecrawl's crawl endpoint is **asynchronous** (submit → poll a job id). Handle the polling inside
the client with a bounded wall-clock budget (`FIRECRAWL_CRAWL_TIMEOUT_MS`, default 120 s) and return
a clear timeout string rather than hanging a node forever. A tool handler that never returns is
indistinguishable from a hung provider call in the UI.

**Content size is the real hazard.** A scraped page can be hundreds of KB; dropped into a local
model's context it will blow the window and silently degrade every downstream node. Enforce a
`maxChars` (default ~20 000, overridable per call) in the client, and append an explicit
`"[truncated N of M chars]"` marker so the model knows it saw a prefix.

**`unavailableReason`:** `"Firecrawl is not configured (set FIRECRAWL_API_KEY)"` when unset; a
cached auth probe otherwise.

### 4.4 Making these two toolsets work in exported scripts

Today `compileGraph` embeds `requiredToolsets(graph)` as `REQUIRED_PLUGIN_TOOLSETS` and the emitted
`main()` refuses to run if it is non-empty (`compile-graph.ts:121,146`). That is correct for Spotify
(OAuth tokens live in the server's DB) and for MCP (server-side config file), but it is *too strict*
for SearXNG and Firecrawl, whose entire configuration is one or two env vars. A flow that searches
the web should still export to a runnable script — that is the stated product goal.

**Design.** Add an optional field to `ToolRegistration`:

```ts
/** How an exported, server-less script can reconstruct this toolset from environment alone.
 *  Absent ⇒ the toolset is server-only and a compiled script using it refuses to run. */
standalone?: {
  /** Package the emitted script imports, e.g. "@flowlathe/plugin-searxng". */
  module: string;
  /** Named export the script calls, e.g. "searxngToolsetFromEnv". */
  factory: string;
  /** Env vars the script should document as required. Names only — never values. */
  env: string[];
};
```

`compileGraph` then partitions `requiredToolsets(graph)` into standalone-capable and not:

- standalone-capable → emit the import and add `...searxngToolsetFromEnv()` to the existing
  `createToolRegistry(stateToolset(state))` call, plus a generated comment listing the required env
  vars.
- not → keep today's `REQUIRED_PLUGIN_TOOLSETS` refusal, with the message narrowed to just those.

`compileGraph` needs the registration list to do this, so `CompileOptions` grows
`toolsets?: ToolRegistration[]` and `/api/flows/:id/export` (`routes/flows.ts:105`) passes the
server's `pluginToolsets`. **Secrets stay out**: the emitted code calls `…FromEnv()`, which reads
`process.env` at runtime — matching PLAN.md's "emit `process.env.OLLAMA_BASE_URL`-style references."

Covered by extending `packages/testing/src/plugin-gate.test.ts`, which already spawns the compiled
script rather than asserting on source text: one fixture whose toolset is standalone-capable (runs,
against a local fixture HTTP server) and one that is not (exits 1 with the message).

---

## 5. Phase C — deterministic `search` and `fetch` node kinds

Tools let a model decide to search. Nodes let an author *wire* a search: ports, a visible box on the
canvas, a `node_started`/`node_finished` pair in the log, a snapshot boundary, step-debuggable, and
a deterministic line in the compiled script. Both are wanted; this phase adds the second.

### 5.1 The NodeKind checklist (tsc enforces most of it)

Adding a kind to `NODE_KINDS` (`packages/core/src/node-kind.ts:1`) makes **three** `Record<NodeKind, …>`
tables fail to compile until filled in — that is the anti-drift device from PLAN.md, and it is the
reason this list is short and safe:

1. `packages/nodes/<kind>/src/{schema,run,emit}.ts` + `index.ts` (copy `packages/nodes/gate` — it is
   the smallest complete example).
2. `packages/interpreter/src/registry.ts` — `schema`, `inputPorts`, `outputPorts`, `dispatch`.
3. `packages/compiler/src/emit-table.ts` — **both** `emitTable` and `schemaTable`. The `schemaTable`
   entry is not optional: a schema field with a `.default()` that skips it is the exact parity bug
   CLAUDE.md documents for `enabledToolsets`.
4. `packages/runtime/src/run.ts` — a method on `Run` (`search(spec, inputs)`, `fetch(spec, inputs)`)
   delegating to the node package's `run*` function. One implementation, two callers (interpreter
   and generated code). Never a second implementation in the compiler.
5. `packages/web/src/nodes/` — a node view + `node-types.ts` entry, and the kind added to
   `NODE_KIND_OPTIONS` (`Canvas.tsx:89`).
6. A golden parity fixture in `packages/testing/src/golden/`.

### 5.2 Port shapes

Follow the existing template-variable convention exactly — input ports are derived from a template
string via `extractTemplateVars`, as `prompt`, `loop`, and `map` all do (`registry.ts`):

```ts
// search
{ label?, queryTemplate: string, toolset: "searxng", limit?, categories? }
  inputPorts  = extractTemplateVars(queryTemplate)   // required
  outputPorts = ["results"]        // JSON array string: [{title,url,snippet}]

// fetch
{ label?, urlTemplate: string, toolset: "firecrawl", format?, maxChars? }
  inputPorts  = extractTemplateVars(urlTemplate)
  outputPorts = ["content"]        // markdown/text, truncation-marked
```

**Handle-naming trap.** `PromptNodeView`'s target handle is hardcoded `id="input"` (CLAUDE.md), which
is why every prompt template in this codebase uses `{{input}}`. A new node view must either render
one handle per extracted template variable, or adopt the same single-`input` convention and be
documented as such. **Render one handle per variable** — this is a new view with no legacy fixtures
to preserve, and the single-handle shortcut is already a known footgun. Give each handle
`id={varName}` and lay them out down the left edge.

### 5.3 Network access, and keeping parity deterministic

These nodes perform I/O that neither the parity harness nor the e2e suite may actually do. Add one
capability to `RuntimeHost` (`packages/core/src/contracts.ts:138`):

```ts
/** Outbound HTTP for node kinds that fetch (search/fetch). Injected — never a bare global
 *  `fetch` — so the parity harness, unit tests, and e2e run fully offline against a stub.
 *  Node's global fetch is the production value; core stays isomorphic because this is a type. */
net: { fetch: typeof globalThis.fetch };
```

Every hand-built `RuntimeHost` needs the new field (there are several in tests — `tsc` will find
them all; `packages/nodes/gate/src/run.test.ts:11` is the canonical fake). `host-builder.ts` supplies
the real one on the server; the compiled script emits `net: { fetch: globalThis.fetch }`; the parity
harness supplies a table-driven stub keyed by `(nodeId, sha256(renderedUrlOrQuery))` — deliberately
the same shape as the mock provider's response table, so a template-rendering regression surfaces as
a *missing key* rather than a different answer (PLAN.md, design trap 8).

**Do not** route these through `ProviderScheduler`. It exists to protect VRAM residency; an HTTP
GET is not a model call and must not consume a model-affinity queue slot. If crawl concurrency
needs limiting later, that is a per-plugin semaphore inside the client.

### 5.4 Relationship to the toolsets

The node kinds are a *different front end to the same client*, not a fork of it. `runSearch` calls
the same `SearxngClient` the `searxng_search` tool handler calls. The node's `toolset` field names
which plugin backs it, so the existing dependency gate covers node-driven use too — but
`requiredToolsets(graph)` currently scans only `enabledToolsets` (`plugin-deps.ts:9`). Extend it to
also collect `node.data.toolset` for these kinds, keeping it kind-agnostic (read the field if it is
a string; don't switch on `node.type`), and add a test pinning that a `search` node alone trips the
canvas banner.

---

## 6. Phase D — Discord outbound toolset

**Package:** `packages/plugins/discord` → `@flowlathe/plugin-discord`.

**Auth:** a bot token, stored via `plugin_credentials` under pluginId `discord`
(`setPluginCredential`/`getPluginCredential`), configured by `DISCORD_BOT_TOKEN` at boot or entered
in the UI. **No OAuth dance** — a bot token is a static secret, which makes this strictly simpler
than Spotify.

**Client:** hand-rolled REST over `fetch` against `https://discord.com/api/v10`, with an injectable
`fetchImpl`, exactly like `SpotifyClient`. No dependency yet — `discord.js` only becomes necessary in
Phase E, for the gateway.

Discord's REST API returns `429` with a `retry_after` body field and per-route buckets. Honor it in
the client with a bounded retry; `packages/providers/src/retry-after.ts` already parses the header
form and should be reused rather than duplicated.

**Tools:**

| Tool | Args | Notes |
|---|---|---|
| `discord_send_message` | `channelId`, `content`, `replyToMessageId?` | Chunk at 2000 chars; return the created message id |
| `discord_read_messages` | `channelId`, `limit?`, `before?` | Trimmed `{id, author, content, timestamp}` |
| `discord_react` | `channelId`, `messageId`, `emoji` | |

**Guardrails — this toolset can act in the world, unlike search/scrape:**

- `DISCORD_ALLOWED_CHANNELS` (comma-separated ids; unset ⇒ **none**, secure default, mirroring
  `MCP_ALLOWED_COMMANDS`). Every tool validates `channelId` against it and returns a clear error
  string otherwise.
- Strip `@everyone`/`@here` and role mentions from outbound content by default
  (`allowed_mentions: {parse: []}` on the REST call), overridable by an explicit
  `DISCORD_ALLOW_MENTIONS=1`. A model that has just read untrusted web content should not be one
  prompt-injection away from pinging a server.
- Message content read back in is untrusted text → same sanitizer as §3.

---

## 7. Phase E — Discord inbound triggers

This is the largest phase and the only one that adds a subsystem rather than a plugin. Today an
execution can only start from `POST /api/flows/:id/run` or `/step-start` (`routes/flows.ts:69,91`),
both invoked by the canvas. Phase E lets an external event start one.

### 7.1 The `trigger` node kind

A trigger is a **node**, not a flow-level config block. Reasons: it is visible on the canvas; it
reuses the readiness lattice unchanged (zero input ports, like `userInput`); it works in the
compiler with no new control-flow concept; and it needs no schema change to `FlowGraph`.

```ts
// packages/nodes/trigger
{ label?, source: "discord" | "manual", channelIds?: string[], testPayload?: string }
  inputPorts  = []
  outputPorts = ["content", "authorId", "channelId", "messageId"]
```

Behavior by start mode:

- **Started from the canvas** (`/run`, `/step-start`): the trigger node resolves immediately to
  `testPayload` (defaulting to an empty string), so a flow with a trigger is still fully
  debuggable at the desk. This is what makes step-debugging a Discord flow possible at all.
- **Started by a trigger source**: its outputs are pre-seeded from the event.

### 7.2 Seeding outputs into a run

`GraphEngine` needs to start with some node already resolved. Add one option:

```ts
// packages/interpreter/src/run-graph.ts
interface RunGraphOptions { seed?: Record<NodeId, Record<PortName, string>>; }
```

Applied once at construction, before the first readiness pass, by writing `value` slots exactly as a
finished dispatch would. It must also be captured in `StepSnapshot` so a step-mode restore of a
triggered execution reproduces it (`packages/server/src/stepper.ts`) — a seeded value that vanishes
on restore would make triggered flows undebuggable in exactly the way this project exists to avoid.
The compiled script's equivalent is `process.argv`/stdin JSON bound to the same node ids.

### 7.3 The trigger runner

New `packages/server/src/triggers/` (server-side, not a plugin package — it owns DB and execution
lifecycle):

```
registry.ts     TriggerRegistry: (source, flowId) -> subscription; start/stop/list
discord.ts      DiscordTriggerSource: gateway connection -> onMessage -> startExecution
routes.ts       GET/POST/DELETE /api/triggers
```

**Gateway connection:** use `discord.js` (verify and pin the version at implementation time). Hand
-rolling heartbeat/resume/intents/reconnect is a week of subtle bugs for no product value. Confine it
to `triggers/discord.ts`; the Phase-D tool client stays dependency-free so the *tool* path is
unaffected if the dependency is later swapped.

**What a trigger record holds** (new table `triggers`):

```
triggers(id, flow_id, flow_version_id, source, config_json, enabled, created_at)
```

`flow_version_id` is **not nullable**. A trigger runs a *pinned* version, never HEAD — see
`PLAN-FLOW-VERSIONING.md` §"Pinning". Editing a flow on the canvas must not silently change what a
live Discord bot does; re-pinning is an explicit action with its own button and its own log line.

**Registration-time validation** (409 with a specific message, reusing the existing gate style):

1. `findMissingToolsets` over the pinned version's graph — same check `/run` already does.
2. The graph contains at least one `trigger` node with `source: "discord"`.
3. The graph contains **no `pause` or `userInput` node**. A headless run cannot answer them and
   would sit in `awaiting_input` forever. (Phase E2 may lift this by resolving `userInput` from a
   Discord reply; until then, refuse clearly rather than hang.)

### 7.4 Event → execution

```
message event
  → allowlist check (guild id, channel id, author is not a bot)
  → dedupe on message.id           (Discord redelivers; see 7.5)
  → rate limit                     (per channel and per author, token bucket)
  → concurrency admission          (max in-flight triggered executions, default 4; reject visibly)
  → startExecution(pinnedVersion, mode: "run", seed: {[triggerNodeId]: {...payload}})
  → on run_finished: post outputs back to the originating channel (Phase D's client)
  → on run_failed:   post a short failure line; full error stays in the execution log
```

The execution is an ordinary row: same SSE stream, same branch tree, same step/step-back tooling. A
triggered run is fully inspectable after the fact in the existing UI, which is most of the value.

Record provenance so "why did this run?" is answerable:

```
execution_triggers(execution_id PK, trigger_id, source, external_id, payload_sha -> blobs, at)
```

`external_id` is the Discord message id and carries a `UNIQUE` constraint — that *is* the dedupe
mechanism, and it survives a server restart, which an in-memory set would not.

### 7.5 Traps specific to this phase

1. **Redelivery.** Gateway resume replays events. Dedupe on message id at the DB level (above), not
   in memory.
2. **Untrusted input is the whole point and the whole risk.** The message body is attacker-authored
   text that flows straight into a prompt and, if the Discord toolset is enabled on the same flow,
   back out into a channel. Sanitize on the way in, keep `allowed_mentions: {parse: []}` on the way
   out, and keep the channel allowlist mandatory. Say so in the README next to the feature.
3. **Runaway loops.** A bot that replies in a channel it also watches will trigger itself. Ignore
   messages authored by the bot's own user id — non-negotiable, and worth a test.
4. **A trigger outlives the canvas session.** The gateway connection must be started at boot for
   every enabled trigger and closed on `SIGINT`/`SIGTERM` alongside `app.close()`
   (`packages/server/src/index.ts:68`).
5. **Boot is already `await`-ing at top level** for MCP discovery (CLAUDE.md). Trigger startup is
   another async boot step; keep it after the app is listening so a slow/failing Discord connection
   cannot prevent the server from serving the UI. A trigger that fails to connect reports through
   `/api/plugins/status`, like an MCP server that fails discovery.

---

## 8. Testing

- **Unit (vitest), per plugin package**: client behavior against an injected `fetchImpl`; argument
  coercion; result trimming/truncation; error-to-string; `unavailableReason` caching. Never the real
  network — the `SpotifyClient` "invalid_client" incident in CLAUDE.md is the cautionary tale.
- **Parity (`packages/testing`)**: golden fixtures for the `search` and `fetch` node kinds, running
  interpreter vs. compiled script against the stubbed `net.fetch` table. Plus the extended
  `plugin-gate.test.ts` cases from §4.4 (standalone-capable toolset runs; server-only one exits 1).
- **Interpreter**: `seed` applied at construction; seed survives snapshot→restore.
- **Server**: trigger registration rejects a flow with `pause`/`userInput`, with missing toolsets, or
  with no trigger node; `execution_triggers` unique constraint dedupes a replayed message id.
- **E2E (`playwright/`)**: one spec per phase, per PLAN.md's verification rule.
  - Phases A–B: a fixture HTTP server stands in for SearXNG/Firecrawl (wire its URL through
    `playwright/playwright.config.ts`'s `webServer` env, the same gap CLAUDE.md flags as *not* done
    for MCP — do it properly here). Assert the dependency banner appears when unconfigured and the
    tool result reaches the node log when configured.
  - Phase C: drag a `fetch` node, wire it to a prompt, run, assert both nodes animate and the log
    shows the truncation marker.
  - Phase E: no live Discord. Drive `DiscordTriggerSource` through an injected event emitter and
    assert an execution row, its `execution_triggers` provenance, and a redelivered id creating no
    second execution.
- **Manual smoke**: a real SearXNG instance and a real Discord test guild, once per phase. Record
  anything surprising in `CLAUDE.md` — that is what it is for.

---

## 9. Definition of done

- [ ] `routes/plugins-spotify.ts` split into a generic `routes/plugins.ts` + Spotify-specific routes.
- [ ] `@flowlathe/plugin-searxng` with `searxng_search`, gated by `SEARXNG_BASE_URL`, cached liveness
      `unavailableReason`, untrusted-text sanitization, unit tests.
- [ ] `@flowlathe/plugin-firecrawl` with scrape/crawl/map, bounded crawl polling, `maxChars`
      truncation marker, unit tests.
- [ ] `ToolRegistration.standalone` + `compileGraph` partitioning; a flow using SearXNG/Firecrawl
      exports to a script that actually runs; `plugin-gate.test.ts` extended both ways.
- [ ] `RuntimeHost.net` added; every hand-built host updated; parity stub table in place.
- [ ] `search` and `fetch` node kinds complete across all six checklist points in §5.1, with golden
      parity fixtures and per-variable handles in their node views.
- [ ] `requiredToolsets` also collects node-level `toolset` fields; canvas banner test pins it.
- [ ] `@flowlathe/plugin-discord` outbound toolset with channel allowlist, mention stripping, 429
      handling via the existing `retry-after` helper.
- [ ] `trigger` node kind; `GraphEngine` `seed` option, snapshotted and restored.
- [ ] `TriggerRegistry` + `DiscordTriggerSource` + `/api/triggers`; `triggers` and
      `execution_triggers` tables; version pinning enforced; self-message loop guard.
- [ ] Trigger registration validation (missing toolsets / no trigger node / contains pause|userInput).
- [ ] E2E spec per phase; README updated (config env vars, the trust model for inbound messages).
- [ ] `CLAUDE.md` updated with whatever surprised the implementing agent.
