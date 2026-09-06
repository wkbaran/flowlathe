import { extractTemplateVars, type NodeEmitter } from "@flowlathe/core";
import type { MapSpec } from "./schema.js";

export const mapEmitter: NodeEmitter<MapSpec> = {
  runtimeMethod: "map",
  inputPorts: (spec) => extractTemplateVars(spec.itemsTemplate),
  outputPorts: () => ["results"],
};
