import type { ProviderAdapter, ProviderCallRequest, ProviderCallResult, Scheduler } from "@flowlathe/core";
import { classifyFailure, ProviderCallError } from "./errors.js";
import type { ResidencyProbe } from "./residency.js";
import type { SchedulerClock } from "./scheduler-clock.js";
import { TokenBucket } from "./token-bucket.js";

export type Priority = "interactive" | "normal" | "bulk";

export interface ProviderLimits {
  maxParallel: number;
  rpm?: number | undefined;
  tpm?: number | undefined;
  swapCostMs?: number | undefined;
  residentModels?: number | undefined;
  maxQueue?: number | undefined;
}

export interface AffinityConstants {
  quantum: number;
  starvationMs: number;
  residentBonus: number;
  ageWeight: number;
  priorityWeight: Record<Priority, number>;
  circuitBreakerThreshold: number;
  circuitOpenMs: number;
}

export const DEFAULT_CONSTANTS: AffinityConstants = {
  quantum: 8,
  starvationMs: 20_000,
  residentBonus: 6,
  ageWeight: 4,
  priorityWeight: { interactive: 10, normal: 0, bulk: -3 },
  circuitBreakerThreshold: 5,
  circuitOpenMs: 30_000,
};

export class QueueFullError extends Error {
  constructor(maxQueue: number) {
    super(`queue full (max ${maxQueue})`);
    this.name = "QueueFullError";
  }
}

export class CircuitOpenError extends Error {
  constructor(providerId: string) {
    super(`circuit open for provider "${providerId}"`);
    this.name = "CircuitOpenError";
  }
}

export type SchedulerEvent =
  | { kind: "queue_admitted"; providerId: string; modelId: string; priority: Priority; queueDepth: number }
  | { kind: "model_swap"; providerId: string; from: string | undefined; to: string }
  | { kind: "call_started"; providerId: string; modelId: string; waitMs: number }
  | { kind: "call_finished"; providerId: string; modelId: string; latencyMs: number }
  | { kind: "call_retry"; providerId: string; modelId: string; attempt: number; failureClass: string }
  | { kind: "circuit_open"; providerId: string };

export interface ModelStats {
  queueDepth: number;
  waitMsP50: number;
  waitMsP95: number;
  tokensPerSecond: number;
}

export interface SchedulerStats {
  currentModel: string | undefined;
  swapCount: number;
  models: Record<string, ModelStats>;
}

interface QueuedTicket {
  req: ProviderCallRequest;
  priority: Priority;
  estTokens: number | undefined;
  enqueuedAt: number;
  resolve: (result: ProviderCallResult) => void;
  reject: (err: unknown) => void;
}

interface ModelMetrics {
  waitSamples: number[];
  tokens: number;
  latencyMs: number;
}

export interface SubmitOptions {
  priority?: Priority;
  estTokens?: number;
}

export interface AffinitySchedulerOptions {
  providerId: string;
  limits: ProviderLimits;
  adapter: ProviderAdapter;
  clock: SchedulerClock;
  residency?: ResidencyProbe | undefined;
  onEvent?: ((event: SchedulerEvent) => void) | undefined;
  constants?: Partial<AffinityConstants>;
  random?: () => number;
}

const METRIC_WINDOW = 50;

/**
 * A per-provider scheduler: Layer 1 (semaphore + optional rpm/tpm token buckets) always
 * applies. Layer 2 (model-affinity quantum scheduling) only activates when `swapCostMs > 0` —
 * for cheap-to-swap providers, tickets are just served in priority/age order.
 */
export class AffinityScheduler implements Scheduler {
  private readonly providerId: string;
  private readonly limits: ProviderLimits;
  private readonly adapter: ProviderAdapter;
  private readonly clock: SchedulerClock;
  private readonly residency: ResidencyProbe | undefined;
  private readonly onEvent: ((event: SchedulerEvent) => void) | undefined;
  private readonly constants: AffinityConstants;
  private readonly random: () => number;
  private readonly rpmBucket: TokenBucket | undefined;
  private readonly tpmBucket: TokenBucket | undefined;
  private readonly affinityEnabled: boolean;

  private readonly queues = new Map<string, QueuedTicket[]>();
  private readonly inFlightByModel = new Map<string, number>();
  private readonly metrics = new Map<string, ModelMetrics>();
  private availableSlots: number;
  private currentModel: string | undefined;
  private servedInQuantum = 0;
  private totalQueued = 0;
  private swapCount = 0;
  private consecutiveFatals = 0;
  private circuitOpenUntil: number | undefined;

