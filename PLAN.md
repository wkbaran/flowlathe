<!--
Handoff document. Written for an implementing agent picking this up cold.

How to use it:
- "Locked decisions" were settled with the project owner. Don't relitigate them.
- "Design traps" are known failure modes, several found by inspecting the Flowise
  reference implementation. Read that section before writing the interpreter.
- Build in slice order. Each slice ends runnable, tested, and e2e-green before the
  next begins. Slice 0's blob store and slice 1's parity harness are prerequisites
  for everything after them.
- Flowise at /home/bill/github/Flowise is a READ-ONLY reference. The "what to mine"
  section says what to lift and what to avoid; it has already been surveyed, so
  don't re-explore it broadly.
- Dependency versions were verified against the npm registry on 2026-09-05.
- Hardware figures were measured on the target machine, not assumed.
-->

# flowlathe — Implementation Plan

> A graphical builder and visual compiler for LLM workflows, built for local models.

## Context

There is no shortage of visual LLM workflow builders (Flowise, n8n, LangFlow), but they are built
around hosted frontier models where one call solves the whole problem. They treat concurrency as
"fire everything at once," and they treat the drawn graph as the only artifact.

**flowlathe** targets the opposite situation: a workstation with one or two GPUs running small local
models, where solving a frontier-grade problem means decomposing it into many small, individually
tractable steps. That reframing drives three things nothing else does well:

1. **Resource management is the product, not an afterthought.** With local models the binding
   constraint is VRAM and model-swap thrash, not API rate limits. A scheduler that batches queued
   work by model beats one that maximizes raw parallelism. (Surveyed: Flowise has *no* per-provider
   pool, *no* backpressure, and its AgentflowV2 interpreter drains one node at a time — it has no
   real node-level parallelism at all.)
2. **Debuggability at the step level.** Decomposition means many steps, so finding *which* step went
   wrong matters more than in a one-shot pipeline. Hence step / step-back with forked history, and
   conversation logs sliced both per-execution and per-node.
3. **The graph compiles to a script.** The canvas is for building and debugging; the exported
   TypeScript is the deterministic, version-controllable, hand-debuggable artifact you ship.

The repo is empty (one commit, empty README). This plan covers greenfield construction through the
first several vertical slices.

---

## Locked decisions

Settled in discussion; do not relitigate without cause.

| Decision | Choice | Why |
|---|---|---|
| Graph model | **Ports + declared State** | Edges carry immutable values port→port (race-free fan-out, visible lineage); named State handles accumulation, ambient values, and the LLM `read_state`/`write_state` tool |
| Compile target | **One-way TS export** | Graph is source of truth; generated script imports `@flowlathe/runtime`. No round-tripping |
| Context | **Immutable versioned message list** | Role-tagged (system/user/assistant/thinking/tool); each version links to parent + producing transform. Flat text rendered on demand |
| Step-back | **Snapshot per step, always re-run live** | User's explicit choice over replay-from-cache. Every call is still logged append-only, so an optional per-node "pin response" can be added later without rearchitecting |
| Deployment | **Local Node server + browser SPA** | Server owns SQLite, scheduler, all provider connections; SPA over HTTP + SSE |
| UI | **React 18 + MUI 9 + @xyflow/react 12 + Vite** | Lift patterns (not code) from Flowise's `packages/agentflow` |
| Ordering | **MCP and tool calling last** | Except the built-in `read_state`/`write_state` tool, which the State design needs early |

---

## Target hardware (measured on this machine)

Not hypothetical — this is the constraint the scheduler must satisfy:

- **RTX 3090, 24 GB VRAM.** Ollama on `:11434`, 19 models installed, none resident at rest.
- Most are **17–22 GB**: `qwen3.6:27b` 17.4, `gemma4:31b` 19.9, `ornith:35b` 21.2, `qwq:32b` 19.9.
  Plus small ones: `ornith:9b` 5.6, `minicpm5-1b` 0.7, `functiongemma` 0.3.

