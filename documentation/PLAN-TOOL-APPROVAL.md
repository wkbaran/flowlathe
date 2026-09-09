# PLAN-TOOL-APPROVAL — an optional, generic human-in-the-loop gate for tool calls

Companion to `PLAN-SHELL-TOOL.md` and `PLAN-FILE-TOOL.md`, both of which defer "human-in-the-loop
approval" in their own §8 citing the same limitation this plan removes. Read both first — this
plan changes nothing about their allow/deny+sandbox design, which remains the permanent default
security boundary. This is a temporary, opt-in bootstrapping aid layered on top of it.

> **Amended by `PLAN-DOMAIN-TOOLS.md` (§8).** Per-tool-name gating, deferred in §7 below, is now
> in scope and should land with this plan rather than after it — a domain toolset's tools differ
> enormously in consequence (`git_status` vs. `git_push`), and gating a whole toolset to catch one
> dangerous tool produces exactly the approval fatigue this gate is supposed to prevent. See §7's
> first bullet for the (small) change. Nothing else in this plan is affected.

---

## 1. Problem

flowlathe's answer to "should a tool call be allowed" is, and remains, allowlists + sanitization +
sandboxing (PLAN-SHELL-TOOL.md, PLAN-FILE-TOOL.md) — decided once, structurally, at boot. What
that design cannot offer is a *transitional* mode: an operator who has just turned on the shell or
fs toolset for the first time may reasonably want to watch and approve every call for a while
before trusting the allow/deny rules alone. Today there is no way to do that at all — a tool
handler cannot reach `host.suspend`, only `{activationKey, signal}` (`ToolInvokeMeta`).

This plan adds exactly one thing: an optional gate that pauses a tool call for a human decision,
built entirely from existing generic machinery (`ctx.suspend`/`createSuspendRegistry`/
`POST /api/executions/:id/resume`/Canvas's suspended-activation panel). It must:

- default off, with zero runtime cost when off;
- work for any toolset, so it is not duplicated per plugin;
- never become a substitute for allow/deny/sandboxing — it is documented as a bootstrapping and
  debugging aid, nothing else;
- leave `createToolRegistry` and the compiled/standalone script path (`compile-graph.ts`) entirely
  untouched.

### 1.1 Facts that shape the design

Verified directly against the current code before writing anything below (not inferred):

1. **A tool call's `activationKey` is shared, not per-call.** `packages/nodes/prompt/src/run.ts`'s
   tool loop invokes every call in a round with `Promise.all(result.toolCalls.map((call) =>
   ctx.tools.invoke(call.name, call.args, { activationKey: spec.id, signal })))` — every call in
   that round carries the *same* `activationKey`. A suspend keyed by `activationKey` verbatim
   would collide across concurrent calls in one round. The suspend key must be synthesized per
   call.
2. **`node_suspended`'s `nodeId` and the later `node_finished`'s `nodeId` are the same string**
   for Pause/UserInput (`spec.id`, both scoped and unscoped) — that identity is what lets Canvas's
   `suspended` list clear itself on `node_finished` (`s.nodeId !== event.nodeId` filter). Reusing
   `meta.activationKey` verbatim as the gate's `nodeId` reproduces this for free.
3. **`createSuspendRegistry` rejects every pending suspend on run cancellation**, independent of
   the reason's contents (`suspend-registry.ts`'s `_reason` parameter is unused). No new code is
   needed for this to compose with PLAN-CANCELLATION.md.
4. **Every other per-execution setting (`pluginToolsets`) already flows** `index.ts` → `buildApp`
   options → route deps (`ExecutionRouteDeps`/`FlowRouteDeps`/`TriggerRegistryDeps`) →
   `runFlow`/`stepOnce` options → `buildHostAndRun` options — confirmed by grep across every touch
   point. The new setting reuses this exact pipeline, including the one other `runFlow` call site
   (`triggers/registry.ts`, the Discord-triggered run).
5. **`createToolRegistry` and `compile-graph.ts`'s emitted script never change.** The gate is
   layered on top of the *built* registry, only inside `host-builder.ts` — a compiled, server-less
   script structurally cannot be gated, and isn't meant to be (there is no human in that loop).
6. **`@flowlathe/runtime` must not depend on `@flowlathe/plugin-common`** (locked precedent,
   CLAUDE.md: plugin-common is a helper library *for* plugins, not for what plugins plug into).
   `toolOk`/`toolFail` live there — a denial message must follow `tool-registry.ts`'s own plain-
   string convention instead (its unknown-tool case: `` `[${name}]: error - unknown tool` ``).
