# PLAN-STATE-FILES — file-backed State entries, replacing the generic file tool

Supersedes `PLAN-FILE-TOOL.md` (GitHub issue #2). That plan is left in place, marked superseded,
not deleted — it remains a valid design if a genuinely generic "browse an arbitrary directory at
runtime" tool is ever wanted later. This plan takes a different, narrower bet: fold file access
into the existing flow State system instead of adding a new toolset, because the two real use
cases (a flow reads a known document; a flow accumulates notes across a run) don't need a model to
supply an arbitrary path at all — the flow *author* already knows which file, at design time.

---

## 1. Problem, and why this is a better fit than a generic tool

`PLAN-FILE-TOOL.md` needed a rooted-path allowlist, symlink-escape checks, and a basename/prefix
denylist specifically because the *model* supplies an arbitrary path argument at runtime. If
instead the flow author picks a specific file when they build the flow — the same trust level as a
template string or a provider id — nearly that entire defensive apparatus becomes unnecessary: the
model never sees a path.

This plan merges two ideas the user raised together:

1. **State entries that hold long-form text** (a markdown document, not a short JSON value) —
   these should be real files on disk, not blobs in SQLite, so a human can find/inspect them
   directly and so writes are simple text operations, not JSON-merge semantics.
2. **Read-only file attachments a node can reference** (the "Resource" idea) — a document the
   author picks once, whose content becomes available to a node without a tool call.

The user's own framing, confirmed in conversation: these are the same mechanism with a mode flag,
not two features. A `StateDecl` gets a new `type: "file"` (which becomes the **default** type for
new declarations), with a `fileMode: "read-only" | "read-write"`. Read-only is the Resource case.
Read-write is the "markdown state" case, with an optional `versioned` flag.

### 1.1 Facts that shape the design (verified against the actual code, not assumed)

1. **`StateStore`'s interface is already exactly the right seam.** `packages/core/src/state.ts`:
   `{read(entry, meta?), write(entry, value, meta?)}`. `packages/runtime/src/tool-registry.ts`'s
   `stateToolset` (the `read_state`/`write_state` tools) calls only `state.read`/`state.write` —
   it has zero knowledge of how a value is stored. This means **file-backed entries need no
   change at all above `createStateStore`'s implementation** — not to the tools, not to their
   `trustedResult: true` reasoning (still correct: it's the flow's own data, written by its own
   tools, regardless of backing store), not to `RunEvent`'s shape.
2. **`createStateStore` today has exactly one precedent for "a value not sourced from replaying
   `state_writes` rows": `decl.initial`, applied once at construction, before replay.** There is
   no existing mechanism for a value computed live from anywhere else. File-backed entries need a
   genuinely new branch inside `createStateStore` (`packages/runtime/src/state-store.ts`) that
   does live disk I/O instead of `Map` + `applyMerge` + blob persistence.
3. **A declared port must always have a real edge — confirmed, no existing exception class.**
   `NodeEmitter<Spec>.inputPorts(spec: Spec): string[]` (`packages/core/src/contracts.ts`) takes
   only the node's own spec — no graph, no state. `packages/nodes/prompt/src/emit.ts`:
   `inputPorts: (spec) => extractTemplateVars(spec.template)` — every `{{name}}` becomes a
   required port, full stop. `packages/interpreter/src/registry.ts`'s parallel `NodeDescriptor`
   does the same, independently. `packages/core/src/regions.ts`'s `validateGraph` (R7) flags any
   port with no incoming edge as an error, with **the only existing exception being Loop/Map's
   injected port name** (`accPortName`/`itemPortName`) — a port-name match, not a "this name
   means something other than a port" rule. Context/LlmConfig are ambient today, but they're never
   resolved through `extractTemplateVars` at all — they're looked up by node id, invisible to the
   template mechanism. **Auto-injecting a state entry's value into `{{entryName}}` without a wired
   edge is a genuinely new kind of exception**, and it has to be built without changing
   `NodeEmitter.inputPorts`'s signature (that would ripple through every node package for a
   feature only Prompt nodes need).
