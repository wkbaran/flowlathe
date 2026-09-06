import type { ContextMessage, ContextStore } from "@flowlathe/core";

/** No emit of its own — `runPrompt` emits `context_appended`/`context_compacted` itself, since
 *  only it knows whether a given write was an ordinary turn or a compaction. */
export function createContextStore(): ContextStore {
  const byNode = new Map<string, ContextMessage[]>();
  return {
    get: (nodeId) => byNode.get(nodeId) ?? [],
    append: (nodeId, turns) => {
      byNode.set(nodeId, [...(byNode.get(nodeId) ?? []), ...turns]);
    },
    replace: (nodeId, messages) => {
      byNode.set(nodeId, messages);
    },
  };
}