**Only one large model fits at a time.** Two 27B models cannot co-reside; a 27B + 9B (23.0 GB)
barely fits. So `maxParallel` — the only knob in the original domain notes, and the only one
Flowise-class systems offer — is *insufficient*. A fan-out across three large models would evict and
reload on every call and run **slower than sequential**. Ollama gives two levers we should use:
`GET /api/ps` reports real residency, and `keep_alive` controls eviction.

---

## What to mine from Flowise (`/home/bill/github/Flowise`)

Lift the *pattern*, not the code — most is JSX or coupled to LangChain.

**Worth copying:**
- `packages/agentflow/src/atoms/NodeInputHandler.tsx` — data-driven node input renderer switching on
  `inputParam.type`. Node UIs generated from metadata, not hand-written per node type. Also
  `StructuredOutputBuilder.tsx` for the structured-output editor.
- `packages/agentflow/src/core/validation/flowValidation.ts` — writes `data.validationErrors` back
  onto nodes for inline display.
- `packages/agentflow/src/features/canvas/components/NodeStatusIndicator.tsx` + `canvas.css`
  pulse/spin animations — the execution animation.
- `packages/observe/src/features/executions/` — closest existing thing to our log views.
- Credential AES-at-rest via `getCredentialData`/`getCredentialParam` (`packages/components/src/utils.ts`).
- `packages/components/nodes/tools/MCP/core.ts` — `MCPToolkit` with stdio/SSE/StreamableHTTP **and**
  its `sanitizeMCPToolName`/`sanitizeMCPToolDescription` injection blocklist. Keep the sanitization.
- `ChatOpenAICustom` — the OpenAI-compatible-base-URL pattern reaches LM Studio, llama.cpp, and vLLM
  with one adapter.

**Do not copy:**
- `buildAgentflow.ts` (2471-line single-file interpreter, no parallelism).
- `@langchain/langgraph@0.0.22` legacy path — badly outdated.
- Stringified-JSON-in-text-columns persistence.
- `packages/ui/**` — plain JSX, no TypeScript.
- `NodesPool.ts` filesystem auto-discovery — **use a static registry object instead**, so node kinds
  are type-checked and the editor bundle tree-shakes.
- `connectionValidation.ts` — it rejects *all* cycles at node granularity with no port typing. We
  need port-type compatibility instead (and we forbid cycles differently; see below).
- Untagged token streaming (client infers the active node from transitions). **Every event we emit
  carries `nodeId`.**

---

## The interpreter

The unit of scheduling is an **activation** — one instance of a node in one scope — not a node.
Scopes are what make Loop/Map iterations independent.

```ts
type PortRef     = `${NodeId}:${PortName}`
type ScopePath   = ReadonlyArray<{ loop: NodeId; index: number }>
type ActivationKey = string          // `judge@map:critique/3`

type PortSlot =
  | { kind: 'empty' }
  | { kind: 'value'; ref: BlobRef; producedBy: ActivationKey }
  | { kind: 'never'; reason: 'branch_not_taken' | 'upstream_skipped' | 'upstream_failed' }

interface Activation {
  key: ActivationKey; nodeId: NodeId; scope: ScopePath
  inputs: Map<PortName, PortSlot>
  status: 'waiting'|'ready'|'running'|'suspended'|'done'|'skipped'|'failed'|'cancelled'
}
```

**Readiness rule (the whole branch-pruning story).** An activation is `ready` when every *required*
input is `value` and every *optional* input is `value | never`. If any required input becomes
`never`, it goes straight to `skipped` and emits `never` on all its outputs.

`never` is a lattice value that only ever moves `empty → value|never`, so it propagates locally and
monotonically. That is correct under arbitrary parallelism and needs no global re-analysis — strictly
better than Flowise's `determineNodesToIgnore()` graph walk.

**Genuine parallelism** — the loop dispatches *all* ready activations:

```ts
while (ready.size || running.size || suspended.size) {
  if (mode === 'run') for (const a of drainReady()) running.add(dispatch(a))
  else                { const a = drainOneReady(); if (a) running.add(dispatch(a)) }
  await Promise.race([...running, controlSignal])   // control = cancel / resume / step
}
```

