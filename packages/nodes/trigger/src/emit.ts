import type { NodeEmitter } from "@flowlathe/core";
import type { TriggerSpec } from "./schema.js";

export const triggerEmitter: NodeEmitter<TriggerSpec> = {
  runtimeMethod: "trigger",
  inputPorts: () => [],
  outputPorts: () => ["content", "authorId", "channelId", "messageId"],
};
