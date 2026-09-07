# Implementation plan — network posture (Host-header allowlist)

Status: implemented. See `packages/server/src/allowed-hosts.ts`, the `onRequest` hook in
`packages/server/src/app.ts`, and the wiring in `packages/server/src/index.ts`. §8's definition of
done is met; the CLAUDE.md entry lives with the rest of this repo's surprise-log entries.

Source: `FIX-NETWORK-POSTURE.md` (security/bug audit, finding #6).

That document was blocked on one product decision (its §1). **It is now settled:**

- **Posture:** loopback is the default, and the allowlist is operator-configurable — it can be
  added to, or replaced outright.
- **Scope:** this plan implements FIX §4 **option 1 only** (the `Host`-header allowlist).
  Option 2 (shared secret) is explicitly deferred, not dropped — see §2. Option 3 (users and
  sessions) stays rejected as wrong for a documented single-user local tool.

Everything below has been verified against the code as it stands; §4 in particular is a list of
findings, not assumptions, and is what makes this change cheap.

## 1. The settled posture

State it once, and make every knob agree with it:

> **The flowlathe API is unauthenticated. Only loopback-equivalent exposure is supported.**

- `packages/server/src/index.ts` keeps `HOST` defaulting to `127.0.0.1`.
- The `Dockerfile` **keeps** `HOST=0.0.0.0`. A container is unreachable through `-p` without it;
  removing it would make the published image useless. What changes is the documented run command:
  publish to loopback, `-p 127.0.0.1:4310:4310`, never `-p 4310:4310`.

That is what resolves the contradiction the FIX doc opens with ("that is not a posture; it is two
postures"). The container binds every interface *inside its own network namespace*; the host-side
publish is the boundary that stays on loopback. One posture, two mechanisms.

An operator who deliberately goes further adds their hostname to the allowlist — and accepts that
there is no authentication behind it.

## 2. What this closes, and what it does not

| Attack | Before | After |
| --- | --- | --- |
| DNS rebinding from a page the user visits | **open** | closed — the rebound hostname is not in the allowlist |
| Casual browser access to `http://<lan-ip>:4310/` | open | closed (403) |
| Cross-origin `fetch` from an unrelated page | mostly blocked already: Fastify parses `application/json` only, so a JSON POST is preflighted and the preflight fails | unchanged |
| `curl -H 'Host: localhost' http://<lan-ip>:4310/api/flows` | open | **still open** |

The last row is the deferred half. A `Host` allowlist is a routing check, not an authentication
check: anything that can route to the port and set one header still has full control of the API —
which can create and overwrite flows, run them (invoking every configured provider and enabled
plugin toolset), read every execution's prompts and outputs, and register triggers.

Closing that is FIX §4 option 2's job (a shared secret generated next to `credential.key`, injected
into the SPA at serve time, carried by cookie or query parameter so `EventSource` still works) and
it is **out of scope here**. Say so plainly in the README rather than letting a reader infer that
the API is now protected.

## 3. Design

### 3.1 New module `packages/server/src/allowed-hosts.ts`

Zero dependencies, pure, unit-testable. The entire security surface lives in `normalizeHost`.

- `DEFAULT_ALLOWED_HOSTS = ["127.0.0.1", "localhost", "::1"]`

- `normalizeHost(raw: string | undefined): string | undefined`
  - `undefined` for missing or empty input;
  - lowercase;
  - unwrap a bracketed IPv6 authority: `[::1]:4310` → `::1`;
  - strip a single trailing dot: `localhost.` → `localhost`;
  - strip a trailing `:<digits>` port, but **only** when the remainder is not a bare (unbracketed)
    IPv6 literal — otherwise `::1` loses its last group.

- `resolveAllowedHosts(env = process.env): string[]`
  - `FLOWLATHE_ALLOWED_HOSTS` — comma-separated; entries are **added** to the defaults;
  - `FLOWLATHE_ALLOWED_HOSTS_EXCLUSIVE=1` — the list **replaces** the defaults instead;
  - every entry goes through `normalizeHost`; empties dropped, result deduped.

  Two knobs, each doing one obvious thing: this is the "replaced or added-to" the posture calls for.

- `isHostAllowed(raw: string | undefined, allowed: string[]): boolean` — normalize, then **exact
  match only**. Default-deny.

Deliberate choices worth not undoing:

- **The port is ignored entirely.** Rebinding is about the hostname; ignoring the port keeps
  reverse-proxy and alternate-port setups working, and buys the attacker nothing.
- **`0.0.0.0` is not a default entry** — see §6.3.

### 3.2 The hook, in `buildApp`

`packages/server/src/app.ts` — add `allowedHosts?: string[]` to `BuildAppOptions` (currently
`app.ts:18-51`), defaulting to `DEFAULT_ALLOWED_HOSTS`. Register as the first statement after
`const app = Fastify(...)` (`app.ts:54`), above the `app.register(fastifyStatic, ...)` at
`app.ts:95`:

```ts
const allowedHosts = opts.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;
app.addHook("onRequest", async (request, reply) => {
  if (isHostAllowed(request.headers.host, allowedHosts)) return;
  await reply.code(403).send({ error: "forbidden host" });
});
```

This is the **first hook of any kind in the server** — verified: the `fastifyStatic` registration
at `app.ts:95` is currently the only `addHook`/`register` call anywhere in `packages/server/src`,
and there is no `setErrorHandler`, no CORS, no helmet, no rate limit.

Read `request.headers.host` directly rather than `request.hostname`; the parsing rules in §3.1 are
the contract, and they should not silently change with a Fastify version.

**No route is exempt.** FIX §3 flags the Spotify OAuth callback
(`routes/plugins-spotify.ts:41`) as needing to stay reachable without credentials — it does, and
for free: that request is a *browser* redirect, so its `Host` is whatever `SPOTIFY_REDIRECT_URI`'s
host is, which §3.3 makes sure is allowlisted. Handling it this way sidesteps FIX §5's first trap
(exempting the callback is correct; exempting all of `/api/plugins/**` is not) by having no
exemption list to get wrong.

### 3.3 `packages/server/src/index.ts`

- `const allowedHosts = resolveAllowedHosts();`
- When the Spotify config block (`index.ts:50-66`) produced a config, push
  `new URL(config.redirectUri).hostname` onto that list. An operator who overrides
  `SPOTIFY_REDIRECT_URI` to something non-loopback would otherwise get a 403 on the callback with
  no clue why — the failure would look like a broken OAuth dance, not a host check.
- Pass `allowedHosts` into the `buildApp({...})` call at `index.ts:98`.
- Move `const host = process.env["HOST"] ?? "127.0.0.1"` (currently stranded at `index.ts:113`, far
  from the other env reads) up beside `port` at `index.ts:21`.
- Log a one-line warning at boot when `host` is not a loopback address: the API has no
  authentication and should be published to loopback only. Cheap, and it is the one moment an
  operator is looking at the terminal.

### 3.4 `Dockerfile`

No functional change. Add a comment above the `ENV ... HOST=0.0.0.0` block explaining why it is
`0.0.0.0` (container port mapping requires it) and that the image is meant to be published as
`-p 127.0.0.1:4310:4310`.

### 3.5 `README.md`

A new `## Deployment and network posture` section after `## Quickstart`. The README currently has
**no** deployment section, no mention of Docker at all, and no documentation of `HOST` — so this is
new prose, not an edit. It should carry:

- the §1 posture sentence verbatim;
- `HOST`, `FLOWLATHE_ALLOWED_HOSTS`, `FLOWLATHE_ALLOWED_HOSTS_EXCLUSIVE`;
- the `docker`/`podman run` line with the loopback publish;
- an explicit statement that the allowlist **is not authentication** (§2's last table row).

Match the existing style: env vars are documented in running prose, not a table.

## 4. Compatibility — verified findings

- **Server tests: zero changes needed.** Five test files call `buildApp` — `app.test.ts`,
  `routes/flows-versioning.test.ts`, `routes/plugins.test.ts`, `routes/plugins-spotify.test.ts`,
  `routes/triggers.test.ts`. (FIX §5's "nine test files" is the count of *all* server test files,
  not the ones using `buildApp`.) Every one drives the app through `app.inject()`; none ever calls
  `listen()`. light-my-request fills in `headers.host` from `BASE_URL = 'http://localhost'` when
  the caller supplies none (`lib/request.js:132`), i.e. `localhost:80` — already in the default
  allowlist.

  This is the deliberate answer to FIX §5's third trap ("decide which, deliberately"): the
  middleware is **on by default**, and the defaults happen to be exactly what the existing tests
  already send. No test needs a bypass flag.

- **Playwright: zero changes needed.** `baseURL` and `webServer.url` are both
  `http://127.0.0.1:4311`, and `webServer.env` sets no `HOST`. The three specs that touch the API
  (`slice1-prompt-chain`, `slice2-providers`, `slice8-dsl-file-sync`) do it via
  `page.evaluate(() => fetch("/api/..."))` — in-page and same-origin — not via the Playwright
  `request` fixture or `page.request`. FIX §3's "the Playwright harness is an HTTP client"
  constraint therefore does not bite for this option.

- **Web app: zero changes needed.** `packages/web/src/api.ts` uses relative URLs throughout, and
  both `EventSource` sites (`api.ts:178`, `pages/Canvas.tsx:541`) are relative.

  This is precisely why the allowlist was chosen over a bearer token: FIX §3's "check this first"
  constraint — `EventSource` cannot set custom headers — is what would have forced a
  cookie-or-query-parameter redesign under option 2. Under option 1 it is a non-issue.

- **CLI: unaffected.** `packages/cli` goes straight to SQLite via `openDb`; it is not an HTTP
  client.

## 5. Tests

**`packages/server/src/allowed-hosts.test.ts`** (new) — a table over `isHostAllowed`:

- allowed: `127.0.0.1`, `127.0.0.1:4310`, `localhost`, `LOCALHOST:4310`, `localhost.`,
  `[::1]:4310`, `::1`
- rejected: `evil.example`, `evil.example:4310`, `127.0.0.1.evil.com`, `0.0.0.0:4310`, `""`,
  `undefined`

Plus `resolveAllowedHosts`: defaults with an empty env; add-mode; exclusive-mode; whitespace and
empty entries in the comma-separated list.

**`packages/server/src/app.test.ts`** (extended) — via `app.inject`:

1. a default inject (`localhost:80`) still reaches routes — existing behavior unchanged;
2. `headers: { host: "evil.example:4310" }` on `/api/flows` → 403;
3. the same foreign host on `/api/executions/:id/events` — the `reply.hijack()` SSE route
   (`routes/executions.ts:136`) → 403, proving the hook runs before the handler hijacks the reply
   and detaches the lifecycle;
4. with `staticRoot` pointed at a temp dir containing an `index.html`, a foreign host on `/` →
   **403, not 200 with the SPA** (FIX §5's second trap — see §6.1);
5. an explicit `allowedHosts: ["flowlathe.lan"]` option is honored.

## 6. Design traps

1. **The SPA fallthrough.** `setNotFoundHandler` (`app.ts:96`) serves `index.html` with a 200 for
   any non-`/api/` path. A root-instance `onRequest` hook does run ahead of the 404 context and
   short-circuits it — but assert that with test 4 above rather than trusting it. A rejected
   request that returns 200 and the SPA is the exact failure the FIX doc warns about.
2. **Trailing dot and case.** `LocalHost.` is a real rebinding bypass against a naive `===`.
   Normalization is not cosmetic here; it is the check.
3. **`0.0.0.0` is deliberately not allowlisted.** Browsers on Linux and macOS will reach a
   loopback-bound server through `http://0.0.0.0:<port>` (the "0.0.0.0 day" class of bug). Adding
   it "for symmetry with the Dockerfile's `HOST`" reopens the hole — the Dockerfile's `0.0.0.0` is
   a *bind* address, which has nothing to do with what a client may put in a `Host` header.
4. **Default-deny on a missing `Host`.** Absent or empty is rejected, not waved through.
5. **No exemption list at all**, by construction — see §3.2.
6. **The two knobs are independent.** Adding a hostname to the allowlist does not open a port; only
   `HOST` does. Someone debugging a 403 will reach for the wrong one, and someone debugging a
   connection refused will reach for the other — say this in the README.
7. **Exact match, never suffix match.** `endsWith("localhost")` matches `evil-localhost`, and
   `endsWith(".127.0.0.1")`-style thinking matches nothing useful. Exact, after normalization.
8. **Don't let the README read as though the API is now authenticated.** §2's last table row is the
   load-bearing sentence of the whole change.

## 7. Slices

One commit is defensible. Two is cleaner:

1. `allowed-hosts.ts` + the `buildApp` hook + `index.ts` wiring + both test files.
2. `Dockerfile` comment + `README.md` section + the `CLAUDE.md` entry + flipping this plan's and
   `FIX-NETWORK-POSTURE.md`'s status lines.

## 8. Definition of done

Mirrors FIX §6, minus the token clauses:

- One documented posture, with `index.ts`'s default and the `Dockerfile`'s `ENV` agreeing with it.
- A test asserting a request with a foreign `Host` header is rejected — including on the
  SPA-fallback path and on an SSE route.
- `README.md`'s new deployment section states the posture explicitly, and says plainly that this is
  not authentication.
- `pnpm typecheck && pnpm test` green from the repo root; `pnpm e2e` green with **no**
  `playwright/playwright.config.ts` change.
- A `CLAUDE.md` entry recording the posture decision, the `0.0.0.0` / trailing-dot / exact-match
  traps, and the deferred shared-secret half.
- `FIX-NETWORK-POSTURE.md`'s status line updated from "Blocked on one product decision" to point at
  this plan.
