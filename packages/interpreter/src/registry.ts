import { extractTemplateVars, type NodeKind } from "@flowlathe/core";
import { LoopNodeDataSchema } from "@flowlathe/node-loop";
import { MapNodeDataSchema } from "@flowlathe/node-map";
import { type MergeSpec, MergeNodeDataSchema } from "@flowlathe/node-merge";
import { type PauseSpec, PauseNodeDataSchema } from "@flowlathe/node-pause";
import { type PromptSpec, PromptNodeDataSchema } from "@flowlathe/node-prompt";
import { type RouterSpec, RouterNodeDataSchema } from "@flowlathe/node-router";
import { type UserInputSpec, UserInputNodeDataSchema } from "@flowlathe/node-user-input";
import type { Run } from "@flowlathe/runtime";
import type { z } from "zod";

export interface PortDecl {
  name: string;
  required: boolean;
}

export type DispatchFn = (run: Run, spec: unknown, inputs: Record<string, string>) => Promise<Record<string, string>>;

export interface NodeDescriptor {
  schema: z.ZodTypeAny;
  inputPorts(spec: unknown): PortDecl[];
  outputPorts(spec: unknown): string[];
  /** Undefined for "loop"/"map": the engine drives their body activations itself. */
  dispatch?: DispatchFn;
}

export const registry: Record<NodeKind, NodeDescriptor> = {
  prompt: {
    schema: PromptNodeDataSchema,
    inputPorts: (spec) => extractTemplateVars((spec as PromptSpec).template).map((name) => ({ name, required: true })),
    outputPorts: () => ["output"],
    dispatch: async (run, spec, inputs) => ({ output: (await run.prompt(spec as PromptSpec, inputs)).output }),
  },
  router: {
    schema: RouterNodeDataSchema,
    inputPorts: () => [{ name: "input", required: true }],
    outputPorts: (spec) => (spec as RouterSpec).routes,
    dispatch: async (run, spec, inputs) => {
      const result = await run.route(spec as RouterSpec, inputs);
      return { [result.route]: result.passthrough };
    },
  },
  merge: {
    schema: MergeNodeDataSchema,
    inputPorts: () => [
      { name: "in1", required: false },
      { name: "in2", required: false },
    ],
    outputPorts: () => ["output"],
    dispatch: async (run, spec, inputs) => ({ output: (await run.merge(spec as MergeSpec, inputs)).output }),
  },
  pause: {
    schema: PauseNodeDataSchema,
    inputPorts: () => [{ name: "input", required: true }],
    outputPorts: () => ["output"],
    dispatch: async (run, spec, inputs) => ({ output: (await run.pause(spec as PauseSpec, inputs)).output }),
  },
  userInput: {
    schema: UserInputNodeDataSchema,
    inputPorts: () => [],
    outputPorts: () => ["output"],
    dispatch: async (run, spec) => ({ output: (await run.userInput(spec as UserInputSpec)).output }),
  },
  loop: {
    schema: LoopNodeDataSchema,
    inputPorts: (spec) =>
      extractTemplateVars((spec as { initTemplate: string }).initTemplate).map((name) => ({ name, required: true })),
    outputPorts: () => ["result"],
  },
  map: {
    schema: MapNodeDataSchema,
    inputPorts: (spec) =>
      extractTemplateVars((spec as { itemsTemplate: string }).itemsTemplate).map((name) => ({ name, required: true })),
    outputPorts: () => ["results"],
  },
};
