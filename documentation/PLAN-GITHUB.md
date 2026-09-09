# PLAN-GITHUB — a `github` toolset over the REST API

Read `PLAN-DOMAIN-TOOLS.md` first: it holds the reasoning for why this is an HTTP client rather
than a `gh` subprocess (D1), why auth is the operator's job done manually elsewhere (D4), and the
shared `slot-safety.ts` primitive this plan introduces (§7 there).

This is Tier A work — the vendor has a complete REST API, so there is no argv parser, no
subcommand, no config file and no local process anywhere in the design. It needs **zero** new
runtime machinery beyond one validator module, and it is the closest thing in this family to a
copy of `@flowlathe/plugin-discord` with different endpoints.

---

## 1. Problem

A flow that manages software cannot see its own issues, pull requests or CI results. Everything
about "what is the state of this project" lives behind a GitHub API this repo has no client for.

The `shell` plan would have reached this through `gh`, which would add: a subprocess, `gh`'s own
argv parser, `gh`'s alias config file (the §1 config-file class in `PLAN-DOMAIN-TOOLS.md`), a
second credential path, and untestability offline. All to reach endpoints that are one `fetch`
away.

### 1.1 Facts that shape the design

Verified in this repo before writing anything below:

1. **Four HTTP plugins already exist and share one shape**: an injected `fetchImpl` (defaulting to
   the global `fetch`) on a hand-rolled client class, `httpGetJson`/`requestJson` from
   `@flowlathe/plugin-common` for the error taxonomy, `guarded(vendor, kind, fn)` in the handler,
   and `toolOk`/`toolFail` for the envelope. `packages/plugins/discord/src/client.ts` is the
   closest model — static-token auth, hand-rolled `request<T>()`, `retryAfterMsFromHeader` for
   429s.
2. **`@flowlathe/plugin-discord` already depends on `@flowlathe/providers`** solely for
   `retryAfterMsFromHeader`. This plugin takes the same dependency for the same reason; do not
   reimplement the arithmetic (CLAUDE.md's HANDOFF-QUICK-FIXES note about a second, unclamped
   parse path).
3. **`DiscordClient` learned the URL-path-segment lesson the hard way.** `ID_PATTERN` +
   `requireId()` exist because undici normalizes `..` during URL parsing, so a `messageId`
   containing `/../` silently retargeted the request at a different endpoint — bypassing the
   channel allowlist the whole toolset rested on. Every id this plan interpolates into a path
   needs the same treatment (`PLAN-DOMAIN-TOOLS.md` §7 rule 3).
4. **`unavailableReason()` is called synchronously on a request path** — `/run`, `/step-start`,
   and every `GraphEngine` construction including step-mode restores — so it must never block on
   I/O. `CachedLivenessProbe` (`plugin-common`) exists for exactly this and is optimistic before
   its first probe resolves.
5. **"Unset env var ⇒ zero tool registrations" is locked and load-bearing.**
   `/api/plugins/status` derives `configured`/`connected` uniformly from whether a toolset has any
   live registrations; a plugin registering unconditionally and always failing
   `unavailableReason()` reads as "configured" when it is not.
6. **Layer-1 sanitization is mandatory for third-party text** (PLAN-SANITIZATION-BOUNDARY.md).
   Everything this plugin returns except a number or a timestamp is authored by an arbitrary
   GitHub user.

---

## 2. Locked decisions

