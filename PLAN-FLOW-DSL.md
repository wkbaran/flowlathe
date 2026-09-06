<!--
Handoff document. Written for an implementing agent picking this up cold.

- "Locked decisions" were settled with the project owner. Don't relitigate them.
- Read PLAN.md (architecture source of truth) and CLAUDE.md (surprises log) first.
- Build in slice order; each slice ends runnable, tested, and e2e-green.
- The single most important invariant in this document is in §3.1: the DSL is SYNTAX OVER
  `FlowGraph`, and carries no semantics of its own. Every design choice below follows from it.
-->

# Implementation plan — a flow DSL, and what stays in SQLite

**Status:** not started.
**Related:** `PLAN-FLOW-VERSIONING.md` (once flows are files, most of "versioning" becomes git plus
an execution-provenance snapshot — that document depends on this one), `PLAN-INTEGRATIONS.md`
(a triggered flow is a headless run of a file-backed flow).

---

## 1. The problem

A flow's definition today is a JSON blob in one column:

```
flow_versions(id, flow_id, version, graph_json, created_at)     packages/persistence/src/schema.ts:22
```

`graph_json` is a serialized `FlowGraph` (`packages/core/src/graph.ts:27`) — `{nodes, edges, state}`,
where every node is `{id, type, position, data, parentId?}` and every edge is a source/target pair
with opaque handle strings. That representation is fine for the canvas and hostile to everything
else:

- **It is not reviewable.** A one-word change to a prompt template shows up as a rewritten JSON blob.
  No PR reviewer can see what changed.
- **It is not authorable.** Writing a 12-node flow by hand — or having a model write one — means
  emitting node ids, positions, and edge records by hand.
- **It is not versionable by the tools people already use.** It lives in a SQLite row, so `git log`,
  `git blame`, branches, and PRs do not apply to the artifact that matters most.
- **It is not greppable.** "Which flows use the Firecrawl toolset?" is a SQL query over JSON, not a
  `rg`.

Meanwhile the *export* direction already exists and proves the point: `compileGraph`
(`packages/compiler/src/compile-graph.ts`) turns a graph into readable, version-controllable
TypeScript — but that path is deliberately one-way (PLAN.md: "No round-tripping"). The compiled
script is a *deployment artifact*, not a source format. What's missing is a source format.

---

## 2. Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Role of the DSL | **Source of truth for flow definitions**, stored as files on disk | Makes flows git-versionable, PR-reviewable, hand- and model-authorable. This is the whole point |
| Role of SQLite | **Keeps everything runtime**: executions, branches, steps, snapshots, blobs, responses, state writes/reads, contexts, providers, credentials | These need recursive CTEs over the branch tree, content-addressed blob refcounting, WAL durability, and per-step writes. A filesystem is worse at all four. Replacing SQLite wholesale is **rejected** |
| Round-tripping | **Required and property-tested**: `parse(print(g))` deep-equals `g` for every graph | Without it the canvas and the file diverge and the feature is worse than nothing |
| Surface syntax | **A small custom text format**, not YAML/JSON/TOML | Loop/Map bodies (`parentId`) become a nested `body { }` block, and edges become `a.out -> b.in` lines. Both read wrong in YAML |
| Semantics in the parser | **None.** Node property blocks are passed through verbatim into `node.data` and validated by the existing `schemaTable[kind]` zod schemas | Same anti-drift device PLAN.md already relies on: a new node field needs zero DSL changes |
| Layout | **In-file**, as a `@(x, y)` attribute, normalized by a formatter | One file per flow is the artifact. A sidecar layout file drifts and doubles the review surface |
| Compiled TS export | **Unchanged, still one-way** | The DSL is source; the TS is the shipped artifact. Two different jobs |

---

## 3. Design

### 3.1 The invariant: syntax over `FlowGraph`, nothing else

```
parse : string    -> FlowGraph      (then FlowGraphSchema.parse + validateGraph, unchanged)
print : FlowGraph -> string         (canonical form; print(parse(s)) is idempotent)
```

