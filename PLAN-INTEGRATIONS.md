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

## 2. What to build on

### 2.1 In this repo (already in place and generic)

Read these before writing anything.

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

### 2.2 What to mine from `hermes-agent` (`/home/bill/github/hermes-agent`)

**All three of these integrations already exist there, in production**: `plugins/web/searxng/`,
`plugins/web/firecrawl/` (+ `plugins/browser/firecrawl/`), and `plugins/platforms/discord/`
(a 7 400-line adapter). It is Python against a different architecture, so — exactly as with Flowise
in PLAN.md — **lift the pattern, not the code.** The value is that it has been hit by real failures
and the fixes are in the comments. Survey done; the table below is what to take.

**Worth copying:**

| Source | What to take |
|---|---|
| `plugins/web/_common.py` | A shared `_common` for the web-ish plugins: uniform result envelopes (`search_ok`/`search_fail`/`title_hit`/`document`/`page_error`), one guarded-execution wrapper (`run_search`/`run_extract`) that classifies failures identically everywhere, and `http_get_json` with a `reach_target` so the error names the actual host. Its comment "**key order is part of the contract — it reaches the model as JSON**" is the right instinct: a tool result is prompt text |
| `plugins/web/_common.py` | Per-URL failures are **returned as entries carrying `error`, never raised** — one bad URL in a batch must not fail the batch |
| `plugins/web/searxng/provider.py` | The whole SearXNG call: `GET {base}/search?q=&format=json&pageno=1` with `Accept: application/json`, then **sort by the `score` field descending** before capping to `limit`. Also `SEARCH_LIMIT_CAP = 20` — every vendor in that tree caps server-side at 20 |
| `plugins/web/firecrawl/provider.py` | `_scrape_one`: a 60 s per-URL timeout whose message names an alternative (`"page may be too large or unresponsive. Try browser_navigate instead"`), and — the important one — **re-validating SSRF + site policy against the POST-REDIRECT final URL** (`metadata.sourceURL`), not just the requested one |
| `tools/url_safety.py` | The URL-safety layer flowlathe has no equivalent of. See §4.5 |
| `plugins/platforms/discord/adapter.py` | `_build_allowed_mentions()` applied **at client construction**, not per-send; `MAX_SPLIT_MESSAGES = 8` (from a real incident: 60 698 chars delivered as 31 back-to-back messages); privileged-intents failure guidance; the dedup claim-vs-check split |
| `plugins/platforms/discord/recovery.py` | A durable per-channel cursor ledger + post-reconnect REST scan. See §7.6 |
| `plugin.yaml` (`requires_env` / `optional_env` with `{name, description, prompt, url, password}`) and `get_setup_schema()` | A **declarative config manifest per plugin**, so a setup UI renders generically instead of hardcoding each plugin's form. See §2.3 |
| `plugins/plugin_storage.py` | "Secrets are deliberately NOT part of this convention — credential reads go through `secret_scope`/`.env`." flowlathe already splits these (`plugin_credentials` vs. config); this is confirmation, not new work |

**Do not copy:**

- The provider-resolution logic in `plugins/web/firecrawl/provider.py` (`_get_firecrawl_client`,
  `_use_keyless_ring`, keyless-ring vs. direct vs. managed-gateway precedence, ~120 lines of
  selection state). That complexity exists to serve Nous's hosted subscription tiers. flowlathe has
  one question to answer: is `FIRECRAWL_API_KEY`/`FIRECRAWL_BASE_URL` set.
- The lazy-SDK proxy (`_FirecrawlProxy`, `lazy_ensure`) — a Python cold-start concern with no TS
  analogue. Use plain `fetch`; do not take a Firecrawl SDK dependency.
- `_to_plain_object` / `_extract_web_search_results`'s multi-shape response normalization — that is
  the cost of accepting SDK objects, direct REST, and a gateway all at once. Pick REST, type it once.
