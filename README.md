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
- **Write it as text.** Every flow is also a `flows/*.flow` file in a small, custom DSL — the
  canvas edits it live, and it's what actually lands in `git`. See "Flows as text" below.

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
- **Monorepo:** pnpm workspaces + Turborepo. Packages: `core`, `dsl`, `cli`, `interpreter`,
  `compiler`, `runtime`, `providers`, `persistence`, `server`, `web`, `testing`, one package per
  node kind under `packages/nodes/*`, and one package per plugin (Spotify, MCP, SearXNG,
  Firecrawl, Discord) under `packages/plugins/*`.
- **Tools/MCP:** `@modelcontextprotocol/sdk` for the MCP client (stdio, SSE, and Streamable
  HTTP transports).
- **Testing:** Vitest for unit/integration tests, Playwright for end-to-end tests.

## Quickstart

Requires Node ≥ 22 and pnpm.

```bash
pnpm install
pnpm --filter @flowlathe/web build
pnpm --filter @flowlathe/server start
```

This repo has no build step for the server itself — every package other than `web` (which needs
a real Vite bundle to serve) runs straight from its TypeScript source via `tsx`, so there's no
`dist/` to `node` directly. `pnpm dev` (below) is the same thing with hot reload.

Then open `http://127.0.0.1:4310`. By default the server keeps its SQLite database under
`packages/server/data/` and its `.flow` files under `./flows` (relative to wherever the server
process runs); set `FLOWLATHE_DB_PATH`, `FLOWLATHE_FLOWS_DIR`, and `PORT` to override the
database location, flows directory, and port respectively.

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

