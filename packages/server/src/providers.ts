import { MockProviderAdapter, OllamaProviderAdapter, SimpleScheduler } from "@flowlathe/providers";

export function createDefaultScheduler(): SimpleScheduler {
  return new SimpleScheduler({
    mock: { adapter: new MockProviderAdapter(), maxParallel: 4 },
    ollama: {
      adapter: new OllamaProviderAdapter({ baseUrl: process.env["OLLAMA_BASE_URL"] ?? "http://127.0.0.1:11434" }),
      maxParallel: 1,
    },
  });
}