4. **The compiler independently re-derives ports from the same `NodeEmitter`s, through a second
   table.** `packages/compiler/src/emit-table.ts`'s `emitTable`/`schemaTable` import each node
   package's own emitter — a different object from the interpreter's `registry.ts`. Both wrap
   `extractTemplateVars` separately. **Any exemption for a state-bound template variable must be
   implemented at both call sites** (`packages/interpreter/src/run-graph.ts`'s port-readiness
   checks and `packages/compiler/src/compile-graph.ts`'s `portsOf`/`callExpr`) — the same
   "manual parity risk" class CLAUDE.md already documents for `contextNodeId` and scoped
   activation keys. This plan pins it with a golden parity fixture (§6.4), matching the
   established convention of verifying such a fixture actually fails pre-fix before trusting it.
5. **`validateGraph` already receives the whole `FlowGraph` — including `.state` — but never
   reads it.** `packages/core/src/regions.ts`: `export function validateGraph(graph: FlowGraph,
   opts: ValidationOptions = {})`. No new parameter is needed to make R7 state-aware; the function
   just has to start reading `graph.state`, which it already has in hand.
6. **The actual template-rendering seam is `packages/nodes/prompt/src/run.ts`'s
   `renderTemplate(spec.template, inputs)`, where `inputs: Record<string, string>` is built
   entirely from wired ports by `packages/interpreter/src/run-graph.ts` before `runPrompt` is
   ever called.** This is exactly where a state-entry fallback has to be spliced in: build
   `inputs` from real ports as today, then fill in any remaining template names that match a
   declared state entry from `ctx.state.read(name)`, before calling `runPrompt`. The compiled
   script's equivalent (`compile-graph.ts`'s `callExpr`, which builds the object literal passed to
   `rt.prompt(...)`) needs the identical fallback.
7. **Branch-forking is safe-by-omission for an entry with no `state_writes` rows — confirmed, not
   guessed.** `packages/server/src/stepper.ts`'s `stepBack` seeds a new branch only by iterating
   `getStateSnapshotAsOf`'s result, which is built purely from querying `stateWrites` rows
   (`packages/persistence/src/state.ts`). A declared entry with zero such rows simply never
   appears in that result — nothing throws, nothing silently corrupts. This is why deferring
   branch isolation for file-backed entries (§7) is a real, bounded decision and not a hidden risk:
   the consequence is exactly "one shared file across every branch of an execution, last-write-wins
   on disk," never a crash.
8. **No filesystem-path-containment code exists anywhere in this repo.** Grepped across
   `packages/core`, `packages/runtime`, `packages/server`, `packages/persistence`: zero matches for
   `resolveWithinRoot`, `realpathSync`-based containment, or anything similar.
   `PLAN-FILE-TOOL.md`'s §5.1 fully specifies the primitive this plan needs (NUL-byte rejection,
   absolute/`~` rejection, lexical `..` rejection, `path.resolve` + `realpathSync` + containment,
   the symlink-escape and sibling-prefix test cases) — reused here verbatim, relocated to
   `packages/runtime` (Node-only already; hosts `state-store.ts`) rather than a plugin package,
   since there is no separate `fs` toolset in this design.
9. **`run_events` is a separate table from `state_writes`** (`packages/persistence/src/schema.ts`)
   — a `RunEvent` is always persisted through the generic run-event log regardless of whether a
   `state_write`'s value came from a blob or a file. No new persistence path is needed for the
   event itself, only for the value.
10. **Merge semantics turn out to be simpler for files, not harder.** `applyMerge`'s existing
    `"append"` rule wraps a value into a JSON array (`[...prevArr, incoming]`) — wrong for a
    growing document. For a *file*, "append" has an obvious, correct meaning: append bytes/text to
    the end of the file. No new merge-rule variant is needed — file-type entries just interpret
    `"replace"`/`"append"` as file operations (overwrite vs. append-to-end) instead of running them
    through `applyMerge`. `numeric-add`/`set-union`/`error-on-conflict` don't apply to a file and
    are excluded from the type's allowed merge rules (UI-enforced).

---

## 2. Locked decisions