The parser must never know what a `prompt` node's fields mean. It knows how to read a block of
`key = value` pairs into a `Record<string, unknown>` and hands it to `node.data`. Validation is the
existing `schemaTable[node.type].parse(...)` (`packages/compiler/src/emit-table.ts`) and
`validateGraph` (`packages/core/src/regions.ts`). Consequences, all good:

- Adding `enabledToolsets` (or any future field) to `PromptNodeDataSchema` requires **no** DSL work.
- A typo in a field name produces the same zod error the canvas produces, from one code path.
- The DSL cannot drift from the graph model, because it does not model anything.

**The one place this is bent:** node *ids*. In the graph they are opaque strings (`node-1`); in the
DSL they are the author-visible name. See §3.4.

### 3.2 Package

New `packages/dsl` → `@flowlathe/dsl`:

```
src/lex.ts       hand-written tokenizer (identifiers, strings, triple-quoted blocks, numbers, punctuation)
src/parse.ts     recursive-descent parser -> FlowGraph
src/print.ts     FlowGraph -> canonical text
src/format.ts    format(source) = print(parse(source))
src/errors.ts    DslError with {line, column, message, sourceExcerpt}
src/index.ts
```

Dependencies: `@flowlathe/core` and `zod`. **No parser generator** — the grammar is under 100 lines
of productions and a generator would add a build step to a repo that deliberately has none.

**It must be isomorphic** (no `node:*`, no `Buffer`) so the web canvas can import it for a live text
view and paste-to-import. CLAUDE.md's warning applies exactly: workspace packages resolve to raw
`.ts` source, so *any* Node-only import anywhere in `@flowlathe/dsl` breaks `packages/web`'s
typecheck even for code web never calls. File I/O lives in `server` and the CLI, never here.

### 3.3 Surface syntax

```
flow "research-brief" {
  state findings: array merge=append initial=[]
  state verdict:  string merge=replace

  node extract: prompt @(80, 40) {
    provider = "ollama"
    model    = "qwen3.6:27b"
    tools    = ["searxng"]
    state_tools = true
    template = """
      Extract the key claims from the following text.

      {{input}}
    """
  }

  node critique: loop @(340, 40) {
    initTemplate  = "{{input}}"
    accPortName   = "input"
    stopValue     = "DONE"
    maxIterations = 10

    body {
      node judge: prompt @(40, 40) {
        provider = "ollama"
        model    = "ornith:9b"
        template = """Critique this draft:\n{{input}}"""
      }
      node revise: prompt @(300, 40) {
        provider = "ollama"
        model    = "ornith:9b"
        template = """Revise using the critique:\n{{input}}"""
      }
      judge.output -> revise.input
    }
  }

  extract.output -> critique.input
}
```

Grammar notes, each earning its place:

- **`node <name>: <kind> @(x, y) { … }`** — name, kind, position, properties. The position is one
  short token at the end of the header line, so a node moved on the canvas dirties exactly one line.
- **Properties are `key = value`** where value is a string, triple-quoted string, number, boolean,
  array, or object literal (JSON-ish, trailing commas allowed). Unknown keys pass through to
  `node.data` and are rejected — with a good message — by the kind's zod schema, not by the parser.
- **Triple-quoted strings** (`"""…"""`) strip the common leading indentation of their lines. Prompt
  templates are multi-line and must read naturally inside an indented block; without dedenting,
  every template silently gains leading whitespace and every rendered prompt changes.
