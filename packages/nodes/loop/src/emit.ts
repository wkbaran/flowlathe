import { extractTemplateVars, type NodeEmitter } from "@flowlathe/core";
import type { LoopSpec } from "./schema.js";

export const loopEmitter: NodeEmitter<LoopSpec> = {
  runtimeMethod: "loop",
  inputPorts: (spec) => extractTemplateVars(spec.initTemplate),
  outputPorts: () => ["result"],
};
