# Flow DSL and the file-backed flow store

`.flow` text, round-tripping, the CLI, and watching the flows directory.

Moved verbatim out of `CLAUDE.md` when that file was split by topic; see it for the
index and for the invariants that apply repo-wide.

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