| # | Decision | Why |
|---|---|---|
| L1 | **REST API over `fetch`, never the `gh` CLI.** | `PLAN-DOMAIN-TOOLS.md` D1. Also the only way to unit-test offline: every existing HTTP plugin injects `fetchImpl`; a subprocess cannot be stubbed that way. |
| L2 | **Auth is `GITHUB_TOKEN`, set by the operator by hand. Unset ⇒ zero registrations.** No OAuth dance, no device flow, no `plugin_credentials` row, no Connect button, no manifest `connect` field. | `PLAN-DOMAIN-TOOLS.md` D4, and the identical narrowing CLAUDE.md already records for `DISCORD_BOT_TOKEN`. A fine-grained PAT's own repo and permission scopes are the real boundary; replicating Spotify's OAuth storage for a static token buys nothing. |
| L3 | **A repository allowlist, secure default empty: `GITHUB_ALLOWED_REPOS` (comma-separated `owner/name`).** Every tool checks its `repo` argument against it before doing anything. Empty ⇒ `unavailableReason` reports the toolset unusable. | Exactly `DISCORD_ALLOWED_CHANNELS`'s design, including the split between "token unset ⇒ no registrations" and "allowlist empty ⇒ registered but unavailable". A PAT scoped to one repo is better still, but the allowlist is what flowlathe itself can enforce and what the workflow-dependency banner can report. |
| L4 | **Mode is structural: `GITHUB_MODE` ∈ `ro` (default) \| `rw`.** `ro` registers the five read tools only; `rw` additionally registers the three write tools. | `PLAN-FILE-TOOL.md`'s L2 verbatim: a registered-but-refusing write tool still reaches the model in `tools` and invites calls that always fail. |
| L5 | **Nothing destructive, nothing administrative, nothing irreversible-to-others.** No merge, close, reopen, edit, delete, force-anything, branch deletion, release, workflow dispatch, label/milestone/assignee management, repo or org settings. See §5 for the full list and why. | Every one of those is either a human's decision, an admin surface a PAT should not carry, or unrecoverable. Adding one later is cheap; a model that closed forty issues is not recoverable. |
| L6 | **`repo` is always an explicit argument, never a configured default.** | A default repo is one prompt away from a model acting on the wrong project without saying so. Explicitness also means the allowlist check has something to check on every single call. |
| L7 | **`standalone` is set** (`githubToolsetFromEnv`), so an exported compiled script can use this toolset. | Config is env-only, exactly like SearXNG/Firecrawl. An operator who set `GITHUB_TOKEN` on the machine running the script opted in there too. |
| L8 | **No `github` node kind.** Toolset only. | `PLAN-DOMAIN-TOOLS.md` D6. |

---

## 3. The operations

Eight tools. Five read, three write. This is the minimal set for general software development and
version management — enough to see what is being asked for, what is in flight, and whether it is
passing, plus the three creations a flow legitimately originates.

Every tool takes `repo` as `"owner/name"`, validated by `repoSlugSlot` and checked against
`GITHUB_ALLOWED_REPOS`. Every one returns `toolOk(data)` / `toolFail(message)`.

### 3.1 Read tools (always registered)

#### `github_list_issues`

`GET /repos/{owner}/{repo}/issues`

| Argument | Type | Required | Validation |
|---|---|---|---|
| `repo` | string | yes | `repoSlugSlot`, then allowlist |
| `state` | string | no | one of `open` (default) \| `closed` \| `all`; anything else ⇒ `toolFail` |
| `labels` | string \| string[] | no | `asStringArray`, each `textSlot(…, 100)`, joined with `,` |
| `limit` | number | no | `intSlot(…, 1, 50)`, default 20 → `per_page` |

Returns `{number, title, state, author, labels, commentCount, updatedAt, url}` per issue.

> **GitHub's `/issues` endpoint returns pull requests too** — every PR is an issue in its data
> model, distinguished only by a `pull_request` key on the item. Filter those out here, or
> `github_list_issues` silently returns PRs and the model's issue count is wrong. This is the
> single most likely bug in this file.

#### `github_get_issue`

`GET /repos/{owner}/{repo}/issues/{number}` plus
`GET /repos/{owner}/{repo}/issues/{number}/comments`

| Argument | Type | Required | Validation |
|---|---|---|---|
| `repo` | string | yes | as above |
| `number` | number | yes | `intSlot(…, 1, 2_000_000)` |
| `commentLimit` | number | no | `intSlot(…, 0, 30)`, default 10 |

