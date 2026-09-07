import { extractTemplateVars, type NodeEmitter } from "@flowlathe/core";
import type { FetchSpec } from "./schema.js";

export const fetchEmitter: NodeEmitter<FetchSpec> = {
  runtimeMethod: "fetch",
  inputPorts: (spec) => extractTemplateVars(spec.urlTemplate),
  outputPorts: () => ["content"],
};
