import { renderTemplate, type PromptResult, type RuntimeHost } from "@flowlathe/core";
import { type LoopSpec } from "@flowlathe/node-loop";
import { type MapSpec } from "@flowlathe/node-map";
import { type MergeResult, type MergeSpec, runMerge } from "@flowlathe/node-merge";
import { type PauseResult, type PauseSpec, runPause } from "@flowlathe/node-pause";
import { type PromptSpec, runPrompt } from "@flowlathe/node-prompt";
import { type RouterResult, type RouterSpec, runRouter } from "@flowlathe/node-router";
import { type UserInputResult, type UserInputSpec, runUserInput } from "@flowlathe/node-user-input";
import { loopUntil, mapConcurrent } from "./combinators.js";

export interface Run {
  prompt(spec: PromptSpec, inputs: Record<string, string>): Promise<PromptResult>;
  route(spec: RouterSpec, inputs: Record<string, string>): Promise<RouterResult>;
  merge(spec: MergeSpec, inputs: Record<string, string | undefined>): Promise<MergeResult>;
  pause(spec: PauseSpec, inputs: Record<string, string>): Promise<PauseResult>;
  userInput(spec: UserInputSpec): Promise<UserInputResult>;
  loop(
    spec: LoopSpec,
    inputs: Record<string, string>,
    body: (acc: string, i: number) => Promise<string>,
  ): Promise<string>;
  map(spec: MapSpec, inputs: Record<string, string>, body: (item: string, i: number) => Promise<string>): Promise<string[]>;
  skipped<T>(): T | undefined;
  finish(outputs: Record<string, unknown>): void;
}

export interface CreateRunOptions {
  host: RuntimeHost;
}

export function createRun(opts: CreateRunOptions): Run {
  const host = opts.host;
  return {
    prompt: (spec, inputs) => runPrompt(host, spec, inputs),
    route: (spec, inputs) => runRouter(host, spec, inputs),
    merge: (spec, inputs) => runMerge(host, spec, inputs),
    pause: (spec, inputs) => runPause(host, spec, inputs),
    userInput: (spec) => runUserInput(host, spec),

    loop: async (spec, inputs, body) => {
      const init = renderTemplate(spec.initTemplate, inputs);
      host.emit({ kind: "node_started", nodeId: spec.id });
      try {
        const result = await loopUntil(
          init,
          { maxIterations: spec.maxIterations, stopValue: spec.stopValue },
          body,
        );
        host.emit({
          kind: "node_finished",
          nodeId: spec.id,
          output: result,
          renderedPrompt: init,
          finishReason: "stop",
          latencyMs: 0,
        });
        return result;
      } catch (err) {
        host.emit({ kind: "node_failed", nodeId: spec.id, error: (err as Error).message });
        throw err;
      }
    },

    map: async (spec, inputs, body) => {
      const itemsJson = renderTemplate(spec.itemsTemplate, inputs);
      let items: unknown;
      try {
        items = JSON.parse(itemsJson);
      } catch {
        throw new Error(`map "${spec.id}" itemsTemplate did not render valid JSON: ${itemsJson}`);
      }
      if (!Array.isArray(items) || !items.every((v) => typeof v === "string")) {
        throw new Error(`map "${spec.id}" itemsTemplate must render to a JSON array of strings, got: ${itemsJson}`);
      }
      if (items.length > spec.maxItems) {
        throw new Error(`map "${spec.id}" got ${items.length} items, exceeding maxItems (${spec.maxItems})`);
      }
      host.emit({ kind: "node_started", nodeId: spec.id });
      try {
        const results = await mapConcurrent(items as string[], { concurrency: spec.maxConcurrency }, body);
        const output = JSON.stringify(results);
        host.emit({
          kind: "node_finished",
          nodeId: spec.id,
          output,
          renderedPrompt: itemsJson,
          finishReason: "stop",
          latencyMs: 0,
        });
        return results;
      } catch (err) {
        host.emit({ kind: "node_failed", nodeId: spec.id, error: (err as Error).message });
        throw err;
      }
    },

    skipped: <T>() => undefined as T | undefined,
    finish: (outputs) => host.emit({ kind: "run_finished", outputs }),
  };
}
