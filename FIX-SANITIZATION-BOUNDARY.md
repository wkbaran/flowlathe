# FIX-SANITIZATION-BOUNDARY — where untrusted text gets sanitized before it reaches a model

Status: implemented. See PLAN-SANITIZATION-BOUNDARY.md, which settled the §2 architectural
decision (both layers) and carried out the mechanical work in full.

Source: security/bug audit, findings #4 and #5.

## 1. The problem

`packages/plugins/_common/src/sanitize.ts` states the policy clearly: untrusted text landing in a
model's context gets hidden/control characters stripped, length bounded, and loud injection
phrasing flagged. The policy is applied **per plugin, by hand**, and three of the highest-exposure
paths were missed:

| Path | Sanitized? | Exposure |
| --- | --- | --- |
| SearXNG result title/snippet | yes (`summarizeSearxngResults`) | a few hundred chars |
| Discord `discord_read_messages` | yes (`summarizeMessage`) | ≤2000 chars |
| MCP tool *description* | yes (`sanitizeMcpToolDescription`) | ≤1024 chars |
| **Firecrawl scrape/crawl content** | **no** | up to 20,000 chars of a fully attacker-controlled page |
| **MCP tool *result*** | **no** | unbounded (`JSON.stringify(result.content)`) |
| **Discord *trigger* message content** | **no** | seeded raw into the graph by any channel member |

The pattern is backwards: the small, low-risk sources are sanitized and the large, fully
attacker-controlled ones are not. Sanitizing an MCP server's descriptions but not its results is
close to meaningless — the same server controls both.

Locations:
- `packages/plugins/firecrawl/src/client.ts:113` — `toOutcome` truncates but never sanitizes.
  Reached by the `firecrawl_*` tools *and* by the `fetch` node (`packages/nodes/fetch/src/run.ts`).
- `packages/plugins/mcp/src/client.ts:120` — `callTool` returns `JSON.stringify(result.content)`
  with no sanitization and no length cap.
- `packages/server/src/triggers/registry.ts:160` — `seed[node.id] = { content: message.content, ... }`.

All of these converge on `runPrompt`'s tool loop (`packages/nodes/prompt/src/run.ts:56`), which
concatenates results straight into the next prompt:

```ts
prompt = `${prompt}\n[tool calls]\n${resultLines.join("\n")}\nContinue.`;
```

## 2. The decision to make first

**Keep per-plugin sanitization and fill the three holes, or move to a single choke point?**

Choke-point candidates:
- `ToolRegistry.invoke` (`packages/runtime/src/tool-registry.ts:26`) — catches every tool result
  from every plugin, present and future, in one place.
- `runPrompt`'s tool-loop concatenation — same coverage, but further from the source.

Arguments for the choke point: a new plugin cannot forget. The current design has already
demonstrated that it *is* forgettable, three times.

Arguments against / complications:
- It makes the existing per-plugin calls redundant. Double-sanitizing is harmless in effect
  (the function is idempotent) but leaves confusing dead-looking code — decide whether to strip
  the per-plugin calls or keep them as defence in depth, and say which in a comment.
- The per-plugin calls apply **different length caps** deliberately (100 for a Discord username,
  500 for a SearXNG title, 1000 for a snippet, 1024 for an MCP description, 2000 for a message).
  A single choke point can only apply one cap, and it would be a *whole-result* cap rather than a
  per-field one. That is a real loss of granularity — work out whether it matters.
- **The Discord trigger seed is not a tool invocation at all.** No choke point at the tool
  boundary covers it. It needs its own fix regardless of which option you pick.

Recommendation: choke point at `ToolRegistry.invoke` for the whole-result safety net, *keeping*
the per-field per-plugin calls for their tighter caps, plus an explicit separate fix for the
trigger seed path. Document the two-layer arrangement so the next agent doesn't "simplify" one of
them away.

## 3. Second, smaller piece: the character ranges are out of date

`HIDDEN_CHAR_RANGES` (`sanitize.ts`) covers U+200B–200D, U+2028–2029, U+202A–202E, U+2060, U+FEFF.
Missing:

- **U+2066–U+2069** — bidi *isolates* (LRI/RLI/FSI/PDI). U+202A–202E covers only the older
  embeddings and overrides; the isolates are what the Trojan Source technique actually uses.
- **U+E0000–U+E007F** — Unicode tag characters. This is the current standard "invisible ASCII
  smuggling" vector against LLMs specifically, and it is the most significant omission here.
- U+00AD (soft hyphen), U+180E (Mongolian vowel separator).

These are additions to one array. Note the existing construction builds the regex from numeric
code points on purpose (so the file never embeds the invisible characters it strips) — keep that,
and keep the `u` flag, which the astral-plane U+E0000 range requires.

## 4. Design traps

- `sanitizeUntrustedText` **truncates before scanning** for injection patterns
  (`cleaned.slice(0, maxLength)` then the pattern loop). A result whose injection phrasing sits
  past the cap is silently never flagged. Decide whether that's acceptable or whether the scan
  should run on the full text.
- Sanitizing at `ToolRegistry.invoke` changes what the **state tools** return too
  (`read_state` results). Confirm that's harmless — it should be, since state values originate
  in-flow, but check that a JSON value round-trips unchanged.
- The `fetch` node's output is a normal node output feeding a downstream `{{input}}`, not a tool
  result. A tool-boundary choke point does not cover it. Either sanitize in
  `FirecrawlClient.toOutcome` (covers both callers at once — probably the right place) or handle
  the node separately.

## 5. Definition of done

- Firecrawl content, MCP tool results, and Discord trigger content are all sanitized and bounded.
- The four missing character ranges are stripped, with tests feeding each range in and asserting
  it is gone.
- **A test that would have caught the original gap**: `packages/plugins/searxng/src/tools.test.ts`
  currently asserts pass-through text only, which is why removing SearXNG's sanitization entirely
  survives the whole test suite (verified by mutation). Whatever arrangement you land on, add
  tests that feed hidden characters and over-length input through each path and assert on the
  output — not just that the happy path is unchanged.
