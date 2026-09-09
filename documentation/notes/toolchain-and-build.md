# Toolchain and build

Pinned versions, module resolution, and package-boundary rules that surprise on first contact.

Moved verbatim out of `CLAUDE.md` when that file was split by topic; see it for the
index and for the invariants that apply repo-wide.

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
- **`@flowlathe/path-safety` (`packages/path-safety`) is a new, dependency-free, Node-only package
  extracted from `@flowlathe/runtime`'s `state-file-io.ts` (PLAN-GIT.md §4.1, C5 of the git-toolset
  handoff).** It holds `resolveWithinRoot`/`PathVerdict` (moved verbatim, zero behavior change —
  the pre-existing test suite moved with it, import path aside) plus a new `relativeTo(root,
  absolute)` helper. Both `@flowlathe/runtime` (`state-store.ts`) and `@flowlathe/plugin-common`
  now depend on it — `@flowlathe/plugin-common` re-exports it from its own `index.ts` so
  `@flowlathe/plugin-git` (and any future path-touching plugin) only needs a dependency on
  `@flowlathe/core` + `@flowlathe/plugin-common`, not a third direct workspace dependency. The
  reason this is its own package rather than living in either existing location: `core` must stay
  isomorphic (`realpathSync` is `node:fs`), and `plugin-common` must not depend on `runtime`
  (runtime's transitive closure pulls in every node kind — the locked direction is that
  `plugin-common` is a helper library *for* plugins, not for what plugins plug into). **Do not
  write a second copy of `resolveWithinRoot` anywhere** — that's the exact `url-safety.ts` ↔
  `allowed-hosts.ts` duplication mistake already recorded in `documentation/notes/security.md`,
  where the same SSRF gaps had to be independently found and fixed twice. `PLAN-FILE-TOOL.md`, if
  it is ever built, becomes a third consumer of this package rather than a fourth copy.