7. **`scrubUntrustedText`** (`packages/core/src/sanitize.ts`) strips hidden/control characters and
   flags injection phrasing with no length bound; **`sanitizeUntrustedText`** additionally bounds
   length. A caller owning its own truncation marker must scrub-then-truncate itself and never
   pass a `maxLength` to `sanitizeUntrustedText` (it would slice the marker back off) —
   established rule, reused here for the args preview.

---

## 2. Locked decisions

| # | Decision | Why |
|---|---|---|
| L1 | **Default off, zero cost when off.** `FLOWLATHE_TOOL_APPROVAL` unset or `off` ⇒ `resolveToolApprovalConfig` returns `undefined` ⇒ `host-builder.ts` returns the base `ToolRegistry` unwrapped — no extra indirection on the hot path. | The whole point: allow/deny+sandbox is permanent; this is optional and temporary. |
| L2 | **Generic over toolset, not per-plugin.** `FLOWLATHE_TOOL_APPROVAL` = `all` \| a comma-separated list of **toolset names** (`shell`, `fs`, `git`, `mcp:<server>`, …) **or individual tool names** (`git_push`, `github_create_pull_request`) — per `PLAN-DOMAIN-TOOLS.md` §8; a tool-name match is checked first. One decorator, no plugin-specific code. | Works for any current or future toolset without duplicating logic per plugin. The tool-name grain exists because a domain toolset's tools differ enormously in consequence, and gating all ten of `git`'s tools to catch `git_push` is how a gate becomes a rubber stamp. |
| L3 | **The suspend key is synthesized per call**: `` `${meta.activationKey}#tool-approval:${randomUUID()}` ``. | §1.1 fact 1 — `meta.activationKey` alone collides across concurrent tool calls in one round. |
| L4 | **The gate's `node_suspended.nodeId` is `meta.activationKey` verbatim** (the prompt node's own scoped id) — never a derived/stripped form. | §1.1 fact 2 — matches the identical string the node's own eventual `node_finished` carries, so Canvas's existing clear-on-finish logic keeps working with zero change to that mechanism. |
| L5 | **`args` reach the UI/log only as a pre-scrubbed, pre-truncated preview string** (`argsPreview: string`, ≤2,000 chars, via `scrubUntrustedText`), never as a raw `Record<string, unknown>`. | Args can carry untrusted text from an earlier tool result; this now reaches a persisted `RunEvent` and a human-facing render surface (bidi/zero-width spoofing of an approval prompt is the same attack class `scrubUntrustedText` already exists to stop, applied to a new surface). |
| L6 | **Resume convention is exact-match, trimmed, case-sensitive `"approve"` ⇒ proceed; anything else ⇒ deny.** No new route, no new schema — reuses `POST /api/executions/:id/resume`'s existing free-text `value: string`. | Fail-closed by construction; the Canvas UI only ever sends the two literals `"approve"`/`"deny"`, so ambiguity only matters for a manual `curl`. |
| L7 | **A denied call returns a plain string**, `` `[${name}]: denied - operator did not approve this call` ``, not a `toolOk`/`toolFail` envelope. | §1.1 fact 6. |
| L8 | **A cancellation rejection is not caught inside the decorator.** It propagates out of `invoke` exactly like a Pause/UserInput node's own `ctx.suspend` rejection does. | Catching it would misreport a run cancellation as an ordinary tool failure string; the enclosing node runner's own try/catch is where this is meant to become `node_cancelled`. |
| L9 | **`createToolRegistry` and `compile-graph.ts` are untouched.** The decorator wraps the registry only in `host-builder.ts`. | A compiled/standalone script has no host-builder and no human in the loop; it must be structurally unaffected. |
| L10 | **The gate is layered onto the merged registry (state + plugin toolsets), not per-toolset.** `host-builder.ts` builds one `toolsetOf: (name) => string \| undefined` map from the same `ToolRegistration[]` it already assembles, and wraps once. | One implementation, works for any toolset (including "state", if an operator chooses — unusual but not specially forbidden). |

---

## 3. Files

New:

```
packages/runtime/src/tool-approval.ts             # withToolApproval + GatedToolsets + ToolApprovalOptions
packages/runtime/src/tool-approval.test.ts

packages/server/src/tool-approval-config.ts       # resolveToolApprovalConfig + ToolApprovalConfig
packages/server/src/tool-approval-config.test.ts
```

Modified:

