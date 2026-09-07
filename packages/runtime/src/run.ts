import {
  renderTemplate,
  type ContextStore,
  type LlmConfigStore,
  type PromptResult,
  type RunEvent,
  type RuntimeHost,
  type StateStore,
  type ToolRegistry,
} from "@flowlathe/core";
import { type FetchResult, type FetchSpec, runFetch } from "@flowlathe/node-fetch";
import { type GateResult, type GateSpec, runGate } from "@flowlathe/node-gate";
import { type LoopSpec } from "@flowlathe/node-loop";
import { type MapSpec } from "@flowlathe/node-map";
import { type MergeResult, type MergeSpec, runMerge } from "@flowlathe/node-merge";
import { type PauseResult, type PauseSpec, runPause } from "@flowlathe/node-pause";
import { type PromptSpec, runPrompt } from "@flowlathe/node-prompt";
import { type RouterResult, type RouterSpec, runRouter } from "@flowlathe/node-router";
import { type SearchResult, type SearchSpec, runSearch } from "@flowlathe/node-search";
import { type UserInputResult, type UserInputSpec, runUserInput } from "@flowlathe/node-user-input";
import { loopUntil, mapConcurrent } from "./combinators.js";

export interface Run {
  readonly state: StateStore;
  readonly llmConfig: LlmConfigStore;
  readonly context: ContextStore;
  readonly tools: ToolRegistry;
  emit(event: RunEvent): void;
  prompt(spec: PromptSpec, inputs: Record<string, string>): Promise<PromptResult>;
  route(spec: RouterSpec, inputs: Record<string, string>): Promise<RouterResult>;
  merge(spec: MergeSpec, inputs: Record<string, string | undefined>): Promise<MergeResult>;
  pause(spec: PauseSpec, inputs: Record<string, string>): Promise<PauseResult>;
  userInput(spec: UserInputSpec): Promise<UserInputResult>;
  gate(spec: GateSpec, inputs: Record<string, string>): Promise<GateResult>;
  search(spec: SearchSpec, inputs: Record<string, string>): Promise<SearchResult>;
  fetch(spec: FetchSpec, inputs: Record<string, string>): Promise<FetchResult>;
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
    state: host.state,
    llmConfig: host.llmConfig,
    context: host.context,
    tools: host.tools,
    emit: (event) => host.emit(event),
    prompt: (spec, inputs) => runPrompt(host, spec, inputs),
    route: (spec, inputs) => runRouter(host, spec, inputs),
    merge: (spec, inputs) => runMerge(host, spec, inputs),
    pause: (spec, inputs) => runPause(host, spec, inputs),
    userInput: (spec) => runUserInput(host, spec),
    gate: (spec, inputs) => runGate(host, spec, inputs),
    search: (spec, inputs) => runSearch(host, spec, inputs),
    fetch: (spec, inputs) => runFetch(host, spec, inputs),

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