| # | Decision | Why |
|---|---|---|
| L1 | **New `StateValueType` value: `"file"`, and it becomes the default** for new declarations (Canvas's `addStateDecl` and the schema's `.default()`). | Matches the user's framing: file-backed is the primary, expected shape going forward, not an edge case. |
| L2 | **`fileMode: "read-only" \| "read-write"`** on the decl, required when `type === "file"`. Read-only is the Resource case; read-write is the markdown/notes case. | One mechanism, one mode flag — the whole point of the merge. |
| L3 | **`versioned: boolean`**, meaningful only when `fileMode === "read-write"`. Off (default) means the declared `filePath` is written to directly, in place, across every run forever — no copies, ever. | User's explicit answer: "yes" to writing straight to the path when not versioned. |
| L4 | **Versioned mode**: `filePath` is a read-only **template/seed document**, never mutated. On the *first* read or write of that entry in a given execution, a fresh file is minted at `<dir>/<basename>.v<flowVersion>.<isoTimestamp>.<ext>`, seeded with the template's current content, and every subsequent access in that same execution reuses that same minted path. | User's explicit answer: timestamp instead of a run-number counter (no new sequence needed — `flow_versions.version`, already an integer, plus `Date.now()`/ISO string, is enough for a unique, sortable, human-legible name). |
| L5 | **Read-only mode never mints a copy.** Every read is a live read of `filePath` itself. | It's a Resource — the point is reading the author's document as it currently is. |
| L6 | **`write_state` on a read-only entry rejects** with a clear error, not a silent no-op. | Mirrors the "mode is structural" principle from `PLAN-FILE-TOOL.md`'s L2 — a read-only entry should behave read-only, not merely be discouraged from writes. |
| L7 | **File-type merge is restricted to `replace` \| `append`**, interpreted as literal file operations (overwrite / append-to-end), not run through `applyMerge`. `numeric-add`/`set-union`/`error-on-conflict` are not offered for `type: "file"` in the UI. | §1.1 fact 10 — this is a correct, obvious semantics for files with zero new merge-rule code. |
| L8 | **Ambient template-variable auto-injection is scoped to Prompt nodes only, in v1.** A `{{name}}` in a Prompt's template with no wired edge on that port, where `name` matches a declared state entry (any type, not just `file` — the mechanism is type-agnostic once built), resolves to `ctx.state.read(name)` instead of requiring an edge. Loop/Map's `initTemplate`/`itemsTemplate` are untouched — their template variables still require real edges, no exception. | Keeps the blast radius of a genuinely new port-exemption mechanism to the one node kind that motivated it, and avoids touching Loop/Map's already-delicate scoped-activation-key/`contextNodeId` machinery (§1.1 fact 4's "manual parity risk" is already a full plate for one node kind). |
| L9 | **The exemption lives outside `NodeEmitter.inputPorts`, at the three call sites that interpret its result as "needs an edge"** (`validateGraph`'s R7, `run-graph.ts`'s port-readiness checks, `compile-graph.ts`'s `portsOf`/`callExpr`) — never by changing `NodeEmitter<Spec>.inputPorts`'s signature. | §1.1 facts 3/4/5 — a signature change would ripple through every node package for a Prompt-only feature; `validateGraph` and the dispatch/codegen paths already have `graph.state` in scope without any new parameter. |
| L10 | **A `state_write` RunEvent for a file-type entry carries a bounded preview, not the full file content.** Same discipline as `PLAN-TOOL-APPROVAL.md`'s `argsPreview`: scrub, cap at a few thousand characters, mark truncation. | A growing markdown document embedded in full on every write would bloat the persisted `run_events` log and the live SSE stream without bound. |
| L11 | **Path containment reuses `PLAN-FILE-TOOL.md`'s `resolveWithinRoot` design verbatim**, relocated to `packages/runtime/src/state-file-io.ts` (Node-only). One root env var (e.g. `FLOWLATHE_STATE_FILES_ROOT`); every `filePath` a flow author picks (via a Canvas file-picker) is relative to it. | §1.1 fact 8 — no reason to redesign a primitive this plan already has a fully-specified version of; only its location and consumer change. |
| L12 | **Branch-fork isolation for file-backed entries is explicitly deferred** (§7) — confirmed safe-by-omission, not a hidden risk (§1.1 fact 7). | User's explicit instruction: "let's not worry about this for now." |
| L13 | **No changes needed to `PLAN-TOOL-APPROVAL.md`.** An operator can already gate the `"state"` toolset generically via `FLOWLATHE_TOOL_APPROVAL=state` — file-backed `write_state` calls fall under that for free, since the tool-approval gate operates on toolset name, not on how a value is stored. | Confirms the two plans compose without new work — worth stating explicitly so nobody re-derives it. |

---

## 3. Files

New:

```
packages/runtime/src/state-file-io.ts             # resolveWithinRoot, versioned-copy minting,
                                                    #   bounded read/write/append, binary detection
packages/runtime/src/state-file-io.test.ts
```

Modified:

```
packages/core/src/state.ts                         # StateValueTypeSchema += "file"; StateDeclSchema
                                                    #   += fileMode/versioned/filePath; default "file"
packages/core/src/regions.ts                        # validateGraph R7: exempt prompt-node ports
                                                    #   matching a declared state entry name
packages/runtime/src/state-store.ts                 # createStateStore: file-backed read/write branch
packages/runtime/src/state-store.test.ts
packages/interpreter/src/run-graph.ts               # dispatchNode: state-entry fallback for prompt
                                                    #   template vars with no wired edge; port-
                                                    #   readiness exemption for the same names
packages/interpreter/src/run-graph.test.ts
packages/compiler/src/compile-graph.ts              # portsOf / callExpr: identical state-entry
                                                    #   exemption + fallback for the emitted script
packages/persistence/src/schema.ts                  # state_decls: + file_mode, versioned, file_path
                                                    #   columns; migration via drizzle-kit generate
packages/persistence/src/state.ts                   # saveStateDecls/getStateDecls: thread new fields
packages/server/src/host-builder.ts                 # pass the resolved state-files root + flow
                                                    #   version number into createStateStore
packages/server/src/index.ts                        # resolve FLOWLATHE_STATE_FILES_ROOT once
packages/web/src/pages/Canvas.tsx                   # State panel: type "file" UI (mode toggle,
                                                    #   versioned checkbox, file-picker for filePath)
packages/testing/src/golden/file-state-node.ts       # golden parity fixture (§6.4)
documentation/PLAN-FILE-TOOL.md                     # superseded banner at top (kept, not deleted)
README.md                                           # document FLOWLATHE_STATE_FILES_ROOT and the
                                                    #   file/resource merge, in place of the old
                                                    #   fs-tool section this replaces
CLAUDE.md                                           # §9 notes
```

---

## 4. Implementation

### 4.1 — `packages/core/src/state.ts`

```ts
export const StateValueTypeSchema = z.enum(["file", "string", "number", "boolean", "array", "object"]);
export type StateValueType = z.infer<typeof StateValueTypeSchema>;

export const FileStateModeSchema = z.enum(["read-only", "read-write"]);
export type FileStateMode = z.infer<typeof FileStateModeSchema>;

export const StateDeclSchema = z.object({
  name: z.string().min(1),
  type: StateValueTypeSchema.default("file"),
  merge: MergeRuleSchema,
  initial: z.unknown().optional(),
  /** Only meaningful when type === "file". Relative to FLOWLATHE_STATE_FILES_ROOT, validated via
   *  resolveWithinRoot at every access, never trusted as pre-validated just because it round-
   *  tripped through a saved graph. */
  filePath: z.string().min(1).optional(),
  fileMode: FileStateModeSchema.optional(),
  /** Only meaningful when fileMode === "read-write". Ignored for read-only entries. */
  versioned: z.boolean().optional(),
});
```

A `.superRefine` (or a small standalone validator called from wherever `StateDeclSchema` is parsed
— see §1.1 fact 8's call-site list, `packages/core/src/graph.ts:44`'s `parseFlowGraph`) should
reject a `type: "file"` decl missing `filePath`/`fileMode`, and reject `merge` values outside
`{replace, append}` for `type: "file"` — fail at graph-parse time (the existing 400-on-save path
in `routes/flows.ts`), not at first run.

### 4.2 — `packages/runtime/src/state-file-io.ts`

The relocated, Node-only path/IO layer. Ports `PLAN-FILE-TOOL.md` §5.1's `resolveWithinRoot`
verbatim (NUL check, absolute/`~` rejection, lexical `..` rejection, `path.resolve` +
`realpathSync` + containment, the accepted TOCTOU gap documented the same way), plus:

```ts
export interface StateFileConfig {
  root: string;           // realpath'd at boot, verified directory
  flowVersion: number;    // flow_versions.version — for minting versioned filenames
}

export interface ResolvedStateFile {
  path: string;           // absolute, realpath'd, contained in root
}

/** Mints "<dir>/<basename>.v<flowVersion>.<isoTimestamp>.<ext>" next to the template document,
 *  seeded with the template's current content. Called at most once per execution per entry — the
 *  caller (state-store.ts) remembers the minted path for the rest of that execution. */
export function mintVersionedCopy(cfg: StateFileConfig, templatePath: ResolvedStateFile): ResolvedStateFile;

export function readStateFile(path: ResolvedStateFile, opts: { maxChars: number }): { content: string; truncated: boolean };

export function writeStateFile(path: ResolvedStateFile, content: string, mode: "replace" | "append", opts: { maxBytes: number }): void;
```

`readStateFile` reuses `PLAN-FILE-TOOL.md`'s binary-detection and scrub-then-truncate discipline
(§5.4 of that plan) — a state-backed document is exactly as capable of carrying hidden/control
characters as an arbitrary file would have been. `writeStateFile`'s `"replace"` uses the same
atomic temp-file-then-rename pattern that plan specified (L5 there); `"append"` cannot be made
atomic the same way (documented there too) and uses a plain append-mode write.

### 4.3 — `packages/runtime/src/state-store.ts`

`createStateStore` gains a per-entry file-config map and an in-memory "resolved path for this
execution" cache (populated lazily, on first access, only for versioned entries):

```ts
export function createStateStore(
  emit: (event: RunEvent) => void,
  init: StateStoreInit & { fileConfig?: StateFileConfig },
): StateStore {
  // existing values/rules maps, unchanged for non-file entries
  const fileDecls = new Map(init.decls.filter((d) => d.type === "file").map((d) => [d.name, d]));
  const resolvedPaths = new Map<string, ResolvedStateFile>(); // lazily minted, per execution

  function resolveFor(decl: StateDecl): ResolvedStateFile {
    const template = resolveWithinRoot(init.fileConfig!.root, decl.filePath!, { mustExist: decl.fileMode === "read-only" });
    if (decl.fileMode === "read-only" || !decl.versioned) return template;
    if (!resolvedPaths.has(decl.name)) {
      resolvedPaths.set(decl.name, mintVersionedCopy(init.fileConfig!, template));
    }
    return resolvedPaths.get(decl.name)!;
  }

  return {
    read(entry, meta) {
      const decl = fileDecls.get(entry);
      if (decl) {
        const { content } = readStateFile(resolveFor(decl), { maxChars: STATE_FILE_MAX_READ_CHARS });
        emit({ kind: "state_read", entry, seqSeen: seq, viaTool: meta?.viaTool ?? false, activationKey: meta?.activationKey });
        return content;
      }
      // ...existing Map-based path, unchanged
    },
    write(entry, value, meta) {
      const decl = fileDecls.get(entry);
      if (decl) {
        if (decl.fileMode === "read-only") throw new Error(`state entry "${entry}" is read-only`);
        writeStateFile(resolveFor(decl), String(value), decl.merge as "replace" | "append", { maxBytes: STATE_FILE_MAX_WRITE_BYTES });
        seq += 1;
        emit({ kind: "state_write", entry, value: previewOf(String(value)), merge: decl.merge, seq, viaTool: meta?.viaTool ?? false, activationKey: meta?.activationKey });
        return;
      }
      // ...existing applyMerge + blob-persist path, unchanged
    },
  };
}
```

`previewOf` implements L10 — scrub, truncate to a few thousand characters, mark truncation,
following the exact "scrub-then-truncate, never `sanitizeUntrustedText(text, maxLength)`"
discipline this codebase already established (`PLAN-TOOL-APPROVAL.md`'s `previewArgs`).

`init.fileConfig` is only required when at least one `type: "file"` decl exists — `host-builder.ts`
threads it through only when `resolveToolApprovalConfig`-style boot resolution (§4.5) succeeded;
if a flow declares a file-type entry but `FLOWLATHE_STATE_FILES_ROOT` is unset, fail the same way
`FLOWLATHE_FS_ROOT` unset would have — a clear error at run-start, not a null-pointer deep inside
`createStateStore`.

### 4.4 — the ambient template-variable exemption (the two-sided parity risk, §1.1 facts 3/4)

**Interpreter side** — `packages/interpreter/src/run-graph.ts`. Add one function, called from both
`isReady()` and `dispatchNode()` in place of the bare `registry[node.type].inputPorts(spec)`:

```ts
function requiredPortsFor(node: FlowNode, spec: unknown, graph: FlowGraph): PortDecl[] {
  const all = registry[node.type].inputPorts(spec);
  if (node.type !== "prompt") return all;
  const stateNames = new Set(graph.state.map((d) => d.name));
  return all.filter((p) => !stateNames.has(p.name));
}
```

`dispatchNode`, when building `inputs` for a Prompt node, supplements the filtered-out names:

```ts
const inputs: Record<string, string> = /* existing port-derived inputs, unchanged */;
if (node.type === "prompt") {
  for (const varName of extractTemplateVars((spec as PromptSpec).template)) {
    if (!(varName in inputs)) {
      const decl = graph.state.find((d) => d.name === varName);
      if (decl) inputs[varName] = String(this.run.state.read(varName));
    }
  }
}
```

**Compiler side** — `packages/compiler/src/compile-graph.ts`. `portsOf` (feeds `validateGraph`)
and `callExpr` (builds the emitted `inputs` object literal) both need the identical filter/fallback,
using `graph.state` (already in scope in both functions — `compileGraph`'s top-level `graph`
parameter). `callExpr`'s emitted code for a state-bound name becomes `state.read("varName")`
inlined into the generated `inputs` object literal, rather than a `n_<id>.output` reference.

**`validateGraph` side** — `packages/core/src/regions.ts`, R7:

```ts
const stateNames = new Set(graph.state.map((d) => d.name));
// ...for each node, for each port from portsOf(node):
if (node.type === "prompt" && stateNames.has(port)) continue; // ambient state binding, not a port
```

All three changes are additive and gated on `node.type === "prompt"` — no other node kind's port
semantics change at all.

### 4.5 — server wiring

`packages/server/src/index.ts`: resolve `FLOWLATHE_STATE_FILES_ROOT` once at boot (realpath,
verify it's a directory — same pattern as `resolveAllowedHosts`/`PLAN-FILE-TOOL.md`'s
`fsConfigFromEnv`), unset ⇒ `undefined` (any flow declaring a `type: "file"` entry then fails
clearly at run-start, per §4.3). Thread the resolved root through `buildApp` → route deps →
`runFlow`/`stepOnce` → `buildHostAndRun`, the same pipeline `pluginToolsets`/`toolApprovalConfig`
already use (`PLAN-TOOL-APPROVAL.md` §1.1 fact 4 traced this exact pipeline in full).

`packages/server/src/host-builder.ts`: look up the flow version's numeric `version` (a cheap
query against `flow_versions` by the already-available `flowVersionId`) and pass
`{root, flowVersion}` into `createStateStore`'s new `fileConfig` option.

### 4.6 — `packages/web/src/pages/Canvas.tsx`

The State panel's per-entry row gains, when `type === "file"`:
- a mode select (`read-only` / `read-write`)
- a `versioned` checkbox, shown only when mode is `read-write`
- a file-path field with a picker — for v1, a plain text field is acceptable (typed relative to
  the configured root, validated server-side on save via §4.1's refinement) rather than a real
  file-browser dialog; a proper picker needs a new `/api/state-files/browse`-style endpoint and is
  a reasonable v1.1 follow-on, not blocking this plan.
- `addStateDecl()`'s default changes from `{type: "string", merge: "replace"}` to
  `{type: "file", merge: "replace", fileMode: "read-write"}` (L1).

---

## 5. What existing content this leaves alone

- `read_state`/`write_state` tool specs, `stateToolset`, `trustedResult` reasoning: **unchanged**
  (§1.1 fact 1).
- Non-file `StateValueType`s (`string`/`number`/`boolean`/`array`/`object`): **unchanged** —
  same `Map` + `applyMerge` + blob-persist path as today.
- Loop/Map's `initTemplate`/`itemsTemplate`: **unchanged** (L8) — no ambient-state exemption there.
- Router/Merge/Gate/Search/Fetch/Trigger node kinds: **unchanged** — none of them derive ports from
  `extractTemplateVars`, so nothing in §4.4 touches them.
- `PLAN-TOOL-APPROVAL.md`: **unchanged** (L13) — `FLOWLATHE_TOOL_APPROVAL=state` already gates
  every `read_state`/`write_state` call, file-backed or not.

---

## 6. Testing

### 6.1 `packages/runtime/src/state-file-io.test.ts`

Real filesystem under `mkdtempSync` — no mocking, matching `PLAN-FILE-TOOL.md`'s own testing
discipline:

- `resolveWithinRoot`: every case from `PLAN-FILE-TOOL.md` §6.1 (symlink escape, sibling-prefix,
  `..` rejection, NUL byte, absolute path) — this is the same primitive, just relocated.
- `mintVersionedCopy`: two calls in the same second produce two distinct paths (timestamp
  granularity must not collide — use a monotonic counter suffix or millisecond+random tie-breaker
  if `Date.now()` alone isn't fine-grained enough); the minted file's content matches the
  template's content at mint time; the template file itself is untouched afterward.
- `readStateFile`/`writeStateFile`: binary detection, byte cap, scrub-then-truncate marker survival
  (never `sanitizeUntrustedText(text, maxLength)` — same rule as every other plan in this repo),
  `"append"` genuinely appends rather than overwriting, `"replace"` is atomic (temp+rename).

### 6.2 `packages/runtime/src/state-store.test.ts`

- a `type: "file", fileMode: "read-write", versioned: false` entry: first `write` creates the file
  at the declared path; a second `write` with `merge: "replace"` overwrites it; with `merge:
  "append"` extends it; `read` returns current content.
- `versioned: true`: first `read` OR first `write` (test both orders) mints a copy; a second
  access in the same store instance reuses the same minted path; the original `filePath` is never
  mutated.
- `fileMode: "read-only"`: `write` throws; `read` returns the live file's content with no copy
  minted, verified by asserting no new file appears in the directory.
- `state_write` event's `value` field is a bounded preview for a large write, not the full content.
- a non-file entry is completely unaffected — this test suite doesn't touch the existing
  `applyMerge`/blob-replay tests, it only adds to them.

### 6.3 `packages/interpreter/src/run-graph.test.ts`

- a Prompt node whose template contains `{{notes}}`, with a declared `type: "file"` state entry
  named `notes` and **no wired edge** on that port name: the node dispatches successfully (proves
  the port-readiness exemption actually works, not just that the value resolves) and its rendered
  prompt contains the file's content.
- the same graph with the entry declared but the wrong name in the template still errors with the
  existing "missing template variable" message — the exemption is name-matched, not blanket.
- a *non-prompt* node kind with a template-shaped field (none exist today, but assert defensively
  that `requiredPortsFor`'s `node.type !== "prompt"` early-return means Loop/Map's own port
  computation is byte-for-byte unchanged) — a regression guard for L8.

### 6.4 Golden parity fixture: `packages/testing/src/golden/file-state-node.ts`

Following this repo's established convention (`router-deep-branch`, `colliding-ids`): a graph with
one Prompt node whose template references a declared file-backed state entry by name, with no
wired edge for it. **Verify this fixture actually fails against a compiler that has only the
interpreter-side fix applied** (i.e., confirm the two-sided parity risk is real, not theoretical)
before trusting it as a regression pin — the same discipline every other golden fixture in this
repo was held to.

### 6.5 e2e

**No new Playwright spec** — consistent with the state-of-the-art in this repo for every
plugin/feature-shaped slice that isn't a numbered core slice. Coverage is the suites above plus a
manual smoke test: declare a `type: "file"` entry, wire a Prompt node's template to reference it
with no edge, run the flow, and confirm the rendered prompt in the run log actually contains the
file's content.

---

## 7. Scope: deliberately not built

- **Branch-fork isolation for file-backed entries** (L12) — confirmed safe-by-omission (§1.1 fact
  7): stepping back and forking a branch mid-run leaves a file-backed entry's on-disk file shared
  across every branch of that execution, last-write-wins. A real gap for a user who forks a branch
  specifically to try two different notes-taking paths side by side; not fixed here.
- **Loop/Map ambient state injection** (L8) — deferred to keep this plan's blast radius to one
  node kind. A future extension would need the same two-sided treatment applied to
  `initTemplate`/`itemsTemplate`'s port computation, on top of Loop/Map's existing scoped-id
  machinery — nontrivial, and no motivating use case yet.
- **A real file-picker UI** (§4.6) — v1 ships a validated text field; a browse dialog is a small,
  separable follow-on needing one new read-only listing endpoint.
- **Multiple roots** — one `FLOWLATHE_STATE_FILES_ROOT`, matching `PLAN-FILE-TOOL.md`'s own L1
  reasoning (multi-root generality only worth it once someone asks).
- **Any locking or true concurrency safety beyond last-write-wins** for a non-versioned read-write
  entry accessed by more than one node/tool-call in the same run. Not new — this is the exact
  concurrency story `applyMerge`'s existing `"replace"` rule already accepts for regular state
  ("`replace` is genuinely nondeterministic under concurrency," per `state.ts`'s own doc comment) —
  file-backed `"replace"` inherits the identical tradeoff, just against a file instead of a blob.
- **DSL (`.flow` text) representation of the new `StateDecl` fields.** `packages/dsl` needs to
  round-trip `filePath`/`fileMode`/`versioned` the same way it already does for `merge`/`initial` —
  not verified as part of this plan's research; flagged as a real, not-yet-checked integration
  point to confirm during implementation, not silently assumed to fall out for free.
- **Compiled/standalone-script support.** A compiled script has no server-resolved
  `FLOWLATHE_STATE_FILES_ROOT` pipeline built for it in this pass — `compile-graph.ts`'s emitted
  `inputs` fallback (§4.4) assumes a `state.read(...)` call exists in the runtime host the script
  constructs, but wiring that host's `state` to real file I/O (env-resolved root, mirroring how
  `standalone` toolsets reconstruct themselves from `process.env`) is not designed here. A
  compiled script using a `type: "file"` entry should fail clearly at compile time (mirroring
  `REQUIRED_PLUGIN_TOOLSETS`'s exported-script refusal pattern) until this is designed properly —
  don't let it silently crash at runtime instead.

---

## 8. Migration

`state_decls` gains three nullable columns (`file_mode`, `versioned`, `file_path`) via
`drizzle-kit generate`, following this repo's standard migration process. Existing declared
entries (persisted with no value for these columns, and whatever `type` they already have) are
completely unaffected — the new default (`type: "file"`) only applies to *new* declarations
created through Canvas's "add" button from this point forward; `StateDeclSchema`'s `.default()`
never rewrites an already-saved value.

---

## 9. `CLAUDE.md` notes (definition of done)

- **A declared state entry's name can now satisfy a Prompt node's template variable with no wired
  edge at all** — the first exception to "every declared port needs a real edge" that isn't the
  Loop/Map injected-port convention. Scoped deliberately to Prompt nodes only; do not assume it
  generalizes to Loop/Map's `initTemplate`/`itemsTemplate` without doing the same two-sided work.
- **The exemption is implemented at the three call sites that interpret `NodeEmitter.inputPorts`'s
  result, never inside `inputPorts` itself** — `NodeEmitter<Spec>.inputPorts(spec)` still takes
  only the node's own spec, unchanged, because changing that signature would ripple through every
  node package for a Prompt-only feature.
- **File-backed state entries bypass `state_writes`/blob persistence entirely** — they are
  invisible to `getStateSnapshotAsOf`/`stepBack`'s branch-forking, which only ever iterates rows
  that exist. This is why deferring branch isolation for them was safe: there was never a code
  path that assumed every declared entry is replayable and would misbehave if one isn't.
  Recorded so any future audit of branch-forking correctness doesn't have to re-derive this.
- **File-type "append" means literal byte/text append, not `applyMerge`'s array-wrapping
  semantics** — file-type entries never go through `applyMerge` at all. Don't "simplify" by
  routing them through the shared merge function; that's exactly the array-wrapping bug this
  design avoids.
- **`resolveWithinRoot` now lives in `packages/runtime`, not a plugin package** — the same
  primitive `PLAN-FILE-TOOL.md` designed, relocated because this design has no separate `fs`
  toolset for it to belong to. If `PLAN-FILE-TOOL.md`'s generic tool is ever built later, it
  should import this copy rather than re-deriving a second one.
- **`FLOWLATHE_TOOL_APPROVAL=state` already gates file-backed writes for free** — no change needed
  to `PLAN-TOOL-APPROVAL.md`'s design; the gate operates on toolset name, not storage backing.
- **DSL round-tripping of the new `StateDecl` fields was not verified as part of this plan's
  research** — check `packages/dsl` before assuming it falls out for free.

## 10. Definition of done

- [ ] `pnpm -r typecheck` and `pnpm test` green from the repo root.
- [ ] `packages/runtime/src/state-file-io.ts` exists with the tests in §6.1, including the
      symlink-escape and sibling-prefix cases ported from `PLAN-FILE-TOOL.md`.
- [ ] `state-store.test.ts` covers non-versioned/versioned/read-only behavior and the bounded
      `state_write` preview (§6.2).
- [ ] `run-graph.test.ts`'s ambient-injection test (§6.3) passes, and the golden fixture (§6.4) is
      confirmed to actually fail against an interpreter-only fix before being trusted as a pin.
- [ ] A flow with no `type: "file"` entries behaves identically to before this plan — no new
      required env var, no behavior change to non-file state.
- [ ] With `FLOWLATHE_STATE_FILES_ROOT` set: a real flow with a read-only resource entry and a
      versioned read-write notes entry runs end to end, verified manually against the running
      server, including confirming a second run mints a second, distinctly-named file.
- [ ] README documents `FLOWLATHE_STATE_FILES_ROOT` and the file/resource merge, replacing the
      section that would otherwise have documented `PLAN-FILE-TOOL.md`'s generic tool.
- [ ] CLAUDE.md carries the §9 entry.
- [ ] `PLAN-FILE-TOOL.md` carries a superseded banner pointing here.