```
packages/core/src/activation.ts                   # third SuspendReason variant
packages/runtime/src/index.ts                      # export ./tool-approval.js
packages/server/src/host-builder.ts                # build toolsetOf map; wrap tools when configured
packages/server/src/index.ts                       # resolveToolApprovalConfig() once at boot; thread it
packages/server/src/app.ts                         # BuildAppOptions.toolApprovalConfig; thread to route deps
packages/server/src/executor.ts                    # RunFlowOptions.toolApprovalConfig
packages/server/src/stepper.ts                     # StepOnceOptions.toolApprovalConfig
packages/server/src/routes/executions.ts           # ExecutionRouteDeps.toolApprovalConfig -> stepOnce
packages/server/src/routes/flows.ts                # FlowRouteDeps.toolApprovalConfig -> runFlow
packages/server/src/triggers/registry.ts           # TriggerRegistryDeps.toolApprovalConfig -> runFlow
packages/server/src/executor.test.ts               # + one integration test (§5.3)
packages/web/src/pages/Canvas.tsx                  # SuspendedActivation.toolCall; render branch; optimistic clear
README.md                                          # Quickstart env doc + a short "bootstrapping, not a
                                                    #   substitute for §7 of PLAN-SHELL-TOOL" paragraph
CLAUDE.md                                          # §8 notes
documentation/PLAN-SHELL-TOOL.md                   # §8 bullet update (already applied — see that file)
documentation/PLAN-FILE-TOOL.md                    # §8 bullet update (already applied — see that file)
```

---

## 4. Implementation

### 4.1 — `packages/core/src/activation.ts`: the third `SuspendReason` variant

```ts
export type SuspendReason =
  | { type: "user_input"; prompt: string }
  | { type: "pause"; message?: string | undefined }
  | { type: "tool_approval"; toolName: string; argsPreview: string };
```

No other edit to `packages/core` is needed: `contracts.ts`'s `RunEvent`'s `node_suspended` variant
and `RuntimeHost.suspend`'s signature both already take `SuspendReason` generically.

Every exhaustive match on `SuspendReason.type` in the repo (checked via grep — there are exactly
these): `Canvas.tsx`'s live `node_suspended` handler (two ternaries today, becomes three, §4.6)
and `Canvas.tsx`'s `describeEvent` (already reads `event.reason.type` generically — needs no
edit). `createSuspendRegistry`'s `suspend` ignores the reason entirely (`_reason` is unused) and
needs no edit.

### 4.2 — `packages/runtime/src/tool-approval.ts`

```ts
import { randomUUID } from "node:crypto";
import { scrubUntrustedText, type RunEvent, type RuntimeHost, type ToolRegistry } from "@flowlathe/core";

/** "all" gates every toolset; a Set gates exactly the named toolsets (e.g. right after an
 *  operator turns on `shell`/`fs` for the first time). Toolset names, not tool names — matches
 *  the same grain `enabledToolsets`/`requiredToolsets` already use everywhere else. */
export type GatedToolsets = "all" | ReadonlySet<string>;

export interface ToolApprovalOptions {
  gatedToolsets: GatedToolsets;
  /** Resolves a tool name to the toolset that registered it. Built once in `host-builder.ts` from
   *  the same `ToolRegistration[]` it already assembles — this module never sees registrations
   *  directly, only this one function, so it stays free of any plugin-shaped knowledge. */
  toolsetOf: (toolName: string) => string | undefined;
  suspend: RuntimeHost["suspend"];
  emit: (event: RunEvent) => void;
}

const ARGS_PREVIEW_MAX_CHARS = 2_000;
const APPROVE_VALUE = "approve";

/** Scrub-then-truncate (never `sanitizeUntrustedText(text, maxLength)` — see
 *  PLAN-SANITIZATION-BOUNDARY.md's rule) because `args` can carry text produced by an earlier
 *  tool call; this reaches a persisted RunEvent and a browser render surface directly. */
function previewArgs(args: Record<string, unknown>): string {
  let json: string;
  try {
    json = JSON.stringify(args);
  } catch {
    json = "[arguments could not be serialized]";
  }
  const scrubbed = scrubUntrustedText(json, "tool approval args");
  return scrubbed.length > ARGS_PREVIEW_MAX_CHARS
    ? `${scrubbed.slice(0, ARGS_PREVIEW_MAX_CHARS)}\n[truncated ${scrubbed.length - ARGS_PREVIEW_MAX_CHARS} more chars]`
    : scrubbed;
}

function isGated(opts: ToolApprovalOptions, name: string): boolean {
  const toolset = opts.toolsetOf(name);
  if (toolset === undefined) return false; // unknown tool: let the base registry produce its own error
  return opts.gatedToolsets === "all" || opts.gatedToolsets.has(toolset);
}

/** Wraps only `invoke` — `specsFor`/`missingToolsets` pass straight through by reference, so a
 *  gated toolset is described to the model exactly as if it weren't gated, and every existing
 *  availability check (409 gates, `/api/plugins/status`, the workflow-dependency banner) is
 *  entirely unaffected. Pure; layered ONLY in `host-builder.ts`. `createToolRegistry` and the
 *  compiled/standalone script that calls it directly (no host-builder, no human) never see this. */
export function withToolApproval(registry: ToolRegistry, opts: ToolApprovalOptions): ToolRegistry {
  return {
    specsFor: registry.specsFor,
    missingToolsets: registry.missingToolsets,
    invoke: async (name, args, meta) => {
      if (!isGated(opts, name)) return registry.invoke(name, args, meta);

      // Per-call, not `meta.activationKey` verbatim: a prompt node's tool loop invokes every call
      // in a round concurrently (Promise.all in packages/nodes/prompt/src/run.ts) with the same
      // activationKey, and a bare reuse here would collide across them.
      const suspendKey = `${meta.activationKey}#tool-approval:${randomUUID()}`;
      const reason = { type: "tool_approval" as const, toolName: name, argsPreview: previewArgs(args) };
      // `nodeId` is `meta.activationKey` verbatim (the prompt node's own scoped id) — the same
      // string that node's eventual node_finished carries, so Canvas's existing "clear suspended
      // entries whose nodeId matches a finished node" logic keeps working unmodified.
      opts.emit({ kind: "node_suspended", nodeId: meta.activationKey, activationKey: suspendKey, reason });

      // Deliberately not caught here: on run cancellation this rejects (createSuspendRegistry
      // rejects every pending suspend on abort, independent of the reason), and that rejection
      // must propagate out of `invoke` as a real rejection — exactly like a Pause/UserInput
      // node's own `ctx.suspend` rejection does — so the enclosing node runner's try/catch turns
      // it into `node_cancelled`, not a swallowed "[name]: error - ..." string.
      const decision = await opts.suspend(suspendKey, reason);
      if (decision.trim() !== APPROVE_VALUE) {
        return `[${name}]: denied - operator did not approve this call`;
      }
      return registry.invoke(name, args, meta);
    },
  };
}
```

`packages/runtime/src/index.ts`: add `export * from "./tool-approval.js";`.

### 4.3 — `packages/server/src/tool-approval-config.ts`

Modeled directly on `allowed-hosts.ts`'s `resolveAllowedHosts` (same signature shape, same
pure/no-I/O style):

```ts
import type { GatedToolsets } from "@flowlathe/runtime";

