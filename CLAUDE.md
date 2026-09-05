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
- **Playwright is pinned to `1.54.1`** (not registry `latest`) to match the browsers already
  cached at `~/.cache/ms-playwright` on this machine — bumping the version would trigger a browser
  download.
