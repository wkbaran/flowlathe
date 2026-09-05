export interface ResidencyProbe {
  isResident(modelId: string): boolean;
}

/** For tests and non-GPU providers: an explicitly-set resident set, no polling. */
export class StaticResidencyProbe implements ResidencyProbe {
  private resident: Set<string>;

  constructor(resident: string[] = []) {
    this.resident = new Set(resident);
  }

  isResident(modelId: string): boolean {
    return this.resident.has(modelId);
  }

  setResident(models: string[]): void {
    this.resident = new Set(models);
  }
}

interface OllamaPsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

/**
 * Polls Ollama's `/api/ps` for real resident models. Residency is a hint, not truth —
 * `keep_alive` expiry can unload a model between polls without us knowing yet.
 */
export class OllamaResidencyProbe implements ResidencyProbe {
  private resident = new Set<string>();
  private readonly baseUrl: string;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  isResident(modelId: string): boolean {
    return this.resident.has(modelId);
  }

  async refresh(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/api/ps`);
      if (!res.ok) return;
      const body = (await res.json()) as OllamaPsResponse;
      this.resident = new Set((body.models ?? []).map((m) => m.name ?? m.model).filter((v): v is string => !!v));
    } catch {
      // network hiccup: keep the last-known residency set rather than flapping to "nothing resident"
    }
  }

  startPolling(intervalMs = 5000): void {
    this.stopPolling();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
