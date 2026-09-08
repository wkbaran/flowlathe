# HANDOFF-QUICK-FIXES — ten bounded fixes, safe to work in parallel

Status: done (2026-09-07). All ten items landed as individual commits on `main` (see `git log`),
plus the four "also worth doing" test-quality items and the §C consolidation pass into CLAUDE.md.
Each item below is independently completable in one sitting.

Source: security/bug audit. These are everything the audit found that does **not** need its own
planning session. The six that did are in `FIX-*.md` alongside this file — **all six have since
been planned and landed** (`PLAN-CANCELLATION.md`, `PLAN-COMPILER-VARNAME.md`,
`PLAN-EXECUTION-RETENTION.md`, `PLAN-LOOPMAP-BRANCH-SKIP.md`, `PLAN-NETWORK-POSTURE.md`,
`PLAN-SANITIZATION-BOUNDARY.md`; see `git log`). Note that four of those `FIX-*.md` files still
carry a stale `Status: not started` line in their own header — the work is committed regardless;
only `FIX-NETWORK-POSTURE.md` and `FIX-SANITIZATION-BOUNDARY.md` had their status updated in
place. Two items below (9 and the `releaseBlob` bullet in the trailing section) depended on that
work and have been updated accordingly.

**Re-verified against the tree on 2026-09-07**: all ten bugs below are still present, every source
path still exists, the four "NEW" test files are still absent and the six "exists" ones still
exist. The corrections that pass found are marked **[corrected 2026-09-07]** inline.

**All three HIGH-severity security findings are in this document** (items 1, 2, 3). They are also
three of the cheapest fixes here. Do them first regardless of how the rest is scheduled.

---

## How to run these in parallel safely

The ten items were chosen and scoped so that **no two of them edit the same file.** The table in
§A is the contract that makes parallel work safe. If you find yourself needing to edit a file
assigned to another item, stop and re-coordinate rather than doing it anyway.

### Rules

1. **One branch (or git worktree) per item.** Name it after the item number, e.g. `fix/q3-ssrf`.
   One commit per item. Do not batch two items into one commit — several of these are worth
   reverting independently.
2. **Do not edit `packages/server/src/app.test.ts`.** It is 636 lines covering many routes and is
   the one file three of these items would otherwise all touch. Items 6, 7 and 9 each create a new
   dedicated test file instead; those new paths are listed in §A and are non-overlapping.
3. **Do not edit `CLAUDE.md`.** Every item will want to append a note and they will all conflict.
   Put your note in the commit body instead; §C explains the consolidation pass.
4. **Do not add dependencies.** None of these need one, and `package.json`/`pnpm-lock.yaml` are
   shared files. If you think you need a dependency, you have scope-crept.
5. **Two items change shared core behaviour** (items 3 and 8, in `@flowlathe/core`). Those two
   must run the **full** `pnpm test` from the repo root, not just their own package — see §B.
   Everyone else can iterate with their package's `npx vitest run` but should still run the full
   suite once before committing.
6. **Nobody runs `pnpm e2e` concurrently.** The Playwright config binds a fixed port (4311,
   `playwright/playwright.config.ts`). Two parallel e2e runs will fight. Coordinate, or leave e2e
   to the integration pass in §C.

### §A — File assignment table

| # | Fix | Source file(s) edited | Test file |
| --- | --- | --- | --- |
| 1 | git argument injection | `packages/server/src/git-history.ts` | `packages/server/src/git-history.test.ts` *(exists)* |
| 2 | Discord id path traversal | `packages/plugins/discord/src/client.ts` | `packages/plugins/discord/src/client.test.ts` *(exists)* |
| 3 | SSRF address gaps | `packages/core/src/url-safety.ts` | `packages/core/src/url-safety.test.ts` *(exists)* |
| 4 | Spotify pending-map growth | `packages/server/src/routes/plugins-spotify.ts` | `packages/server/src/routes/plugins-spotify.test.ts` *(exists)* |
| 5 | credential key length | `packages/server/src/credential-key.ts` | **NEW** `packages/server/src/credential-key.test.ts` |
| 6 | provider `baseUrl` validation | `packages/server/src/routes/providers.ts` | **NEW** `packages/server/src/routes/providers.test.ts` |
| 7 | `Retry-After` clamp | `packages/providers/src/retry-after.ts` | **NEW** `packages/providers/src/retry-after.test.ts` |
| 8 | template prototype lookup | `packages/core/src/template.ts` | `packages/core/src/template.test.ts` *(exists)* |
| 9 | execution route ownership | `packages/server/src/routes/executions.ts` | **NEW** `packages/server/src/routes/executions.test.ts` |
| 10 | openai-compat SSE parse | `packages/providers/src/openai-compat.ts` | `packages/providers/src/openai-compat.test.ts` *(exists)* |