- The whole `PLUGIN-COMPAT` `__getattr__` machinery — an external-plugin-ecosystem problem
  flowlathe explicitly does not have (compile-time, single-author plugins).
- `plugins/platforms/discord/` at large: voice mixing, slash-command trees, session/approval
  routing, free-response channels. flowlathe's Phase E is "a message starts an execution," not a
  chat client.

### 2.3 Generalize `/api/plugins/status` into a plugin manifest

Hermes's `plugin.yaml` `requires_env`/`optional_env` and the web providers' `get_setup_schema()`
solve a problem flowlathe is about to hit four times over: the canvas currently knows Spotify
specifically (a "Connect" button) and treats everything else as a bare `{configured, connected}`
pair. With SearXNG, Firecrawl, and Discord arriving, add a declarative descriptor alongside the
registrations:

```ts
export interface PluginManifest {
  toolset: string;                 // "searxng", "firecrawl", "discord", "mcp:<name>"
  displayName: string;
  description: string;
  env: { name: string; description: string; required: boolean; secret: boolean; docsUrl?: string }[];
  /** Present only for plugins needing an interactive grant (Spotify). */
  connect?: { startPath: string; disconnectPath: string };
}
```

`/api/plugins/status` returns manifests alongside status, and the canvas renders setup and the
dependency banner from data — no per-plugin UI code, and `displayName()`'s `mcp:` special-case
(`Canvas.tsx:129`) becomes a manifest field instead of a string prefix test. Do this in Phase A,
while there are two plugins to migrate rather than five.

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
`SEARXNG_ENGINES`, `SEARXNG_LANGUAGE`, `SEARXNG_SAFESEARCH` defaults. (Hermes names this
`SEARXNG_URL`; keep flowlathe's `_BASE_URL` suffix for consistency with `FIRECRAWL_BASE_URL` and
`OLLAMA_BASE_URL`, and mention the alias in the README for anyone moving a config across.)

**The actual call**, taken from `plugins/web/searxng/provider.py` rather than rediscovered:

```
GET {baseUrl}/search?q=<query>&format=json&pageno=1     Accept: application/json
→ { results: [{ title, url, content, score, engine }, ...] }
```

Two non-obvious details from that implementation: the response field carrying the snippet is
`content`, not `description`/`snippet`; and results arrive **unsorted** with a `score` field, so
sort descending by `score` before capping to `limit`. Cap `limit` at 20 — Hermes's `_common.py`
notes every vendor in that tree caps at 20 server-side anyway.

**Tool:** one tool, `searxng_search`, following `SPOTIFY_SEARCH_TOOL`'s shape
(`packages/plugins/spotify/src/tools.ts:62`):

```ts
{ query: string, categories?: string, engines?: string, limit?: number, timeRange?: string }
```

