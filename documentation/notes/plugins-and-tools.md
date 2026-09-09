# Plugins, toolsets and tool-calling

The ToolRegistry, plugin-common, the plugin-dependency gate, and each shipped plugin's scope cuts.

Moved verbatim out of `CLAUDE.md` when that file was split by topic; see it for the
index and for the invariants that apply repo-wide.

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
- **PLAN-GITHUB.md added `@flowlathe/plugin-github` — an HTTP client over the REST API (L1),
  never a `gh` subprocess** (`PLAN-DOMAIN-TOOLS.md` D1). Eight tools: five read, always
  registered; three write (`github_create_issue`, `github_comment`,
  `github_create_pull_request`), registered only under `GITHUB_MODE=rw`.
  - **`GET /repos/{owner}/{repo}/issues` returns pull requests too** — a PR is an issue in
    GitHub's data model, distinguished only by a `pull_request` key on the item, present with
    any value (including `null`) on every PR-shaped item. `GithubClient.listIssues` filters
    those out (in the client, not `tools.ts` — deliberately, so `client.test.ts` alone proves
    the filtering independent of any sanitization/allowlist concern layered on top).
    `github_comment` deliberately *relies on the same fact* to serve both issues and PRs through
    one endpoint: removing either half breaks the other's justification, so don't "simplify" one
    without checking the other still needs it.
  - **A primary rate limit is a 403, not a 429** (`x-ratelimit-remaining: 0` +
    `x-ratelimit-reset`), and a secondary (abuse) limit is a `retry-after` header on *either*
    403 or 429. Three cases, not two: collapsing "403 + remaining:0" into "any 403 is a rate
    limit" makes a missing PAT scope look self-healing; collapsing "any 403" into "bad
    credentials" makes rate-limit exhaustion look like a broken token. `GithubClient.request`
    checks `x-ratelimit-remaining: 0` first (immediate failure naming the reset time, no retry —
    the reset can be an hour out), then `retry-after` on either status (bounded retry, `MAX_
    RETRIES = 3`, same loop shape as `DiscordClient.request`), then falls through to a generic
    authorization-failure message naming the repo for anything else. Keep the order: checking
    `retry-after` before `remaining: 0` would retry a call that's going to fail for an hour.
  - **`GET /rate_limit` is the `unavailableReason` liveness probe** because GitHub documents it
    as not counting against the rate limit, and it 401s on a bad or expired token — reachability
    and auth in one free call. It deliberately bypasses `request()`'s own retry loop (a probe
    should report quickly, not back off) and still goes through `CachedLivenessProbe`, never a
    direct call, so it inherits the optimistic-before-first-probe behavior already recorded for
    SearXNG above — a freshly-registered toolset can briefly report itself usable against a bad
    token.
  - **Auth is a manually-set `GITHUB_TOKEN` and nothing else** — no OAuth, no
    `plugin_credentials` row, no Connect button, no `connect` field on `GITHUB_MANIFEST`. Same
    narrowing already recorded for `DISCORD_BOT_TOKEN` above.
  - **`GITHUB_ALLOWED_REPOS` entries and a tool's `repo` argument are compared
    case-insensitively** — GitHub owners and repo names are themselves case-insensitive, so an
    operator writing `MyOrg/MyRepo` while a model emits `myorg/myrepo` must not read as a denial.
    `githubConfigFromEnv` lowercases the allowlist at parse time; `tools.ts`'s
    `repoAllowlistError` lowercases the (already `repoSlugSlot`-validated) incoming slug before
    comparing.
  - **PR bodies, issue comments, branch names, and CI check output are attacker-authored by
    design**, not incidentally like a search snippet — anyone can open an issue or a fork PR on
    a public repo. Every field in the §4.4 cap table is sanitized at the source; the pull-request
    diff is the one exception that owns its own `[truncated N of M chars]` marker and must be
    `scrubUntrustedText`-then-sliced by hand rather than passed through
    `sanitizeUntrustedText(text, maxLength)`, which would cut the marker back off. A check run's
    `output.summary` is surfaced (capped at 1,000 chars); its `output.text` is never read at all
    — CI log output is the single most attacker-influenceable field in this plugin.
  - **No parity fixture, and the reason is not the usual "subprocess can't be stubbed" one**:
    `packages/testing/src/net-stub.ts`'s `injectNetStubTable` only stubs `RuntimeHost.net`
    (`globalThis.fetch` wired through the compiled script's `net.fetch`), which only the
    `search`/`fetch` *node kinds* use. A plugin toolset's client (this one included) builds its
    own `fetch` inside `<toolset>ToolsetFromEnv()`, a path the harness never touches — so a
    parity run's compiled-script half would hit the real `api.github.com`. Closing this needs
    `injectNetStubTable` to also stub the `standalone` factory's fetch, keyed by `(method, url,
    sha256(body))` rather than URL alone (PLAN.md's design trap 8) — tracked, not hidden, and
    true of every plugin in this repo, not particular to GitHub.
  - **No Playwright spec**, for the usual reason: no plugin in this repo has one yet, and writing
    the first is separable work (`notes/testing-and-e2e.md`).
