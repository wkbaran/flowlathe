# PLAN-COMPILER-VARNAME — make the compiler's generated variable names injective

Source: `FIX-COMPILER-VARNAME.md` (security/bug audit finding #12).
Status: not started. Own session. Small change, but it touches the one function every emitted
identifier flows through, so the regression net has to go in first.

---

## 1. The bug, as verified

`packages/compiler/src/compile-graph.ts:575`:

```ts
function varName(nodeId: string): string {
  return `n_${nodeId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}
```

The mapping is not injective: `a-b`, `a.b`, `a b` and `a_b` all become `n_a_b`.

### 1.1 It is reachable through the product, not just through arbitrary API input

The audit note frames this as "node ids are arbitrary strings" (`FlowNodeSchema.id` is only
`z.string().min(1)`). That understates it — both authoring surfaces actively permit the colliding
shapes:

- **Canvas rename** (`packages/web/src/pages/Canvas.tsx:361`) validates against
  `/^[A-Za-z_][A-Za-z0-9_-]*$/` — **hyphens are explicitly allowed**, and the only other check is
  "not already used by another node". So `fetch-page` and `fetch_page` are both accepted, are
  distinct nodes, and collide.
- **The DSL lexer** (`packages/dsl/src/lex.ts:216`) deliberately admits internal hyphens in
  identifiers (`if (peekChar() === "-" && isIdentPart(peekChar(1)))`, added for merge-rule names).
  The parser rejects duplicate node *names* but has no notion of names that are distinct yet
  collide downstream.

So this is a two-node rename away in the UI, not a synthetic input.

### 1.2 Three failure shapes — one of them completely silent

Verified empirically against the current compiler (`compileGraph` run directly, output inspected;
the cross-region case additionally executed end to end via `tsx`):

**(a) Same region, fan-out level** — `emitLevel`'s multi-node branch:

```js
const [n_a_b, n_a_b] = await allOrCancel(rt.cancellation, [ ... ]);
```

A duplicate binding in a destructuring pattern → `SyntaxError`. Loud.

**(b) Same region, sequential chain** — `emitLevel`'s single-node branch:

```js
const n_a_b = await rt.prompt(N.n_a_b, {  });
const n_a_b = await rt.prompt(N.n_a_b, { input: n_a_b.output });
```

`const` redeclared in one scope → `SyntaxError`. Loud (and note the second node's own binding is
what it reads from — the input expression is wrong too).

**(c) Different regions — silent, and the one that matters.** Two nodes in different lexical scopes
(a Loop/Map body vs. the top level) produce no duplicate *declaration* at all. Only the global `N`
spec table collides, as a duplicate object-literal key — legal in ES2015+ even in strict-mode ESM,
last one wins. Graph: a top-level prompt `x_y` (template `TOP`) and a Map body prompt `x-y`
(template `BODY {{item}}`), no edge between them. Emitted:

```js
const N = {
  n_m:   {"id":"m", ...},
  n_x_y: {"id":"x-y","template":"BODY {{item}}", ...} as const,   // ← shadowed
  n_x_y: {"id":"x_y","template":"TOP", ...}          as const,   // ← wins
} as const;
```

Actual run of that compiled script:

```
STATUS 0
{"kind":"node_finished","nodeId":"x-y@m:0","output":"[mock:m] TOP","renderedPrompt":"TOP", ...}
{"kind":"node_finished","nodeId":"x_y",    "output":"[mock:m] TOP","renderedPrompt":"TOP", ...}
```

Exit 0, no warning, no stderr. The body node rendered `TOP` instead of `BODY x`. The interpreter
runs the same graph correctly (it keys everything by the real node id), so this is a pure
compiler-side divergence that produces plausible-looking wrong output.

Additionally, on *any* collision the `rt.finish({ ... })` object literal gets duplicate keys too,
so a colliding terminal node silently drops out of the run's reported outputs.

### 1.3 The `bodyResult` sub-question — checked, nothing to do

`emitName` returns the fixed literal `"bodyResult"` for a region's terminal node. No ordinary node
can ever claim that name: `varName` prefixes `n_` unconditionally, so every non-terminal name
starts `n_` and `bodyResult` does not. Same reasoning covers the other generated identifiers in
scope (`rt`, `N`, `acc`, `item`, `i`/`i1`/`i2`, `state`, `emit`), and the `n_` prefix also
guarantees no generated name is ever a JS reserved word. **Verified, not assumed — no change
needed here.**

One coupling worth recording while in this code: `bindPort` (`:485`) resolves an edge's source with
`varName(edge.source)` while statements are named with `emitName`. These agree today only because a
region's terminal node has no outgoing in-region edge (that is the definition of terminal), so a
terminal never appears as an `edge.source` inside its own region. After this change both must
resolve through the same map — see §4.2.

---

## 2. The byte-identical constraint — resolved: it is not enforced anywhere

`FIX-COMPILER-VARNAME.md` §2 asks this to be settled first, because the answer changes the fix.
Settled:

- No snapshot mechanism is used anywhere in the repo. `toMatchSnapshot` / `toMatchInlineSnapshot`
  / `toMatchFileSnapshot`: zero hits across all packages. No `__snapshots__` directory exists.
- `packages/compiler/src/compile-graph.test.ts` has 2 tests, `compile-graph-control-flow.test.ts`
  has 6; every assertion in both is `expect(script).toContain("<one exact line>")`.
- The commit that introduced `bodyResult` (`e142909`, "Implement multi-node (subgraph) Loop/Map
  bodies") added 147 lines to `compile-graph-control-flow.test.ts` — all `toContain`.
- `PLAN-SUBGRAPH-BODIES.md` §6, which specified that slice's must-have tests, only ever asked for
  string-position and `toContain` assertions. It never asked for a whole-output pin.

So `CLAUDE.md`'s claim — "keep the pre-existing single-node-body compiled output byte-identical
(a real regression test asserts this)" — is **inaccurate as written**. What actually exists is a
set of exact-line `toContain` assertions that pin roughly a dozen individual emitted lines,
including the single-node-body shape (`compile-graph-control-flow.test.ts:61-72`). That is
meaningful protection, but it is not the whole-output guarantee the sentence describes.

**Consequences for this plan** (both, not either):

1. Correct that sentence in `CLAUDE.md` (§4.4).
2. Give the guarantee a real home as part of this change (§4.1). This fix is precisely the class of
   change the claimed test was meant to protect against — it rewrites the function every emitted
   identifier passes through — so it is the right moment to stop relying on a test that was never
   written.

The recommended fix below satisfies the strict reading regardless, so nothing about the approach
hinges on this.

---

## 3. Locked decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | **Disambiguate on collision; do not reject colliding ids at compile time.** | The FIX doc's "rejecting turns a previously working flow into a hard failure" worry does not apply — §1.2 proves such a flow is *already* broken, so rejecting protects nothing. But a flow with `fetch-page` and `fetch_page` is perfectly legal, runs correctly in the interpreter, and there is no user-facing reason it should be unexportable. Disambiguation costs ~25 lines. |
| D2 | **Do not add this check to `validateGraph`.** | `validateGraph` (`@flowlathe/core`'s `regions.ts`) gates the *interpreter* too — `GraphEngine`'s constructor, every step-mode restore, and `/run` + `/step-start`'s 409. Putting a compiler-namespacing concern there would refuse to *run* a graph that runs fine, for an export-only reason. This stays inside `@flowlathe/compiler`. |
| D3 | **One name map, built globally over `graph.nodes` — not per region.** | The `N` spec table is a single global object literal, and `specExpr` indexes it from every region at every nesting depth. A per-region map would leave failure shape (c) — the silent one — completely unfixed. |
| D4 | **Order-independent assignment: when a base name has ≥2 claimants, *every* claimant gets a suffix.** No "first one keeps the plain name." | Makes the emitted names a function of the *set* of node ids only. A "first wins" scheme makes names depend on `graph.nodes` array order, so a canvas drag or a DSL reformat that reorders nodes would churn every downstream name in the diff. |
| D5 | **Suffix is a truncated hash of the full node id, not an ordinal.** | Same reasoning as D4 (an ordinal reintroduces order-dependence), and it keeps a given node's name stable when an *unrelated* node joins or leaves its collision set. Per the FIX doc's own recommendation. |
| D6 | **`node:crypto` is acceptable in `@flowlathe/compiler`.** | Verified: `packages/web` does not import `@flowlathe/compiler` (grep is empty), and nothing in `core`/`web`'s transitive source graph reaches it. The consumers are `@flowlathe/cli`, `packages/server`, `packages/testing` — all Node. This is *not* an exception to CLAUDE.md's isomorphic rule, which is scoped to `@flowlathe/core`; state that explicitly in the code comment so the next reader doesn't "fix" it. |
| D7 | **`bodyResult` and `emitName`'s two-tier naming stay exactly as they are.** | Verified safe (§1.3). Changing it would churn output for no reason. |
| D8 | **`adapterCtor`'s identical `.replace(/[^a-zA-Z0-9_]/g,"_")` on `providerId` (`:571`) is out of scope, but recorded.** | Providers `open-ai` and `open_ai` collide onto one `FLOWLATHE_APIKEY_OPEN_AI` env var. Genuinely a different bug: the output is an operator-facing env var name, not a program identifier, so it degrades to "wrong key used" rather than "wrong node executed"; and provider ids come from a small operator-curated set, not from flow authors. Note it in `CLAUDE.md` so the next audit doesn't re-file it as new. |

---

## 4. Implementation

Four phases. **Phase 1 goes first, before `compile-graph.ts` is touched at all** — it is the net
that catches an accidental output change in phases 2–3.

### 4.1 Phase 1 — pin the current output (before any behavior change)

Add a whole-output regression test for two representative non-colliding graphs, capturing the
compiler's output **as it is today**:

- the single-node Map body from `compile-graph-control-flow.test.ts:46-72` — this is the exact
  shape CLAUDE.md's byte-identical claim is about;
- one router graph with hoisting and reconvergence (reuse `router-nested`'s graph from
  `packages/testing/src/golden/router-nested.ts`, or the local fixture at
  `compile-graph-control-flow.test.ts:129-180`), which exercises `emitScope`, the `let` pre-pass,
  and `?.` accessors.

Mechanism: `await expect(script).toMatchFileSnapshot("./__snapshots__/<name>.ts.snap")`. Vitest
5.0.0 supports it and it creates the file on first run and updates with `-u`.

**This introduces snapshot files as a new convention in this repo** (nothing currently uses them —
§2). If that is unwanted, the no-new-convention alternative is an explicitly checked-in expected
file plus `expect(script).toBe(readFileSync(path, "utf-8"))`; it costs a manual regeneration step
instead of `-u`. Pick one and be consistent; the plan assumes `toMatchFileSnapshot`.

Two graphs, not ten — a snapshot per shape becomes churn on every legitimate compiler change, and
the existing `toContain` assertions already cover the shape-specific details.

Run the suite, commit the generated snapshots, and confirm they are green *before* phase 2. Their
whole job is to be diffed by the next phase.

### 4.2 Phase 2 — build the map, thread it, delete the free function

**New, in `compile-graph.ts`:**

```ts
/** Generated identifiers for a graph's nodes: injective, deterministic, and independent of
 *  `graph.nodes` order. `n_<sanitized id>` maps many distinct ids onto one name (`a-b`, `a.b`
 *  and `a_b` all sanitize to `n_a_b`), which silently produced a duplicate key in the global
 *  spec table `N` — last-wins, so a node ran with another node's spec — see
 *  PLAN-COMPILER-VARNAME.md. Every id whose sanitized base is claimed by more than one node
 *  gets a hash suffix; a base claimed by exactly one node is left alone, so a graph with no
 *  collision compiles to byte-identical output as before.
 *
 *  node:crypto is fine here: @flowlathe/compiler is Node-only (cli, server, testing), never
 *  bundled for the browser. CLAUDE.md's no-node:*-imports rule is scoped to @flowlathe/core. */
function buildVarNames(nodes: FlowNode[]): Map<string, string>;
```

Shape:

1. `base(id) = "n_" + id.replace(/[^a-zA-Z0-9_]/g, "_")` — the current `varName` body, unchanged.
2. Group node ids by `base(id)`.
3. Base claimed once → that node gets `base`.
4. Base claimed ≥2 times → **every** claimant gets `` `${base}__${sha256(id).slice(0, 8)}` ``
   (double underscore, so the suffix reads as a suffix and so a real node literally named
   `a_b_1f2e3d4c` is less likely to be in the way).
5. After building, assert the map's values are all distinct. If not — the only route is a node id
   that happens to equal another's generated disambiguated name — throw a compile error naming both
   ids. This converts an astronomically unlikely residual into a loud, actionable failure rather
   than the silent wrongness this whole plan exists to remove. Do not skip it; it is three lines.

**Thread it, don't recompute it.** Add `varNames: Map<string, string>` to `RegionCtx`
(`:64-82`), set by `buildRegionCtx`, and pass `ctx.varNames` straight through when `emitLoopOrMap`
(`:442`) builds a child region's ctx. Then replace every `varName(...)` call and delete the free
function so there is exactly one source of truth. All six call sites, verified:

| Line | Site | Note |
|------|------|------|
| `:110` | `N` spec table keys | in `compileGraph` itself — **the fix for failure shape (c)** |
| `:115` | `finishBindings` (twice: key and accessor arg) | in `compileGraph` itself |
| `:272` | `emitName`'s non-terminal branch | already has `ctx` |
| `:485` | `bindPort`'s edge-source accessor | already has `ctx`; see §1.3's coupling note |
| `:505` | `specExpr`, top-level branch (`N.<var>`) | already has `ctx` |
| `:506` | `specExpr`, in-body branch (`{ ...N.<var>, ... }`) | already has `ctx` |

`:110`/`:115` sit in `compileGraph`, where the map is a local — but resolve them through the same
single lookup (a local `const nameOf = (id: string) => varNames.get(id)!`) rather than reading the
map two different ways.

Nothing else changes. `emitName`, `bodyResult`, `scopedIdExpr`, `computeScopes`, `emitLevel`,
`emitScope`, `emitLoopOrMap` keep their current logic verbatim.

**Then re-run phase 1's snapshots.** They must be unchanged, with no `-u`. If a snapshot moved,
something in phase 2 is wrong — the sanitized base is identical to today's `varName` output for any
node whose base is unshared, which is every node in both pinned graphs.

### 4.3 Phase 3 — tests

**(a) The silent cross-region collision, as a golden parity fixture.**
`packages/testing/src/golden/colliding-ids.ts`, following the existing fixture shape (graph +
`Map` of `mockResponseKey(...)` responses), wired into `parity.test.ts`. Use the §1.2(c) shape:
a top-level prompt and a Map-body prompt whose ids collide, with *different* templates so the
wrong-spec substitution is visible in the trace. The parity harness compares interpreter output to
compiled-script output, which is exactly the signal that was missing — the audit's observation that
"the parity harness would only catch this if a fixture happened to use colliding ids" is the gap
being closed.

**Verify it fails against the pre-fix compiler before keeping it.** This repo's established
practice (`router-deep-branch` / `router-nested` were both checked this way — CLAUDE.md records
it), and it is cheap here: stash phase 2, run the fixture, record the observed mismatch, unstash.
The expected pre-fix failure is a trace mismatch on `renderedPrompt`, **not** a crash — a fixture
written with a same-region shape would fail with a `SyntaxError` instead, which also "fails" but
pins the loud case rather than the silent one. Getting this wrong makes the test look like it works
while leaving shape (c) uncovered.

**(b) The loud same-region collisions, as compiler unit tests.** Cheap, and they pin the two
`SyntaxError` shapes that a future refactor could reintroduce:
assert the emitted script contains two *different* identifiers for the two nodes, for both a
fan-out level and a sequential chain.

**(c) Order independence** (pins D4): compile a colliding graph, then compile the same graph with
`nodes` reversed, and assert the two scripts are identical strings. One `expect`, and it is the
only thing that stops a later "simplify" back to first-wins-plus-ordinal.

**(d) `bodyResult` non-collision** (§1.3): a body whose terminal node's id sanitizes toward
something adjacent, asserting the generated non-terminal names still all start `n_`. Optional —
the `n_` prefix makes this structurally impossible — include it only if it reads as documentation
rather than ceremony.

### 4.4 Phase 4 — docs

In `CLAUDE.md`, in the PLAN-SUBGRAPH-BODIES.md bullet block, amend the `bodyResult` entry: replace
"(a real regression test asserts this)" with an accurate statement of what enforces it — the
`toContain` line assertions in `compile-graph-control-flow.test.ts`, plus (now) the whole-output
snapshots from phase 1. Follow the same in-place stale-correction style the file already uses for
the `branches`/`snapshots` FK claim and the `ToolInvokeMeta.signal` comment.

Add a new bullet for this plan covering: the non-injective-`varName` failure (all three shapes,
with shape (c) called out as the silent one), D1–D6, the "map is global, never per-region" trap,
and D8's `adapterCtor` note.

---

## 5. Design traps

1. **Building the name map per region.** The most likely wrong turn, because `RegionCtx` is where
   the map gets threaded and `buildRegionCtx` is where it is tempting to build it. `N` is global;
   a per-region map leaves the silent failure shape entirely unfixed while making every loud one
   go away — i.e. it looks like a complete fix and is the exact opposite of one.
2. **First-claimant-keeps-the-plain-name.** Reintroduces order-dependence: reordering
   `graph.nodes` (a canvas edit, a DSL reformat) rewrites names across the diff. D4 exists for this;
   test (c) is what enforces it.
3. **Writing the collision fixture with a same-region shape.** It fails against the pre-fix
   compiler — with a `SyntaxError` — so the "verified to actually fail first" ritual passes while
   the silent case stays untested. §4.3(a).
4. **Leaving `bindPort` on a stale lookup.** It is the one call site that resolves a *different*
   node's name than the statement it sits in. Safe today only by the terminal-node argument in
   §1.3; if it and `emitName` ever read from different sources, that argument stops holding.
5. **Snapshot churn.** After phase 1, every legitimate compiler change needs `-u` and a reviewed
   snapshot diff. That is the intended cost — but it should be a deliberate choice, and phase 1's
   "two graphs, not ten" limit is what keeps it bearable.
6. **Reaching for `validateGraph`.** It is right there, it already walks the graph, and it is the
   wrong place — D2.

---

## 6. Definition of done

- [ ] Whole-output snapshots for two non-colliding graphs, committed, green — and **unchanged**
      across the phase-2 rewrite with no `-u`. (This is the byte-identical guarantee finally
      having a home.)
- [ ] `varName` deleted; one `buildVarNames` map, built globally, threaded through `RegionCtx`,
      used by all six former call sites; residual-collision assertion in place.
- [ ] `colliding-ids` golden parity fixture green, and **recorded as verified to fail against the
      pre-fix compiler with a trace mismatch (not a crash)**.
- [ ] Compiler unit tests for both loud same-region shapes, plus the order-independence test.
- [ ] `CLAUDE.md`: the byte-identical sentence corrected to what actually enforces it; a new bullet
      for this plan including D8's `adapterCtor` note.
- [ ] `pnpm -w turbo typecheck test` green; root `e2e` green (no e2e change expected — this is
      export-path only, and no spec exercises `/export`).
