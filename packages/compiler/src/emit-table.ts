import type { NodeEmitter, NodeKind } from "@flowlathe/core";
import { FetchNodeDataSchema, fetchEmitter } from "@flowlathe/node-fetch";
import { GateNodeDataSchema, gateEmitter } from "@flowlathe/node-gate";
import { LoopNodeDataSchema, loopEmitter } from "@flowlathe/node-loop";
import { MapNodeDataSchema, mapEmitter } from "@flowlathe/node-map";
import { MergeNodeDataSchema, mergeEmitter } from "@flowlathe/node-merge";
import { PauseNodeDataSchema, pauseEmitter } from "@flowlathe/node-pause";
import { PromptNodeDataSchema, promptEmitter } from "@flowlathe/node-prompt";
import { RouterNodeDataSchema, routerEmitter } from "@flowlathe/node-router";
import { SearchNodeDataSchema, searchEmitter } from "@flowlathe/node-search";
import { UserInputNodeDataSchema, userInputEmitter } from "@flowlathe/node-user-input";
import type { ZodTypeAny } from "zod";

export const emitTable: Record<NodeKind, NodeEmitter<any>> = {
  prompt: promptEmitter,
  router: routerEmitter,
  merge: mergeEmitter,
  pause: pauseEmitter,
  userInput: userInputEmitter,
  loop: loopEmitter,
  map: mapEmitter,
  gate: gateEmitter,
  search: searchEmitter,
  fetch: fetchEmitter,
};

/** Parsed through before a node's data is serialized into the compiled script, so a schema
 *  default (e.g. PromptNodeDataSchema's `enabledToolsets`) reaches the emitted literal the same
 *  way it reaches the interpreter's `registry[kind].schema.parse(node.data)` call — otherwise a
 *  field a flow author never set is `undefined` in the compiled script but present (defaulted)
 *  in the interpreter, and the two diverge at runtime instead of at compile time. */
export const schemaTable: Record<NodeKind, ZodTypeAny> = {
  prompt: PromptNodeDataSchema,
  router: RouterNodeDataSchema,
  merge: MergeNodeDataSchema,
  pause: PauseNodeDataSchema,
  userInput: UserInputNodeDataSchema,
  loop: LoopNodeDataSchema,
  map: MapNodeDataSchema,
  gate: GateNodeDataSchema,
  search: SearchNodeDataSchema,
  fetch: FetchNodeDataSchema,
};