To send/read Discord messages, set `DISCORD_BOT_TOKEN` (from a
[Discord Developer Portal](https://discord.com/developers/docs/topics/oauth2#bots) application)
and `DISCORD_ALLOWED_CHANNELS` (comma-separated channel ids) — this registers
`discord_send_message`, `discord_read_messages`, and `discord_react` under the `discord` toolset.
Leaving `DISCORD_ALLOWED_CHANNELS` unset means no channel is allowed (secure default), even with
a valid bot token. Mentions of `@everyone`/`@here` and roles are stripped from every message this
sends unless you explicitly set `DISCORD_ALLOW_MENTION_EVERYONE=1` / `DISCORD_ALLOW_MENTION_ROLES=1`.
This toolset is outbound-only — there's no way yet for a Discord message to *start* a flow.

To let a flow read (and optionally change) a local git repository's history, set `GIT_TOOL_ROOT`
to an absolute path inside a git work tree — this registers five read-only tools
(`git_status`, `git_log`, `git_diff`, `git_show`, `git_list_branches`) under the `git` toolset.
`GIT_TOOL_MODE=rw` additionally registers `git_add`, `git_commit`, `git_create_branch`, and
`git_switch`; `GIT_TOOL_ALLOW_PUSH=1` (only honored together with `GIT_TOOL_MODE=rw`) additionally
registers `git_push`, which publishes `HEAD` to `GIT_TOOL_REMOTE` (default `origin`). Each mode is
structural — a mode that doesn't include a tool never registers it at all, rather than registering
it gated to always fail. `GIT_TOOL_ROOT` unset, nonexistent, not a directory, or not a git work
tree means the toolset isn't registered at all (with a warning logged at startup for the latter
three). This plugin **only ever reads your git configuration, never writes it**: commit identity
(`user.name`/`user.email`), the credential helper, and every remote are the **operator's** to set
up by hand, outside flowlathe, exactly as if you were using `git` yourself in a terminal — there is
no `git_config`/`git_remote`/`git_clone`/`git_fetch`/`git_pull` tool and there will not be one (see
`documentation/PLAN-DOMAIN-TOOLS.md` for why: a config-writing tool is what turns a command
allowlist into arbitrary code execution in two calls, which is also why this toolset — unlike an
open-ended shell tool — is not and cannot be reached through a generic shell/exec toolset; none is
built in this repository, and `git` is deliberately excluded from ever being allowlisted in one if
it is). Every argv is a fixed template the plugin author wrote; a model can only ever supply
already-validated values into named holes (a ref, a path, a commit message), never a subcommand or
a flag.

To let a flow see and manage GitHub issues/pull requests, set `GITHUB_TOKEN` (secret — a
[fine-grained personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens),
scoped to **only the repositories you allowlist below**; that scoping is the real security
boundary, `GITHUB_ALLOWED_REPOS` is what flowlathe can enforce on top of it) and
`GITHUB_ALLOWED_REPOS` (comma-separated `owner/name`, case-insensitive) — this registers
`github_list_issues`, `github_get_issue`, `github_list_pull_requests`, `github_get_pull_request`,
and `github_get_checks` under the `github` toolset. Set `GITHUB_MODE=rw` to additionally register
`github_create_issue`, `github_comment`, and `github_create_pull_request` — **doing so lets a
model open issues, post comments, and open pull requests under the token owner's own identity**,
so only enable it with a token you're comfortable attributing that way. `github_create_pull_request`
defaults to `draft: true` regardless of GitHub's own API default, so an opened PR requests no
reviews and notifies no CODEOWNERS unless the flow explicitly overrides it. `GITHUB_API_BASE_URL`
overrides the default `https://api.github.com` for GitHub Enterprise. As with Discord, there's no
Connect button for this plugin — auth is entirely a manually-set env var.

To use file-backed State entries — a flow author picks a specific document at design time,
either a read-only reference a Prompt node pulls in or a markdown-style notes file a flow writes
to across a run — set `FLOWLATHE_STATE_FILES_ROOT` to a directory on disk. Every declared
`type: "file"` entry's `filePath` is resolved relative to that root (absolute paths, `~`, and `..`
are all refused); a flow declaring one with the root unset fails clearly at run-start rather than
partway through. A State panel entry of type `file` has a `fileMode` (`read-only`, for a document
a flow only ever reads; `read-write`, for one it can also write to) and an optional `versioned`
flag (read-write only): off writes straight to `filePath` every run, in place, forever; on treats
`filePath` as a read-only seed document and mints a fresh copy — named
`<basename>.v<flow version>.<timestamp>.<ext>` next to it — the first time that entry is touched
in a given run, so every execution gets its own copy and the seed document is never mutated. A
file-backed entry's merge rule is restricted to `replace` (overwrite) or `append` (append text to
the end) — the other merge rules don't have a sensible meaning for a file. This is the same
`read_state`/`write_state` mechanism non-file state entries use, just backed by a real file instead
of a value in the execution's blob store. A Prompt node's template can also reference a declared
state entry by name (`{{notes}}`) with no wired edge at all — it resolves ambiently from that
entry's current value, file-backed or not.

### Discord triggers (starting a flow from a message)

A `trigger` node lets a flow be started by an inbound event instead of only the canvas's Run
button. Add one to a flow (`source: "discord"`), wire its `content`/`authorId`/`channelId`/
`messageId` outputs like any other node's, and register it:

```
POST /api/triggers   { "flowId": "...", "source": "discord", "channelIds": ["123456789012345678"] }
```

This pins the trigger to the flow's *current* version — editing the flow on the canvas afterward
does not change what the live trigger runs; re-pin explicitly with
`POST /api/triggers/:id/repin`. Registration is rejected (409) if the graph has no `discord`
trigger node, contains a `pause`/`userInput` node (nothing can answer one in a headless run), or
requires a plugin toolset that isn't configured. `GET /api/triggers` lists every trigger with its
live `active` status; `DELETE /api/triggers/:id` stops and removes one.

