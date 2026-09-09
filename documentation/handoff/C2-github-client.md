# C2 — `@flowlathe/plugin-github`: package, `env.ts`, `client.ts`

**Goal.** Scaffold the package and build the HTTP client for all eight operations, with the
403/429 rate-limit taxonomy. Nothing model-facing, nothing registered with the server yet.

**Depends on:** C1. **Blocks:** C3.

---

## Read

- `documentation/PLAN-GITHUB.md` §2 (locked decisions L1–L8), §3 (the operation tables — these are
  the method signatures), §4.0, §4.2, §4.3, §6.2.
- `documentation/notes/plugins-and-tools.md` — the SearXNG/Firecrawl/Discord entries, for the
  established client shape and the `unavailableReason` I/O constraint.
- `documentation/notes/toolchain-and-build.md` — the TypeScript pin.

## Copy the shape from

- **`packages/plugins/discord/src/client.ts`** — the closest existing model. Static-token auth, a
  hand-rolled private `request<T>()`, `retryAfterMsFromHeader` for 429s, id validation before
  interpolation. Read the whole file before writing anything.
- `packages/plugins/searxng/src/env.ts` — the `xConfigFromEnv` / `xToolsetFromEnv` pair and the
  "unset ⇒ undefined ⇒ zero registrations" comment.
- `packages/plugins/searxng/src/client.test.ts` — how an injected `fetchImpl` is used to test
  fully offline.
- `packages/plugins/searxng/package.json` and `tsconfig.json` — copy verbatim, change the name.

## Create

```
packages/plugins/github/package.json          # + "@flowlathe/providers": "workspace:*"
packages/plugins/github/tsconfig.json
packages/plugins/github/src/index.ts
packages/plugins/github/src/env.ts
packages/plugins/github/src/client.ts
packages/plugins/github/src/env.test.ts
packages/plugins/github/src/client.test.ts
```

`packages/plugins/*` is already a pnpm workspace glob, so `pnpm install` is all the wiring needed.

## Traps

- **Pin `typescript@5.9.3` and `vitest@5.0.0` by copying the sibling.** TS 7 exists and is
  `latest` on npm; it is a different compiler.
- **`@flowlathe/providers` is a real dependency**, for `retryAfterMsFromHeader` only.
  `plugin-discord` already takes it for the same reason. Do not reimplement the arithmetic — a
  previous audit found an unclamped second parse path in exactly this situation.
- **GitHub signals a primary rate limit with a 403, not a 429.** Three distinct cases, and
  collapsing any two of them produces a misleading error:
  - `403` + `x-ratelimit-remaining: 0` → do **not** retry (reset may be an hour out); fail naming
    the reset time.
  - `403` or `429` + `retry-after` → back off via `retryAfterMsFromHeader`, retry, bounded at 3.
  - any other `403` → an authorization failure; name the repo. This is the common "PAT lacks the
    scope" case and must not read as a rate limit.
- **Pin `X-GitHub-Api-Version: 2022-11-28`** on every request, alongside
  `Accept: application/vnd.github+json`. An unpinned client is a future silent behavior change.
- **Validate every id before it reaches a URL path.** `repoSlugSlot` / `gitRefSlot` from C1, then
  the allowlist. A `..` in a ref is a path-traversal bug even though no filesystem is involved.
- **Forward `signal`** from `ToolInvokeMeta` through to `fetchImpl`. SearXNG and Firecrawl do;
  Spotify and Discord do not. Be on the correct side of that split.
- `GITHUB_MODE` anything other than `rw` — unset, empty, misspelled — is `ro`, with one
  `console.warn` for an unrecognized value. Fail closed on a typo.
- Repo allowlist comparison is **case-insensitive**; GitHub owners and repo names are.

## Do NOT

- Implement pagination or follow `Link` headers (`PLAN-GITHUB.md` §4.3). One page, `per_page`,
  report what you got.
- Write `tools.ts` or `manifest.ts` — that is C3.
- Touch `packages/server/src/index.ts` — that is C4. This package must be invisible to the server
  when this chunk ends.
- Add any OAuth, credential storage, or `plugin_credentials` row. Auth is a manually-set
  `GITHUB_TOKEN` and nothing else (L2).

## Done when

```
pnpm -r typecheck && pnpm test
```

- `client.test.ts` covers a happy path per operation, all three 403/429 cases, the
  `pull_request`-key filtering fixture for `listIssues`, and a `..`-containing id rejected **with
  the `fetchImpl` stub never invoked** (assert the stub's call count, not just that the call
  failed).
- `env.test.ts`: `{}` ⇒ `undefined`; token only ⇒ config with an empty allowlist; `GITHUB_MODE`
  parsing including the fail-closed case.
- Every test runs offline. No network, no live token, no recorded cassettes.

**Commit:** `Add @flowlathe/plugin-github client and env config`
