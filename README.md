# flowlathe

> A graphical builder and visual compiler for LLM workflows, built for local models.

Most visual LLM workflow tools (Flowise, n8n, LangFlow) are built around hosted frontier
models, where one call usually solves the whole problem and concurrency just means "fire
everything at once." flowlathe targets the opposite situation: a workstation with one or two
GPUs running small local models, where solving a frontier-grade problem means decomposing it
into many small, individually tractable steps — and where VRAM and model-swap thrash, not API
rate limits, are the binding constraint.

![The Research Assistant demo flow: a router fans out into parallel code/prose prompts, a merge joins them, a diamond-shaped Gate node overrides ambient LLM settings downstream, and a final prompt polishes the result.](documentation/images/03-canvas-flow.png)

## What it is

flowlathe is a canvas-based flow builder plus a small runtime and compiler:

- **Draw a graph** of prompt, router, merge, loop, map, gate, pause, and user-input nodes,
  wired together with typed ports carrying immutable values.
- **Run it** against local (Ollama) or OpenAI-compatible providers, with real per-node
  parallelism and a scheduler that batches work by model instead of just maximizing
  concurrency.
- **Debug it step by step** — step forward, step back with a forked branch, edit a prompt
  mid-run, and re-run from that point without losing the original branch.
- **Export it** to a standalone, dependency-free TypeScript script. The canvas is for
  building and debugging; the exported script is the deterministic, version-controllable
  artifact you actually ship.

See [`documentation/WALKTHROUGH.md`](documentation/WALKTHROUGH.md) for a full walkthrough
with screenshots of every feature described below.

## Key features

- **Ports + edges, not a shared blackboard.** Edges carry immutable values port-to-port, so
  fan-out (router, map) is race-free and every value's lineage is visible in the graph.
- **Declared State.** Named, typed state entries with a merge rule (`replace`, `append`, …)
  live alongside the graph for values that need to accumulate across nodes rather than flow
  through a single edge; a node opts in to a built-in `read_state`/`write_state` tool to touch
  them.
- **Ambient per-node context.** Every prompt node automatically accumulates its own
  conversation history (the messages it has sent and received) across activations — including
  each iteration of a loop or map body — with no wiring required.
- **The Gate node.** A diamond-shaped node that overrides ambient LLM settings — temperature,
  top-k, and context-compaction method/threshold — for every node wired downstream of it, from
  the moment execution passes through it. It always wins over a node's own local setting,
  making "everything after this point gets more conservative / gets compacted" a single node
  instead of per-node configuration.
- **Context compaction.** When a Gate sets a compaction method (`drop-oldest-half` or
  `summarize-oldest-half`) and a threshold (fixed token count or percentage of context window),
  a node's accumulated context is compacted once it crosses that threshold. `system`-role
  messages are never dropped.
- **Step debugging with branching.** Run, step back to any prior node, edit something, and
  step forward — this forks a new branch from that point while the original run stays intact
  and inspectable.
- **Model-affinity scheduling.** The scheduler batches queued work by which model it needs,
  rather than firing every ready node at once — important when only one or two large local
  models fit in VRAM simultaneously.
- **Compile to a standalone script.** Any flow can be exported as a self-contained TypeScript
  program built on `@flowlathe/runtime` and `@flowlathe/providers` — no server or canvas
  required to run it again.
- **MCP tool servers.** Point flowlathe at an `mcpServers` config file (the same shape Claude
  Desktop/Code use) to connect stdio, SSE, or Streamable HTTP MCP servers; each server's tools
  become a toolset a prompt node opts into, the same way as the built-in state tools or a
  plugin. Tool names/descriptions are sanitized before they ever reach a model's context.

## Tech stack

- **Server:** Node 22, Fastify, SQLite via Drizzle, Server-Sent Events for live execution logs.
- **Web:** React 18, MUI 9, `@xyflow/react` (React Flow) for the canvas, Vite.
- **Providers:** Ollama and OpenAI-compatible HTTP APIs, plus a deterministic Mock provider for
  testing and demos.
- **Monorepo:** pnpm workspaces + Turborepo. Packages: `core`, `interpreter`, `compiler`,
  `runtime`, `providers`, `persistence`, `server`, `web`, `testing`, one package per node kind
  under `packages/nodes/*`, and one package per plugin (Spotify, MCP) under `packages/plugins/*`.
- **Tools/MCP:** `@modelcontextprotocol/sdk` for the MCP client (stdio, SSE, and Streamable
  HTTP transports).
- **Testing:** Vitest for unit/integration tests, Playwright for end-to-end tests.

## Quickstart

Requires Node ≥ 22 and pnpm.