export interface ToolApprovalConfig {
  gatedToolsets: GatedToolsets;
}

/** `FLOWLATHE_TOOL_APPROVAL` unset or "off" (case-insensitive) => undefined — the gate does not
 *  exist and `host-builder.ts` never wraps the tool registry (zero overhead, L1). "all" gates
 *  every toolset. Anything else is parsed as a comma-separated list of toolset names — the same
 *  grain a node's `enabledToolsets` already uses. This is a bootstrapping/debugging aid, not a
 *  security boundary: see PLAN-SHELL-TOOL.md §7 and PLAN-FILE-TOOL.md for the real one. */
export function resolveToolApprovalConfig(env: NodeJS.ProcessEnv = process.env): ToolApprovalConfig | undefined {
  const raw = env["FLOWLATHE_TOOL_APPROVAL"]?.trim();
  if (!raw || raw.toLowerCase() === "off") return undefined;
  if (raw.toLowerCase() === "all") return { gatedToolsets: "all" };

  const names = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (names.length === 0) {
    console.warn(`[tool-approval] FLOWLATHE_TOOL_APPROVAL="${raw}" named no toolsets — approval gate disabled`);
    return undefined;
  }
  return { gatedToolsets: new Set(names) };
}
```

### 4.4 — `packages/server/src/host-builder.ts`

```ts
import { createToolRegistry, withToolApproval, stateToolset, /* … */ } from "@flowlathe/runtime";
import type { ToolApprovalConfig } from "./tool-approval-config.js";

