import type { TokenUsage } from "./types.js";

/**
 * Prefix-cache hit-rate telemetry (M18).
 *
 * The harness earns cache hits by keeping its prompt prefix byte-stable; this
 * checks that it did. Each step's hit rate is recorded with what kind of step
 * it was. A tool-result step (the previous step's prompt plus one
 * observation) should reuse almost all of its prompt, so a hit rate under the
 * threshold there means something upstream of the tail changed: an alert.
 */
export type CacheStepKind = "first" | "tool_result" | "other";

export interface CacheStepRecord {
  step: number;
  kind: CacheStepKind;
  promptTokens: number;
  cachedPromptTokens: number;
  cacheHitRate: number;
  alert: boolean;
}

export interface CacheSummary {
  steps: number;
  /** Token-weighted: total cached over total prompt tokens. */
  hitRate: number | undefined;
  toolResultHitRate: number | undefined;
  alerts: number;
  /** Steps whose usage carried no cache figures (Ollama, old servers). */
  unmeasured: number;
}

export const CACHE_ALERT_THRESHOLD = 0.85;

export class PrefixCacheMonitor {
  private records: CacheStepRecord[] = [];
  private unmeasured = 0;

  constructor(
    private threshold = CACHE_ALERT_THRESHOLD,
    private onAlert?: (record: CacheStepRecord) => void,
  ) {}

  /** Record one step. Returns the record, or undefined when usage had no cache figures. */
  public record(step: number, kind: CacheStepKind, usage: TokenUsage): CacheStepRecord | undefined {
    if (usage.cacheHitRate === undefined || usage.cachedPromptTokens === undefined) {
      this.unmeasured++;
      return undefined;
    }
    const promptTokens =
      usage.evaluatedPromptTokens !== undefined
        ? usage.cachedPromptTokens + usage.evaluatedPromptTokens
        : usage.promptTokens;
    const record: CacheStepRecord = {
      step,
      kind,
      promptTokens,
      cachedPromptTokens: usage.cachedPromptTokens,
      cacheHitRate: usage.cacheHitRate,
      alert: kind === "tool_result" && usage.cacheHitRate < this.threshold,
    };
    this.records.push(record);
    if (record.alert) this.onAlert?.(record);
    return record;
  }

  public steps(): readonly CacheStepRecord[] {
    return this.records;
  }

  public summary(): CacheSummary {
    const rate = (rs: CacheStepRecord[]): number | undefined => {
      const total = rs.reduce((a, r) => a + r.promptTokens, 0);
      return total > 0 ? rs.reduce((a, r) => a + r.cachedPromptTokens, 0) / total : undefined;
    };
    return {
      steps: this.records.length,
      hitRate: rate(this.records),
      toolResultHitRate: rate(this.records.filter((r) => r.kind === "tool_result")),
      alerts: this.records.filter((r) => r.alert).length,
      unmeasured: this.unmeasured,
    };
  }
}

/**
 * Prefill and decode throughput per model (M3, `measureThroughput`).
 *
 * Token-weighted means over every request that reported timings, so a long
 * prefill counts for more than a two-token one. `predictMs` turns them into
 * a time estimate for a request, which is what a time budget needs.
 */
export interface ThroughputStats {
  modelId: string;
  requests: number;
  prefillTokens: number;
  prefillMs: number;
  decodeTokens: number;
  decodeMs: number;
  /** Tokens/s, undefined until measured. */
  prefillTokensPerSecond: number | undefined;
  decodeTokensPerSecond: number | undefined;
}

/** A model's loads of one kind: how many, their total and the first (MS-T7-1). */
export interface LoadStat {
  count: number;
  totalMs: number;
  firstMs: number;
}

export class ThroughputMeter {
  private stats = new Map<
    string,
    { requests: number; pT: number; pMs: number; dT: number; dMs: number }
  >();

  private loadTimes = new Map<string, { loadMs?: LoadStat; spawnToHealthyMs?: LoadStat }>();

  /**
   * Every load of each model, kept apart from its requests (MS-T7-1): the
   * server-reported load (Ollama) and, for a server the harness started, the
   * time from spawn to healthy — counted and totalled, so a reload after a
   * swap or a memory-guard unload is reported too (review M3).
   */
  public loads(): { modelId: string; loadMs?: LoadStat; spawnToHealthyMs?: LoadStat }[] {
    return [...this.loadTimes].map(([modelId, l]) => ({ modelId, ...l }));
  }

  /** Fold one request's usage in. Requests without server timings count only as requests. */
  public record(modelId: string, usage: TokenUsage): void {
    if (usage.loadMs !== undefined || usage.spawnToHealthyMs !== undefined) {
      const l = this.loadTimes.get(modelId) ?? {};
      const add = (stat: LoadStat | undefined, ms: number): LoadStat =>
        stat
          ? { count: stat.count + 1, totalMs: stat.totalMs + ms, firstMs: stat.firstMs }
          : { count: 1, totalMs: ms, firstMs: ms };
      if (usage.loadMs !== undefined) l.loadMs = add(l.loadMs, usage.loadMs);
      if (usage.spawnToHealthyMs !== undefined)
        l.spawnToHealthyMs = add(l.spawnToHealthyMs, usage.spawnToHealthyMs);
      this.loadTimes.set(modelId, l);
    }
    const s = this.stats.get(modelId) ?? { requests: 0, pT: 0, pMs: 0, dT: 0, dMs: 0 };
    s.requests++;
    const evaluated = usage.evaluatedPromptTokens ?? usage.promptTokens;
    if (usage.prefillTokensPerSecond !== undefined && evaluated > 0) {
      s.pT += evaluated;
      s.pMs += usage.prefillMs ?? (evaluated / usage.prefillTokensPerSecond) * 1000;
    }
    if (usage.decodeTokensPerSecond !== undefined && usage.completionTokens > 0) {
      s.dT += usage.completionTokens;
      s.dMs += usage.decodeMs ?? (usage.completionTokens / usage.decodeTokensPerSecond) * 1000;
    }
    this.stats.set(modelId, s);
  }

