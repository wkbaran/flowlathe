# C3 — `@flowlathe/plugin-github`: the 8 tools and the manifest

**Goal.** Turn the client into `ToolRegistration`s — five read tools always, three write tools
only under `GITHUB_MODE=rw` — with layer-1 sanitization on every third-party string.

**Depends on:** C2. **Blocks:** C4.

---

## Read

- `documentation/PLAN-GITHUB.md` §3 — **the argument tables are the specification.** Every tool's
  name, arguments, requiredness, validator and return shape is there.
- `documentation/PLAN-GITHUB.md` §4.4 (handler order, sanitization caps), §4.5
  (`unavailableReason`), §4.6 (manifest), §6.3 (tests).
- `documentation/notes/security.md` — the sanitization-boundary entry. Mandatory; the caps table
  in §4.4 only makes sense against it.
- `documentation/notes/plugins-and-tools.md` — `toolOk`/`toolFail` key order, `trustedResult`,
  the `unavailableReason`-must-not-block rule.

## Copy the shape from

- **`packages/plugins/discord/src/tools.ts`** — the whole file. Handler order (validate → allowlist
  → `guarded` → envelope), the `channelAllowlistError` pattern your repo allowlist mirrors,
  `summarizeMessage`'s per-field `sanitizeUntrustedText`, and `createDiscordToolset`'s shared
  `unavailableReason` closure.
- `packages/plugins/searxng/src/tools.ts` — `guarded`/`toolOk` composition and
  `summarizeSearxngResults`.
- `packages/plugins/searxng/src/manifest.ts` — manifest shape.

## Create

```
packages/plugins/github/src/tools.ts
packages/plugins/github/src/manifest.ts
packages/plugins/github/src/tools.test.ts
```

## Modify

```
packages/plugins/github/src/env.ts      # githubToolsetFromEnv now returns real registrations
packages/plugins/github/src/index.ts    # export the manifest and the toolset factory
```

## Traps

- **`GITHUB_MODE=ro` must register five tools, not eight-with-three-refusing.** A
  registered-but-always-failing tool still reaches the model in `tools` and invites calls that
  always fail. Structural, not conditional (L4).
- **`toolOk`'s key order is contract** — `ok` first. It reaches the model as JSON text.
- **The diff is the one field that owns its truncation marker**, so it must `scrubUntrustedText`
  then slice by hand. Passing a `maxLength` to `sanitizeUntrustedText` would cut the marker back
  off. Every other field uses `sanitizeUntrustedText(value, cap, label)` with the §4.4 caps.
- **Never set `trustedResult`.** That field is whitelisted to the built-in state tools.
- **`unavailableReason` must not do I/O.** It is called synchronously on `/run`, `/step-start` and
  every `GraphEngine` construction including step-mode restores. Allowlist-empty check first, then
  a `CachedLivenessProbe` over `GET /rate_limit` — never a direct call. `/rate_limit` is the right
  probe because GitHub documents it as not counting against the rate limit and it 401s on a bad
  token.
- **`github_create_pull_request` defaults `draft: true`**, unlike GitHub's own API default.
  Deliberate — a draft PR does not request reviews or notify CODEOWNERS.
- `github_comment` serves both issues and PRs through the issue-comments endpoint. That is the same
  data-model fact that forces `github_list_issues` to filter items carrying a `pull_request` key.
  Both halves are deliberate; a comment in the code should say so.
- The manifest has **no `connect` field** — there is no OAuth dance.

## Do NOT

- Add merge, close, reopen, edit, delete, review-approval, label management, workflow dispatch, or
  any repo/org administration. `PLAN-GITHUB.md` §5 lists each and why.
- Add a ninth tool of any kind.
- Touch `packages/server/src/index.ts` — that is C4.

## Done when

```
pnpm -r typecheck && pnpm test
```

- `tools.test.ts` covers §6.3 in full: allowlist rejection without calling the client, `ok`-first
  key order, `labels` as both `"a,b"` and `'["a","b"]'`, zero-width/tag characters scrubbed out of
  an issue body, the diff's truncation marker surviving as the **last** thing in the string,
  `ro` ⇒ 5 registrations / `rw` ⇒ 8 / `nonsense` ⇒ 5, and token-without-allowlist ⇒ 5
  registrations all reporting an `unavailableReason` naming `GITHUB_ALLOWED_REPOS`.
- The `ro`/`rw` count assertions check **tool names**, not just array length.

**Commit:** `Add @flowlathe/plugin-github toolset and manifest`