Every path appears exactly once. Verified against the current tree.

**[corrected 2026-09-07] Items 2 and 7 collided as originally written.** Item 7's fix text told the
implementer to "clamp there too" in Discord's JSON-body `retry_after` fallback
(`packages/plugins/discord/src/client.ts:115`) — a file the table assigns exclusively to item 2,
which silently falsified the "every path appears exactly once" guarantee this whole section rests
on. Resolved by moving that one line into **item 2's** scope, and in a way that needs no new
exported helper and no branch-ordering dependency between the two items: item 2 reroutes the body
value through the existing shared parser (`retryAfterMsFromHeader(String(parsed.retry_after))`),
which is semantically identical to today's `parsed.retry_after * 1000` and inherits item 7's clamp
for free whenever item 7 lands — in either order. Item 7 is therefore scoped to `retry-after.ts`
alone. Both items' rows above are unchanged and now accurate.

### §B — Blast radius warnings

- **Item 3** (`url-safety.ts`) is consumed by `@flowlathe/plugin-firecrawl` and the `fetch` node.
  Tightening the blocklist can fail tests in those packages if any fixture uses an address that
  becomes blocked. Run the full suite.
- **Item 8** (`template.ts`) is consumed by the interpreter, the compiler, and every node kind that
  renders a template. `renderTemplate` and `extractTemplateVars` are load-bearing. Run the full
  suite.
- **Item 2** has a test-fixture hazard called out in its own section below — read it before
  choosing your validation rule.

### §C — Integration pass (after the ten land)

One person, one pass, once:

1. Rebase/merge all branches, run `pnpm typecheck && pnpm test` from the root.
2. Run `pnpm e2e` once.
3. Consolidate the per-commit notes into a single `CLAUDE.md` entry. Only record things that
   would *surprise* a future agent — that file's stated purpose — not a changelog of the ten fixes.

---

## The fixes

### 1. HIGH — Argument injection in `git show` → arbitrary file write

`packages/server/src/git-history.ts:50`

```ts
const text = git(dir, ["show", `${sha}:${slug}.flow`]);
```

`sha` is the unvalidated `from`/`to` query param of `GET /api/flows/:id/git-diff`
(`routes/flows.ts:247`). `execFileSync` blocks *shell* injection but not *argument* injection: a
value starting with `-` is parsed by git as an option, and `git show` accepts diff options
including `--output=<file>`.

Verified end-to-end through the real route with `app.inject`:

```
GET /api/flows/victim/git-diff?from=--output=%2Ftmp%2Ffl-gitinj-2sFVP3%2FOWNED
→ 404 response, and /tmp/fl-gitinj-2sFVP3/OWNED:victim.flow was written on disk
```

The route returns 404 because git wrote to the file instead of stdout, so the write is completely
silent. The API has no authentication, so anything that can reach the port can do this. The
`:${slug}.flow` suffix is forced onto the filename, but the directory and name prefix are
attacker-controlled, as is the content (git diff output).

**Fix:** validate in `git-history.ts` (not at the route layer — keeps the file assignment clean and
protects any future caller). Legitimate values only ever come from `listGitHistory`'s `%H` output,
so require `/^[0-9a-fA-F]{4,40}$/` and return `undefined` otherwise. Reject before the `execFileSync`
call, in both `graphAtGitCommit` and anywhere else user input reaches an argv slot.

Also note `/git-diff` never calls `isGitWorkTree`, unlike `/git-history`. Adding that check is a
reasonable belt-and-braces addition but is not the fix.

**Test:** assert `graphAtGitCommit(dir, slug, "--output=/tmp/whatever")` returns `undefined` and
writes no file. Assert a real 40-char sha still works.

---

### 2. HIGH — Discord `react` path traversal bypasses the channel allowlist

`packages/plugins/discord/src/client.ts:157`

```ts
await this.request<void>("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
```

`channelId` is allowlist-checked and `emoji` is encoded, but `messageId` is raw model-supplied
input interpolated into a URL path. undici normalizes `..` during URL parsing. Verified:

```
messageId = "../../../../guilds/999/members/888/roles"
→ https://discord.com/api/guilds/999/members/888/roles/reactions/777/@me
```

