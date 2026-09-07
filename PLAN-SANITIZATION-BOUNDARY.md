# Implementation plan — the sanitization boundary

Status: implemented (slices 1-4 complete).

Source: `FIX-SANITIZATION-BOUNDARY.md` (security/bug audit, findings #4 and #5).

That document is blocked on one architectural decision (its §2). **This plan settles it** (§1) and
turns the rest into mechanical work. Everything in §5 is a verified finding against the code as it
stands, not an assumption; the line numbers below were checked, not copied from the FIX doc.

## 1. The settled decision

FIX §2 asks: keep per-plugin sanitization and fill the three holes, or move to a single choke
point? **Both, in two named layers**, which is the FIX doc's own recommendation, adopted here:

| Layer | Where | Cap | Job |
| --- | --- | --- | --- |
| 1 — at source | each plugin/client, per field | tight, per-field (100/500/1000/1024/2000/`maxChars`) | strip *and* bound each field to what that field is actually for |
| 2 — choke point | `createToolRegistry`'s `invoke` (`packages/runtime/src/tool-registry.ts:27`) | one generous whole-result cap | a plugin that forgets layer 1 still cannot land raw bytes in a prompt |
| — separate | the Discord trigger seed, and the `fetch` node's output | per-field | neither is a tool result; no tool-boundary choke point can ever cover them |

Why both, stated once so the next agent does not "simplify" one away:

- **Layer 2 exists because layer 1 is forgettable.** It has been forgotten three times already
  (Firecrawl content, MCP results, trigger content). A new plugin author cannot forget layer 2.
- **Layer 1 exists because layer 2 cannot be granular.** A single whole-result cap cannot express
  "a Discord username is 100 characters and a scraped page is 20,000." Deleting the per-field
  calls would silently relax every one of those caps to the choke point's.
- **Double-sanitizing is a no-op**, not a hazard: `sanitizeUntrustedText` is idempotent (stripping
  an already-stripped string changes nothing; slicing an already-shorter string changes nothing).
  The only observable cost is a duplicate `console.warn` on an injection-pattern match.

Say all of that in a comment at the choke point, and in the CLAUDE.md entry.

## 2. Where the shared module has to live

**`sanitize.ts` moves from `@flowlathe/plugin-common` to `@flowlathe/core`.** This is a
prerequisite for layer 2, not a tidy-up.

Verified dependency directions:

- `@flowlathe/plugin-common` → `@flowlathe/core` (only dep).
- `@flowlathe/runtime` → `@flowlathe/core` + every `@flowlathe/node-*`. It does **not** depend on
  `plugin-common`, and should not: `plugin-common` is a helper library *for plugins*, and runtime
  is what plugins plug into.
- `@flowlathe/server` depends on both, so the trigger-seed fix works either way.

So the choke point in `packages/runtime/src/tool-registry.ts` cannot import
`sanitizeUntrustedText` where it currently lives. Moving it to `core` follows the precedent this
repo already set twice for exactly this shape of problem — one pure primitive consumed by plugins
*and* runtime *and* server: `packages/core/src/url-safety.ts` (used by `plugin-firecrawl`) and
`packages/core/src/plugin-deps.ts` (used by UI + interpreter + compiler + server routes).

Isomorphism check (CLAUDE.md's hard rule for `core`): the module is pure string/regex work plus
`console.warn`. No `Buffer`, no `node:*`. It is safe for `packages/web`'s typecheck and bundle.

**Zero call-site churn:** keep `packages/plugins/_common/src/sanitize.ts` as a one-line re-export
(`export { sanitizeUntrustedText, scrubUntrustedText } from "@flowlathe/core";`), so
`plugin-searxng`, `plugin-discord` and `plugin-mcp` keep importing from `@flowlathe/plugin-common`
unchanged. Add `export * from "./sanitize.js";` to `packages/core/src/index.ts` next to the
`url-safety.js` line (`index.ts:11`).

## 3. Design

### 3.1 Split the function in two

The FIX doc's §4 first trap — the scan for injection phrasing runs *after* truncation, so an
injection sitting past the cap is never flagged — and Firecrawl's need to keep its own truncation
marker are the same problem: "strip and flag" and "bound the length" are two jobs welded together.
Split them:

```ts
/** Strip hidden/control characters and flag loud injection phrasing. No length bound — for
 *  callers that own their own truncation (and its marker). */
export function scrubUntrustedText(text: string, source = "untrusted text"): string;

/** scrub, then bound. The scan now runs on the FULL text, before the cap. */
export function sanitizeUntrustedText(text: string, maxLength = 4000, source = "untrusted text"): string;
```

`sanitizeUntrustedText` keeps its exact current signature and its current output for every
existing caller — only the warning behavior changes (it now fires for a match past the cap, which
is the fix). The scan is a dozen regexes over at most a few tens of kilobytes; running it on the
full text is free.

### 3.2 Layer 1 — the three holes

**Firecrawl page content** — `packages/plugins/firecrawl/src/client.ts:107`, `toOutcome`:

```ts
const raw = data?.markdown ?? data?.html ?? "";
return { url: finalUrl, title: data?.metadata?.title, content: truncate(scrubUntrustedText(raw, "firecrawl page"), maxChars) };
```

`scrub`-then-`truncate`, deliberately in that order: `truncate` appends the
`\n[truncated N of M chars]` marker that `client.test.ts:38` asserts on, and a `sanitize` call with
`maxLength` would silently slice that marker off. Sanitize `data?.metadata?.title` too (a page
title is attacker-controlled text of no legitimate length) — `sanitizeUntrustedText(title, 500,
"firecrawl page")`, matching SearXNG's title cap.

This one edit covers **both** callers at once: the `firecrawl_*` tools and the `fetch` node
(`packages/nodes/fetch/src/run.ts`), whose output is an ordinary node output feeding a downstream
`{{input}}` and is therefore invisible to layer 2. That is why it belongs in the client, not in
`packages/plugins/firecrawl/src/tools.ts`.

**MCP tool results** — `packages/plugins/mcp/src/client.ts:117`, `callTool`, currently
`return JSON.stringify(result.content)` with no cap and no scrub. Add a third helper next to the
two that already exist in `packages/plugins/mcp/src/sanitize.ts`:

```ts
const DEFAULT_TOOL_RESULT_MAX_LENGTH = 8_000;
export function sanitizeMcpToolResult(text: string, maxLength = DEFAULT_TOOL_RESULT_MAX_LENGTH): string;
```

Apply it **in `callTool`**, not in the toolset's handler, so any future caller of the client is
covered. Sanitizing a server's tool *descriptions* while leaving its *results* raw is close to
meaningless — the same server controls both.

Note what `result.content` actually is: an array of MCP content blocks, which may include
base64 image data. The cap is what makes that survivable; it should append a truncation marker
(reuse Firecrawl's `[truncated N of M chars]` wording) rather than cutting silently, so a model
that gets half a JSON array can at least tell.

**Discord trigger content** — `packages/server/src/triggers/registry.ts:160`, in `admitMessage`:

```ts
seed[node.id] = {
  content: sanitizeUntrustedText(message.content, 2000, "discord trigger"),
  authorId: message.authorId, channelId: message.channelId, messageId: message.id,
};
```

2000 matches the cap `discord_read_messages` already uses for the same kind of text
(`plugins/discord/src/tools.ts:62`) — the two paths carry identical data and should not disagree.

**Sanitize the seed, never the persisted payload.** The raw message goes on being written to
`execution_triggers.payload` verbatim (`registry.ts`'s `claimExecutionTrigger` call): that row is a
forensic record of what actually arrived, not model context. Getting this backwards would corrupt
the dedupe/replay record to protect a prompt.

The three id fields are Discord snowflakes (numeric, ≤20 chars) and need no scrubbing — but they
are seeded into the graph and can be wired into a template, so bound them defensively at 64 chars.
Cheap; no legitimate value comes near it.

### 3.3 Layer 2 — the choke point

`packages/runtime/src/tool-registry.ts:27`:

```ts
invoke: async (name, args, meta) => {
  const reg = byName.get(name);
  if (!reg) return `[${name}]: error - unknown tool`;
  try {
    const raw = await reg.handler(args, meta);
    return reg.trustedResult ? raw : sanitizeUntrustedText(raw, TOOL_RESULT_MAX_CHARS, `tool ${name}`);
  } catch (err) {
    return `[${name}]: error - ${(err as Error).message}`;
  }
},
```

Three decisions inside that:

- **`TOOL_RESULT_MAX_CHARS = 32_000`.** It has to sit *above* Firecrawl's `DEFAULT_MAX_CHARS`
  (20,000, `firecrawl/src/client.ts:36`) plus the JSON envelope, or the backstop silently becomes
  the routine cap and starts gutting legitimate scrape results that layer 1 already bounded
  correctly. This number is a "nothing unbounded reaches a prompt" limit, not a context-budget
  limit — the latter is the Gate node's compaction job (`PromptSpec` / `maybeCompact`).
- **`ToolRegistration.trustedResult?: boolean`** (new optional field in
  `packages/core/src/contracts.ts`, alongside `standalone`), set by `stateToolset` and by nothing
  else. `read_state` returns in-flow data that this system itself wrote; stripping characters out
  of it, or truncating it, corrupts a value rather than defending anything. Express it as a data
  field on the registration — the `standalone` precedent — never as
  `if (reg.toolset === "state")`, which is the name-special-casing this codebase has deliberately
  avoided elsewhere (see `routes/plugins.ts`'s uniform `configured`/`connected` derivation).
- **The error strings pass through unsanitized** — they are constructed here, from
  `(err as Error).message`. A plugin's error message can embed vendor response text
  (`PluginHttpError` carries a truncated body), so route the `catch` arm through the same
  `sanitizeUntrustedText` call rather than leaving a hole under the safety net.

`createToolRegistry` is the **only** `ToolRegistry` implementation in the repo (verified), with
three production call sites — `packages/server/src/host-builder.ts:129`,
`packages/cli/src/commands/run.ts:62`, and the string the compiler emits at
`packages/compiler/src/compile-graph.ts:214`. So the server, the CLI, and every exported script get
layer 2 for free, with no change to the emitted script's source.

## 4. The character ranges

`HIDDEN_CHAR_RANGES` (`sanitize.ts`) currently covers U+200B–200D, U+2028–2029, U+202A–202E,
U+2060, U+FEFF. Add four entries:

| Range | Why |
| --- | --- |
| `[0x2066, 0x2069]` | bidi **isolates** (LRI/RLI/FSI/PDI). U+202A–202E covers only the older embeddings/overrides; the isolates are what the Trojan Source technique actually uses. |
| `[0xe0000, 0xe007f]` | Unicode **tag characters** — the current standard invisible-ASCII-smuggling vector against LLMs specifically. The most significant omission of the five. |
| `[0x00ad, 0x00ad]` | soft hyphen |
| `[0x180e, 0x180e]` | Mongolian vowel separator |

Mechanically this is four entries in one array — the existing construction already handles
single-code-point ranges (`[0x2060, 0x2060]`) and already builds the regex from numeric code points
with the `u` flag, which the astral U+E0000 range requires. **Keep both**: the numeric construction
is there so the file's own source never embeds the invisible characters it strips, and dropping
`u` would silently stop matching the one range that matters most.

Accept the U+00AD false-positive: legitimately hyphenated text loses its soft hyphens. That
degrades rendering slightly and defends against a real hiding place; it is the right trade for text
whose only destination is a model's context.

## 5. Verified findings

- **Dependency directions** are as stated in §2 — checked against each package's `package.json`.
  `runtime` has no path to `plugin-common` today.
- **`createToolRegistry` is the single `ToolRegistry` implementation**; nothing hand-builds the
  interface. Three production call sites, listed in §3.3.
- **Existing `sanitize.test.ts` (4 cases) all still pass** under the §3.1 split: the truncation case
  asserts a silent slice (`"x".repeat(20), 5` → `"xxxxx"`), which `sanitizeUntrustedText` keeps
  doing, and the injection case asserts exactly one `console.warn`, unchanged for text under the
  cap.
- **`packages/plugins/searxng/src/tools.test.ts` is the FIX doc's mutation finding**: its success
  case (`tools.test.ts:9-28`) asserts pass-through text only — `"Result <b>1</b>"` / `"snippet
  text"` — so deleting SearXNG's `sanitizeUntrustedText` calls entirely leaves the whole suite
  green. Whatever else this plan does, that has to stop being true (§6).
- **`packages/plugins/firecrawl/src/client.test.ts:38` pins the truncation marker** exactly
  (`` `${"x".repeat(10)}\n[truncated 10 of 100 chars]` ``). §3.2's scrub-then-truncate ordering is
  what keeps it green.
- **The `state-tools` golden parity fixture is a canary for layer 2.**
  `packages/testing/src/golden/state-tools.ts` keys its mock response on the literal second-round
  prompt, which embeds the tool-result string `[write_state notes]: ok`. Any change to what
  `invoke` returns for a state tool breaks parity loudly rather than silently — which is the
  behavior you want, and a second reason `trustedResult` is worth having.
- **`packages/web` is unaffected**, but it does typecheck all of `core`'s source transitively
  (CLAUDE.md's `export *` note), which is why §2's isomorphism check matters.

## 6. Tests

**`packages/core/src/sanitize.test.ts`** (moved from `plugin-common`, extended):

- one case per **new** range, each feeding the character in by code point and asserting it is gone:
  U+2066, U+E0001 (inside the tag-character range, astral), U+00AD, U+180E. Plus a regression case
  for an existing range so the move is covered.
- `scrubUntrustedText` does not truncate; `sanitizeUntrustedText` does.
- **an injection phrase positioned past the cap now warns** — the §3.1 fix, and the one behavioral
  change worth pinning.

**Per-path tests feeding hidden characters and over-length input through each front end** — this is
FIX §5's "a test that would have caught the original gap", and it is the part most likely to be
skipped:

- `plugins/firecrawl/src/client.test.ts` — a scrape whose markdown contains U+200B and a tag
  character comes back clean, with the truncation marker still intact on an over-length body.
- `plugins/mcp/src/toolset.test.ts` — a fixture server returning a huge, hidden-character-laden
  result: the handler's return value is bounded and clean.
- `plugins/searxng/src/tools.test.ts` — a result whose `title`/`content` carry hidden characters:
  assert they are stripped. Deleting `summarizeSearxngResults`'s sanitize calls must now fail.
- `plugins/discord/src/tools.test.ts` — same, for `summarizeMessage`.
- `server/src/triggers/registry.test.ts` — drive `DiscordTriggerSource` (through the existing
  injected fake gateway) with a message containing hidden characters and >2000 chars; assert the
  **seed** is clean and bounded and the **persisted `execution_triggers.payload` is byte-identical
  to the raw message**.
- `runtime/src/tool-registry.test.ts` (new) — a registration whose handler returns hidden
  characters and 50,000 characters: `invoke` returns clean, bounded text. A `trustedResult`
  registration returns its value byte-identical. A throwing handler's message is sanitized too.

**`pnpm test` and `pnpm typecheck` from the repo root**, plus the parity harness (the golden
fixtures exercise the real `createToolRegistry`).

## 7. Design traps

1. **Truncating a JSON envelope produces invalid JSON.** Every web-ish plugin returns
   `toolOk(...)`/`toolFail(...)` — a JSON string. The choke point's cap slices bytes, so a result
   that actually hits 32,000 chars reaches the model as an unparseable fragment. This is exactly
   why the cap is set well above every layer-1 cap: layer 2 must be the thing that never normally
   fires. Do not "tighten" it later without moving to a JSON-aware truncation.
2. **`JSON.stringify` does not escape the characters that matter.** It escapes below U+0020, but
   U+200B, U+2066 and U+E0001 pass through literally into an envelope — so the choke point does
   real work on JSON results, and a "the plugins already stringify it, it must be safe" argument
   is wrong.
3. **Scrub before truncate, at every site that has a truncation marker.** Firecrawl's
   `[truncated N of M chars]` is asserted by a test; a `sanitizeUntrustedText(x, maxChars)` call
   layered on top of `truncate` would cut the marker back off.
4. **Never sanitize the persisted trigger payload** (§3.2). Model context and forensic record are
   different destinations with different rules.
5. **`trustedResult` is a whitelist of exactly one thing.** It exists for the built-in state tools,
   whose data this system wrote. A plugin must never set it; say so in the field's doc comment.
6. **The `fetch` node is not a tool call.** Neither is the `search` node, nor the trigger seed. A
   reader who sees layer 2 land will assume the boundary is closed — three of these paths do not
   cross it. Layer 1 is not redundant.
7. **`core` must stay isomorphic.** `sanitize.ts` qualifies today; keep it that way (no `Buffer`,
   no `node:*`, no `process.env`) — `packages/web` typechecks all of it.
8. **A `console.warn` per tool invocation gets noisy.** Pass a source label that names the tool
   (`` `tool ${name}` ``), so a duplicate warning from layers 1 and 2 is at least traceable to two
   different origins rather than looking like a double-fire bug.
9. **None of this stops a competent injection.** The module's own doc comment already says so; keep
   that framing in the CLAUDE.md entry. Stripping hidden characters and bounding length raises the
   floor; it is not a defense that should be cited as one.

## 8. Slices

1. **Move + extend the shared module.** `sanitize.ts` → `@flowlathe/core`, `plugin-common`
   re-export shim, `scrubUntrustedText`/`sanitizeUntrustedText` split, the four new ranges, the
   moved-and-extended test file. No behavior change at any call site except the injection scan now
   seeing full text.
2. **Layer 1, the three holes.** Firecrawl `toOutcome`, MCP `callTool`, the Discord trigger seed,
   with their per-path tests.
3. **Layer 2.** `ToolRegistration.trustedResult`, the `invoke` wrapper, `stateToolset` opting out,
   `tool-registry.test.ts`.
4. **Coverage for the gap that hid all of this**: the SearXNG/Discord hidden-character tests (§6),
   the CLAUDE.md entry, and flipping this plan's and `FIX-SANITIZATION-BOUNDARY.md`'s status lines.

Slices 2 and 3 are independent of each other and both depend on 1.

## 9. Definition of done

Mirrors FIX §5:

- Firecrawl page content (both the `firecrawl_*` tools **and** the `fetch` node), MCP tool results,
  and Discord trigger content are all scrubbed and bounded.
- Every tool result crossing `ToolRegistry.invoke` is bounded, with exactly one documented
  exemption (`trustedResult`, used only by the built-in state toolset).
- The four missing character ranges are stripped, with a test per range feeding the character in by
  code point and asserting it is gone.
- Deleting a per-plugin sanitize call **fails a test** — verified by actually doing it once, per
  the mutation check that produced this finding.
- `pnpm typecheck && pnpm test` green from the repo root; the parity harness green.
- A CLAUDE.md entry recording: the two-layer arrangement and why neither layer may be deleted; why
  `sanitize.ts` lives in `core`; the choke-point cap's relationship to Firecrawl's 20,000; the
  `trustedResult` exemption; and the "sanitize the seed, not the persisted payload" rule.
- `FIX-SANITIZATION-BOUNDARY.md`'s status line updated to point at this plan.
