import type { NodeEmitter } from "@flowlathe/core";
import type { PauseSpec } from "./schema.js";

export const pauseEmitter: NodeEmitter<PauseSpec> = {
  runtimeMethod: "pause",
  inputPorts: () => ["input"],
  outputPorts: () => ["output"],
};