Requires `DISCORD_BOT_TOKEN` and the **"MESSAGE CONTENT INTENT"** privileged Gateway Intent
enabled for the bot in the
[Discord Developer Portal](https://discord.com/developers/applications) — the single most common
setup failure, since without it the bot connects but never receives message text. The bot's own
messages are always ignored (no self-triggering loops); only messages in a trigger's own
`channelIds` are admitted, independent of `DISCORD_ALLOWED_CHANNELS` (the outbound toolset's own
allowlist). `DISCORD_RECOVERY_WINDOW_SECONDS` (default 900) and `DISCORD_RECOVERY_LIMIT` (default
50) bound the post-reconnect scan that recovers messages missed during a gateway drop or server
restart; a message id is only ever admitted once, surviving a restart.

## Deployment and network posture

The flowlathe API is unauthenticated. Only loopback-equivalent exposure is supported — the server
binds `127.0.0.1` by default (override with `HOST`, e.g. `HOST=0.0.0.0` inside a container), and
every request is checked against a `Host`-header allowlist before any route runs, closing off
DNS-rebinding-style attacks where a public web page's script sends a request that lands on this
server with a rebound hostname. The allowlist defaults to `127.0.0.1`, `localhost`, and `::1`; set
`FLOWLATHE_ALLOWED_HOSTS` to a comma-separated list to add hostnames to that default (an operator
who deliberately publishes further, e.g. behind their own reverse proxy on a trusted LAN), or set
`FLOWLATHE_ALLOWED_HOSTS_EXCLUSIVE=1` alongside it to replace the default outright instead of
adding to it.

**The allowlist is a routing check, not authentication.** Anything that can already reach the port
and send a matching `Host` header has full API access — creating and overwriting flows, running
them (invoking every configured provider and enabled plugin toolset), reading every execution's
prompts and outputs, and registering triggers. Treat network reachability itself as the trust
boundary: only run this on a machine or network you control.

To run the published Docker image, publish to loopback explicitly:

```bash
docker run -p 127.0.0.1:4310:4310 -v flowlathe-data:/app/data -v flowlathe-flows:/app/flows flowlathe
```

Never `-p 4310:4310` without the loopback prefix — that publishes the port on every interface on
the host. The image's `HOST=0.0.0.0` is unrelated to this and must stay as-is: it's a *bind*
address inside the container's own network namespace, required for `-p` port-forwarding to reach
it at all, not a statement about who else can connect — that boundary is the host-side `-p` publish
address above.

## Flows as text

A flow's source of truth is a `.flow` file — a small custom DSL, not a JSON blob in SQLite. This
is what makes a one-word prompt-template change show up as a one-line `git diff`, lets a flow be
authored (by hand, or by a model) as text, and gives flows the tools you already have for text —
`git log`, `git blame`, branches, PRs, `rg`.

```
flow "research-brief" {
  state findings: array merge=append initial=[]

  node extract: prompt @(80, 40) {
    providerId = "ollama"
    modelId    = "qwen3.6:27b"
    template   = """
      Extract the key claims from the following text.

      {{input}}
    """
  }
}
```

- **`flows/*.flow`** (`FLOWLATHE_FLOWS_DIR`, default `./flows`) is what the server reads and
  watches. Editing a file with any text editor, `git checkout`-ing a different revision, or
  running `flowlathe fmt` all take effect live — the canvas offers to reload when a flow's file
  changes underneath it, and a running step-debug session picks up the edit on its next step.
- **The canvas edits the same text live.** Toggle "Text" in a flow's toolbar for a DSL panel that
  parses on blur (a syntax error leaves the graph untouched and shows the message instead of
  applying a broken edit); "Import from text" on the flow list pastes a `.flow` file's contents
  straight into a new (or updated) flow.
- **SQLite still owns everything about *running* a flow** — executions, branches, per-step
  snapshots, blobs, state writes, provider credentials. `flow_versions` keeps a content-addressed
  cache of what was on disk at run time, so an execution's flow is still viewable (as a graph and
  as text) even if the file is later edited or deleted.