The interpreter is willing to have 50 activations in flight and **does not limit LLM concurrency** —
the provider scheduler does. Separating those two is the thing Flowise conflates.

**Loops: `Loop` and `Map` nodes only. Raw back-edges on the canvas are forbidden in v1** (editor
rejects with "use a Loop or Map node"). This is the highest-leverage constraint in the design: it
preserves the DAG-within-scope invariant that both the readiness lattice and structured codegen
depend on. `Map(items, body, {maxConcurrency, maxItems})` spawns child scopes with independent
activation keys; `Loop(init, {maxIterations})` threads an `acc_in`/`acc_out` accumulator plus a
`continue` port. Exceeding the cap raises a real `LoopLimitExceeded` surfaced on the canvas — not
Flowise's silent `MAX_LOOP_COUNT` stop.

**State under parallelism.** The store is a **serialized write log**, not a CRDT: each write appends
`{seq, entry, value, by: ActivationKey, viaTool}` folded by the entry's merge rule in arrival order.
Each read records `{entry, seqSeen}` on the activation, so the per-node log shows exactly what the
model saw. The LLM's `read_state`/`write_state` tools use the identical path with `viaTool: true` —
no second code path.

```ts
type MergeRule = 'replace' | 'append' | 'numeric-add' | 'set-union' | 'error-on-conflict'
```

`append`/`numeric-add`/`set-union` are commutative, so parallel writes are safe. `replace` under
concurrent writers is genuinely nondeterministic: **static check** at edit time (warn if two
activations with no happens-before path both write a `replace` entry), **runtime** either
`StateWriteConflict` or logged last-write-wins. Making the user pick a merge rule per entry *is* the
feature — don't pretend arbitrary values can be merged.

**Snapshots.** A step advances to the next quiescence boundary: snapshot, dispatch exactly one ready
activation (deterministic order: topological rank, then node id), await. You cannot snapshot
mid-HTTP-call, so activation granularity is forced.

```ts
interface StepSnapshot {
  id; executionId; branchId; stepIndex; parentSnapshotId?
  activations: SerializedActivation[]        // slots hold BlobRefs, never inline text
  state: { entry; valueRef: BlobRef; seq }[]
  contextHeads: Record<ChannelId, ContextVersionId>
  scopeCounters: Record<string, number>
  readyKeys: string[]; runningKeys: string[] // running -> restored as ready (re-run live)
  suspended: { activationKey; reason: SuspendReason }[]
  seed: string; wallClockOffsetMs: number
}
```

Snapshots are kilobytes of refs **because everything is content-addressed**. Without that, per-step
snapshots are unaffordable and the debugging model collapses — so build blobs first.

**Forking.** Step-back to snapshot `S` creates `branch{parent_branch_id, forked_from_snapshot_id: S}`
and restores from `S`; the old branch is retained, never truncated. Consequences: every `response`,
`step`, and `state_write` row carries `branch_id`; per-node logs must be queryable both "this node on
this branch" and "this node across all branches" (recursive CTE up `branches.parent_branch_id`); and
step-back must `abort()` in-flight provider calls on the abandoned tip.

**Suspension unifies Pause and User Input.** A handler returns
`{kind:'suspend', reason:{type:'user_input'|'pause', ...}}`. That activation suspends while **other
branches keep running**; when `running` empties and only `suspended` remains, persist a snapshot with
`status='awaiting_input'` and exit. Resume injects the answer as the activation's output. Pause,
human-in-the-loop, and approvals are one mechanism, and run/step/suspend are one loop with different
stopping conditions — not three code paths.

---

## The scheduler (the differentiator)

```ts
interface CallTicket {
  id; executionId; branchId; activationKey
  providerId; modelId                    // modelKey = `${providerId}/${modelId}`
  priority: 'interactive' | 'normal' | 'bulk'
  estTokens?: number; signal: AbortSignal; enqueuedAt: number
}
interface ProviderLimits {
  maxParallel: number
  rpm?: number; tpm?: number             // cloud
  swapCostMs?: number                    // > 0 => local, swaps expensive
  residentModels?: number                // default 1
  maxQueue?: number                      // default 512
}
```