  constructor(opts: AffinitySchedulerOptions) {
    this.providerId = opts.providerId;
    this.limits = opts.limits;
    this.adapter = opts.adapter;
    this.clock = opts.clock;
    this.residency = opts.residency;
    this.onEvent = opts.onEvent;
    this.constants = { ...DEFAULT_CONSTANTS, ...opts.constants };
    this.random = opts.random ?? Math.random;
    this.availableSlots = opts.limits.maxParallel;
    this.affinityEnabled = (opts.limits.swapCostMs ?? 0) > 0;
    this.rpmBucket = opts.limits.rpm ? new TokenBucket({ ratePerMinute: opts.limits.rpm, clock: opts.clock }) : undefined;
    this.tpmBucket = opts.limits.tpm ? new TokenBucket({ ratePerMinute: opts.limits.tpm, clock: opts.clock }) : undefined;
  }

  async submit(req: ProviderCallRequest, opts: SubmitOptions = {}): Promise<ProviderCallResult> {
    if (this.circuitOpenUntil !== undefined) {
      if (this.clock.now() < this.circuitOpenUntil) {
        throw new CircuitOpenError(this.providerId);
      }
      this.circuitOpenUntil = undefined;
    }
    const maxQueue = this.limits.maxQueue ?? 512;
    if (this.totalQueued >= maxQueue) {
      throw new QueueFullError(maxQueue);
    }

    return new Promise<ProviderCallResult>((resolve, reject) => {
      const priority = opts.priority ?? "normal";
      const ticket: QueuedTicket = {
        req,
        priority,
        estTokens: opts.estTokens,
        enqueuedAt: this.clock.now(),
        resolve,
        reject,
      };
      let queue = this.queues.get(req.modelId);
      if (!queue) {
        queue = [];
        this.queues.set(req.modelId, queue);
      }
      queue.push(ticket);
      this.totalQueued++;
      this.onEvent?.({
        kind: "queue_admitted",
        providerId: this.providerId,
        modelId: req.modelId,
        priority,
        queueDepth: queue.length,
      });
      if (this.affinityEnabled && priority === "interactive" && req.modelId !== this.currentModel) {
        this.servedInQuantum = this.constants.quantum;
      }
      this.tryDispatch();
    });
  }

  getStats(): SchedulerStats {
    const models: Record<string, ModelStats> = {};
    const modelIds = new Set([...this.queues.keys(), ...this.metrics.keys()]);
    for (const modelId of modelIds) {
      const m = this.metrics.get(modelId);
      const waits = [...(m?.waitSamples ?? [])].sort((a, b) => a - b);
      models[modelId] = {
        queueDepth: this.queues.get(modelId)?.length ?? 0,
        waitMsP50: percentile(waits, 0.5),
        waitMsP95: percentile(waits, 0.95),
        tokensPerSecond: m && m.latencyMs > 0 ? m.tokens / (m.latencyMs / 1000) : 0,
      };
    }
    return { currentModel: this.currentModel, swapCount: this.swapCount, models };
  }

  private tryDispatch(): void {
    while (this.availableSlots > 0) {
      const winner = this.affinityEnabled ? this.pickWinnerModel() : this.pickWinnerFlat();
      if (winner === undefined) return;
      const queue = this.queues.get(winner);
      const ticket = queue?.shift();
      if (!ticket) continue;
      this.totalQueued--;
      void this.dispatchTicket(winner, ticket);
    }
  }

  /** Layer 2: model-affinity quantum scheduling, only reached when swapCostMs > 0. */
  private pickWinnerModel(): string | undefined {
    const needsRescore =
      this.currentModel === undefined ||
      (this.queues.get(this.currentModel)?.length ?? 0) === 0 ||
      this.servedInQuantum >= this.constants.quantum;

    if (!needsRescore) return this.currentModel;

    const scored = this.scoreCandidates();
    if (scored.length === 0) return undefined;
    const winner = scored[0]!.modelId;

    if (winner !== this.currentModel) {
      if (this.currentModel !== undefined && (this.inFlightByModel.get(this.currentModel) ?? 0) > 0) {
        return undefined; // still draining the old model; retry once it fully releases
      }
      this.swapCount++;
      this.onEvent?.({ kind: "model_swap", providerId: this.providerId, from: this.currentModel, to: winner });
      this.currentModel = winner;
    }
    this.servedInQuantum = 0;
    return winner;
  }