export function buildHostAndRun(opts: {
  // … unchanged fields …
  pluginToolsets?: ToolRegistration[] | undefined;
  /** Optional, opt-in tool-call approval gate — see PLAN-TOOL-APPROVAL.md. Undefined (the
   *  default) means every tool call runs immediately, exactly as before this plan; passing this
   *  adds one `withToolApproval` wrap and nothing else. */
  toolApprovalConfig?: ToolApprovalConfig | undefined;
}): BuiltHost {
  const { /* … */ toolApprovalConfig } = opts;
  // … cancellation / suspendRegistry / emit / hostEmit unchanged …

  const allRegistrations = [...stateToolset(state), ...(pluginToolsets ?? [])];
  const baseTools = createToolRegistry(allRegistrations);
  const tools = toolApprovalConfig
    ? withToolApproval(baseTools, {
        gatedToolsets: toolApprovalConfig.gatedToolsets,
        toolsetOf: (() => {
          const byName = new Map(allRegistrations.map((r) => [r.spec.name, r.toolset]));
          return (name: string) => byName.get(name);
        })(),
        suspend: suspendRegistry.suspend,
        emit: hostEmit,
      })
    : baseTools;

  const run = createRun({
    host: {
      // … unchanged …
      tools,
      // … unchanged …
    },
  });

  return { run, resolveSuspended: suspendRegistry.resolveSuspended, emit, cancellation };
}
```

Note `emit: hostEmit`, not the raw `emit` — this is what makes the existing `node_suspended`
branch inside `hostEmit` (`setExecutionStatus(db, executionId, "awaiting_input")`) fire for a
gated tool call with no code change to `hostEmit` itself; the branch is already generic over
`SuspendReason`'s contents.

### 4.5 — threading `toolApprovalConfig` through every existing call site

Mechanical, one field added at each layer, identical in shape to how `pluginToolsets` already
flows (confirmed by grep across all of these files):

- `packages/server/src/index.ts`: `const toolApprovalConfig = resolveToolApprovalConfig();` once,
  near the other boot-time config reads; pass it into `buildApp({ …, toolApprovalConfig })` and
  into `new TriggerRegistry({ …, toolApprovalConfig })`.
- `packages/server/src/app.ts`: `BuildAppOptions.toolApprovalConfig?: ToolApprovalConfig`; pass to
  `registerExecutionRoutes` and `registerFlowRoutes`'s deps.
- `packages/server/src/routes/executions.ts`: `ExecutionRouteDeps.toolApprovalConfig?`; pass into
  the `stepOnce({ …, toolApprovalConfig })` call inside `POST /api/executions/:id/step`.
- `packages/server/src/routes/flows.ts`: `FlowRouteDeps.toolApprovalConfig?`; pass into the
  `runFlow({ …, toolApprovalConfig })` call inside `POST /api/flows/:id/run`.
- `packages/server/src/executor.ts`: `RunFlowOptions.toolApprovalConfig?`; pass straight into
  `buildHostAndRun`.
- `packages/server/src/stepper.ts`: `StepOnceOptions.toolApprovalConfig?`; pass straight into
  `buildHostAndRun`.
- `packages/server/src/triggers/registry.ts`: `TriggerRegistryDeps.toolApprovalConfig?`; pass into
  the one `runFlow({ …, toolApprovalConfig: this.deps.toolApprovalConfig })` call site (the
  Discord-triggered run) — confirmed via grep to be the only other `runFlow` call in the repo. A
  headless trigger-initiated run is gated identically to a manual run; no special-casing.

`startStepExecution` (creates the initial snapshot only, no host) needs no change.

### 4.6 — `packages/web/src/pages/Canvas.tsx`

```ts
interface SuspendedActivation {
  activationKey: string;
  nodeId: string;
  prompt?: string | undefined;
  message?: string | undefined;
  toolCall?: { name: string; argsPreview: string } | undefined;
}
```

`node_suspended` handler — add one field to the existing object literal (~line 559-570):

```ts
setSuspended((prev) => [
  ...prev,
  {
    activationKey: e.activationKey,
    nodeId: e.nodeId,
    prompt: e.reason.type === "user_input" ? e.reason.prompt : undefined,
    message: e.reason.type === "pause" ? e.reason.message : undefined,
    toolCall: e.reason.type === "tool_approval" ? { name: e.reason.toolName, argsPreview: e.reason.argsPreview } : undefined,
  },
]);
```

`describeEvent` needs no change — it already reads `event.reason.type` generically.

`handleResume` (currently `async function handleResume(activationKey: string)`, line ~676) —
accept an explicit value (Approve/Deny send a literal; the existing free-text Resume button keeps
using `resumeDraft`), and clear the entry optimistically on success rather than waiting for a
`node_finished` that, for a gated tool call, may not arrive for a while (§4.7):

```ts
async function handleResume(activationKey: string, value?: string) {
  if (!executionId) return;
  await resumeExecution(executionId, activationKey, value ?? resumeDraft[activationKey] ?? "");
  setSuspended((prev) => prev.filter((s) => s.activationKey !== activationKey));
}
```

Render branch inside the existing `suspended.map(...)` (same `Paper`, no new component):

```tsx
{s.toolCall ? (
  <>
    <Typography variant="body2">
      Approve tool call <code>{s.toolCall.name}</code> from {s.nodeId}?
    </Typography>
    <Typography variant="caption" component="pre" sx={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
      {s.toolCall.argsPreview}
    </Typography>
    <Box sx={{ display: "flex", gap: 1, mt: 1 }}>
      <Button size="small" variant="contained" color="success" onClick={() => void handleResume(s.activationKey, "approve")}>
        Approve
      </Button>
      <Button size="small" variant="outlined" color="error" onClick={() => void handleResume(s.activationKey, "deny")}>
        Deny
      </Button>
    </Box>
  </>
) : (
  // existing prompt/message + TextField + Resume button, unchanged
)}
```

No new imports needed (`Typography`/`Box`/`Button`/`Paper` are already imported for the existing
panel).

### 4.7 — step-mode restore and a browser closed mid-approval (stated precisely, not guessed)

`GraphEngine.restore` does nothing special for a pending tool approval, and needs no change,
because a suspend of any kind (Pause, UserInput, or this one) is purely in-memory
(`createSuspendRegistry`'s local `Map`) and is never part of a persisted `EngineSnapshot` — a
snapshot only exists once a dispatch has *settled*. Two concrete scenarios:

- **The server process stays up, the browser closes.** The original `POST /step` HTTP request
  keeps its server-side `await engine.step()` parked exactly as it would for a Pause node; nothing
  aborts it just because the client vanished. Reopening the browser has no reconnect-and-replay
  path to that live execution today (`subscribeToExecution` is only invoked right after a fresh
  `handleRun`/`handleStep`) — this is a pre-existing gap identical for every suspend kind, not
  introduced by this plan.
- **The server process restarts while a node (of any kind) is suspended.** The in-flight
  `stepOnce` call and its `GraphEngine` instance are gone; the branch's latest *persisted* snapshot
  still shows that node as not-yet-settled. The next `POST /step` re-dispatches it from the start —
  for a Prompt node with a gated tool call, this replays the entire tool loop, potentially
  re-requesting approval for the same or a different call, since no state below "which nodes have
  settled" survives a restart. Identical in kind to what already happens to a UserInput node after
  a restart (it re-prompts).

---

## 5. Testing

### 5.1 `packages/runtime/src/tool-approval.test.ts`

Pure — a stub `ToolRegistry`, a stub `suspend` (`vi.fn` resolving/rejecting as directed), and a
`vi.fn` `emit`:

- an ungated tool name calls straight through to `registry.invoke`, no `emit`/`suspend` call
- an unknown tool name (not in `toolsetOf`'s map) calls straight through — never suspends
- a gated tool: `emit` is called once with `kind: "node_suspended"`, `nodeId` equal to
  `meta.activationKey` verbatim, `activationKey` matching
  `` `${meta.activationKey}#tool-approval:` `` plus a UUID, and `reason.type === "tool_approval"`
- `gatedToolsets: "all"` gates every registered name; a `Set` gates only its members
- `suspend` resolving with `"approve"` calls `registry.invoke` and returns its result
- `suspend` resolving with `"deny"`, `""`, `"Approve"` (wrong case), or `" approve "` un-trimmed-elsewhere
  all deny — pin the exact-match, trimmed, case-sensitive rule
- two concurrent calls to the same tool (same `meta.activationKey`) produce two distinct suspend
  keys — the collision case from §1.1 fact 1, asserted directly
- `suspend` rejecting (simulating cancellation) makes `invoke`'s returned promise reject with the
  same reason, not resolve with an error string — pins L8
- `argsPreview` is scrubbed and truncated at 2,000 chars with a trailing `[truncated N more chars]`
  marker for an oversized args object; a non-serializable arg (e.g. a circular reference) falls
  back to the literal `"[arguments could not be serialized]"` rather than throwing

### 5.2 `packages/server/src/tool-approval-config.test.ts`

- `{}` (no env) ⇒ `undefined`
- `FLOWLATHE_TOOL_APPROVAL=off` ⇒ `undefined`
- `FLOWLATHE_TOOL_APPROVAL=all` ⇒ `{ gatedToolsets: "all" }`
- `FLOWLATHE_TOOL_APPROVAL=shell,fs` ⇒ `{ gatedToolsets: new Set(["shell", "fs"]) }`, with
  whitespace around commas tolerated
- `FLOWLATHE_TOOL_APPROVAL=,,` ⇒ `undefined` + a `console.warn`

### 5.3 `packages/server/src/executor.test.ts` — one integration test through the real pipeline

Mirrors the existing `describe("runFlow — cancellation ...")` test's structure exactly. New fixture:

```ts
function toolApprovalGraph(): FlowGraph {
  return {
    nodes: [{
      id: "asks",
      type: "prompt",
      position: { x: 0, y: 0 },
      data: { template: 'CALL_TOOL: demo_tool {"x":1}', providerId: "mock", modelId: "m", enabledToolsets: ["demo"] },
    }],
    edges: [],
    state: [],
  };
}

const demoToolset: ToolRegistration[] = [{
  toolset: "demo",
  spec: { name: "demo_tool", description: "test", parameters: { type: "object", properties: {} } },
  handler: () => "demo_tool ran",
}];
```

Cases, each waiting on `hub.subscribe`/`listRunEventsSince` the same way the existing cancellation
test polls `getExecution(...).status`:

- with `toolApprovalConfig: { gatedToolsets: "all" }`: `runFlow` produces a `node_suspended` event
  with `reason.type === "tool_approval"`, `reason.toolName === "demo_tool"`, and execution status
  `"awaiting_input"`; calling `hub.resume(executionId, event.activationKey, "approve")` lets the
  run reach `"finished"`, and the finished output reflects `"demo_tool ran"` having actually run
- same setup, `hub.resume(..., "deny")`: the run still finishes (the model sees a denial string and
  the mock's `CALL_TOOL` marker doesn't re-fire on the follow-up round per `mock.ts`'s own
  suppression rule), and no side effect from the handler occurred
- `toolApprovalConfig: { gatedToolsets: new Set(["other"]) }` (not `"demo"`): the run finishes with
  no `node_suspended` event at all — confirms toolset-scoped gating, not blanket gating
- `toolApprovalConfig` omitted entirely: identical to today's behavior, no `node_suspended`
- cancelling the run while the tool-approval suspend is pending (same `control.cancel` pattern the
  existing failing-fan-out test exercises) resolves to `"failed"`/`node_cancelled`, not a hang —
  give this an explicit vitest timeout per the existing suite's own precedent for suspend-adjacent
  tests

### 5.4 Canvas / e2e

**No new Playwright spec** — consistent with every plugin-shaped slice in this repo per both
companion plans' testing sections. Coverage is the unit/integration suites above plus a manual
smoke test: set `FLOWLATHE_TOOL_APPROVAL=all` alongside `SHELL_TOOL_*`, run a flow whose prompt
node calls `shell_exec`, confirm the "Awaiting input" panel shows Approve/Deny with a scrubbed
args preview, and that Deny returns a plain string to the model instead of running the command.

---

## 6. Ordering

1. `packages/core/src/activation.ts`'s new variant; `pnpm -r typecheck` green (this alone forces
   every exhaustive switch to be revisited — there turn out to be none needing code changes beyond
   Canvas's two ternaries, per §4.1).
2. `packages/runtime/src/tool-approval.ts` + tests (§5.1) — pure, no server dependency.
3. `packages/server/src/tool-approval-config.ts` + tests (§5.2).
4. `host-builder.ts` wiring (§4.4), then the mechanical thread-through (§4.5) one file at a time,
   `pnpm -r typecheck` after each.
5. `executor.test.ts`'s integration test (§5.3) — the first point anything is actually exercised
   end to end.
6. Canvas.tsx (§4.6) — last, since it only needs the `reason.type` to already exist.
7. README + CLAUDE.md.

Steps 1–3 touch no existing behavior and are independently revertible.

---

## 7. Scope: deliberately not built

- ~~**Per-tool-name gating** (only per-toolset).~~ **Amended by `PLAN-DOMAIN-TOOLS.md` §8 — this
  is now in scope and should land with this plan, not after it.** The original reasoning was that
  a toolset is the grain every other availability concept uses (`enabledToolsets`,
  `requiredToolsets`, `missingToolsets`), which is still true — but it assumed the gated toolset
  would be `shell`, where every call is equally unbounded and per-toolset is therefore the only
  meaningful grain anyway. With domain toolsets that assumption fails in both directions:
  `git_status` and `git_push` are not remotely the same decision, nor are `github_get_issue` and
  `github_create_pull_request`. Gating a whole toolset to catch its one dangerous tool means
  approving a dozen harmless calls per run, which is how approval fatigue produces
  rubber-stamping — the gate then actively degrades safety rather than adding to it.

  The change is small and lands entirely inside this plan's existing shapes:
  `GatedToolsets` becomes `"all" | ReadonlySet<string>` where a member matching a **tool** name
  gates that tool and a member matching a **toolset** name gates all of its tools;
  `resolveToolApprovalConfig` needs no parsing change at all (it already splits a comma-separated
  list); `isGated` gains one `has(name)` check beside its existing `has(toolset)`. Ambiguity
  between the two namespaces is not a real risk — every tool name in this repo is prefixed with
  its toolset (`git_push`, `github_comment`, `read_state`) — but the union order matters, so
  document that a tool-name match is checked first and add a §5.1 case pinning
  `new Set(["git_push"])` gating only that one tool out of `git`'s ten.
- **A distinct "resumed" RunEvent / precise execution-status restoration.** Execution status can
  read `awaiting_input` longer than the real wait, since `hostEmit`'s `node_finished` branch is
  the only thing that flips status back to `"running"`, and after a tool approval resumes the
  gated node keeps computing (possibly making more calls) before its own `node_finished` fires.
  Fixing it needs a new RunEvent kind and a Canvas-side status-restoring branch — more than an
  optional debugging aid should cost. Documented as a known, accepted cosmetic gap.
- **Per-suspend-entry live removal from Canvas the moment its own resolver fires** (only the
  optimistic client-side removal added in §4.6, not a server-pushed "this one was resumed" event).
  Adequate because the operator who clicked Approve/Deny already knows the outcome.
- **Fixing the pre-existing "suspended panel entry never clears on node_cancelled/node_failed"
  Canvas gap.** Real, shared with Pause/UserInput today, out of scope for an approval-specific plan.
- **A reconnect-and-replay path for a browser closed mid-run.** Same, pre-existing, shared with
  every suspend kind.
- **Meaningfully closing the audit-trail deferral** in PLAN-SHELL-TOOL.md/PLAN-FILE-TOOL.md.
  `node_suspended` for a gated call is incidental, partial visibility only while gating is on for
  that toolset — not a real audit log. Those plans' audit-trail deferrals remain fully open.
- **Any change to `createToolRegistry`, `ToolInvokeMeta`, or `compile-graph.ts`.** The gate lives
  entirely in a decorator applied once, only in `host-builder.ts`.

---

## 8. `CLAUDE.md` notes (definition of done)

- **The approval gate is optional and temporary by design — it is not the security boundary.**
  Allow/deny + sanitization + sandboxing (PLAN-SHELL-TOOL.md, PLAN-FILE-TOOL.md) remain the
  permanent default; `FLOWLATHE_TOOL_APPROVAL` defaults off and costs nothing when off.
- **A tool call's `activationKey` is shared across every call in one round** (`Promise.all` in
  `packages/nodes/prompt/src/run.ts`) — any future code that suspends per tool call must
  synthesize its own key, never reuse `meta.activationKey` bare.
