import {
  findMissingToolsets,
  READ_STATE_TOOL,
  sanitizeUntrustedText,
  WRITE_STATE_TOOL,
  type StateStore,
  type ToolRegistration,
  type ToolRegistry,
  type ToolSpec,
} from "@flowlathe/core";

export type { ToolRegistration };

/** Layer 2 of the sanitization boundary (PLAN-SANITIZATION-BOUNDARY.md §1/§3.3): one generous
 *  whole-result cap so a plugin that forgot its own per-field sanitization (layer 1, at the
 *  source) still cannot land raw/unbounded bytes in a prompt. Deliberately well above
 *  Firecrawl's own `DEFAULT_MAX_CHARS` (20,000) plus its JSON envelope — this is a "nothing
 *  unbounded reaches a prompt" backstop, not a context-budget limit (that's the Gate node's
 *  compaction job), and must stay high enough that it never normally fires: truncating a JSON
 *  envelope produces invalid JSON, so tightening this without JSON-aware truncation would gut
 *  legitimate results layer 1 already bounded correctly. */
const TOOL_RESULT_MAX_CHARS = 32_000;

/** Built from a flat list of registrations rather than a nested map: a plugin contributes one
 *  toolset's worth of `ToolRegistration`s (see @flowlathe/plugin-spotify), and this just indexes
 *  them two ways (by toolset, for `specsFor`; by tool name, for `invoke`). A name collision across
 *  toolsets silently keeps the later registration — toolset names are curated in-process, not
 *  user-supplied, so this isn't a real risk. */
export function createToolRegistry(registrations: ToolRegistration[]): ToolRegistry {
  const byName = new Map(registrations.map((r) => [r.spec.name, r]));
  const byToolset = new Map<string, ToolSpec[]>();
  for (const r of registrations) {
    byToolset.set(r.toolset, [...(byToolset.get(r.toolset) ?? []), r.spec]);
  }

  return {
    specsFor: (toolsets) => toolsets.flatMap((t) => byToolset.get(t) ?? []),
    invoke: async (name, args, meta) => {
      const reg = byName.get(name);
      if (!reg) return `[${name}]: error - unknown tool`;
      try {
        const raw = await reg.handler(args, meta);
        return reg.trustedResult ? raw : sanitizeUntrustedText(raw, TOOL_RESULT_MAX_CHARS, `tool ${name}`);
      } catch (err) {
        // Route through the same sanitizer as a successful result — a plugin's error message can
        // embed vendor response text (e.g. PluginHttpError carries a truncated response body).
        return sanitizeUntrustedText(`[${name}]: error - ${(err as Error).message}`, TOOL_RESULT_MAX_CHARS, `tool ${name}`);
      }
    },
    missingToolsets: (required) => findMissingToolsets(registrations, required),
  };
}

/** The built-in `read_state`/`write_state` tool, registered under the "state" toolset — same
 *  path a plugin's tools take, just no longer special-cased in the prompt node's tool loop. */
export function stateToolset(state: StateStore): ToolRegistration[] {
  return [
    {
      toolset: "state",
      spec: READ_STATE_TOOL,
      trustedResult: true,
      handler: (args, meta) => {
        const entry = String(args["entry"]);
        const value = state.read(entry, { viaTool: true, activationKey: meta.activationKey });
        return `[read_state ${entry}]: ${JSON.stringify(value)}`;
      },
    },
    {
      toolset: "state",
      spec: WRITE_STATE_TOOL,
      trustedResult: true,
      handler: (args, meta) => {
        const entry = String(args["entry"]);
        state.write(entry, args["value"], { viaTool: true, activationKey: meta.activationKey });
        return `[write_state ${entry}]: ok`;
      },
    },
  ];
}
