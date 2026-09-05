import type { ProviderAdapter, ProviderCallRequest, ProviderCallResult, Scheduler } from "@flowlathe/core";
import { type Db, getProvider, getProviderSecret, type ProviderRecord } from "@flowlathe/persistence";
import {
  AffinityScheduler,
  MockProviderAdapter,
  OllamaProviderAdapter,
  OllamaResidencyProbe,
  OpenAiCompatAdapter,
  RealSchedulerClock,
  type SchedulerEvent,
  type SchedulerStats,
} from "@flowlathe/providers";

function buildAdapter(provider: ProviderRecord, db: Db, credentialKey: Buffer): ProviderAdapter {
  switch (provider.kind) {
    case "mock":
      return new MockProviderAdapter();
    case "ollama":
      return new OllamaProviderAdapter({ baseUrl: provider.baseUrl ?? "http://127.0.0.1:11434" });
    case "openai-compat":
      return new OpenAiCompatAdapter({
        baseUrl: provider.baseUrl ?? "",
        apiKey: getProviderSecret(db, credentialKey, provider.id),
      });
  }
}

interface RegistryEntry {
  scheduler: AffinityScheduler;
  residency?: OllamaResidencyProbe | undefined;
}

/**
 * Builds one AffinityScheduler per provider, lazily, from its DB configuration — and the
 * single implementation of the core `Scheduler` interface the rest of the app depends on.
 */
export class SchedulerRegistry implements Scheduler {
  private readonly instances = new Map<string, RegistryEntry>();
  private readonly clock = new RealSchedulerClock();

  constructor(
    private readonly db: Db,
    private readonly credentialKey: Buffer,
    private readonly onEvent?: (event: SchedulerEvent) => void,
  ) {}

  async submit(req: ProviderCallRequest): Promise<ProviderCallResult> {
    return this.getOrCreate(req.providerId).scheduler.submit(req);
  }

  /** Call after any provider CRUD mutation so the next call picks up fresh config. */
  invalidate(providerId: string): void {
    this.instances.get(providerId)?.residency?.stopPolling();
    this.instances.delete(providerId);
  }

  getStats(): Record<string, SchedulerStats> {
    const out: Record<string, SchedulerStats> = {};
    for (const [providerId, entry] of this.instances) out[providerId] = entry.scheduler.getStats();
    return out;
  }

  private getOrCreate(providerId: string): RegistryEntry {
    const existing = this.instances.get(providerId);
    if (existing) return existing;

    const provider = getProvider(this.db, providerId);
    if (!provider) throw new Error(`unknown provider: "${providerId}"`);
    const adapter = buildAdapter(provider, this.db, this.credentialKey);

    let residency: OllamaResidencyProbe | undefined;
    if (provider.kind === "ollama" && provider.baseUrl) {
      residency = new OllamaResidencyProbe(provider.baseUrl);
      residency.startPolling();
    }

    const scheduler = new AffinityScheduler({
      providerId,
      limits: {
        maxParallel: provider.maxParallel,
        rpm: provider.rpm ?? undefined,
        tpm: provider.tpm ?? undefined,
        swapCostMs: provider.swapCostMs ?? undefined,
        residentModels: provider.residentModels,
      },
      adapter,
      clock: this.clock,
      residency,
      onEvent: this.onEvent,
    });

    const entry: RegistryEntry = { scheduler, residency };
    this.instances.set(providerId, entry);
    return entry;
  }
}
