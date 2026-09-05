import type { NodeEmitter } from "@flowlathe/core";
import { extractTemplateVars } from "@flowlathe/core";
import type { PromptSpec } from "./schema.js";

export const promptEmitter: NodeEmitter<PromptSpec> = {
  runtimeMethod: "prompt",
  inputPorts: (spec) => extractTemplateVars(spec.template),
  outputPorts: () => ["output"],
};
