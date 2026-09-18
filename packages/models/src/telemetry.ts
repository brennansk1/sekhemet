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

export class ThroughputMeter {
  private stats = new Map<
    string,
    { requests: number; pT: number; pMs: number; dT: number; dMs: number }
  >();

  /** Fold one request's usage in. Requests without server timings count only as requests. */
  public record(modelId: string, usage: TokenUsage): void {
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
