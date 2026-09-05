import type { ProviderKind } from "@flowlathe/compiler";

/** The fixed set of built-in providers the server wires up (see providers.ts). */
export const PROVIDER_KINDS: Record<string, ProviderKind> = {
  mock: "mock",
  ollama: "ollama",
};