Return a compact JSON array of `{title, url, snippet, engine}` — not the raw response. Spotify's
`summarizeSearchResults` is the model to follow: **a tool result is prompt context, so trim it.**
Reuse `asStringArray`/`clampLimit`-style argument coercion; models are inconsistent about list
arguments (that helper's comment says why).

**Extract a shared `packages/plugins/_common` while writing this**, mirroring
`plugins/web/_common.py`. Three plugins in this document all need the same four things, and Spotify's
`toolError`/`requireString`/`asStringArray`/`clampLimit` (`packages/plugins/spotify/src/tools.ts:1-60`)
are already a private first copy of them:

- `toolOk(data)` / `toolFail(message)` — one result envelope. Hermes's comment is the reason to fix
  the shape now rather than later: **key order is part of the contract, because it reaches the model
  as JSON.** Three plugins each inventing an error shape teaches a local model three formats.
- `guarded(vendor, kind, fn)` — one failure classifier, so "unreachable host", "HTTP 4xx with a
  body", and "unparseable JSON" read the same from every plugin.
- `httpGetJson(label, url, {params, headers, timeoutMs, reachTarget})` — `reachTarget` is why
  SearXNG's unreachable message can name the instance URL, which is the single most useful thing it
  can say to someone self-hosting.
- Argument coercion, moved out of Spotify's file rather than copied a third time.

**Cancellation is a real gap, and this is where it shows up.** `ProviderCallRequest` carries an
`AbortSignal` (`packages/core/src/contracts.ts:70`) and PLAN.md requires step-back to abort in-flight
provider calls — but `ToolRegistration.handler` has no signal at all
(`contracts.ts:50`), so a 60-second Firecrawl crawl or a slow SearXNG query cannot be cancelled by
step-back, cancel, or a branch fork. Hermes checks `is_interrupted()` before each call *and between
URLs in a batch* for exactly this reason. **Add `signal: AbortSignal` to `ToolInvokeMeta`** in Phase
A, while there is one non-trivial consumer, and thread it from the tool-loop in `runPrompt` through
`ToolRegistry.invoke`. Every handler in this document then honors it; the state tools ignore it
harmlessly.

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

Hit the REST API (`POST /v2/search`, `POST /v2/scrape`) directly with `fetch` — **do not take the
Firecrawl SDK dependency.** Hermes's own keyless path is a 6-line REST client
(`_KeylessFirecrawlClient`), while its SDK path costs a lazy-import proxy plus ~40 lines of
`_to_plain_object` response normalization to paper over SDK objects vs. dicts. Typing one REST shape
is strictly less work.

Firecrawl's crawl endpoint is **asynchronous** (submit → poll a job id). Handle the polling inside
the client with a bounded wall-clock budget (`FIRECRAWL_CRAWL_TIMEOUT_MS`, default 120 s) and return
a clear timeout string rather than hanging a node forever. A tool handler that never returns is
indistinguishable from a hung provider call in the UI. Per-URL scrapes get their own 60 s timeout
(Hermes's figure, and its message names a fallback: *"page may be too large or unresponsive"* — say
what to try next, not just that it failed).

**A multi-URL call returns per-URL results, never a whole-batch failure.** One dead link in a crawl
must produce `{url, error}` in its slot and leave the rest intact — `plugins/web/_common.py`'s
`extract_fail`/`page_error` shape. Check the abort signal between URLs, too, not only before the
first.

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

### 4.5 URL safety — the gap this survey exposed

flowlathe has **no URL-safety layer at all**, and until now hasn't needed one: every outbound URL in
the codebase is operator-configured (an Ollama base URL, an MCP server URL). CLAUDE.md records
dropping Flowise's SSRF `checkDenyList` for the MCP HTTP path on exactly that reasoning — "less
relevant when the operator configured the URL themselves."

**Firecrawl and the `fetch` node break that assumption.** The URL comes from a model's tool
arguments, from a template rendered out of an upstream node's output, or from a link inside a page
that was itself scraped. It is attacker-influenceable, and the request originates from a server
sitting on the user's LAN next to an Ollama instance and a SQLite file.

Port `tools/url_safety.py`'s *checks* (not its code) into a small `packages/core/src/url-safety.ts`
— isomorphic, zero-I/O, so the canvas can warn at edit time and the server enforce at call time:

1. **Scheme allowlist** — `http`/`https` only. Rejects `file:`, `gopher:`, `data:`.
2. **Private/internal address blocking** — RFC1918, loopback, link-local, unique-local, plus
   `.local`/`.internal`. Escape hatch: an explicit `FLOWLATHE_ALLOW_PRIVATE_URLS=1` for someone
   deliberately scraping their own intranet.
3. **Cloud metadata endpoints are blocked unconditionally**, escape hatch or not —
   `169.254.169.254`, `metadata.google.internal`, `fd00:ec2::254`. This is the one Hermes calls out
   as never overridable, and it is right.
4. **Re-validate the post-redirect final URL.** A public URL that 302s to `127.0.0.1` defeats every
   check above. Firecrawl reports the final URL as `metadata.sourceURL`; check it before returning
   content, and say `"Blocked: URL targets a private or internal network address"`. For the `fetch`
   node's own requests, follow redirects manually and validate each hop.
5. **Refuse to hand credential-bearing URLs to a third party.** `sensitive_query_param_name` blocks
   a URL carrying `access_token`, `api_key`, `client_secret`, `signature`, `x_amz_signature`, … A
   flow that scrapes a magic link would otherwise ship the user's credential to Firecrawl's cloud.
   Hermes's list is deliberately narrow (`code`, `key`, `session` are *excluded* as ordinary page
   facets) — copy the narrowness, not just the idea.
