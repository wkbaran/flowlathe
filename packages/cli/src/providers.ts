import { existsSync } from "node:fs";
import type { ProviderConfig } from "@flowlathe/compiler";
import type { FlowGraph } from "@flowlathe/core";
import { listProviders, openDb, runMigrations } from "@flowlathe/persistence";
import {
  MockProviderAdapter,
  OllamaProviderAdapter,
  OpenAiCompatAdapter,
  type ProviderRegistration,
} from "@flowlathe/providers";
import type { ProviderAdapter } from "@flowlathe/core";

function usedProviderIds(graph: FlowGraph): string[] {
  const ids = graph.nodes
    .map((n) => (n.data as Record<string, unknown>)["providerId"])
    .filter((id): id is string => typeof id === "string");
  return [...new Set(ids)];
}

/**
 * Same source of truth `/api/flows/:id/export` uses (the `providers` table), reached via
 * `FLOWLATHE_DB_PATH` instead of a running server — `export`/`run` are meant to work against the
 * same flowlathe install the server itself uses. A provider id used in the flow but absent from
 * the DB (or no DB configured at all) falls back to a bare "ollama" adapter, this project's
 * local-first default (CLAUDE.md).
 */
export function resolveProviders(graph: FlowGraph): Record<string, ProviderConfig> {
  const ids = usedProviderIds(graph);
  const dbPath = process.env["FLOWLATHE_DB_PATH"];
  const byId = new Map<string, ProviderConfig>();
  if (dbPath && existsSync(dbPath)) {
    const opened = openDb(dbPath);
    try {
      runMigrations(opened);
      for (const row of listProviders(opened.db)) {
        byId.set(row.id, { kind: row.kind, baseUrl: row.baseUrl ?? undefined });
      }
    } finally {
      opened.close();
    }
  }
  const out: Record<string, ProviderConfig> = {};
  const defaulted: string[] = [];
  for (const id of ids) {
    const found = byId.get(id);
    out[id] = found ?? { kind: "ollama" };
    if (!found) defaulted.push(id);
  }
  if (defaulted.length > 0) {
    console.error(
      `note: provider(s) not found in ${dbPath ? `the DB at ${dbPath}` : "any DB (FLOWLATHE_DB_PATH is not set)"}, ` +
        `defaulting to a plain "ollama" adapter: ${defaulted.join(", ")}`,
    );
  }
  return out;
}

/** Mirrors `compile-graph.ts`'s `adapterCtor` exactly — same env var names — so a compiled
 *  script and `flowlathe run` behave identically for the same provider config. */
export function buildAdapter(providerId: string, config: ProviderConfig): ProviderAdapter {
  if (config.kind === "mock") return new MockProviderAdapter();
  if (config.kind === "ollama") {
    return new OllamaProviderAdapter({ baseUrl: process.env["OLLAMA_BASE_URL"] ?? config.baseUrl ?? "http://127.0.0.1:11434" });
  }
  const envVar = `FLOWLATHE_APIKEY_${providerId.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase()}`;
  return new OpenAiCompatAdapter({ baseUrl: config.baseUrl ?? "", apiKey: process.env[envVar] });
}

export function buildScheduler(providers: Record<string, ProviderConfig>): Record<string, ProviderRegistration> {
  const out: Record<string, ProviderRegistration> = {};
  for (const [id, config] of Object.entries(providers)) {
    out[id] = { adapter: buildAdapter(id, config), maxParallel: 4 };
  }
  return out;
}