A prompt-injected model reaches arbitrary Discord API endpoints under `PUT` — including
`PUT /guilds/{gid}/members/{uid}/roles/{rid}`, role assignment — defeating the
`DISCORD_ALLOWED_CHANNELS` gate the whole toolset's security model rests on.

`readMessages` passes `before`/`after` through `URLSearchParams` and `sendMessage` puts
`replyToMessageId` in the JSON body, so `react` is the only affected call site — but fix this in
`DiscordClient` for all ids, not just at that one line.

**Fixture hazard — read before choosing the rule.** The existing Discord and trigger tests use
non-numeric ids: `"c1"`, `"c2"`, `"m1"`, `"msg-1"`, `"bot-user-id"`, `"original-id"`. A strict
snowflake rule (`/^\d{1,20}$/`) is more faithful to Discord but breaks those fixtures across two
packages, which would pull `packages/server/src/triggers/registry.test.ts` into your file set and
violate §A.

**Recommended:** validate a safe *charset*, `/^[A-Za-z0-9_-]{1,64}$/`. That rejects `/`, `.`, `%`,
and `\` — which is everything needed to kill the traversal — while leaving every existing fixture
valid and keeping this item's file footprint to `client.ts` alone. Document the reasoning in a
comment so it doesn't read as an arbitrary charset.

**Test:** assert `react(...)` with a traversing `messageId` throws before any fetch is attempted
(use the injected `fetchImpl` to assert it was never called). Cover `channelId` and
`replyToMessageId` too.

**[added 2026-09-07] One extra line, moved here out of item 7.** While you are in this file, change
the 429 body fallback at `client.ts:115` from `retryMs = parsed.retry_after * 1000` to route
through the shared parser this file already imports:

```ts
retryMs = retryAfterMsFromHeader(String(parsed.retry_after)) ?? retryMs;
```

That is semantically identical today (`retryAfterMsFromHeader` does `Number(value)` then
`Math.max(0, seconds * 1000)`), needs no new export, and makes this path inherit item 7's upper
clamp for free whenever item 7 lands — in either order, with no branch dependency. Item 7 is
explicitly forbidden from touching this file, so if you skip this the body-fallback path keeps its
unbounded stall. It is unrelated to the traversal fix, so mention it in the commit body.

---

### 3. HIGH — SSRF address-range gaps

`packages/core/src/url-safety.ts:103`, `isPrivateOrInternalHost`. Verified against the real
function — all of these currently return `{ ok: true }`:

| URL | Why it's dangerous |
| --- | --- |
| `http://0.0.0.0/` | routes to loopback on Linux; no `a === 0` case exists |
| `http://0/` | canonicalizes to `0.0.0.0` |
| `http://[::]/` | IPv6 unspecified → loopback; only `::1` is checked |
| `http://[::ffff:0:0]/` | IPv4-mapped `0.0.0.0`; reaches the v4 branch, which has no `a === 0` case |
| `http://localhost./` | trailing dot is a valid FQDN; the check is `bare === "localhost"`, exact |
| `http://100.64.1.1/` | RFC 6598 CGNAT — the Tailscale range, very reachable on a dev machine |

**Fix**, all within `isPrivateOrInternalHost`:

- strip a single trailing `.` from `bare` before the hostname comparisons;
- v4 branch: add `if (a === 0) return true;` and `if (a === 100 && b >= 64 && b <= 127) return true;`
- v6 branch: add `if (bare === "::") return true;`

Leave `isCloudMetadataHost` alone — it is correct, and its unconditional-block semantics are
deliberate.

**[corrected 2026-09-07] Read `packages/server/src/allowed-hosts.ts` first.** It already implements
the exact trailing-dot normalization asked for here (`normalizeHost`, with a comment explaining
why `localhost.` is a real bypass) and documents at length why `0.0.0.0` is dangerous. `core`
cannot import from `server`, so this is a deliberate re-implementation rather than reuse — but the
two should agree, and that file's comments are the best available statement of the reasoning.

**Test:** one case per row of the table above. The existing tests in this file are strong (they
killed every mutation thrown at them); they simply never covered these shapes.

---

### 4. Spotify OAuth pending-map growth

`packages/server/src/routes/plugins-spotify.ts:24,37`. `GET /api/plugins/spotify/oauth/start` is
unauthenticated and inserts into `pending` on every call. Entries are removed only on a matching
callback; the TTL at line 51 is *checked* but never *swept*. Repeated requests grow the map
without bound.

