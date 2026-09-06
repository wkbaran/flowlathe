import type { NodeEmitter } from "@flowlathe/core";
import type { MergeSpec } from "./schema.js";

export const mergeEmitter: NodeEmitter<MergeSpec> = {
  runtimeMethod: "merge",
  inputPorts: () => ["in1", "in2"],
  outputPorts: () => ["output"],
};
