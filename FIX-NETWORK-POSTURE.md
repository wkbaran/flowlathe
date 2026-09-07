# FIX-NETWORK-POSTURE — who is allowed to talk to the flowlathe API

Status: resolved. §1's product decision was settled and implemented — see `PLAN-NETWORK-POSTURE.md`
(§4 option 1, the `Host`-header allowlist). §4 option 2 (shared-secret auth) remains deliberately
deferred, not implemented; option 3 (users and sessions) stays rejected.

Source: security/bug audit, finding #6.

## 1. The question that has to be answered first

**Is the flowlathe server ever meant to be reachable from anything other than the loopback
interface of the machine running it?**

Everything below branches on that answer. Don't start coding until it's settled.

The code currently answers it inconsistently:

- `packages/server/src/index.ts` defaults `host` to `127.0.0.1` — loopback only.
- The `Dockerfile` sets `HOST=0.0.0.0` (line 30) and `EXPOSE 4310` — every interface.

So the shipped container image exposes the whole API to the LAN, while the bare-metal default does
not. That is not a posture; it is two postures.

## 2. What is currently unprotected

Verified by grep across `packages/server/src`: there is **no** authentication, authorization,
CORS configuration, CSRF token, `helmet`, or `Host`-header validation on any route. Zero
occurrences.

The API can, among other things: create and overwrite flows, run flows (which invokes configured
LLM providers and every enabled plugin toolset — Discord sends, Firecrawl scrapes, MCP stdio
subprocess spawns), read every execution's prompts and outputs, register and delete triggers,
create providers, and disconnect Spotify.

Two distinct exposure paths:

1. **Direct network exposure** (the Docker case): anything that can route to the port has full
   control.
2. **DNS rebinding** (even in the loopback case): a page the user visits rebinds a hostname it
   controls to `127.0.0.1`, then issues *same-origin* requests to `http://evil.example:4310/api/...`.
   No CORS policy stops this, because the browser believes it is same-origin. This is the standard
   attack against local developer servers and it is currently unmitigated.

Note that a plain cross-origin `fetch` from an unrelated page is *already* mostly blocked: Fastify
parses `application/json` only, and a JSON-content-type POST is not a CORS-simple request, so it
gets preflighted and the preflight fails (no CORS headers are sent). So **CSRF is largely handled
by accident today; rebinding is not.** Don't let "we should add CORS" crowd out the rebinding fix
— they are different problems and CORS does not address the one that is actually open.

## 3. Constraints, verified

- **The CLI is not an HTTP client.** `packages/cli/src/commands/flows.ts` and
  `packages/cli/src/providers.ts` call `openDb(...)` and go straight to SQLite. Adding auth to the
  HTTP API does not break `flowlathe`. This removes what would otherwise be the largest
  compatibility constraint.
- **The web app is same-origin.** `packages/web/src/api.ts` uses relative URLs; the server serves
  the built SPA from `@fastify/static`. A cookie- or header-based scheme both work.
- **The Spotify OAuth callback must stay reachable from the browser without credentials.**
  `GET /api/plugins/spotify/oauth/callback` is hit by a redirect from Spotify's servers, so it
  cannot sit behind whatever scheme protects the rest of `/api`. It has its own single-use `state`
  check; make sure any new middleware exempts it deliberately rather than by accident.
- **SSE endpoints need the scheme to work over `EventSource`.** `/api/executions/:id/events` and
  `/api/flows/events` are consumed by the browser's `EventSource`, which **cannot set custom
  headers**. A bearer-token-in-a-header design breaks these; a cookie or a query parameter does
  not. This is the constraint most likely to be discovered late and force a redesign — check it
  first.
- **The Playwright harness is an HTTP client.** `playwright/playwright.config.ts`'s `webServer`
  and every spec hit the API. Any auth scheme needs a way for the e2e suite to authenticate, wired
  through `webServer.env`.

## 4. Options, cheapest first

1. **`Host`-header allowlist only.** An `onRequest` hook rejecting any request whose `Host` is not
   `127.0.0.1[:port]`, `localhost[:port]`, or an operator-configured value. Closes DNS rebinding
   completely, needs no client changes at all (browser, CLI, e2e all send the right `Host`
   already), and is a few lines. **Does nothing for direct network exposure.**
2. **Host allowlist + a shared secret.** Adds a token, generated on first boot next to
   `credential.key` (mirroring `resolveCredentialKey`'s pattern) and injected into the SPA at
   serve time. Covers both exposure paths. Cost: the SSE constraint above, plus e2e wiring.
3. **Full auth (users, sessions).** Almost certainly wrong for a documented single-user local
   tool. Listed only so the plan records that it was considered and rejected.

Recommendation: do (1) unconditionally and immediately — it is nearly free and closes the attack
that is open even in the intended loopback deployment. Then decide whether the Docker image's
`HOST=0.0.0.0` should be kept at all; if it is, (2) becomes necessary rather than optional.

## 5. Design traps

- Exempting the OAuth callback from auth is correct; exempting all of `/api/plugins/**` is not.
- The `setNotFoundHandler` in `app.ts:96` serves `index.html` for any non-`/api/` path. Make sure
  a rejected request doesn't fall through to it and return 200 with the SPA.
- `buildApp` is used directly by nine test files. Whatever middleware is added must default to
  something those tests can pass through, or all of them need updating — decide which, deliberately.

## 6. Definition of done

- One documented posture, with `index.ts`'s default and the `Dockerfile`'s `ENV` agreeing with it.
- A test asserting a request with a foreign `Host` header is rejected.
- If a token is added: a test asserting an unauthenticated request is rejected, the SSE path
  proven to work under it, and `playwright.config.ts` wired.
- `README.md`'s deployment section states the posture explicitly.
