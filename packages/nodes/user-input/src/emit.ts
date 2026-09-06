import type { NodeEmitter } from "@flowlathe/core";
import type { UserInputSpec } from "./schema.js";

export const userInputEmitter: NodeEmitter<UserInputSpec> = {
  runtimeMethod: "userInput",
  inputPorts: () => [],
  outputPorts: () => ["output"],
};