- **`a.port -> b.port`** is an edge. Both handles are always written explicitly, even when
  defaultable — `extract.output -> summarize.input` is self-documenting, and the codebase's
  handle-naming footgun (`PromptNodeView`'s hardcoded `id="input"`, CLAUDE.md) is exactly the kind of
  thing an implicit default would hide.
- **`body { … }` is `parentId` sugar.** Nodes declared inside a Loop/Map's `body` block get
  `parentId` set to that node. Nesting is arbitrary-depth, matching the region model in
  `PLAN-SUBGRAPH-BODIES.md`. This makes the closed-boundary rule *visible*: an edge crossing a `body`
  brace is obviously wrong on the page, where in JSON it is invisible.
- **`state <name>: <type> merge=<rule> initial=<json>`** mirrors `StateDeclSchema`
  (`packages/core/src/state.ts:10`) exactly; `type` defaults to `string` as the schema does.
- **Comments:** `#` to end of line. Preserved by the printer only when attached to a node/edge line
  (see §3.5).

The canonical printer fixes ordering (state decls, then nodes in topological order, then edges
grouped by source), indentation (2 spaces), and quoting, so canvas-written files have stable diffs.

### 3.4 Node ids and names

The DSL name **is** the node id. Today the canvas generates `node-1`, `node-2`
(`Canvas.tsx:137`), which would make files unreadable and diffs meaningless.

- New nodes get slugified names derived from the label/kind with a numeric suffix on collision
  (`extract`, `extract-2`).
- Names are validated `[A-Za-z_][A-Za-z0-9_-]*` and must be unique per flow (not per region — an
  activation key is `nodeId@owner:index` and a globally unique node id is what makes it
  unambiguous).
- **Renaming a node is a rename of its id**, which breaks: existing executions' `steps.node_id`,
  snapshot payloads, and `state_writes` provenance. Historical rows keep the old id and the UI shows
  it verbatim — do **not** attempt a cascading rewrite of execution history. Warn in the rename UI:
  "past executions will keep referring to this node by its old name."
- The canvas keeps `id` stable across ordinary edits. CLAUDE.md's step-mode note depends on this:
  "editing a template doesn't change node ids," which is what lets step-back → edit → step-forward
  work. Renaming is a deliberate, warned-about exception.

### 3.5 What round-tripping does and does not preserve

Property test (§6) asserts `parse(print(g))` deep-equals `g` for every golden fixture and for
generated random graphs. The reverse — `print(parse(s)) === s` — holds only for **already-canonical**
`s`; that is what `flowlathe fmt` is for, and CI checks it.

Not preserved: free-floating comments, blank-line grouping, and non-canonical ordering. Comments
attached to the line immediately above a `node`/`state`/edge declaration **are** preserved (stored
on a `_comment` side-channel in the parse result, not in `FlowGraph`, and re-emitted by the printer).
Anything more (arbitrary trivia preservation) needs a full CST and is out of scope; say so in the
error message when a comment is dropped by a canvas-driven rewrite, or simply accept the loss and
document it. **Recommendation: preserve leading comments, drop the rest, document it.**

---

## 4. Storage: what moves, what stays

### 4.1 Files on disk

```
FLOWLATHE_FLOWS_DIR   default ./flows
  flows/research-brief.flow
  flows/triage.flow
```

The file's basename is the flow's stable identifier. `flows.id` becomes that slug rather than a
UUID; `flows.name` stays the display name from the `flow "…"` header.

The server watches the directory (`fs.watch` with debounce; add `chokidar` only if `fs.watch` proves
unreliable on WSL2 — it often is, so budget for the possibility and test it on the target machine).
On external change: broadcast an SSE/`/api/flows` invalidation and let the canvas offer to reload.

**Save conflicts.** `PUT /api/flows/:id` takes an `ifMatch` content hash of the version the canvas
loaded; a mismatch returns 409 with the on-disk text so the user can choose. Silent clobbering of an
edit made in an editor or by `git checkout` is the fastest way to make people distrust the feature.

### 4.2 SQLite keeps everything else — and `flow_versions` changes role

This is the delicate part, because two existing behaviors depend on `flow_versions`:

1. `executions.flow_version_id` is a **NOT NULL FK** (`schema.ts:59`) — every execution points at the
   exact graph it ran.
2. Step mode resolves the graph via `getLatestGraphForFlowVersion` (`packages/persistence/src/flows.ts:58`),
   deliberately following the flow's *latest* version so "step back, edit a prompt, step forward"
   picks up the edit (CLAUDE.md).

Both must survive. So `flow_versions` stays, with a changed meaning:

> **`flow_versions` becomes an immutable, content-addressed snapshot of a flow file, written on
> demand** — when a run or step session starts, and when the canvas saves — keyed by
> `sha256(canonical DSL text)`. It is a *cache of what was on disk at that moment*, not the primary
> store.

```
flow_versions(id, flow_id, version, graph_json, source_text, content_hash, created_at)
                                                ^^^^^^^^^^^  ^^^^^^^^^^^^  new
UNIQUE(flow_id, content_hash)   -- saving an unchanged flow creates no new row
```

`source_text` is what makes an old execution viewable *as text* even after the file changed on disk
or was deleted. `graph_json` stays as-is so no existing query changes. The `UNIQUE(flow_id, version)`
constraint stays; `version` keeps incrementing but now only when content actually differs — which
incidentally fixes today's version-number inflation (see `PLAN-FLOW-VERSIONING.md` §3).

`getLatestGraphForFlowVersion` changes from "latest row for this flow" to "parse the current file for
this flow, falling back to the latest row if the file is gone." Step mode's documented behavior is
preserved exactly; only the source of "latest" moves.

`state_decls` (FK to `flow_versions`, `schema.ts:211`) is unaffected — it is re-derived from the
graph on each snapshot write, as `saveStateDecls` already does.

### 4.3 Why not replace SQLite (the rejected option, recorded)

- The branch tree is queried with a **recursive CTE** up `branches.parent_branch_id` (PLAN.md).
- **Blobs are content-addressed with refcounts** (`blobs(sha256 PK, bytes, byte_len, encoding,
  refcount)`); dedupe and GC across snapshots/messages/responses is a database's job.
- **Per-step snapshots** are written on the hot path; WAL + synchronous=NORMAL makes them cheap.
  A file per snapshot would be thousands of small files per debugging session.
- Executions are **append-only and query-shaped** ("this node on this branch," "this node across all
  branches"). That is SQL.

What actually motivated "possibly replace SQLite" is the *flow definition* being locked in a DB —
and that is exactly what moves to files. The rest stays.

### 4.4 Migration

One-shot, non-destructive, both directions:

```
flowlathe flows export           # every flow's latest version -> flows/<slug>.flow
flowlathe flows import <file>    # a .flow file -> a new flow_versions row (for a DB-first repo)
```

Export runs automatically once at boot if `FLOWLATHE_FLOWS_DIR` is empty and the DB has flows, with
a log line saying what it wrote. Existing `flow_versions` rows are left untouched — history stays
readable, and `executions.flow_version_id` keeps resolving.

---

## 5. CLI

New `packages/cli` → `@flowlathe/cli`, bin `flowlathe`. It is also the answer to the README
inaccuracy CLAUDE.md flags (a `dist/` that never existed):

| Command | Behavior |
|---|---|
| `flowlathe fmt [files]` | Canonicalize in place; `--check` exits 1 on drift (pre-commit / CI) |
| `flowlathe check [files]` | Parse + `FlowGraphSchema` + per-kind `schemaTable` + `validateGraph`; human-readable errors with line/column |
| `flowlathe export <file>` | Emit the standalone TS script via `compileGraph` — the existing `/api/flows/:id/export` path, minus the server |
| `flowlathe run <file>` | Headless interpreter run against configured providers; streams `RunEvent` JSON to stdout, same shape a compiled script prints |
| `flowlathe flows export/import` | §4.4 migration |

`check` is the piece that makes flows reviewable in CI: a PR touching `flows/*.flow` gets validated
before a human reads it.

---

## 6. Testing

- **Round-trip property test** — the DSL's equivalent of the parity harness, and worth as much:
  for every golden fixture in `packages/testing/src/golden/` plus generated random DAGs (reuse the
  fuzz generator PLAN.md specifies for parity), assert `parse(print(g))` deep-equals `g`, including
  `parentId` nesting, positions, state decls, and every `data` field.
- **Idempotent formatting**: `format(format(s)) === format(s)` over the same corpus.
- **Golden text fixtures**: each `packages/testing/src/golden/*.ts` graph gains a `.flow` sibling,
  committed. A change to the printer shows up as a readable diff in review — which is the feature,
  demonstrated on itself.
- **Error quality tests**: unknown node kind, duplicate node name, edge referencing a missing node,
  an edge crossing a `body` boundary, unclosed triple-quote. Each asserts line/column and that the
  message names the fix (`validateGraph`'s existing "join them with a Merge node" is the standard).
- **Server**: file watcher fires an invalidation; `PUT` with a stale `ifMatch` returns 409 with the
  on-disk text; a run against a file-backed flow writes exactly one `flow_versions` row, and a second
  identical run writes none.
- **Persistence**: `getLatestGraphForFlowVersion` reads the file when present and the newest row when
  the file is gone; an execution whose file was deleted still renders its graph from `source_text`.
- **E2E** (`playwright/`): edit a flow on the canvas → assert the `.flow` file's text changed;
  edit the file externally → assert the canvas offers to reload and shows the change; paste DSL text
  into the import dialog → assert the nodes appear.

---

## 7. Slices

Each ends runnable and green. Slices 1–2 touch no existing behavior at all.

**S1 — `@flowlathe/dsl`.** Lexer, parser, printer, formatter, errors. Round-trip and idempotency
property tests over the golden corpus. Nothing else in the repo imports it yet.

**S2 — `@flowlathe/cli`.** `fmt`, `check`, `export`, `run`. Committed `.flow` fixtures. Still no
server or storage change; the DB remains the source of truth.

**S3 — file-backed flow store.** `FLOWLATHE_FLOWS_DIR`, watcher, `flow_versions` gains
`source_text`/`content_hash` + the unique constraint, snapshot-on-demand, `getLatestGraphForFlowVersion`
reads the file, `flowlathe flows export` + auto-export at first boot. This is the slice that can
break running behavior — the step-mode "latest version" semantics are the thing to guard with tests.

**S4 — canvas integration.** A text panel showing the live DSL for the open flow (read-only first,
then editable with parse-on-blur), save-writes-file with `ifMatch`, external-change reload prompt,
paste-to-import, and node renaming with the warning from §3.4.

**S5 — cleanup.** README rewritten around files-as-source-of-truth; `CLAUDE.md` updated; a
`flowlathe fmt --check` pre-commit hook documented.

---

## 8. Design traps

1. **A parser that knows node semantics will drift.** If you ever find yourself writing
   `if (kind === "prompt")` in `parse.ts`, stop — that logic belongs in the node's zod schema.
2. **Triple-quote dedenting changes rendered prompts.** Get it right in S1 and pin it with a test
   asserting the exact rendered template, or every flow's output shifts subtly at import time.
3. **Positions are semantically irrelevant but diff-relevant.** Do not let the canvas write a file on
   every mouse move. Debounce, and skip the write when only positions changed by less than a
   threshold — or accept position churn and say so. Decide deliberately; don't discover it.
4. **`fs.watch` on WSL2 is unreliable** for editors that write via rename, and this is the target
   machine. Test the actual editing workflow, not just `writeFile`.
5. **Node rename is an id change** with consequences for execution history (§3.4). It is the one
   place the DSL's name-as-id choice costs something.
6. **`@flowlathe/dsl` must stay isomorphic.** One `node:path` import breaks `packages/web`'s
   typecheck through raw-source resolution — CLAUDE.md documents this exact failure with `Buffer`.
7. **Do not make the compiled TS script round-trippable.** It is a deployment artifact. Two source
   formats is one too many.

---

## 9. Definition of done

- [ ] `@flowlathe/dsl` parses and prints every construct: nodes, kinds, positions, properties
      (including triple-quoted templates), edges, state decls, arbitrarily nested `body` blocks.
- [ ] Round-trip property test green over the golden corpus + fuzzed random graphs; formatting
      idempotent; committed `.flow` fixtures for every golden flow.
- [ ] Parse/validation errors carry line, column, and an actionable message.
- [ ] `@flowlathe/cli` with `fmt`, `check`, `export`, `run`, `flows export|import`.
- [ ] `FLOWLATHE_FLOWS_DIR` file store live; `flow_versions` carries `source_text` + `content_hash`
      with `UNIQUE(flow_id, content_hash)`; an unchanged save creates no row.
- [ ] Step mode still resolves the *current* graph, now from the file, with a regression test.
- [ ] An execution whose flow file was deleted still shows its graph and its DSL text.
- [ ] Canvas: live DSL panel, file-backed save with `ifMatch` 409 handling, external-change reload,
      paste-to-import, node rename with the history warning.
- [ ] E2E spec covering canvas→file and file→canvas.
- [ ] README updated (flows live in `flows/*.flow`; SQLite holds execution history); `CLAUDE.md`
      updated with what surprised the implementing agent.