- **`args` reaching a human-facing surface (this gate's `node_suspended`, and any future one) must
  be scrub-then-truncated, never passed raw** — they can carry text an earlier tool call produced.
- **A pending tool-approval suspend rejects on cancellation via the exact same
  `createSuspendRegistry` path every other suspend already uses** — no cancellation-specific code
  exists or should exist in `withToolApproval`.
- **Execution status can lag "actually running again" after a tool approval resumes** — a known,
  accepted cosmetic gap (§7), not a hang; the underlying suspend/resume mechanics are correct.
- **This does not close the audit-trail deferral** both companion plans note — it is incidental,
  partial, and only present while gating happens to be on.

## 9. Definition of done

- [ ] `pnpm -r typecheck` and `pnpm test` green from the repo root.
- [ ] `packages/runtime/src/tool-approval.ts` exists with the tests in §5.1, including the
      concurrent-calls collision test and the cancellation-rejection test.
- [ ] `packages/server/src/tool-approval-config.ts` exists with the tests in §5.2.
- [ ] Per-tool-name gating works alongside per-toolset gating (§7 first bullet), with a §5.1 case
      pinning `new Set(["git_push"])` gating that tool alone and leaving its nine siblings ungated.
- [ ] `executor.test.ts`'s new integration test (§5.3) passes, covering approve, deny, toolset
      scoping, the omitted-config no-op case, and cancellation.
- [ ] With `FLOWLATHE_TOOL_APPROVAL` unset: behavior is byte-for-byte identical to before this
      plan (no `node_suspended` for any tool call, no new indirection).
- [ ] With `FLOWLATHE_TOOL_APPROVAL=all` or a toolset list: a real flow's tool call pauses, shows
      in Canvas with a scrubbed args preview and Approve/Deny buttons, and both outcomes behave as
      designed, verified manually against the running server.
- [ ] README documents `FLOWLATHE_TOOL_APPROVAL` and states plainly that it is a bootstrapping/
      debugging aid, not a substitute for allow/deny + sandboxing.
- [ ] CLAUDE.md carries the §8 entry.
- [ ] PLAN-SHELL-TOOL.md's and PLAN-FILE-TOOL.md's §8 bullets reference this plan (done — see
      those files directly).