6. **Normalize before requesting** — IDNA-encode the host, percent-encode non-ASCII, and repair the
   `https:// example.com` whitespace models emit after the scheme separator. That last one is a
   one-line regex fixing a failure mode small local models produce constantly.

Not ported: DNS-rebinding (TOCTOU) closure, which Hermes solves by re-applying policy at TCP connect
and dialing the validated IP with Host/SNI preserved. That needs a custom agent/connector, is a
meaningful chunk of work, and the threat (an attacker who controls DNS *and* is targeting a
single-user local server) is thin. **Record it as a known, deliberate gap** in the module's doc
comment — the same way CLAUDE.md records the MCP SSRF decision — rather than leaving the next agent
to wonder whether it was considered.

Tests: a table of URLs → expected verdict, including each metadata endpoint, a decimal-encoded IP
(`http://2130706433/`), a public host that redirects to loopback, and a signed S3 URL.

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

**Both node kinds go through §4.5's URL safety**, and the `fetch` node gets it twice over: the
canvas can validate a *literal* `urlTemplate` (one with no `{{vars}}`) at edit time and show the
same inline validation error style `validationErrors` already uses, while the runtime validates the
rendered URL on every activation. A template that renders to a blocked URL fails the node with the
blocked reason in the log — not silently empty content.

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

**Guardrails — this toolset can act in the world, unlike search/scrape.** Each of these is a
lesson from `plugins/platforms/discord/adapter.py`, several of them incident-driven:

- `DISCORD_ALLOWED_CHANNELS` (comma-separated ids; unset ⇒ **none**, secure default, mirroring
  `MCP_ALLOWED_COMMANDS`). Every tool validates `channelId` against it and returns a clear error
  string otherwise. Hermes's env precedent is `DISCORD_ALLOWED_USERS` +
  `DISCORD_ALLOW_ALL_USERS` ("dev only") — take both names and both semantics.
- **`allowed_mentions` is set once, on the client, not per call.** Hermes's `_build_allowed_mentions()`
  denies `@everyone`/`@here` and role pings by default while leaving user and reply pings on, and
  wires it into the client constructor so **no send path can forget it**. A per-call parameter is
  one missed call site away from a model that just read a hostile web page pinging the whole server.
  Per-category overrides (`DISCORD_ALLOW_MENTION_EVERYONE`, `_ROLES`, `_USERS`, `_REPLIED_USER`)
  are a better shape than one blunt `DISCORD_ALLOW_MENTIONS`.
- **Chunk at 1900, not 2000, and cap the number of chunks.** Discord's hard limit is 2000
  characters; Hermes splits at 1900 for headroom and caps a single delivery at
  `MAX_SPLIT_MESSAGES = 8`, replacing the remainder with a notice. That cap comes from a logged
  incident where one degenerate turn posted 60 698 characters as 31 back-to-back messages. A local
  model looping on a prompt will reproduce that exactly; flowlathe's own interpreter concurrency bug
  in CLAUDE.md produced output containing its own prior output.
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

1. **Redelivery, and the claim/check race behind it.** Gateway resume replays events, so dedupe on
   message id at the DB level (above), not in memory. Hermes's deduplicator distinguishes
   `is_duplicate(id)` (**claims** the id) from `contains(id)` (**checks** without claiming),
   because its post-reconnect REST scan races live gateway events for the same message — the
   comment reads "ingress owns the dedup write." flowlathe gets the same race the moment §7.6
   lands: the `UNIQUE(external_id)` insert is the claim, and the recovery scan must use a
   non-claiming existence check.
