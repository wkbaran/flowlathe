import type { LlmConfig, LlmConfigStore } from "@flowlathe/core";

/** No emit of its own — a Gate node emits `llm_config_set` itself when it writes here. */
export function createLlmConfigStore(): LlmConfigStore {
  let config: LlmConfig = {};
  return {
    get: () => config,
    set: (patch) => {
      config = { ...config, ...patch };
    },
  };
}