**Layer 1 — gates.** Per-provider `Semaphore(maxParallel)` plus optional `TokenBucket(rpm)` /
`TokenBucket(tpm)`. Cloud rate limits are the *same* abstraction as local parallelism limits, just
more gates.

**Layer 2 — model-affinity batching**, active only when `swapCostMs > 0`. One FIFO sub-queue per
`modelKey`, selected by score:

```
score(q) = (q.model ∈ resident ? RESIDENT_BONUS : 0)
         + PRIORITY_W[q.head.priority]
         + min(ageMs(q.head) / STARVATION_MS, 1) * AGE_W
```

Serve the winning queue for a **quantum** (default 8 calls) before re-scoring. Switch early if the
resident queue empties, or an `interactive` ticket arrives for another model with nothing pending for
the resident one. Before switching: drain in-flight, emit a `model_swap` event, optionally warm up
with `keep_alive` so the swap cost is paid once and is *visible in the UI*.

**v1 constants:** `residentModels=1`, `quantum=8`, `STARVATION_MS=20_000`, `RESIDENT_BONUS=6`,
`AGE_W=4`, `PRIORITY_W={interactive:+10, normal:0, bulk:-3}`.

The tradeoff is explicit and tunable: `RESIDENT_BONUS ≈ swapCostMs / avgCallMs` — only swap when
waiting work outweighs the swap. Raise it for throughput, raise `AGE_W` for fairness.
`PRIORITY_W.interactive` deliberately exceeds `RESIDENT_BONUS` so step-debug work forces a swap.

**Preemption is queue-head only.** You cannot preempt an in-flight generation without destroying
work: an interactive ticket jumps the line and triggers a swap, but waits for the current call to
finish. Escape hatch: run Ollama with `OLLAMA_NUM_PARALLEL≥2` and `maxParallel=2` so an interactive
call can slot alongside bulk work. Don't promise latency you can't deliver on one GPU.

**Admission** is a bounded queue; overflow rejects with `QueueFull` as a visible node error rather
than an invisible hang. `Map`'s `maxConcurrency` throttles at the source.

**Retry** classifies failures: `RateLimited` (honor `Retry-After`, else full-jitter backoff; not a
node failure), `Transient` (5xx/ECONNRESET, ≤3 attempts), `Fatal` (auth/400/schema, no retry).
Retries re-enter at the front of their model queue with the **original `enqueuedAt`** so they keep
age credit. Per-provider circuit breaker: N consecutive fatals → open 30 s.

**Expose the queue in the UI** — depth, `wait_ms` p50/p95, `swap_count`, `tokens_per_s` per modelKey.
This scheduler is the differentiator; hiding it wastes it.

---

## Compiler / interpreter parity

**Exactly one implementation of every semantic.** `@flowlathe/runtime` exposes node *operations*; the
interpreter is a graph walker that calls them, and generated code calls the same functions with
control flow unrolled at compile time.

```ts
export function createRun(opts: { host: RuntimeHost; stateDecls: StateDecl[] }): Run

export interface Run {
  readonly state: StateStore                       // merge rules live HERE
  prompt<T>(spec: PromptSpec, inputs: Record<string, unknown>): Promise<PromptResult<T>>
  route(spec: RouterSpec, inputs): Promise<string>
  userInput(spec: UserInputSpec, inputs): Promise<string>
  pause(spec: PauseSpec): Promise<void>
  map<T,R>(items: T[], o: {concurrency: number}, body: (x: T, i: number) => Promise<R>): Promise<R[]>
  loop<A>(init: A, o: {maxIterations: number},
          body: (acc: A, i: number) => Promise<{acc: A; continue: boolean}>): Promise<A>
  transformContext(id: ContextVersionId, t: ContextTransform): Promise<ContextVersionId>
  skipped<T>(spec: NodeSpec): T | undefined        // codegen's `never`
  finish(outputs: Record<string, unknown>): void
}
interface RuntimeHost { scheduler; log; blobs; io; clock }
```