**Fix:** sweep expired entries on insert (iterate and delete anything older than `PENDING_TTL_MS`).
A size cap as a second guard is reasonable. No timer — a timer would need clearing on shutdown and
this server already has enough lifecycle to manage.

**Test:** insert, advance past the TTL (inject a clock or set `createdAt` directly), insert again,
assert the stale entry is gone.

---

### 5. Credential key length is not validated

`packages/server/src/credential-key.ts:8`:

```ts
if (envKey) return Buffer.from(envKey, "base64");
```

Base64 decoding is lenient, so a typo'd `FLOWLATHE_CREDENTIAL_KEY` yields a wrong-length buffer.
AES-256-GCM needs exactly 32 bytes, so the failure surfaces later as an opaque `createCipheriv`
error at first use, not at boot.

**Fix:** assert 32 bytes and throw a message naming the env var and the expected encoding. Apply
the same check to the key read from `credential.key` on disk. Consider `mkdirSync(dataDir, { mode: 0o700 })`
while you're in the file — the key file is already `0o600` but its directory is default `0755`.

**Test:** new file. Cover a valid key, a short key, and non-base64 input.

---

### 6. Provider `baseUrl` is not validated as a URL

`packages/server/src/routes/providers.ts:21`: `baseUrl: z.string().optional()`.
`OpenAiCompatAdapter` sends the decrypted API key as a bearer token to whatever this points at
(`scheduler-registry.ts:20`).

**Fix:** make `baseUrl` a validated URL on `CreateProviderBody`; `UpdateProviderBody` picks the
change up for free, since it is just `CreateProviderBody.partial()`. Consider restricting the
scheme to `http:`/`https:`.

**[corrected 2026-09-07] Use `z.url()`, not `z.string().url()`.** Every package here pins
`zod@4.5.4`, where the chained `.url()` string method is deprecated in favour of the top-level
`z.url()`. The repo currently contains zero uses of either spelling, so following the original
wording literally would have introduced its first deprecated zod call.

**Test:** new file `packages/server/src/routes/providers.test.ts` — do **not** add to `app.test.ts`
(see §A rule 2). Use `buildApp` + `app.inject`, following the shape of
`packages/server/src/routes/plugins-spotify.test.ts`. Assert a non-URL `baseUrl` is rejected with
400 and a valid one is accepted.

---

### 7. `Retry-After` has no upper clamp

`packages/providers/src/retry-after.ts` returns `Math.max(0, seconds * 1000)` with no ceiling. A
hostile or broken server sending `Retry-After: 999999` stalls a Discord call
(`plugins/discord/src/client.ts` `setTimeout(resolve, retryMs)`) or a provider retry for hours.

**Fix:** clamp to a sane ceiling (60s is defensible; pick one and comment the reasoning). Apply
inside `retryAfterMsFromHeader` so all three call sites — Discord, Ollama, openai-compat — get it.

**[corrected 2026-09-07] Do not touch `plugins/discord/src/client.ts` for this.** Discord's client
also parses `retry_after` from the JSON body as a fallback, and that path bypasses this function —
but that file belongs to item 2 (§A), and the original wording here ("clamp there too") would have
put two items in one file. Item 2 now owns that one line and reroutes it through this function, so
it inherits whatever ceiling you pick with no coordination needed. Your only job is the clamp
inside `retryAfterMsFromHeader`; keep the exported signature unchanged so item 2's call compiles
against it in either landing order.

**Test:** new file. Cover seconds, an HTTP-date, a value over the ceiling, a negative value, and
garbage.

---

### 8. `renderTemplate` resolves off `Object.prototype`

`packages/core/src/template.ts:12` uses `name in vars`, which walks the prototype chain. Verified:

```js
renderTemplate("x={{toString}} y={{constructor}}", { a: "1" })
// → "x=function toString() { [native code] } y=function Object() { [native code] }"
```

Reachable when a node declares a port named `toString`/`constructor`/`valueOf`/`hasOwnProperty`
and that port resolves to `never` (untaken router branch) while another port carries a value:
`inputs` then lacks the key, and instead of the intended `missing template variable` error you get
native-code source injected into the prompt.

**Fix:** `Object.hasOwn(vars, name)`. One character of real change, but see §B — this file is
consumed everywhere, so run the full suite.

**Test:** assert `renderTemplate("{{toString}}", {})` throws `missing template variable`, and that
an own property named `toString` still renders normally.

---

### 9. Execution routes don't verify resource ownership

`packages/server/src/routes/executions.ts`. These take an id from the request and never check it
belongs to the `:id` execution in the path:

