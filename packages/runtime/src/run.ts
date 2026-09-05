import type { PromptResult, RuntimeHost } from "@flowlathe/core";
import { type PromptSpec, runPrompt } from "@flowlathe/node-prompt";

export interface Run {
  prompt(spec: PromptSpec, inputs: Record<string, string>): Promise<PromptResult>;
  finish(outputs: Record<string, unknown>): void;
}

export interface CreateRunOptions {
  host: RuntimeHost;
}

export function createRun(opts: CreateRunOptions): Run {
  return {
    prompt: (spec, inputs) => runPrompt(opts.host, spec, inputs),
    finish: (outputs) => opts.host.emit({ kind: "run_finished", outputs }),
  };
}