**The anti-drift device: `PromptSpec` is the node's serialized editor config, verbatim.** The
compiler emits it as `const N = {...} as const`. Template rendering, structured-output
parsing/repair, context transforms, and state merge all live inside runtime and are never
reimplemented. The compiler's job is *purely structural*: scheduling → syntax.

**Second anti-drift device, enforced by `tsc`:** `NodeKind` is a union, and both the interpreter
dispatch table and the codegen emitter table are `Record<NodeKind, …>`. Adding a node kind without
implementing both fails compilation — drift is caught before the tests run. Colocate node code as
`packages/nodes/<kind>/{schema,run,emit}.ts` to reinforce this.

```ts
// linear                                    // fan-out + join
const a = await rt.prompt(N.extract,   {…}); const [pros, cons] = await Promise.all([
const b = await rt.prompt(N.summarize, {…});   rt.prompt(N.pros, { topic }),
                                               rt.prompt(N.cons, { topic }),
                                             ]);
                                             const v = await rt.prompt(N.judge,
                                               { pros: pros.output, cons: cons.output });

// conditional — `never` becomes undefined + guard
const route = await rt.route(N.router, { q });
let draft: string | undefined;
if (route === 'code')       draft = (await rt.prompt(N.codeAnswer,  { q })).output;
else if (route === 'prose') draft = (await rt.prompt(N.proseAnswer, { q })).output;
const final = draft === undefined ? rt.skipped<string>(N.polish)
                                  : (await rt.prompt(N.polish, { draft })).output;

// loop with accumulator                     // state
const notes = await rt.loop<string[]>([],    await rt.state.write('findings', r.output);
  { maxIterations: 10 }, async (acc, i) => { const all = rt.state.read('findings');
    const r = await rt.prompt(N.critique,
      { draft, notes: acc.join('\n') });
    return { acc: [...acc, r.output.note],
             continue: !r.output.done };
  });
```

**Codegen algorithm.** Build the scope tree (Loop/Map regions); within each scope the graph is a DAG
(guaranteed by banning back-edges). Topologically sort, group into levels; nodes in a level with no
data dependency *and* no shared `replace` state-write become one `Promise.all`. Router regions become
`if/else` over the dominator-frontier subgraph; anything not cleanly nestable degrades to
`const x = cond ? await f() : undefined` guards. Keeping Router branches as explicit typed output
ports (rather than free-form conditions on edges) is what keeps every graph reducible.

**Parity testing (CI from slice 1):**
1. Golden corpus of ~20 flows, one per construct plus combinations.
2. Mock provider with a deterministic response table keyed by
   `(nodeId, scopeIndex, sha256(renderedPrompt))` — so a template-rendering regression surfaces as a
   *missing key*, not a silently different answer.
3. Per flow: run via interpreter; separately `tsc` + execute the emitted script; diff a **normalized
   trace** `{nodeId, scope, renderedPrompt, output, stateWrites}` with concurrent siblings
   canonically sorted and ids/timestamps stripped.
4. Fuzz: random-DAG generator → both paths → diff.

---

## Package layout

pnpm workspaces + turbo 2.10. Versions verified against the registry today.

```
packages/
  core/         graph, ports, values, NodeKind union, zod 4 schemas — zero I/O
  runtime/      @flowlathe/runtime: Run, ops, state, context, templating, structured output
  nodes/<kind>/ schema.ts | run.ts | emit.ts     <-- colocation is the biggest anti-drift move
  providers/    adapters (mock, ollama, openai-compat) + ProviderScheduler + token buckets
  interpreter/  activations, readiness lattice, snapshots, suspension, branch forking
  compiler/     graph -> TS emitter
  persistence/  drizzle-orm 0.45 + better-sqlite3 13, migrations, repositories
  server/       fastify 5, REST + SSE; owns SQLite, scheduler, provider connections
  web/          React 18 + MUI 9 + @xyflow/react 12.11 + Vite
  testing/      mock provider, golden flows, parity harness
playwright/     e2e suite (global playwright 1.54.2; browsers already cached)
```