  /** No swap cost: just serve whichever queued ticket scores highest, no model stickiness. */
  private pickWinnerFlat(): string | undefined {
    const scored = this.scoreCandidates();
    return scored[0]?.modelId;
  }

  private scoreCandidates(): { modelId: string; score: number }[] {
    const now = this.clock.now();
    const candidates = [...this.queues.entries()].filter(([, q]) => q.length > 0);
    return candidates
      .map(([modelId, q]) => ({ modelId, score: this.score(modelId, q[0]!, now) }))
      .sort((a, b) => b.score - a.score);
  }

  private score(modelId: string, head: QueuedTicket, now: number): number {
    const c = this.constants;
    const residentBonus = this.residency?.isResident(modelId) ? c.residentBonus : 0;
    const ageBonus = Math.min((now - head.enqueuedAt) / c.starvationMs, 1) * c.ageWeight;
    return residentBonus + c.priorityWeight[head.priority] + ageBonus;
  }

  private async dispatchTicket(modelId: string, ticket: QueuedTicket): Promise<void> {
    this.availableSlots--;
    this.inFlightByModel.set(modelId, (this.inFlightByModel.get(modelId) ?? 0) + 1);
    if (this.affinityEnabled) this.servedInQuantum++;

    const waitMs = this.clock.now() - ticket.enqueuedAt;
    this.recordWait(modelId, waitMs);
    this.onEvent?.({ kind: "call_started", providerId: this.providerId, modelId, waitMs });
    const startedAt = this.clock.now();

    try {
      const result = await this.executeWithRetry(ticket);
      this.consecutiveFatals = 0;
      this.recordThroughput(modelId, result.completionTokens ?? 0, this.clock.now() - startedAt);
      this.onEvent?.({
        kind: "call_finished",
        providerId: this.providerId,
        modelId,
        latencyMs: this.clock.now() - startedAt,
      });
      ticket.resolve(result);
    } catch (err) {
      ticket.reject(err);
    } finally {
      this.availableSlots++;
      this.inFlightByModel.set(modelId, (this.inFlightByModel.get(modelId) ?? 1) - 1);
      this.tryDispatch();
    }
  }

  private async executeWithRetry(ticket: QueuedTicket): Promise<ProviderCallResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        if (this.rpmBucket) await this.rpmBucket.consume(1);
        if (this.tpmBucket) await this.tpmBucket.consume(ticket.estTokens ?? 1);
        return await this.adapter.call(ticket.req);
      } catch (err) {
        const failureClass = classifyFailure(err);
        if (failureClass === "fatal") {
          this.consecutiveFatals++;
          if (this.consecutiveFatals >= this.constants.circuitBreakerThreshold) {
            this.circuitOpenUntil = this.clock.now() + this.constants.circuitOpenMs;
            this.onEvent?.({ kind: "circuit_open", providerId: this.providerId });
          }
          throw err;
        }
        const maxAttempts = failureClass === "transient" ? 3 : 10;
        if (attempt >= maxAttempts) throw err;

        this.onEvent?.({
          kind: "call_retry",
          providerId: this.providerId,
          modelId: ticket.req.modelId,
          attempt,
          failureClass,
        });
        const backoffMs =
          err instanceof ProviderCallError && err.retryAfterMs !== undefined
            ? err.retryAfterMs
            : fullJitterBackoffMs(attempt, this.random);
        await new Promise<void>((resolve) => this.clock.setTimer(resolve, backoffMs));
      }
    }
  }

  private recordWait(modelId: string, waitMs: number): void {
    const m = this.metricsFor(modelId);
    m.waitSamples.push(waitMs);
    if (m.waitSamples.length > METRIC_WINDOW) m.waitSamples.shift();
  }

  private recordThroughput(modelId: string, tokens: number, latencyMs: number): void {
    const m = this.metricsFor(modelId);
    m.tokens += tokens;
    m.latencyMs += latencyMs;
  }

  private metricsFor(modelId: string): ModelMetrics {
    let m = this.metrics.get(modelId);
    if (!m) {
      m = { waitSamples: [], tokens: 0, latencyMs: 0 };
      this.metrics.set(modelId, m);
    }
    return m;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

function fullJitterBackoffMs(attempt: number, random: () => number): number {
  const cap = 5000;
  const base = Math.min(cap, 100 * 2 ** (attempt - 1));
  return random() * base;
}
