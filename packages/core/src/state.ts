import { z } from "zod";
import type { ToolSpec } from "./contracts.js";

export const MergeRuleSchema = z.enum(["replace", "append", "numeric-add", "set-union", "error-on-conflict"]);
export type MergeRule = z.infer<typeof MergeRuleSchema>;

export const StateValueTypeSchema = z.enum(["file", "string", "number", "boolean", "array", "object"]);
export type StateValueType = z.infer<typeof StateValueTypeSchema>;

export const FileStateModeSchema = z.enum(["read-only", "read-write"]);
export type FileStateMode = z.infer<typeof FileStateModeSchema>;

/** File-type merge is restricted to literal file operations (overwrite / append-to-end) —
 *  `numeric-add`/`set-union`/`error-on-conflict` don't have a sensible meaning for a file and are
 *  never run through `applyMerge` for a `type: "file"` entry (see PLAN-STATE-FILES.md §1.1
 *  fact 10 and `createStateStore`'s file-backed branch). */
export const FileMergeRuleSchema = z.enum(["replace", "append"]);

export const StateDeclSchema = z
  .object({
    name: z.string().min(1),
    type: StateValueTypeSchema.default("file"),
    merge: MergeRuleSchema,
    initial: z.unknown().optional(),
    /** Only meaningful when type === "file". Relative to FLOWLATHE_STATE_FILES_ROOT, validated
     *  via resolveWithinRoot at every access — never trusted as pre-validated just because it
     *  round-tripped through a saved graph. */
    filePath: z.string().min(1).optional(),
    fileMode: FileStateModeSchema.optional(),
    /** Only meaningful when fileMode === "read-write". Ignored for read-only entries. */
    versioned: z.boolean().optional(),
  })
  .superRefine((decl, ctx) => {
    if (decl.type !== "file") return;
    if (!decl.filePath) {
      ctx.addIssue({ code: "custom", message: `state entry "${decl.name}" has type "file" but no filePath`, path: ["filePath"] });
    }
    if (!decl.fileMode) {
      ctx.addIssue({ code: "custom", message: `state entry "${decl.name}" has type "file" but no fileMode`, path: ["fileMode"] });
    }
    if (!FileMergeRuleSchema.options.includes(decl.merge as "replace" | "append")) {
      ctx.addIssue({
        code: "custom",
        message: `state entry "${decl.name}" has type "file" but merge "${decl.merge}" — file entries only support "replace"/"append"`,
        path: ["merge"],
      });
    }
  });
export type StateDecl = z.infer<typeof StateDeclSchema>;

export interface StateReadMeta {
  viaTool?: boolean;
  activationKey?: string;
}

export interface StateWriteMeta {
  viaTool?: boolean;
  activationKey?: string;
}

/** The LLM's `read_state`/`write_state` tool uses the identical path as direct `run.state.*`
 *  calls (e.g. inside a Loop body) — the only difference is `meta.viaTool`. No second code path. */
export interface StateStore {
  read(entry: string, meta?: StateReadMeta): unknown;
  write(entry: string, value: unknown, meta?: StateWriteMeta): void;
}

export const READ_STATE_TOOL: ToolSpec = {
  name: "read_state",
  description: "Read the current value of a named entry in the flow's shared state store.",
  parameters: {
    type: "object",
    properties: { entry: { type: "string", description: "the declared state entry name to read" } },
    required: ["entry"],
  },
};

export const WRITE_STATE_TOOL: ToolSpec = {
  name: "write_state",
  description:
    "Write a value into a named entry of the flow's shared state store. The entry's configured " +
    "merge rule decides how this combines with any value already there (e.g. append vs replace).",
  parameters: {
    type: "object",
    properties: {
      entry: { type: "string", description: "the declared state entry name to write" },
      value: { type: "string", description: "the value to write, as a JSON-encodable value" },
    },
    required: ["entry", "value"],
  },
};

export class StateWriteConflict extends Error {
  constructor(entry: string) {
    super(`state write conflict on entry "${entry}": concurrent writers disagree and its merge rule is "error-on-conflict"`);
    this.name = "StateWriteConflict";
  }
}

/**
 * Pure fold used by every write to a state entry, interpreter and compiled-script paths alike.
 * `append`/`numeric-add`/`set-union` are commutative — safe under concurrent writers. `replace`
 * is genuinely nondeterministic under concurrency; `error-on-conflict` is how a flow author opts
 * into a hard failure instead of silent last-write-wins (see PLAN.md design trap #3).
 */
export function applyMerge(rule: MergeRule, previous: unknown, incoming: unknown, entry = "(unknown)"): unknown {
  switch (rule) {
    case "replace":
      return incoming;
    case "append": {
      const prevArr = previous === undefined ? [] : Array.isArray(previous) ? previous : [previous];
      return [...prevArr, incoming];
    }
    case "numeric-add": {
      const prevNum = typeof previous === "number" ? previous : 0;
      const incNum = typeof incoming === "number" ? incoming : Number(incoming);
      if (Number.isNaN(incNum)) {
        throw new Error(`numeric-add: incoming value is not a number: ${JSON.stringify(incoming)}`);
      }
      return prevNum + incNum;
    }
    case "set-union": {
      const prevArr = previous === undefined ? [] : Array.isArray(previous) ? previous : [previous];
      const incArr = Array.isArray(incoming) ? incoming : [incoming];
      return [...new Set([...prevArr, ...incArr])];
    }
    case "error-on-conflict": {
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(incoming)) {
        throw new StateWriteConflict(entry);
      }
      return incoming;
    }
  }
}