  public get(modelId: string): ThroughputStats | undefined {
    const s = this.stats.get(modelId);
    if (!s) return undefined;
    const tps = (t: number, ms: number): number | undefined =>
      ms > 0 ? Math.round((t / (ms / 1000)) * 100) / 100 : undefined;
    return {
      modelId,
      requests: s.requests,
      prefillTokens: s.pT,
      prefillMs: Math.round(s.pMs),
      decodeTokens: s.dT,
      decodeMs: Math.round(s.dMs),
      prefillTokensPerSecond: tps(s.pT, s.pMs),
      decodeTokensPerSecond: tps(s.dT, s.dMs),
    };
  }

  public all(): ThroughputStats[] {
    return [...this.stats.keys()]
      .sort()
      .map((id) => this.get(id))
      .filter((s): s is ThroughputStats => s !== undefined);
  }

  /** Predicted wall time for a request, or undefined until both speeds are measured. */
  public predictMs(
    modelId: string,
    uncachedPromptTokens: number,
    completionTokens: number,
  ): number | undefined {
    const s = this.get(modelId);
    if (!s?.prefillTokensPerSecond || !s.decodeTokensPerSecond) return undefined;
    return Math.round(
      (uncachedPromptTokens / s.prefillTokensPerSecond +
        completionTokens / s.decodeTokensPerSecond) *
        1000,
    );
  }
}

/**
 * Wrap an adapter so every response feeds a meter and a cache monitor. The
 * step kind is `first` for the first request and `tool_result` after that,
 * unless `kindOf` says otherwise.
 */
export function measureThroughput<
  A extends { modelId: string; generate: (...args: never[]) => Promise<{ usage: TokenUsage }> },
>(adapter: A, meter: ThroughputMeter, cache?: PrefixCacheMonitor): A {
  let step = 0;
  const original = adapter.generate.bind(adapter) as (...args: unknown[]) => Promise<{
    usage: TokenUsage;
  }>;
  const wrapped = async (...args: unknown[]) => {
    const response = await original(...args);
    step++;
    meter.record(adapter.modelId, response.usage);
    cache?.record(step, step === 1 ? "first" : "tool_result", response.usage);
    return response;
  };
  (adapter as { generate: unknown }).generate = wrapped;
  return adapter;
}

export interface ModelTelemetrySnapshot {
  throughput: ThroughputStats[];
  /** Prefix-cache summary per model id. */
  cache: Record<string, CacheSummary>;
  /** Cache alerts (tool-result steps under the threshold), most recent last. */
  alerts: (CacheStepRecord & { modelId: string })[];
}

/**
 * The process-wide telemetry every `HttpInferenceAdapter` feeds (M3, M18).
 *
 * Each adapter records every response here, so throughput and prefix-cache
 * hit rates are measured on the production path without any wrapping. The
 * run report reads `snapshot()`; `ThroughputMeter.predictMs` turns the
 * measured speeds into a time estimate for the budget.
 */
export class ModelTelemetry {
  public meter = new ThroughputMeter();
  private monitors = new Map<string, PrefixCacheMonitor>();
  private steps = new Map<string, number>();
  private alertLog: (CacheStepRecord & { modelId: string })[] = [];

  /** Record one response. Returns the cache record when the server reported one. */
  public record(
    modelId: string,
    kind: CacheStepKind,
    usage: TokenUsage,
    onAlert?: (record: CacheStepRecord) => void,
  ): CacheStepRecord | undefined {
    this.meter.record(modelId, usage);
    let monitor = this.monitors.get(modelId);
    if (!monitor) {
      monitor = new PrefixCacheMonitor(CACHE_ALERT_THRESHOLD);
      this.monitors.set(modelId, monitor);
    }
    const step = (this.steps.get(modelId) ?? 0) + 1;
    this.steps.set(modelId, step);
    const rec = monitor.record(step, kind, usage);
    if (rec?.alert) {
      this.alertLog.push({ ...rec, modelId });
      if (this.alertLog.length > 200) this.alertLog.shift();
      onAlert?.(rec);
    }
    return rec;
  }

  public snapshot(): ModelTelemetrySnapshot {
    const cache: Record<string, CacheSummary> = {};
    for (const [id, m] of [...this.monitors.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      cache[id] = m.summary();
    }
    return { throughput: this.meter.all(), cache, alerts: [...this.alertLog] };
  }

  public reset(): void {
    this.meter = new ThroughputMeter();
    this.monitors.clear();
    this.steps.clear();
    this.alertLog = [];
  }
}

export const modelTelemetry = new ModelTelemetry();
