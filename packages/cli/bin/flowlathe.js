#!/usr/bin/env node
// This monorepo deliberately has no build step (see CLAUDE.md's README note about
// packages/server never having had a `dist/`) — every package runs from raw .ts source via tsx.
// `--import tsx` is Node's own documented way to run a .ts entrypoint, but the bare specifier
// "tsx" resolves relative to the *child's* cwd, and tsx is only symlinked into this package's own
// node_modules (pnpm's node_modules are strict, not flat) — resolving it here via
// `import.meta.resolve` (relative to *this* file, which does sit under packages/cli/node_modules)
// and passing the resolved path lets the child process keep the caller's real cwd, so relative
// file arguments on the command line still resolve the way the user expects.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));
const cliEntry = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const result = spawnSync(process.execPath, ["--import", tsxLoader, cliEntry, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