Test runner **vitest 5**. `core`, `runtime`, `nodes`, `providers`, `interpreter`, and `compiler` stay
free of server/DB imports, so they unit-test headlessly and a generated script runs with no flowlathe
server present.

**ORM: Drizzle + better-sqlite3.** SQL-first (you will write recursive CTEs for branch and context
trees, which Prisma makes painful), no codegen daemon, negligible runtime. Sync `better-sqlite3` is
correct for a local server. Set `journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`.

---

## Persistence schema

```
flows(id, name, created_at, updated_at)
flow_versions(id, flow_id, version, graph_json, created_at)
providers(id, name, kind, base_url, secret_enc, max_parallel, rpm, tpm,
          swap_cost_ms, resident_models)
models(id, provider_id, model_name, context_window, defaults_json)

executions(id, flow_version_id, status, mode, root_branch_id, started_at, ended_at, error_json)
branches(id, execution_id, parent_branch_id, forked_from_snapshot_id, label, created_at)
steps(id, branch_id, step_index, activation_key, node_id, scope_json, status,
      started_at, ended_at)                                UNIQUE(branch_id, step_index)
snapshots(id, branch_id, step_index, parent_snapshot_id, payload_json, size_bytes, created_at)

blobs(sha256 PK, bytes, byte_len, encoding, refcount)

messages(id, role, content_sha -> blobs, token_count, meta_json)
contexts(id, execution_id, parent_context_id, transform_call_id, message_count, created_at)
context_messages(context_id, ord, message_id)              PRIMARY KEY(context_id, ord)
context_transform_calls(id, source_context_id, result_context_id, transform_kind,
                        params_json, model_id, response_id, created_at)

responses(id, execution_id, branch_id, step_id, node_id, model_id, request_context_id,
          rendered_prompt_sha, thinking_sha, content_sha, structured_json, finish_reason,
          prompt_tokens, completion_tokens, latency_ms, queue_wait_ms, created_at, error_json)
tool_calls(id, response_id, tool_name, args_json, result_sha, error_json, started_at, ended_at)

state_decls(flow_version_id, name, type_json, merge, initial_json)
state_writes(id, branch_id, step_id, entry, value_sha, merge_applied, seq, created_at)
state_reads(id, branch_id, step_id, entry, seq_seen)

run_events(id, execution_id, branch_id, seq, kind, payload_json, at)   -- append-only SSE journal
```

**Contexts never duplicate text.** Messages are content-addressed and immutable; a context *version*
is just an ordered list of message ids. A `drop-all-before(12)` transform creates a new context
sharing ~90% of message rows — three-integer rows — while the text exists exactly once in `blobs`.
Lineage lives in `contexts.parent_context_id` + `context_transform_calls`, so both the version tree
and "which model performed this compaction" are queryable. (Rejected: delta/linked-list encoding —
saves a few thousand tiny rows at the cost of an O(depth) walk per render.)

