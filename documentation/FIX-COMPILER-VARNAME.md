# FIX-COMPILER-VARNAME — generated variable names can collide silently

Status: not started. Own session. Small, but constrained by output stability.

Source: security/bug audit, finding #12.

## 1. The bug

`packages/compiler/src/compile-graph.ts:567`:

```ts
function varName(nodeId: string): string {
  return `n_${nodeId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}
```

Every character outside `[a-zA-Z0-9_]` maps to `_`, so the mapping is not injective. Node ids
`a-b`, `a.b`, `a b`, and `a_b` all produce `n_a_b`.

Node ids are arbitrary strings: `FlowNodeSchema.id` is only `z.string().min(1)`
(`packages/core/src/graph.ts:11`), and the DSL lets an author write whatever id they like. Two
distinct nodes sharing one generated variable means the compiled script silently produces wrong
output — the second `const`/`let` either shadows the first or is a duplicate declaration,
depending on where they land relative to each other and to the hoisting pre-pass.

No error is raised at any point. The interpreter is unaffected (it keys everything by the real
node id), so this is a compiler-only divergence that the parity harness would only catch if a
fixture happened to use colliding ids — none does.

There is a related, narrower case worth checking at the same time: `emitName` returns the fixed
literal `"bodyResult"` for a region's terminal node. Confirm no ordinary node can ever be assigned
that same name (it shouldn't be, since every other name is `n_`-prefixed, but verify rather than
assume).

## 2. The constraint that shapes the fix

`CLAUDE.md` states that keeping the pre-existing single-node-body compiled output **byte-identical**
was a deliberate requirement, and that "a real regression test asserts this."

I could not find that test — grepping `packages/compiler/src/*.test.ts` for `byte-identical`,
`identical`, or `toMatchInlineSnapshot` returns nothing, and `compile-graph.test.ts`'s visible test
names are behavioural ("emits a script for a two-node chain that awaits sequentially", "emits a
`Promise.all` for a fan-out level").

**First task: establish whether that guarantee is actually enforced anywhere.** The answer changes
the fix:

- If it *is* enforced somewhere, the fix must not change output for any non-colliding graph.
- If it is *not* enforced, `CLAUDE.md` is inaccurate and should be corrected, and you have more
  freedom — though preserving existing output is still the conservative choice.

Either way, the recommended approach satisfies the stricter reading.

## 3. Recommended fix

Disambiguate **only on collision**, so every graph without colliding ids compiles to byte-identical
output as before:

1. Build the `nodeId -> varName` map once, up front, over the region's nodes in a deterministic
   order (topological order is already computed; use it or plain graph order, but fix it).
2. On a collision, append a short deterministic suffix — a truncated hash of the full node id is
   better than an ordinal, because an ordinal makes the name depend on iteration order and turns
   an unrelated graph edit into a diff in every downstream name.
3. Thread the map through `RegionCtx` rather than recomputing `varName(id)` at each call site, so
   there is exactly one source of truth. Note `varName` is currently called from several places
   including `emitName`; find them all.

Alternative worth considering if the byte-identical constraint turns out not to exist: reject
colliding ids at compile time with a clear error. Cheaper and safer, but it turns a previously
"working" (silently wrong) flow into a hard failure — which is arguably correct, but is a
behaviour change for any user who has such a graph today.

## 4. Definition of done

- A test with two nodes whose ids collide under the old mapping, asserting the compiled script
  runs and produces both nodes' outputs correctly — verified to fail against the pre-fix compiler.
- A test asserting output is unchanged for a non-colliding graph (which also finally gives the
  byte-identical guarantee a real home, if it turns out not to have one).
- `CLAUDE.md` corrected if the byte-identical regression test does not in fact exist.
