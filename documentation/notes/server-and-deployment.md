# Server, deployment and triggers

How the server is served and bound, the Docker image, network posture, and the trigger subsystem.

Moved verbatim out of `CLAUDE.md` when that file was split by topic; see it for the
index and for the invariants that apply repo-wide.

- **The server serves a pre-built SPA, not a Vite dev server.** `packages/server/src/index.ts`
  points `@fastify/static` at `packages/web/dist`. For manual dev-loop work with HMR you'd run
  `vite` separately (it proxies `/api` to the fastify server per `vite.config.ts`), but the
  Playwright e2e suite always runs `vite build` then starts the fastify server against the built
  output — that's the path that has to stay green.
- **PLAN-INTEGRATIONS.md Phase E added the `trigger` node kind, `GraphEngine`'s `seed` option,
  and `TriggerRegistry`/`DiscordTriggerSource`/`/api/triggers`.** The largest phase; scope
  decisions worth knowing before touching this again:
  - **`RunGraphOptions.seed` writes directly into `GraphEngine`'s internal `outputs` map at
    construction, before the first readiness pass** — a seeded node is therefore never dispatched
    at all (it's already "settled" by the time `remaining()` is computed), not dispatched-then-
    overridden. This is why `runTrigger` (the ordinary, unseeded dispatch path, used only for a
    canvas-started run) never runs when a flow is started by a real trigger: the trigger node's
    `dispatch` function in `registry.ts` is simply never called for that node id. Snapshot/restore
    needs **no shape change** at all: `EngineSnapshot.outputs` already captures whatever's in the
    map, seeded or not, and `GraphEngine.restore` already re-validates the top-level graph and
    toolset gate on every restore (a pre-existing behavior, not new to this phase). For step mode,
    `startStepExecution` bakes the seed into stepIndex 0's persisted snapshot directly (via the
    same `serializeSnapshot`/`putBlob` path every other snapshot uses) rather than reusing
    `GraphEngine`'s constructor-time seeding — there's no `Run` object available yet at that call
    site (host-building is deferred to the first `stepOnce`), so building the snapshot payload by
    hand was simpler than manufacturing a throwaway host just to seed one.
  - **A trigger node's real base-URL-equivalent (which flow-graph node ids to seed) is resolved by
    `TriggerRegistry`, not stored on the `triggers` DB row.** `admitMessage` re-resolves the
    trigger's pinned graph (`getGraphForFlowVersion` — the exact version, deliberately NOT
    `getLatestGraphForFlowVersion`, which step sessions use on purpose to reflect live edits; a
    trigger must never do that) on every single message and seeds *every* node with `type ===
    "trigger" && data.source === "discord"` identically. Registration validation guarantees at
    least one exists; nothing stops an author wiring more than one, and all get the same message
    — an unusual but harmless graph shape, left unhandled the same way the compiler's router-edge-
    reuse edge case is (see the router-branch entry above).
  - **The dedupe claim/check race is resolved with a deliberately asymmetric design**: a *live*
    gateway message only ever gets the fast, non-claiming `executionTriggerExistsForExternalId`
    check before `admitMessage` starts a real execution and then claims via
    `claimExecutionTrigger`'s `UNIQUE(external_id)` insert. If the claim itself loses a race
    (vanishingly rare — it would need the recovery scan and a live event for the *same* message to
    both pass the pre-check in the same instant), the execution that already started is simply
    left to run; it's logged, not rolled back. Getting this fully atomic would mean claiming
    *before* starting the run, but the claim's `execution_id` is a real FK to `executions.id`,
    so the execution has to exist first — closing this completely would need a two-phase
    reservation (claim a bare row, then backfill `execution_id`), judged not worth the complexity
    for a single-user local server.
  - **The self-message loop guard compares against the bot's own user id specifically (learned
    from the gateway's `ready` event), not "any message where `author.bot` is true"** — matching
    the plan's explicit instruction to keep other bots as an opt-in case, not a blanket ignore.
    Before `ready` fires (a brief window right after `login()`), `botUserId` is `undefined` and the
    guard is a no-op — a message from the bot's own account in that narrow window would not be
    filtered. Not observed in testing (the fake-gateway tests fire `ready` synchronously inside
    `login()`), but worth knowing if a real connection's `ready` timing ever matters.
  - **Privileged-intents detection is a message-text heuristic** (`/intent|disallowed/i` against
    the error message), not a check against a stable discord.js error code — discord.js does not
    expose one consistently across versions for this failure mode. False negatives (a real intents
    problem whose error text doesn't match) just fall back to printing the bare error, same as
    before this existed.
  - **Recovery's "how far back to scan" uses the Snowflake id's embedded timestamp**
    (`snowflakeTimestampMs`: the top 42 bits of a Discord message id, shifted, plus the Discord
    epoch) rather than reading each message's `timestamp` field — avoids a second per-message
    field access and matches how Discord's own API documents deriving creation time from an id.
  - **`DiscordClient.readMessages`'s signature changed from `(channelId, limit?, before?)` to
    `(channelId, { limit?, before?, after? })`** to add `after` (needed for the recovery scan's
    forward-from-cursor read; the outbound `discord_read_messages` tool only ever used `before`).
    Every existing call site (the tool, its tests) was updated in the same change — a breaking
    signature change to a function with exactly one internal consumer at the time, not a
    backwards-compatible overload, since there's no external caller to preserve compatibility for.
  - **No web UI for creating/managing triggers** — `/api/triggers` (POST/GET/DELETE/repin) is
    fully functional and covered by route-level tests, but there's no canvas affordance to call
    it yet. A deliberate cut: the plan's own checklist for this phase is entirely about the
    subsystem (node kind, seed, registry, gateway, tables, recovery), and a management UI is a
    separable, later piece of work — same category of cut as Spotify's Connect button being the
    only plugin with dedicated UI beyond the generic manifest-driven surfaces.
  - **No e2e spec** (Playwright can't drive a real Discord gateway) — coverage instead comes from
    `packages/server/src/triggers/registry.test.ts`, which drives `DiscordTriggerSource` through
    an injected fake `DiscordGateway` end to end (admission, channel allowlist, self-message
    guard, dedupe-on-redelivery, and the recovery scan's cursor/window/reverse-ordering logic),
    plus `routes/triggers.test.ts` for the HTTP-layer registration gate. This matches
    PLAN-INTEGRATIONS.md §8's own instruction for this phase exactly ("Drive DiscordTriggerSource
    through an injected event emitter").
- **A root `Dockerfile`/`.dockerignore` were added, and building/running the image (via `podman`,
  verified end to end — image build, container run, `curl` from outside the container, and a
  non-root filesystem check) surfaced one real app bug and one packaging gotcha:**
  - **`packages/server/src/index.ts` used to hardcode `app.listen({ port, host: "127.0.0.1" })`
    with no env override**, unlike every other piece of server config (`PORT`,
    `FLOWLATHE_DB_PATH`, `FLOWLATHE_FLOWS_DIR`, ...) which already reads from `process.env`. This
    made the server unreachable from outside its own network namespace — Docker's port-forwarding
    lands on the container's external interface, not loopback, so every request got a connection
    reset regardless of `-p` mapping. Fixed generally, not just for Docker: `host` now reads
    `process.env["HOST"] ?? "127.0.0.1"`, so bare-metal/local behavior is unchanged and the image
    sets `HOST=0.0.0.0`.
  - **The image installs pnpm via `npm install -g pnpm@10.6.5` in the base stage, deliberately NOT
    `corepack prepare pnpm@... --activate`.** `corepack prepare` as root caches the downloaded
    pnpm package under root's `$COREPACK_HOME` (`~/.cache/node/corepack`); the final stage's
    `USER node` switch has a different `$HOME`, and corepack doesn't share that cache across
    users, so the very first container start tried to hit the npm registry again for a package
    that was already sitting in the image — silently doing a network round-trip at every fresh
    container start (and hard-failing in a network-isolated deployment). A plain global npm
    install has no such per-user cache and needs no network at runtime.
  - **No native build toolchain (`python3`/`make`/`g++`) is needed at all, on Alpine included** —
    `better-sqlite3@13.0.3` ships prebuilt binaries for `linuxmusl-{x64,arm64}` in its own npm
    tarball, and the root `package.json`'s `pnpm.onlyBuiltDependencies: ["esbuild"]` already blocks
    every other package's install/postinstall lifecycle script (including Playwright's browser
    downloader) from running during `pnpm install` — so `node:22-alpine` needs nothing extra
    layered on for this repo to install cleanly.
  - **The image intentionally ships full TS source for every workspace package** (not just
    `packages/server`), because that's how this repo already runs in production per the very
    first entry in this file: `tsx` resolves workspace deps to raw `.ts` via pnpm symlinks, so
    there is no `dist/` to copy for anything except `packages/web` (a real Vite build, copied in
    from a separate `build` stage). Don't try to "slim down" the runtime stage by pruning
    non-server package source — it's a load-bearing part of how the app runs, not build residue.
- **PLAN-NETWORK-POSTURE.md added a `Host`-header allowlist (`packages/server/src/allowed-hosts.ts`),
  the settled resolution of a prior audit's blocked "what's the posture" question.** The API stays
  fully unauthenticated — this only closes DNS-rebinding-style attacks (a public page's script
  sending a request that lands on the loopback-bound server with a rebound `Host`), it does **not**
  add any form of auth. That half (FIX §4 option 2: a shared secret next to `credential.key`,
  carried by cookie/query param since `EventSource` can't set custom headers) is deliberately
  deferred, not implemented.
  - **`0.0.0.0` must never be added to `DEFAULT_ALLOWED_HOSTS`.** It's a *bind* address, unrelated
    to what a client may put in a `Host` header — browsers on Linux/macOS will route
    `http://0.0.0.0:<port>` to a loopback-bound server (the "0.0.0.0 day" bug class), so
    allowlisting it would reopen exactly the hole this module exists to close. The Dockerfile's
    `HOST=0.0.0.0` is a completely separate knob (which interface the process binds inside its own
    network namespace) — adding it to the Host allowlist "for symmetry" is the trap.
  - **`normalizeHost` does real work, not cosmetic cleanup**: a trailing dot (`localhost.` is a
    valid FQDN for `localhost`) and case (`LocalHost.`) are both real bypasses against a naive
    `===`, and the match is exact-only — no `endsWith`, since that would match `evil-localhost`
    against `localhost`.
  - **The `onRequest` hook has no exemption list, by construction.** The Spotify OAuth callback
    (the one route that has to stay reachable without the allowlist blocking it) needs none: its
    own request's `Host` is whatever `SPOTIFY_REDIRECT_URI`'s hostname is, so `index.ts` just
    pushes that hostname onto the allowlist instead of special-casing the route.
  - **A worktree/branch created off `origin/main` can silently be missing recent local-only
    commits.** Implementing this plan in a fresh worktree initially appeared to be missing both
    the Dockerfile and `index.ts`'s `HOST` env-var read entirely — not a code regression, just the
    worktree's base ref (`origin/main`) trailing the local `main` branch by an unpushed commit.
    Fixed by rebasing the worktree branch onto local `main` before starting. Worth checking
    `git branch -vv` for an "ahead" marker before trusting a fresh worktree matches what `git log`
    on the main checkout shows.