2. **Privileged Gateway Intents will be the first thing that fails.** `message_content` is a
   privileged intent that must be enabled in the Discord developer portal; without it the bot
   connects and silently receives empty message bodies, or the connection is rejected outright.
   Hermes carries a dedicated `_format_privileged_intents_guidance()` that names the exact portal
   path and the exact intents requested. Detect the rejection and print that guidance — this is the
   single most common Discord-bot setup failure, and a generic connection error wastes an hour.
3. **Untrusted input is the whole point and the whole risk.** The message body is attacker-authored
   text that flows straight into a prompt and, if the Discord toolset is enabled on the same flow,
   back out into a channel. Sanitize on the way in, keep the client-level `allowed_mentions` denial
   on the way out, and keep the channel allowlist mandatory. Say so in the README next to the
   feature.
4. **Runaway loops.** A bot that replies in a channel it also watches will trigger itself. Ignore
   messages authored by the bot's own user id — non-negotiable, and worth a test. (Hermes reads
   `message.author.bot` and compares against `client.user`, keeping *other* bots as an opt-in
   rather than a blanket ignore; take the same shape.)
5. **A trigger outlives the canvas session.** The gateway connection must be started at boot for
   every enabled trigger and closed on `SIGINT`/`SIGTERM` alongside `app.close()`
   (`packages/server/src/index.ts:68`).
6. **Boot is already `await`-ing at top level** for MCP discovery (CLAUDE.md). Trigger startup is
   another async boot step; keep it after the app is listening so a slow/failing Discord connection
   cannot prevent the server from serving the UI. A trigger that fails to connect reports through
   `/api/plugins/status`, like an MCP server that fails discovery.

### 7.6 Messages missed while disconnected

The failure mode I had not planned for, and the one Hermes built a whole module for
(`plugins/platforms/discord/recovery.py`): **dedupe protects against seeing a message twice; nothing
protects against never seeing it at all.** A gateway drop, a server restart, or a deploy means every
message sent in that window is simply gone — and for a trigger whose whole job is "respond to
messages," silently dropping them is the worst possible behavior.

Hermes's answer is a durable ledger with three tables: completed messages (with delivery status and
attempt counts), scan records, and — the key piece — **per-channel cursors**
(`discord_recovery_cursors(channel_id, last_message_id)`). On reconnect it REST-scans each watched
channel forward from its cursor, within a bounded window and message limit, and dispatches whatever
was missed.

flowlathe's version, deliberately smaller:

- Extend `execution_triggers` (§7.4) with a per-channel cursor table:
  `trigger_cursors(trigger_id, channel_id, last_message_id, updated_at)`, advanced on every
  successfully-admitted message.
- On connect (including the first), REST-scan each allowlisted channel from its cursor, capped by
  `DISCORD_RECOVERY_WINDOW_SECONDS` (default 900) and `DISCORD_RECOVERY_LIMIT` (default 50), and
  feed each missed message through the identical admission path — allowlist, dedupe, rate limit,
  concurrency — not a parallel one.
- The scan uses the **non-claiming** existence check from trap 1; the ingress insert is the claim.
- Skip recovery entirely when the cursor is absent (a brand-new trigger starts at "now"), so
  enabling a trigger doesn't replay a channel's backlog.
- Retention: Hermes prunes at 30 days. `execution_triggers` rows are cheap and carry real
  provenance — keep them, and prune only cursors for channels no longer allowlisted.

---

## 8. Testing

- **Unit (vitest), per plugin package**: client behavior against an injected `fetchImpl`; argument
  coercion; result trimming/truncation; error-to-string; `unavailableReason` caching. Never the real
  network — the `SpotifyClient` "invalid_client" incident in CLAUDE.md is the cautionary tale.
