import type { NodeEmitter } from "@flowlathe/core";
import type { GateSpec } from "./schema.js";

export const gateEmitter: NodeEmitter<GateSpec> = {
  runtimeMethod: "gate",
  inputPorts: () => ["input"],
  outputPorts: () => ["output"],
};