```bash
pnpm install
pnpm build
node packages/server/dist/index.js
```

Then open `http://127.0.0.1:4310`. By default the server keeps its SQLite database under
`packages/server/data/`; set `FLOWLATHE_DB_PATH` and `PORT` to override the database location
and port respectively.

A **Mock** provider (which echoes its prompt back, prefixed with `[provider:model]`) is
seeded automatically, so you can build and run a flow end-to-end with no local model server
running. Add an **Ollama** or **OpenAI-compatible** provider from the Providers page once
you're ready to point a flow at a real model.

For local development with hot reload:

```bash
pnpm dev
```

To connect MCP tool servers, set `MCP_SERVERS_CONFIG_PATH` to a JSON file shaped like:

```json
{
  "mcpServers": {
    "my-server": { "command": "npx", "args": ["-y", "some-mcp-server"] },
    "remote-server": { "url": "https://example.com/mcp" }
  }
}
```

A stdio server (one with a `command`) only runs if its command is also listed in
`MCP_ALLOWED_COMMANDS` (comma-separated) — unset means none may run. Each server's tools are
discovered once at server startup and exposed as the toolset `mcp:<name>`; check
`/api/plugins/status` (or the workflow-dependency banner on the canvas) if a server fails to
connect.

To enable web search, set `SEARXNG_BASE_URL` to a running
[SearXNG](https://docs.searxng.org/) instance's base URL (self-hosted or otherwise) — this
registers the `searxng_search` tool under the `searxng` toolset. Unset, the toolset simply isn't
registered (a flow using it shows the same workflow-dependency banner as an unconfigured MCP
server). Optional `SEARXNG_ENGINES`, `SEARXNG_LANGUAGE`, and `SEARXNG_SAFESEARCH` set defaults
applied to every search. Search results are third-party web content passed into a model's
context — sanitized for hidden characters and flagged for common prompt-injection phrasing, but
still worth treating as untrusted when the flow's output reaches somewhere sensitive.

To enable page scraping/crawling, set `FIRECRAWL_API_KEY` — this registers `firecrawl_scrape`,
`firecrawl_crawl`, and `firecrawl_map` under the `firecrawl` toolset. `FIRECRAWL_BASE_URL` points
at a self-hosted Firecrawl instance instead of Firecrawl's cloud API. Any URL that reaches these
tools (from a model's tool arguments, a rendered template, or a link found on a scraped page) is
checked against a private/internal-network and cloud-metadata-endpoint blocklist before the
request is made, and again against the post-redirect final URL — see
`packages/core/src/url-safety.ts`. Set `FLOWLATHE_ALLOW_PRIVATE_URLS=1` only if you deliberately
want a flow to reach your own intranet; cloud metadata endpoints (`169.254.169.254` and similar)
are never reachable regardless of this setting.

## Loop/Map bodies

A Loop/Map body can be an arbitrary multi-node subgraph — any chain, fan-out, or nested
Router/Loop/Map wired among nodes that share a `parentId` pointing at the Loop/Map — not just a
single node. The interpreter and compiler both walk the graph **region by region**: the
top-level graph is one region, and each Loop/Map's body is another, recursively (a body node can
itself be a Loop/Map with its own body). A body's entry point(s) and its one terminal node are
inferred from the graph shape rather than declared — see `@flowlathe/core`'s `regions.ts` and
`validateGraph` for the exact rules. Two restrictions remain:

- **The body boundary is closed.** An edge with exactly one endpoint inside a body — in either
  direction — is a validation error. Passing a loop-invariant value into a body, or a value out
  of one, goes through flow State (`read_state`/`write_state`) instead.
- **Exactly one terminal per body.** A body that fans out to more than one dead-end node needs a
  Merge to join them back into a single result.

## Known v1 limitations

None currently tracked here — see `CLAUDE.md` for narrower, already-resolved gaps and the
surprises encountered building each slice.

## Repository layout

```
packages/
  core/          zero-I/O contracts and graph types, shared by server and browser
  interpreter/   the graph engine that drives node dispatch and readiness
  compiler/      graph -> standalone TypeScript export
  runtime/       context, state, and LLM-config stores; the pieces an exported script imports
  providers/     Mock, Ollama, and OpenAI-compatible provider adapters
  persistence/   SQLite schema and migrations (Drizzle)
  server/        Fastify API + SSE, serves the built web SPA
  web/           the canvas SPA (React + React Flow)
  nodes/*/       one package per node kind (prompt, router, merge, loop, map, gate, ...)
  testing/       shared test fixtures and the interpreter/compiler parity harness
playwright/      end-to-end tests
documentation/   walkthrough and screenshots
```
