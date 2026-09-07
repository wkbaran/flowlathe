import type { FlowGraph } from "./graph.js";
import type { MissingToolset, ToolRegistration } from "./contracts.js";

/** Every plugin toolset any node in the graph has opted into (via `enabledToolsets`), across all
 *  node kinds and including Loop/Map body nodes — a node's `enabledToolsets` isn't specific to
 *  the "prompt" kind (any future node kind could grow the same field), so this doesn't filter by
 *  `node.type`. "state" is never included: it has no external configuration, so it's never a
 *  workflow "dependency" in the sense this module cares about.
 *
 *  Also collects a single `toolset` string field, if present — the `search`/`fetch` node kinds
 *  each declare which plugin backs them this way (`node.data.toolset`) rather than opting into a
 *  toolset by name via `enabledToolsets`. Read generically (a string field, not switched on
 *  `node.type`) so a future node kind with the same convention is covered for free. */
export function requiredToolsets(graph: FlowGraph): string[] {
  const set = new Set<string>();
  for (const node of graph.nodes) {
    const data = node.data as { enabledToolsets?: unknown; toolset?: unknown };
    if (Array.isArray(data.enabledToolsets)) {
      for (const t of data.enabledToolsets) if (typeof t === "string") set.add(t);
    }
    if (typeof data.toolset === "string") set.add(data.toolset);
  }
  return [...set].sort();
}

/**
 * Which of `required` toolsets aren't actually usable right now, given the toolsets a server (or
 * a compiled script, if it ever supports plugins) has registered. Two ways a toolset can be
 * "missing": nothing registered it at all (not configured), or something registered it but at
 * least one of its registrations reports itself unavailable (e.g. a plugin that's configured but
 * not authenticated) via `unavailableReason()`.
 *
 * Deliberately a plain function over a `ToolRegistration[]`, not a method requiring a full
 * `ToolRegistry` — callers that only need this check (e.g. an HTTP route deciding whether to
 * allow a run) shouldn't have to construct a whole registry (state store included) just to ask it.
 * `ToolRegistry.missingToolsets` (see @flowlathe/runtime) is a thin wrapper around this for
 * callers that already have a registry in hand.
 */
export function findMissingToolsets(registrations: ToolRegistration[], required: string[]): MissingToolset[] {
  const byToolset = new Map<string, ToolRegistration[]>();
  for (const r of registrations) {
    byToolset.set(r.toolset, [...(byToolset.get(r.toolset) ?? []), r]);
  }

  const missing: MissingToolset[] = [];
  for (const toolset of required) {
    const regs = byToolset.get(toolset);
    if (!regs || regs.length === 0) {
      missing.push({ toolset, reason: `plugin toolset "${toolset}" is not configured on this server` });
      continue;
    }
    const reason = regs.map((r) => r.unavailableReason?.()).find((r): r is string => Boolean(r));
    if (reason) missing.push({ toolset, reason });
  }
  return missing;
}