| Route | Unverified input |
| --- | --- |
| `GET /api/executions/:id/snapshots` | `branchId` query |
| `GET /api/executions/:id/state` | `branchId` query |
| `GET /api/executions/:id/state-lineage` | `branchId` query |
| `POST /api/executions/:id/step` | `branchId` body |
| `POST /api/executions/:id/step-back` | `snapshotId` body — ignores `:id` entirely |

There is no auth boundary here today, so this is not currently an escalation. It means a client
bug silently operates on the wrong branch instead of getting a 404 — and it becomes a real
authorization gap the moment anything introduces a notion of a caller.

**[corrected 2026-09-07]** This originally read "the moment `FIX-NETWORK-POSTURE.md` lands any
notion of a caller." That work has since landed (`PLAN-NETWORK-POSTURE.md`) — but it deliberately
shipped only the `Host`-header allowlist and **explicitly deferred the auth half**, so the API is
still fully unauthenticated and this remains latent rather than exploitable. The severity
assessment above is unchanged; only the trigger for revisiting it has moved to whenever a shared
secret or any other caller identity actually arrives.

**Fix:** resolve the branch/snapshot, walk to its `executionId`, and 404 on mismatch. `getBranch`
and `getSnapshot` already exist in `@flowlathe/persistence`.

**Test:** new file `packages/server/src/routes/executions.test.ts` — do **not** add to
`app.test.ts`. Create two executions and assert that passing execution A's branch id to execution
B's route 404s.

---

### 10. openai-compat SSE parsing is unguarded

`packages/providers/src/openai-compat.ts:76`: `JSON.parse(payload)` inside the streaming loop with
no try/catch. One malformed chunk from a local server throws a bare `SyntaxError` out of the
adapter instead of a `ProviderCallError`, so the scheduler's retry/circuit-breaker logic can't
classify it. Accumulated `content` is also uncapped.

**Fix:** wrap the parse; skip an unparseable chunk (or fail with `ProviderCallError` — decide and
comment which, since silently skipping data has its own hazard). A content-length ceiling is worth
adding at the same time.

**Test:** the existing `openai-compat.test.ts` already stubs streaming responses. Add a stream with
one malformed `data:` line and assert the call still completes (or fails cleanly, per your choice)
rather than throwing `SyntaxError`.

---

## Also worth doing, if someone has spare capacity

These came out of the audit's test-quality pass. They are not bugs in shipped behaviour, so they
are not numbered above — but each one is a place where the suite would not catch a regression.
Verified by mutation testing: deleting the guarded code leaves the whole suite green.

- **`MAX_TOOL_ROUNDS` is untested** (`packages/nodes/prompt/src/run.ts:52`). This is the only guard
  against a model looping on tool calls forever. Removing it entirely passes every test.
- ~~**`releaseBlob`'s decrement is untested** — and, per `FIX-EXECUTION-RETENTION.md`, uncalled.
  Leave this one to that plan.~~ **[obsolete 2026-09-07]** Resolved by
  `PLAN-EXECUTION-RETENTION.md`, more decisively than this bullet anticipated: `releaseBlob` and
  `blobs.refcount` were **deleted outright** rather than tested (commit `552002a`, "Drop unused
  blobs.refcount…"), in favour of the mark-and-sweep GC. `grep -rn releaseBlob packages/` now
  returns nothing. Nothing to do here.
- **`isGitWorkTree`'s false case is untested** (`git-history.test.ts`). Making it always return
  `true` passes. Trivial to add — but note it touches item 1's test file, so fold it into item 1
  rather than doing it separately.
- **`token-bucket.test.ts`**: two of its three tests contain no `expect` at all and rely on "didn't
  time out". The third is named *"refills proportionally to elapsed time, not just unblocking on
  any advance"* but only asserts a consume doesn't block — a bucket that refilled to full on any
  clock advance would pass it. Give it an assertion that actually tests proportionality.
- **`CLAUDE.md` accuracy**: its Gate and Slice-6 entries describe Playwright gotchas "found writing
  the Gate spec" and discuss plugin e2e behaviour as though those specs exist. They don't —
  `playwright/tests/` contains only the numbered slice0–slice10 core-flow specs
  (`slice10-cancellation.spec.ts` arrived with `PLAN-CANCELLATION.md`; still no plugin-shaped spec
  of any kind, so this bullet's substance is unchanged). A later entry does
  acknowledge the gap, but the earlier ones still read as if the specs were committed. Fix during
  the §C consolidation pass.
