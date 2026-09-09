# Handoff briefs — domain toolsets (`github`, `git`)

Eight self-contained chunks implementing `PLAN-GITHUB.md` and `PLAN-GIT.md`. Each is sized for one
agent context, ends green on a root-level `pnpm -r typecheck && pnpm test`, and ends at one commit.

Read `../PLAN-DOMAIN-TOOLS.md` §1–§2 once, at C1, for *why* these exist. Later chunks need only
the *what*, which their own brief and plan sections carry.

| # | Brief | Depends on |
|---|---|---|
| C1 | [`C1-slot-safety.md`](C1-slot-safety.md) — shared validators in `plugin-common` | — |
| C2 | [`C2-github-client.md`](C2-github-client.md) — package, `env.ts`, `client.ts` | C1 |
| C3 | [`C3-github-tools.md`](C3-github-tools.md) — 8 tools + manifest | C2 |
| C4 | [`C4-github-wiring.md`](C4-github-wiring.md) — server wiring, README, notes, smoke test | C3 |
| C5 | [`C5-git-shared-plumbing.md`](C5-git-shared-plumbing.md) — `@flowlathe/path-safety` + `runArgv` | C1 |
| C6 | [`C6-git-config-commands.md`](C6-git-config-commands.md) — package, `config.ts`, `commands.ts` | C5 |
| C7 | [`C7-git-tools.md`](C7-git-tools.md) — 10 tools + manifest | C6 |
| C8 | [`C8-git-wiring.md`](C8-git-wiring.md) — server wiring, README, notes, smoke test | C7 |

## Running them

**Sequence:** C1 → (C2 → C3 → C4) and (C5 → C6 → C7 → C8).

The two tracks are independent after C1 and can run in parallel. They append one line each to two
shared files — `packages/plugins/_common/src/index.ts` and `packages/server/src/index.ts` — which
is the entire conflict surface.

If you parallelize with worktrees, **check `git branch -vv` for an "ahead" marker on `main`
first**. A worktree created off `origin/main` can silently be missing unpushed local commits; that
has bitten this repo before (`../notes/server-and-deployment.md`, the network-posture entry).

**C4 and C8 need you.** Both end in a manual smoke test against a running server — C4 wants a
GitHub PAT and a scratch repository, C8 wants a scratch git clone. They are deliberately separate
chunks so the agent stops there rather than declaring victory on unit tests alone.

## Conventions every chunk inherits

- Verify with `pnpm -r typecheck && pnpm test` **from the repo root**, never only the package you
  touched. `CLAUDE.md` rule 3 explains why.
- Copy a sibling plugin's `package.json`/`tsconfig.json` verbatim, including the pinned
  `typescript@5.9.3` and `vitest@5.0.0`. Never resolve `latest`.
- New surprises go in `documentation/notes/<subsystem>.md`, not `CLAUDE.md`.
- One commit per chunk.
