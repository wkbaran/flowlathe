import type { NodeEmitter, NodeKind } from "@flowlathe/core";
import { promptEmitter } from "@flowlathe/node-prompt";

export const emitTable: Record<NodeKind, NodeEmitter<any>> = {
  prompt: promptEmitter,
};