- **`@flowlathe/cli`** (bin `flowlathe`) is the non-canvas way to work with `.flow` files:

  | Command | Behavior |
  |---|---|
  | `flowlathe fmt [files]` | Canonicalize in place; `--check` exits 1 on drift (CI/pre-commit) |
  | `flowlathe check [files]` | Parse + validate; human-readable errors with line/column |
  | `flowlathe export <file>` | Emit the standalone TS script (same as the canvas's Export) |
  | `flowlathe run <file>` | Headless interpreter run, streaming `RunEvent` JSON to stdout |
  | `flowlathe flows export\|import` | One-shot migration between the DB and `.flow` files |

  Files default to every `*.flow` in `FLOWLATHE_FLOWS_DIR` when none are given. `export`/`run`
  resolve a flow's provider config from `FLOWLATHE_DB_PATH`'s `providers` table when set, falling
  back to a plain Ollama adapter per referenced provider id otherwise.

  To keep every committed `.flow` file canonically formatted, add a `pre-commit` git hook:

  ```bash
  #!/bin/sh
  files=$(git diff --cached --name-only --diff-filter=ACM -- 'flows/*.flow')
  [ -z "$files" ] && exit 0
  node packages/cli/bin/flowlathe.js fmt --check $files
  ```

  (drop it in `.git/hooks/pre-commit` and `chmod +x` it — this repo has no hook-runner
  dependency like husky, and one flow author's single hook script doesn't need one either).
- **A node's id is its DSL name.** Renaming a node (via the canvas's "Node ID" field, or by
  editing the text directly) changes what past executions refer to by that id — a deliberate,
  warned-about exception to the rule that ordinary edits never change node identity.

See `PLAN-FLOW-DSL.md` for the full design (grammar, storage model, and the tradeoffs behind
each of the above).

## Flow versioning

`flow_versions` is now a real history, not just noise from every autosave. Three distinct things:

- **Revision** — an immutable, content-addressed snapshot of a graph, taken on every save that
  actually changes something. Cheap and numerous; an unchanged save (a debugging session that runs
  the same graph ten times) creates no new row. Garbage-collected once it's old, superseded, and
  unreferenced — see below.
- **Named version** — a revision a human labeled ("baseline", "with-reranker", "v2 for demo"), via
  "Name version…" next to Save, or by labeling an existing row from the History drawer. Never
  garbage-collected.
- **Pin** — a named pointer some consumer follows (a Discord trigger, or a `"default"` channel set
  from the History drawer), changed only by an explicit action — a pin never silently drifts to
  HEAD just because someone edited the canvas.

The canvas's **History** button opens a drawer listing every revision (newest first, named ones
called out), with a per-row **Restore** (loads that graph as a new HEAD — history is never
rewritten, so the version you restored *from* stays right where it was) and **Pin**, plus a
From/To picker that renders a structural diff (added/removed/changed nodes, edge rewiring, state
changes, and a per-line view for multi-line template edits). A running or step-debugging session
shows which version it's actually executing, and flags it if the flow's HEAD has since moved on —
stepping deliberately keeps following HEAD (so an edit mid-session takes effect on the next step),
this is just making that fact visible instead of silent. When `FLOWLATHE_FLOWS_DIR` is itself a git
work tree, the drawer gains a read-only git history section too (`git log`/`git show` on that
flow's file) — flowlathe never writes to your repo on your behalf.

Retention is automatic: an unnamed revision is deleted once it's not HEAD, not referenced by any
execution/trigger/pin, not among the newest 50 (`FLOWLATHE_VERSION_GC_KEEP_NEWEST`), and older than
30 days (`FLOWLATHE_VERSION_GC_OLDER_THAN_DAYS`) — all four conditions at once, so nothing recent or
load-bearing is ever at risk. See `PLAN-FLOW-VERSIONING.md` for the full design.

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
  dsl/           the flow text format: lexer, parser, canonical printer, formatter
  cli/           `flowlathe` bin: fmt, check, export, run, flows export|import
  interpreter/   the graph engine that drives node dispatch and readiness
  compiler/      graph -> standalone TypeScript export
  runtime/       context, state, and LLM-config stores; the pieces an exported script imports
  providers/     Mock, Ollama, and OpenAI-compatible provider adapters
  persistence/   SQLite schema and migrations (Drizzle)
  server/        Fastify API + SSE, serves the built web SPA, watches flows/*.flow
  web/           the canvas SPA (React + React Flow)
  nodes/*/       one package per node kind (prompt, router, merge, loop, map, gate, ...)
  plugins/*/     one package per plugin (Spotify, MCP, SearXNG, Firecrawl, Discord)
  testing/       shared test fixtures and the interpreter/compiler parity harness
flows/           flow definitions, as .flow text (FLOWLATHE_FLOWS_DIR)
playwright/      end-to-end tests
documentation/   walkthrough and screenshots
```
