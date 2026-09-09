# Security lessons

The sanitization boundary and the audit findings behind several one-line-looking guards.

Moved verbatim out of `CLAUDE.md` when that file was split by topic; see it for the
index and for the invariants that apply repo-wide.

- **PLAN-SANITIZATION-BOUNDARY.md landed a deliberately two-layer sanitization arrangement for
  untrusted text reaching a model's context — neither layer may be deleted, and both were found
  missing in real, previously-shipped code before this plan (Firecrawl page content, MCP tool
  results, the Discord trigger seed all reached a prompt raw and unbounded).**
  - **Layer 1 (at the source, per field, tight caps) and layer 2 (one generous whole-result cap
    at `ToolRegistry.invoke`) do different jobs.** Layer 1 exists because layer 2 can't be
    granular — a single cap can't know a Discord username should be 100 chars and a scraped page
    20,000. Layer 2 exists because layer 1 is forgettable — it had already been forgotten three
    times (Firecrawl, MCP, the trigger seed) before this plan. Double-sanitizing is a no-op
    (`sanitizeUntrustedText` is idempotent), not a hazard — don't "simplify" one layer away because
    the other looks redundant on some call path.
  - **`sanitize.ts` moved from `@flowlathe/plugin-common` to `@flowlathe/core`**, specifically so
    `packages/runtime/src/tool-registry.ts` (the layer-2 choke point) can import it — `runtime`
    depends on `core` and every `@flowlathe/node-*`, never on `plugin-common` (a helper library
    *for* plugins, not for what plugins plug into). `plugin-common`'s `sanitize.ts` is now a
    one-line re-export, so no plugin call site had to change. Same precedent as
    `url-safety.ts`/`plugin-deps.ts`: a pure primitive consumed by plugins *and* runtime *and*
    server lives in `core`.
  - **The function is split**: `scrubUntrustedText` (strip hidden/control chars, flag injection
    phrasing, no length bound) vs. `sanitizeUntrustedText` (scrub, then bound). A caller that owns
    its own truncation marker (Firecrawl's `[truncated N of M chars]`) must scrub-then-truncate
    itself, never call `sanitizeUntrustedText` with a `maxLength` — that would silently slice the
    marker back off. The injection scan always runs on the full scrubbed text, before any
    truncation, so a match sitting past where a caller later truncates is still flagged.
  - **The layer-2 cap (`TOOL_RESULT_MAX_CHARS = 32_000`) is set well above Firecrawl's own
    `DEFAULT_MAX_CHARS` (20,000) plus its JSON envelope, on purpose** — it's a "nothing unbounded
    reaches a prompt" backstop, not a context-budget limit (that's the Gate node's compaction
    job), and must stay high enough that it never normally fires. Truncating a JSON envelope
    (every `toolOk`/`toolFail` result) produces invalid JSON, so tightening this cap later without
    first making truncation JSON-aware would gut legitimate results layer 1 already bounded
    correctly.
  - **`ToolRegistration.trustedResult?: boolean`** is a whitelist of exactly one thing: the
    built-in `read_state`/`write_state` tools, set by `stateToolset` in
    `packages/runtime/src/tool-registry.ts` and nothing else. Their data is in-flow state this
    system itself wrote — sanitizing it would corrupt a value, not defend anything. A plugin must
    never set this field.
  - **Sanitize the Discord trigger *seed*, never the persisted `execution_triggers.payload`.**
    `registry.ts`'s `admitMessage` writes the sanitized/bounded values into `seed` (what the flow
    graph sees) but still passes the raw `message` to `claimExecutionTrigger` verbatim — that row
    is a forensic record of what actually arrived, not model context. Getting this backwards would
    corrupt the dedupe/replay record to protect a prompt.
  - **Four character ranges were added** to the hidden-character strip list: bidi isolates
    (U+2066-2069 — the current Trojan Source vector, not covered by the older U+202A-202E
    embeddings/overrides already there), Unicode tag characters (U+E0000-E007F, astral — the
    current invisible-ASCII-smuggling vector against LLMs specifically), soft hyphen (U+00AD), and
    the Mongolian vowel separator (U+180E). The regex is built from numeric code points with the
    `u` flag specifically so this file's own source never embeds the literal invisible characters
    it strips — the `u` flag is load-bearing for the astral tag-character range.
  - **This stops cheap tricks, not a competent injection.** Stripping hidden characters and
    bounding length raises the floor; don't cite it as a defense against a determined adversary.
- **HANDOFF-QUICK-FIXES.md's ten bounded fixes landed (a security/bug audit's findings that didn't
  need their own planning session — see `git log` for the individual commits).** A few things
  worth knowing if this area comes up again:
  - **`execFileSync`/undici's own URL parsing quietly does most of the hard work, and it's easy to
    assume it does all of it.** Two of the ten bugs were exactly this shape: `git-history.ts`'s
    `git show <sha>:<path>` was vulnerable to *argument* injection (a `sha` starting with `-` is
    parsed by git as an option, e.g. `--output=<file>`) even though `execFileSync` already blocks
    *shell* injection; `DiscordClient.react`'s `messageId` was vulnerable to *path-traversal* via
    `..` segments even though it never touches a filesystem — undici normalizes `..` during URL
    parsing the same way a browser would, silently retargeting the request at a different Discord
    API endpoint entirely. Neither class shows up unless you specifically ask "what if this
    argument starts with `-` / contains `/../`," since the obvious injection vector (shell
    metacharacters, raw `..` in a file path) was already closed.
  - **`isPrivateOrInternalHost` (`packages/core/src/url-safety.ts`) and `normalizeHost`
    (`packages/server/src/allowed-hosts.ts`) are two independent, deliberately duplicated
    implementations of "is this hostname trying to reach something private," not a shared
    primitive** — `core` can't import from `server` (isomorphism), so the SSRF gaps this audit
    found (`0.0.0.0`, `::`, IPv4-mapped `0.0.0.0`, a trailing-dot FQDN, the RFC6598 CGNAT range)
    had to be independently re-derived and fixed in `url-safety.ts` even though
    `allowed-hosts.ts` already had correct trailing-dot handling and correct `0.0.0.0` reasoning
    to copy from. If either file's blocklist changes again, check whether the other one has
    drifted.
  - **A prototype-chain bug in `renderTemplate`** (`name in vars` instead of
    `Object.hasOwn(vars, name)`) **was reachable through ordinary product behavior, not just a
    synthetic API call** — a node declaring a port literally named `toString`/`constructor` that
    resolves to `never` (an untaken router branch) hits exactly this path, since `inputs` then
    genuinely lacks an own property for that name. One-character fix, but it silently rendered
    native-code source into a prompt instead of throwing the intended "missing template variable"
    error, and this file is consumed by every node kind in both engines — see the existing
    core-isomorphism entry above for why a change here always needs the full `pnpm test` run, not
    just `@flowlathe/core`'s own suite.
  - **A `Retry-After`/rate-limit value has two independent parse paths in `DiscordClient` — the
    header, and a JSON-body `retry_after` fallback — and only one of them went through the shared
    `retryAfterMsFromHeader` clamp.** Discord always includes `retry_after` in a 429 body, but the
    header isn't guaranteed on every route, so both paths are live in practice; fixing an upper
    bound in the shared parser alone would have left the body fallback able to stall a call for
    however long a hostile/broken `Retry-After` value said to wait. Route every such fallback
    through the same shared parser rather than reimplementing the arithmetic inline.