- **Parity (`packages/testing`)**: golden fixtures for the `search` and `fetch` node kinds, running
  interpreter vs. compiled script against the stubbed `net.fetch` table. Plus the extended
  `plugin-gate.test.ts` cases from §4.4 (standalone-capable toolset runs; server-only one exits 1).
- **Interpreter**: `seed` applied at construction; seed survives snapshot→restore.
- **URL safety** (`packages/core`): the verdict table from §4.5 — every cloud-metadata endpoint,
  a decimal-encoded loopback IP, a public host redirecting to loopback, a signed S3 URL, an IDN
  host, and a model-emitted `https:// example.com`.
- **Server**: trigger registration rejects a flow with `pause`/`userInput`, with missing toolsets, or
  with no trigger node; `execution_triggers` unique constraint dedupes a replayed message id; a
  recovery scan and a live event for the same message produce exactly one execution (the claim/check
  race, trap 1); a trigger with no cursor recovers nothing.
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
- [ ] `PluginManifest` descriptors; `/api/plugins/status` returns them; canvas renders setup and the
      dependency banner from data, with `displayName()`'s `mcp:` prefix test replaced by a field.
- [ ] `packages/plugins/_common` with the shared result envelope, guarded execution, `httpGetJson`
      (`reachTarget`), and argument coercion moved out of the Spotify plugin.
- [ ] `ToolInvokeMeta.signal` threaded from `runPrompt`'s tool-loop through `ToolRegistry.invoke`;
      every network handler honors it, including between URLs in a batch.
- [ ] `@flowlathe/plugin-searxng` with `searxng_search` (score-sorted, limit capped at 20), gated by
      `SEARXNG_BASE_URL`, cached liveness `unavailableReason`, untrusted-text sanitization, unit tests.
- [ ] `@flowlathe/plugin-firecrawl` over plain REST (no SDK), scrape/crawl/map, per-URL timeouts and
      per-URL error entries, bounded crawl polling, `maxChars` truncation marker, unit tests.
- [ ] `packages/core/src/url-safety.ts`: scheme allowlist, private-range blocking with an env escape
      hatch, unconditional metadata-endpoint blocking, post-redirect re-validation, credential-bearing
      query-param refusal, IRI normalization — with the DNS-rebinding gap documented in-file.
- [ ] `ToolRegistration.standalone` + `compileGraph` partitioning; a flow using SearXNG/Firecrawl
      exports to a script that actually runs; `plugin-gate.test.ts` extended both ways.
- [ ] `RuntimeHost.net` added; every hand-built host updated; parity stub table in place.
- [ ] `search` and `fetch` node kinds complete across all six checklist points in §5.1, with golden
      parity fixtures and per-variable handles in their node views.
- [ ] `requiredToolsets` also collects node-level `toolset` fields; canvas banner test pins it.
- [ ] `@flowlathe/plugin-discord` outbound toolset with channel/user allowlist, client-level
      `allowed_mentions` denial, 1900-char chunking with an 8-chunk flood cap, 429 handling via the
      existing `retry-after` helper.
- [ ] `trigger` node kind; `GraphEngine` `seed` option, snapshotted and restored.
- [ ] `TriggerRegistry` + `DiscordTriggerSource` + `/api/triggers`; `triggers` and
      `execution_triggers` tables; version pinning enforced; self-message loop guard; privileged
      -intents failure detected with actionable guidance.
- [ ] Reconnect recovery: `trigger_cursors`, bounded post-connect REST scan through the same
      admission path, non-claiming existence check, no backlog replay on a fresh trigger.
- [ ] Trigger registration validation (missing toolsets / no trigger node / contains pause|userInput).
- [ ] E2E spec per phase; README updated (config env vars, the trust model for inbound messages).
- [ ] `CLAUDE.md` updated with whatever surprised the implementing agent.
