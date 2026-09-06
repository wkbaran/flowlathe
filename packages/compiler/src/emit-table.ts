import type { NodeEmitter, NodeKind } from "@flowlathe/core";
import { gateEmitter } from "@flowlathe/node-gate";
import { loopEmitter } from "@flowlathe/node-loop";
import { mapEmitter } from "@flowlathe/node-map";
import { mergeEmitter } from "@flowlathe/node-merge";
import { pauseEmitter } from "@flowlathe/node-pause";
import { promptEmitter } from "@flowlathe/node-prompt";
import { routerEmitter } from "@flowlathe/node-router";
import { userInputEmitter } from "@flowlathe/node-user-input";

export const emitTable: Record<NodeKind, NodeEmitter<any>> = {
  prompt: promptEmitter,
  router: routerEmitter,
  merge: mergeEmitter,
  pause: pauseEmitter,
  userInput: userInputEmitter,
  loop: loopEmitter,
  map: mapEmitter,
  gate: gateEmitter,
};