**SSE.** One stream `/api/executions/:id/events`. Every event carries
`{seq, kind, executionId, branchId, nodeId, activationKey}` — **including every `token` event**, the
explicit fix for Flowise's weakness. Kinds: `run_started, step_started, node_started, token,
node_finished, node_skipped, node_suspended, state_write, queue_admitted, model_swap, branch_forked,
run_finished, error`. Reconnect via `Last-Event-ID`, replayed from `run_events`.

**Credentials.** AES-at-rest, key from env var or OS keychain. Secrets never leave the `server`
package and **never appear in generated scripts** — emit `process.env.OLLAMA_BASE_URL`-style
references instead.

---

## Vertical slices

Each slice ends runnable end-to-end with unit tests and a Playwright spec. Don't start a slice before
the prior one's e2e test is green.

**Slice 0 — Skeleton.** Monorepo, turbo, strict tsconfig, vitest, Fastify serving the Vite SPA,
SQLite + drizzle migrations, **blob store**, empty canvas that saves/loads. Playwright: create a
workflow, reload, it persists.

**Slice 1 — Thin end-to-end chain.** Mock + Ollama providers; two `PromptNode`s wired
output→input with `{{input}}` templating; interpreter runs the chain; SSE streams `nodeId`-tagged
tokens; canvas animates status; execution log and per-node log views; compiler emits a script that
runs standalone against the mock. **The parity harness lands here.** Playwright: draw two nodes,
connect, run, assert animation + logs + export.
*This slice must exercise every architectural seam while they're still cheap to change.*

**Slice 2 — Providers, models, secrets, scheduler.** Provider/Model CRUD, encrypted credentials,
`openai-compat` adapter, and the affinity-batching scheduler with a live queue/residency panel.
Policy unit-tested against a **simulated clock** — no GPU required.

**Slice 3 — Parallelism, branching, loops.** Fan-out/join, `RouterNode` with `never` propagation,
`Merge` node, `Loop`/`Map`, `PauseNode`, `UserInputNode` suspend/resume. Playwright: a 3-way mock
fan-out completes concurrently and joins deterministically.

**Slice 4 — Step debugging.** Snapshot/restore, step, step-back-with-fork, branch tree sidebar,
per-branch logs. Playwright: run, step back, edit a prompt, step forward, assert a new branch exists
and the original is intact.

**Slice 5 — State and context transforms.** State declaration UI, merge rules, dashed lineage edges,
the built-in `read_state`/`write_state` tool, and all four context transforms (each able to run on a
different model than its owning node).

**Slice 6 — Tools and MCP** *(last, as specified)*. Embedded tool registry, then MCP client
(stdio/SSE/StreamableHTTP). **Port Flowise's tool-name/description sanitization** — an MCP server's
descriptions are untrusted text landing in a model's context.

---

## Verification

- **Unit** (vitest): graph validation, template rendering, context transforms, codegen snapshots,
  scheduler admission policy on a simulated clock.
- **Parity** — the important one. Every fixture flow runs through the interpreter *and* its compiled
  script against the mock provider; diff the normalized trace. Worth more than the rest of the suite.
- **E2E** (`playwright/`): every slice adds a spec, all against the mock provider — deterministic, no
  GPU.
- **Manual smoke on real hardware**: fan-out across `qwen3.6:27b` and `ornith:9b`, asserting via
  `/api/ps` that the scheduler doesn't thrash residency.

## Design traps

1. **Banning raw back-edges is load-bearing.** Relax it later and structured codegen degrades to a
   state machine — readability, a stated product goal, dies with it.
2. **Content-addressed blobs must exist before snapshots.** Retrofitting after inlining values is a
   painful migration. Build them in slice 0.
3. **`replace` state + fan-out** is the sharpest user-facing footgun. Static warning at edit time plus
   a runtime conflict error — never silent last-write-wins.
4. **Router-diamond joins silently skip.** Users will draw a diamond after a Router and expect it to
   run; with strict-join semantics it becomes `skipped`. Lint at edit time ("unreachable — insert a
   Merge node") and consider auto-applying Merge semantics when a node's required inputs trace to
   sibling Router branches.
5. **Preemption is queue-head only.** Don't promise interactive latency a single GPU can't deliver.
6. **Ollama residency drifts** — models unload on `keep_alive` expiry. Poll `/api/ps` and treat
   residency as a hint, not truth.
7. **Untagged stream tokens.** Every event carries `nodeId` from slice 1.
8. **Non-deterministic e2e.** The mock provider keys on the rendered-prompt hash so template
   regressions surface as missing keys.

## First files to create

`packages/core/src/graph.ts` → `packages/persistence/src/schema.ts` (blobs first) →
`packages/runtime/src/run.ts` → `packages/providers/src/provider-scheduler.ts` →
`packages/interpreter/src/scheduler.ts`