Returns the issue plus up to `commentLimit` most recent comments. Two calls in one tool rather
than a separate `github_list_comments`, because "read the issue" almost always means "read the
discussion" and a second tool is a second round trip through the model.

`commentLimit: 0` skips the second request entirely.

#### `github_list_pull_requests`

`GET /repos/{owner}/{repo}/pulls`

| Argument | Type | Required | Validation |
|---|---|---|---|
| `repo` | string | yes | as above |
| `state` | string | no | `open` (default) \| `closed` \| `all` |
| `limit` | number | no | `intSlot(…, 1, 50)`, default 20 |

Returns `{number, title, state, draft, author, head, base, updatedAt, url}` per PR. `head`/`base`
are branch names, sanitized like any other third-party string — a branch name is attacker-authored
on a fork PR.

#### `github_get_pull_request`

`GET /repos/{owner}/{repo}/pulls/{number}` plus `GET …/pulls/{number}/files`

| Argument | Type | Required | Validation |
|---|---|---|---|
| `repo` | string | yes | as above |
| `number` | number | yes | `intSlot(…, 1, 2_000_000)` |
| `includeDiff` | boolean | no | default `false` |

Always returns metadata plus the changed-file list (`{path, status, additions, deletions}`, capped
at 100 files with a `filesTruncated` flag). With `includeDiff: true`, also returns each file's
`patch` — concatenated, scrubbed, and hard-capped at `DIFF_MAX_CHARS` (12,000) with its own
truncation marker.

Use the `/files` endpoint's `patch` field rather than requesting the `.diff` media type: it needs
no separate `Accept` header, it is already per-file, and GitHub itself omits `patch` for files it
considers too large — which does the first round of bounding for free.

#### `github_get_checks`

`GET /repos/{owner}/{repo}/commits/{ref}/check-runs` plus
`GET /repos/{owner}/{repo}/commits/{ref}/status`

| Argument | Type | Required | Validation |
|---|---|---|---|
| `repo` | string | yes | as above |
| `ref` | string | yes | `gitRefSlot` — a branch, tag or sha |

Returns `{state, checks: [{name, status, conclusion, url}]}`, merging modern check runs with the
legacy combined commit status. Both are queried because different CI providers still populate
different ones, and a flow asking "did this pass" that silently misses half the signal is worse
than no tool.

`check-runs` output text (a failure summary) is the most attacker-influenceable field in this
whole plugin — it is generated by whatever CI the repo runs, on code from whoever opened the PR.
Sanitize it at 1,000 chars per check and never include the full `output.text`.

### 3.2 Write tools (registered only when `GITHUB_MODE=rw`)

#### `github_create_issue`

`POST /repos/{owner}/{repo}/issues`

| Argument | Type | Required | Validation |
|---|---|---|---|
| `repo` | string | yes | as above |
| `title` | string | yes | `textSlot(…, 300)` |
| `body` | string | no | `textSlot(…, 60_000)` |
| `labels` | string \| string[] | no | `asStringArray`, each `textSlot(…, 100)` |

Returns `{number, url}`.

#### `github_comment`

`POST /repos/{owner}/{repo}/issues/{number}/comments`

| Argument | Type | Required | Validation |
|---|---|---|---|
| `repo` | string | yes | as above |
| `number` | number | yes | `intSlot(…, 1, 2_000_000)` |
| `body` | string | yes | `textSlot(…, 60_000)` |

One tool for both issues and pull requests: GitHub's issue-comments endpoint serves PRs too, since
a PR *is* an issue in the data model (the same fact that complicates `github_list_issues`). This
saves an entire tool and one more thing for a local model to get wrong.

Deliberately **not** a PR *review* (`POST /pulls/{n}/reviews`): an approval is a governance
signal, not a comment, and a model should not be able to emit one.

#### `github_create_pull_request`

`POST /repos/{owner}/{repo}/pulls`

