import { extractTemplateVars, type NodeEmitter } from "@flowlathe/core";
import type { SearchSpec } from "./schema.js";

export const searchEmitter: NodeEmitter<SearchSpec> = {
  runtimeMethod: "search",
  inputPorts: (spec) => extractTemplateVars(spec.queryTemplate),
  outputPorts: () => ["results"],
};
