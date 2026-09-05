import type { NodeKind } from "@flowlathe/core";
import { PromptNodeDataSchema, type PromptSpec } from "@flowlathe/node-prompt";
import type { Run } from "@flowlathe/runtime";
import type { z } from "zod";

export type DispatchFn = (run: Run, spec: unknown, inputs: Record<string, string>) => Promise<string>;

export const nodeSchemas: Record<NodeKind, z.ZodTypeAny> = {
  prompt: PromptNodeDataSchema,
};

export const dispatchTable: Record<NodeKind, DispatchFn> = {
  prompt: async (run, spec, inputs) => (await run.prompt(spec as PromptSpec, inputs)).output,
};
