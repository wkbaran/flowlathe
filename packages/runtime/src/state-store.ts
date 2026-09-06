import { applyMerge, type MergeRule, type RunEvent, type StateDecl, type StateStore } from "@flowlathe/core";

export interface StateStoreInit {
  decls: StateDecl[];
  /** Past writes to fold in before this store is used — how a step-mode host resumes a branch's
   *  state across `stepOnce` calls (each of which builds a fresh host). A step-back fork's own
   *  writes already include its pre-fork inheritance, seeded once at fork time by `stepBack`
   *  (see `getStateSnapshotAsOf`) — this replay itself only ever looks at one branch's rows. */
  replay?: { entry: string; value: unknown; seq: number }[] | undefined;
}

export function createStateStore(emit: (event: RunEvent) => void, init: StateStoreInit): StateStore {
  const values = new Map<string, unknown>();
  const rules = new Map<string, MergeRule>();
  for (const decl of init.decls ?? []) {
    rules.set(decl.name, decl.merge);
    if (decl.initial !== undefined) values.set(decl.name, decl.initial);
  }
  let seq = 0;
  for (const write of init.replay ?? []) {
    values.set(write.entry, write.value);
    seq = Math.max(seq, write.seq);
  }

  return {
    read(entry, meta) {
      const value = values.get(entry);
      emit({ kind: "state_read", entry, seqSeen: seq, viaTool: meta?.viaTool ?? false, activationKey: meta?.activationKey });
      return value;
    },
    write(entry, value, meta) {
      const rule = rules.get(entry);
      if (!rule) throw new Error(`unknown state entry "${entry}" — declare it in the flow's State panel first`);
      seq += 1;
      const merged = applyMerge(rule, values.get(entry), value, entry);
      values.set(entry, merged);
      emit({
        kind: "state_write",
        entry,
        value: merged,
        merge: rule,
        seq,
        viaTool: meta?.viaTool ?? false,
        activationKey: meta?.activationKey,
      });
    },
  };
}