| Argument | Type | Required | Validation |
|---|---|---|---|
| `repo` | string | yes | as above |
| `title` | string | yes | `textSlot(…, 300)` |
| `head` | string | yes | `gitRefSlot` — the branch to merge from |
| `base` | string | yes | `gitRefSlot` — the branch to merge into |
| `body` | string | no | `textSlot(…, 60_000)` |
| `draft` | boolean | no | default `true` |

Returns `{number, url}`.

`draft` defaults to **true**, unlike GitHub's own API default. A draft PR does not request
reviews, does not notify a CODEOWNERS list, and is the correct default for something a model
opened; an operator or the flow author can pass `false` deliberately.

Pairs with `git_push` in `PLAN-GIT.md` — that is the intended two-step: push a branch locally,
then open the PR. This plugin never pushes anything itself.

---

## 4. Implementation

### 4.0 — scaffold

Copy `packages/plugins/searxng/{package.json,tsconfig.json}`, rename to
`@flowlathe/plugin-github`, and add `@flowlathe/providers` to `dependencies` (fact 2). Keep the
pinned `typescript@5.9.3` / `vitest@5.0.0` versions **exactly** as the sibling has them — do not
resolve `latest` for either (CLAUDE.md's TypeScript-7 entry). `packages/plugins/*` is already a
workspace glob, so only `pnpm install` is needed.

### 4.1 — `slot-safety.ts` in `plugin-common`

Create it per `PLAN-DOMAIN-TOOLS.md` §7 if `PLAN-GIT.md` has not already. This plan needs
`repoSlugSlot`, `gitRefSlot`, `intSlot` and `textSlot`; it does not need `path-safety.ts`.

`gitRefSlot` in detail, since both plans depend on the same behavior:

```
reject: empty, > 255 chars, NUL, any control character
reject: a leading "-"                      (argument injection — git-history.ts's lesson)
reject: any ".." component, any leading/trailing "/", any "//"   (path-segment injection —
                                                                  DiscordClient.react's lesson)
reject: whitespace, "~", "^", ":", "?", "*", "[", "\", and a trailing ".lock"
        (git's own check-ref-format rules — a ref containing these is invalid anyway)
allow:  interior "/" — "feature/thing" is an ordinary branch name
```

The ref reaches a URL path segment in `github_get_checks` and an argv element in `PLAN-GIT.md`;
one validator has to satisfy both, and the union of the two rule sets is what is written above.

### 4.2 — `env.ts`

```ts
export interface GithubConfig {
  token: string;
  apiBaseUrl: string;          // default "https://api.github.com"; overridable for GHE and tests
  allowedRepos: ReadonlySet<string>;   // lowercased "owner/name"
  mode: "ro" | "rw";
}

export function githubConfigFromEnv(env = process.env): GithubConfig | undefined;
export function githubToolsetFromEnv(env = process.env): ToolRegistration[];
```

`undefined` — zero registrations — exactly when `GITHUB_TOKEN` is unset or empty (L2, fact 5).
An empty `GITHUB_ALLOWED_REPOS` does **not** suppress registration; it produces an
`unavailableReason` (L3), which is what makes the workflow-dependency banner say something useful
instead of the toolset silently not existing.

`GITHUB_MODE` anything other than `rw` (including unset, empty, or unrecognized) is `ro`, with one
`console.warn` for an unrecognized value. Fail closed on a typo.

Repo allowlist entries are compared case-insensitively — GitHub owners and repo names are
case-insensitive, and an operator writing `MyOrg/MyRepo` while a model emits `myorg/myrepo` should
not be a denial.

### 4.3 — `client.ts`

`GithubClient`, modeled on `DiscordClient`, with an injected `fetchImpl`.

Request headers on every call:

```
Authorization:        Bearer <token>
Accept:               application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
User-Agent:           flowlathe
```

Pin the API version header. GitHub uses it to keep breaking changes off unversioned clients; an
unpinned client is a future silent behavior change.

**Rate limiting has two shapes and only one of them is a 429.** A primary rate-limit exhaustion
comes back as **403** with `x-ratelimit-remaining: 0` and an `x-ratelimit-reset` epoch; a
secondary (abuse) limit comes back as 403 or 429 with `retry-after`. So:

- On 429, or on 403 with a `retry-after` header, back off via `retryAfterMsFromHeader` and retry,
  bounded at 3 attempts — the `DiscordClient.request` loop, verbatim in shape.
- On 403 with `x-ratelimit-remaining: 0`, do **not** retry (the reset can be an hour away). Fail
  with a message naming the reset time, so the model gets a legible answer instead of a stalled
  call.
- On any other 403, report it as an authorization failure naming the repo — this is the common
  "your PAT does not have that scope / cannot see this repo" case and it must not be reported as
  a rate limit.

Getting this wrong in the obvious direction (treating every 403 as a bad token) makes rate-limit
exhaustion look like a credential problem; getting it wrong in the other direction makes a
scope problem look like something that will fix itself in an hour.

Methods map one-to-one onto §3's operations. Every one validates its ids before interpolation and
passes `signal` through to `fetchImpl` from `ToolInvokeMeta.signal` (SearXNG and Firecrawl already
do this; Spotify and Discord do not, and this plugin should be on the correct side of that split).

**Pagination is deliberately not implemented.** Every list operation caps at one page via
`per_page` and reports what it got. A model that needs more should narrow its query. Following
`Link` headers turns one tool call into an unbounded number of requests against a rate-limited API.

### 4.4 — `tools.ts`

Handler order is the same in all eight, matching every existing plugin:

1. `requireString`/`intSlot`/`textSlot` inside one try/catch ⇒ `toolFail((err as Error).message)`.
2. `repoSlugSlot(repo)` then the allowlist check ⇒ `toolFail("repository \"…\" is not in
   GITHUB_ALLOWED_REPOS")`, naming the current allowlist the way `plugin-mcp`'s command allowlist
   error does.
3. `guarded("github", "<op>", () => client.<op>(...))`.
4. `result.ok ? toolOk(summarize(result.data)) : toolFail(result.error)`.

**Sanitization (layer 1, mandatory).** Everything below is authored by an arbitrary GitHub user —
on a public repo, by anyone at all — and lands directly in a model's context. This is a sharper
surface than search results, because an issue body is a deliberate channel to the project rather
than incidental text. Per-field caps:

| Field | Cap |
|---|---|
| login / author | 100 |
| title, label, branch name | 300 |
| issue / PR body | 4,000 |
| comment body | 2,000 |
| check name | 200 |
| check output summary | 1,000 |
| concatenated diff | 12,000 (own marker — see below) |

Each uses `sanitizeUntrustedText(value, cap, "github <field>")`, exactly as
`summarizeMessage` in `plugin-discord/src/tools.ts` does.

The **diff is the one exception**: it carries its own `[truncated N of M chars]` marker, so it must
`scrubUntrustedText` then slice by hand and never pass a `maxLength` to `sanitizeUntrustedText` —
which would cut the marker back off (CLAUDE.md's sanitization rule).

The whole envelope must stay under `tool-registry.ts`'s 32,000-char layer-2 backstop, which
truncates blindly and would produce invalid JSON. With the caps above, the worst case is
`github_get_pull_request` with `includeDiff` (~12k of diff + ~100 file entries + metadata) —
comfortably under, and that headroom is the point.

### 4.5 — `unavailableReason`

One shared closure across all eight registrations, in this order:

1. `allowedRepos.size === 0` ⇒ `"GitHub has no allowed repositories configured (set
   GITHUB_ALLOWED_REPOS)"`.
2. Otherwise a `CachedLivenessProbe` over `GET {apiBaseUrl}/rate_limit`.

`/rate_limit` is the right probe: GitHub documents it as **not counting against the rate limit**,
and it 401s on a bad or expired token — so it is a combined reachability *and* auth check, the same
role Firecrawl's `POST /v2/map` probe plays. It must go through `CachedLivenessProbe` and not a
direct call (fact 4); note the deliberate consequence CLAUDE.md already records for SearXNG — the
probe is optimistic before its first result lands, so a freshly-registered toolset can briefly
report itself usable with a bad token.

### 4.6 — `manifest.ts` and server wiring

`GITHUB_MANIFEST` follows `SEARXNG_MANIFEST`'s shape: `toolset: "github"`,
`displayName: "GitHub"`, one `env` entry per variable (`GITHUB_TOKEN` `required: true`,
`secret: true`; `GITHUB_ALLOWED_REPOS` `required: true`; `GITHUB_MODE` and `GITHUB_API_BASE_URL`
optional), `docsUrl` pointing at GitHub's fine-grained-PAT documentation. **No `connect` field** —
there is no OAuth dance (L2).

Two edits in `packages/server/src/index.ts`:

```ts
const pluginManifests: PluginManifest[] = [..., GITHUB_MANIFEST];
pluginToolsets = [...pluginToolsets, ..., ...githubToolsetFromEnv()];
```

Everything else falls out with no further code: `/api/plugins/status` derives
`configured`/`connected` uniformly (and correctly here, because L2 honors the "unset env var ⇒
zero registrations" convention its uniformity depends on), `Canvas.tsx` renders a per-node
"GitHub" checkbox by mapping over the status keys, `requiredToolsets(graph)` picks it up from
`enabledToolsets`, and the workflow-dependency banner plus the `/run` and `/step-start` 409 gates
work unchanged. Verify rather than assume — that generalization is why the third plugin type
needed no Canvas edits (CLAUDE.md's MCP note), and it should hold for a sixth.

---

## 5. Scope: deliberately not built

Each of these was considered and cut; the reason matters more than the list.

- **Merge, close, reopen, or edit anything.** Governance decisions and destructive edits. A model
  that closed the wrong issue has destroyed information a human wrote.
- **PR reviews (approve / request changes).** An approval is a governance signal, not a comment
  (§3.2).
- **Delete anything** — comment, branch, release, run.
- **Labels, milestones, assignees, reviewers management.** Project administration, not
  development. `github_create_issue` can *apply* labels; it cannot create or manage them.
- **Push, commit, or any content write.** That is local git's job — `PLAN-GIT.md`. This plugin
  reaching for the contents API would be a second, silently divergent way to change a repo.
- **Workflow dispatch / re-run.** Triggers arbitrary CI, which is arbitrary code execution on
  someone else's runner. The exact class `PLAN-DOMAIN-TOOLS.md` exists to avoid.
- **Repository, org, team or user administration.** A PAT that can do this should not be in
  `GITHUB_TOKEN` at all; say so in the README.
- **Code search, gists, releases, projects, discussions, packages.** Real API surface, not part of
  a minimal development loop (L5). Adding any one is a self-contained follow-up.
- **Pagination** (§4.3), **webhooks / a GitHub trigger source.** A trigger is `PLAN-INTEGRATIONS.md`
  Phase-E-shaped work (`TriggerRegistry`, `admitMessage`, dedupe, recovery) and completely
  separable; the Discord source is the template if it is ever wanted.
- **A `github` node kind** (L8).

---

## 6. Testing

`vitest`, colocated `*.test.ts`, matching sibling plugins. **Everything below runs offline** — an
injected `fetchImpl` returning canned `Response` objects, exactly as
`packages/plugins/searxng/src/client.test.ts` and `plugin-discord`'s tests do. No network, no
recorded cassettes, no live token.

### 6.1 `slot-safety.test.ts` (in `plugin-common`)

The most valuable file in this plan, and entirely pure:

- `gitRefSlot`: accepts `main`, `feature/x`, a 40-char sha, `v1.2.3`; rejects `-o`, `--upload-pack`,
  `a/../../b`, `/leading`, `trailing/`, `a//b`, `has space`, `a^b`, `a:b`, `x.lock`, `""`, a
  256-char name, `a\0b`
- `repoSlugSlot`: accepts `owner/name`, `Owner.Name/repo-1`; rejects `owner`, `a/b/c`, `../x`,
  `owner/`, `/name`, `-owner/name`, an over-long segment
- `intSlot`: clamps nothing — out of range **throws**, unlike `clampLimit`, and the test asserts
  that difference explicitly so nobody "unifies" the two later
- `textSlot`: rejects NUL and control characters, keeps `\n`/`\t`, rejects a leading `-`, bounds
  length

### 6.2 `client.test.ts`

- happy path for each of the eight operations against a canned response
- the **403 taxonomy**, which is the interesting half: 403 + `x-ratelimit-remaining: 0` ⇒ no
  retry, error names the reset; 403 + `retry-after` ⇒ retried then succeeds; 403 with neither ⇒
  reported as an authorization failure naming the repo; 429 + `retry-after` ⇒ retried, bounded at
  3 attempts
- **`github_list_issues` filters out items carrying a `pull_request` key** — the §3.1 trap,
  asserted directly against a fixture containing one issue and one PR
- an id containing `..` (`repo: "a/../../x"`, `ref: "a/../b"`) is rejected before any `fetchImpl`
  call — assert the stub was **never invoked**, not merely that the call failed
- `signal` is forwarded to `fetchImpl`

### 6.3 `tools.test.ts`

- a repo not in the allowlist returns `{ok:false}` with a message naming the allowlist, and never
  calls the client
- `ok` is the first key in the returned JSON (key order is contract — `toolOk`'s doc comment)
- `labels` supplied as `"bug,ci"` and as `'["bug","ci"]'` both work (`asStringArray`)
- an issue body containing zero-width and Unicode tag characters comes back scrubbed
- a body longer than its cap is truncated; the **diff**'s truncation marker is the *last* thing in
  the string, proving scrub-then-truncate rather than `sanitizeUntrustedText(…, maxLength)`
- `githubToolsetFromEnv({})` ⇒ `[]`; with only `GITHUB_TOKEN` set ⇒ 5 registrations, all reporting
  an `unavailableReason` naming `GITHUB_ALLOWED_REPOS`
- `GITHUB_MODE=ro` ⇒ exactly 5 registrations and no write tool name appears; `rw` ⇒ 8
- `GITHUB_MODE=nonsense` ⇒ 5 registrations (fails closed) plus a `console.warn`

### 6.4 Parity / golden fixtures

**No golden parity fixture, and the reason is specific rather than the usual one.**
`packages/testing/src/net-stub.ts`'s `injectNetStubTable` stubs the compiled script's
`net: { fetch: globalThis.fetch }` — that is `RuntimeHost.net`, which only the `search`/`fetch`
*node kinds* use. A plugin toolset's client builds its own `fetch` inside
`githubToolsetFromEnv()`, which the harness never reaches, so the compiled-script half of a parity
run would hit the real api.github.com.

Closing this needs `injectNetStubTable` to also stub the `standalone` factory's fetch, and needs
the stub keyed by `(method, url, sha256(body))` rather than URL alone — the same fuller design
PLAN-INTEGRATIONS.md's design trap 8 describes and that the `fetch`-node fixture was already
deferred for. Consistent with every existing plugin (none has a parity fixture). Tracked, not
hidden.

### 6.5 e2e

**No Playwright spec**, consistent with every plugin-shaped slice in this repo — CLAUDE.md already
records that `playwright/tests/` contains no spec for Spotify, Gate, MCP, SearXNG, Firecrawl or
Discord, and that writing the first plugin e2e spec is separable work. Coverage is the unit suite
plus one manual smoke test: set the env vars, add a prompt node with the `github` toolset checked,
confirm the workflow-dependency banner appears and Run is disabled when they are unset, and that a
real `github_list_issues` returns through the tool loop when they are.

---

## 7. Ordering

1. `slot-safety.ts` + tests in `plugin-common` (§4.1) — pure, no plugin dependency, and shared with
   `PLAN-GIT.md`.
2. Package scaffold + `env.ts` + tests. Nothing model-facing yet.
3. `client.ts` + tests, including the whole 403 taxonomy.
4. `tools.ts` (read tools first, then write) + `manifest.ts` + tests.
5. Server wiring, README, manual smoke test.
6. CLAUDE.md notes (§8).

Step 1 is the only one touching existing code and is independently revertible.

---

## 8. Notes to record (definition of done)

Add these to **`documentation/notes/plugins-and-tools.md`**, not to `CLAUDE.md` — that file is now
an index plus repo-wide invariants only, and these are plugin-scoped. See CLAUDE.md's "Adding a
note" section. Write the surprise, not the summary.

- **GitHub's `/issues` endpoint returns pull requests too** — a PR is an issue in GitHub's data
  model, distinguished only by a `pull_request` key on the item. `github_list_issues` filters them
  out; `github_comment` deliberately *relies* on the same fact to serve both with one endpoint.
  Removing either half breaks the other's justification.
- **GitHub signals a primary rate limit with a 403, not a 429** (`x-ratelimit-remaining: 0` +
  `x-ratelimit-reset`), and a secondary limit with a `retry-after` on either status. So a bare
  "403 ⇒ bad credentials" reading makes rate-limit exhaustion look like a token problem, and a
  bare "403 ⇒ rate limit, back off" reading makes a missing PAT scope look self-healing.
  `client.ts` splits the three cases explicitly; keep them split.
- **`GET /rate_limit` is the liveness probe** because GitHub documents it as not counting against
  the rate limit, and it 401s on a bad token — reachability and auth in one free call. It still
  goes through `CachedLivenessProbe` (never a direct call), so it inherits the
  optimistic-before-first-probe behavior CLAUDE.md already records for SearXNG.
- **Auth is a manually-set `GITHUB_TOKEN` and nothing else** — no OAuth, no `plugin_credentials`
  row, no Connect button. Same deliberate narrowing already recorded for `DISCORD_BOT_TOKEN`;
  `packages/persistence/src/plugin-credentials.ts` is there if a UI form is ever wanted, and needs
  no schema change.
- **`GITHUB_MODE=ro` registers five tools; `rw` registers eight.** A registered-but-refusing write
  tool would still be described to the model — the same "silently including a broken tool" problem
  this file already flags for a configured-but-not-connected plugin.
- **PR bodies, issue comments, branch names and CI check output are attacker-authored by design**,
  not incidentally like a search snippet — anyone can open an issue on a public repo. Layer-1
  per-field sanitization is mandatory, and the diff is the one field that owns its truncation
  marker and therefore must scrub-then-slice by hand.
- No parity fixture, and **the reason is not the usual one**: `injectNetStubTable` only stubs
  `RuntimeHost.net`, which a plugin's own client never goes through (§6.4). No e2e spec, for the
  usual one.

## 9. Definition of done

- [ ] `pnpm -r typecheck` and `pnpm test` green from the repo root (`plugin-common` is modified).
- [ ] `packages/plugins/github` exists with the tests in §6.1–§6.3, including the 403-taxonomy
      cases, the `pull_request`-filtering case, and the `..`-rejected-before-fetch case.
- [ ] `slot-safety.ts` exists in `plugin-common` with its own tests and is exported from its
      `index.ts`.
- [ ] With no env set: `/api/plugins/status` shows github as not configured, a graph enabling it
      shows the workflow-dependency banner, and `/run` returns 409.
- [ ] With `GITHUB_TOKEN` but no `GITHUB_ALLOWED_REPOS`: status shows configured-but-not-connected
      with a reason naming the variable.
- [ ] With both set: a real `github_list_issues` and `github_get_checks` run end to end through a
      prompt node's tool loop against a real repository, verified manually.
- [ ] README documents every `GITHUB_*` variable, states that the PAT should be fine-grained and
      scoped to the allowlisted repositories only, and says plainly that `GITHUB_MODE=rw` lets a
      model open issues, comments and pull requests under the token owner's identity.
- [ ] `documentation/notes/plugins-and-tools.md` carries the §8 entries.
