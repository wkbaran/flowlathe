import type { NodeEmitter } from "@flowlathe/core";
import type { RouterSpec } from "./schema.js";

export const routerEmitter: NodeEmitter<RouterSpec> = {
  runtimeMethod: "route",
  inputPorts: () => ["input"],
  outputPorts: (spec) => spec.routes,
};
