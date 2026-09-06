import {
  findMissingToolsets,
  READ_STATE_TOOL,
  WRITE_STATE_TOOL,
  type StateStore,
  type ToolRegistration,
  type ToolRegistry,
  type ToolSpec,
} from "@flowlathe/core";

export type { ToolRegistration };

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
        return await reg.handler(args, meta);
      } catch (err) {
        return `[${name}]: error - ${(err as Error).message}`;
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
      handler: (args, meta) => {
        const entry = String(args["entry"]);
        const value = state.read(entry, { viaTool: true, activationKey: meta.activationKey });
        return `[read_state ${entry}]: ${JSON.stringify(value)}`;
      },
    },
    {
      toolset: "state",
      spec: WRITE_STATE_TOOL,
      handler: (args, meta) => {
        const entry = String(args["entry"]);
        state.write(entry, args["value"], { viaTool: true, activationKey: meta.activationKey });
        return `[write_state ${entry}]: ok`;
      },
    },
  ];
}
