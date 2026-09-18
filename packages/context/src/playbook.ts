import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { estimateTokens } from "./tokens.js";
import { type TomlTable, type TomlValue, escapeTomlString, parseToml } from "./toml.js";

export interface PlaybookRule {
  id: string;
  originCard?: string;
  triggerGate?: string;
  pattern: string;
  instruction: string;
  effectiveDate?: string;
  /** Human-facing record of the measured delta, e.g. `"+0.08"`. */
  evalPassRateDelta?: string;
}

/**
 * Measured effect of a rule (Design §1190, C12).
 *
 * The context-debt criterion is two-sided: a rule is debt when it costs more
 * than 300 tokens AND has not bought at least a +3 percentage-point pass-rate
 * gain. The gain half needs data, which is what this shape carries: pass rates
 * for eval runs with and without the rule, plus the sample sizes that say
 * whether the delta means anything.
 */
export interface RulePerformance {
  ruleId: string;
  /** Eval suite / run the measurement came from. */
  evalRunId?: string;
  samplesWithRule: number;
  samplesWithoutRule: number;
  /** Fraction in [0, 1]. */
  passRateWithRule: number;
  /** Fraction in [0, 1]. */
  passRateWithoutRule: number;
  measuredAt?: string;
}

export interface ContextDebtOptions {
  /** Token cost above which a rule must justify itself. Design: 300. */
  tokenThreshold?: number;
  /** Minimum pass-rate gain that justifies the cost. Design: +0.03. */
  minPassRateGain?: number;
  /** Measurements not already stored on the registry. */
  performance?: RulePerformance[];
  /** Below this many eval samples a measurement is treated as absent. */
  minSamples?: number;
}

export interface ContextDebtEntry {
  ruleId: string;
  tokenEstimate: number;
  /** Measured pass-rate delta as a fraction, when one is available. */
  passRateDelta?: number;
  hasMeasurement: boolean;
  sampleSize: number;
  flaggedDebt: boolean;
  reason: string;
}

const DEFAULT_TOKEN_THRESHOLD = 300;
const DEFAULT_MIN_PASS_RATE_GAIN = 0.03;
const DEFAULT_MIN_SAMPLES = 1;

function asString(value: TomlValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: TomlValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asTables(value: TomlValue | undefined): TomlTable[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is TomlTable =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

/** Accepts `"+0.08"`, `"0.08"`, `"+8%"` and `"-3%"`. */
export function parsePassRateDelta(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const percent = trimmed.endsWith("%");
  const numeric = Number.parseFloat(percent ? trimmed.slice(0, -1) : trimmed);
  if (Number.isNaN(numeric)) return undefined;
  return percent ? numeric / 100 : numeric;
}

export class PlaybookRegistry {
  private rules: Map<string, PlaybookRule> = new Map();
  private performance: Map<string, RulePerformance> = new Map();
  private filePath: string;

  constructor(repoRoot: string) {
    this.filePath = join(repoRoot, ".sekhemet", "playbook.toml");
    this.load();
  }

  public load(): void {
    this.rules.clear();
    this.performance.clear();
    if (!existsSync(this.filePath)) {
      return;
    }

    let document: TomlTable;
    try {
      document = parseToml(readFileSync(this.filePath, "utf-8"));
    } catch {
      // A corrupt playbook must never take the harness down: an empty registry
      // costs a card its conventions, a thrown error costs it the run.
      return;
    }

    for (const table of asTables(document.rule)) {
      const id = asString(table.id);
      const pattern = asString(table.pattern);
      const instruction = asString(table.instruction);
      if (!id || !pattern || !instruction) continue;

      const originCard = asString(table.originCard);
      const triggerGate = asString(table.triggerGate);
      const effectiveDate = asString(table.effectiveDate);
      const delta = asString(table.evalPassRateDelta);

      this.rules.set(id, {
        id,
        pattern,
        instruction,
        ...(originCard ? { originCard } : {}),
        ...(triggerGate ? { triggerGate } : {}),
        ...(effectiveDate ? { effectiveDate } : {}),
        ...(delta ? { evalPassRateDelta: delta } : {}),
      });
    }

    for (const table of asTables(document.performance)) {
      const ruleId = asString(table.ruleId);
      if (!ruleId) continue;
      const evalRunId = asString(table.evalRunId);
      const measuredAt = asString(table.measuredAt);
      this.performance.set(ruleId, {
        ruleId,
        samplesWithRule: asNumber(table.samplesWithRule) ?? 0,
        samplesWithoutRule: asNumber(table.samplesWithoutRule) ?? 0,
        passRateWithRule: asNumber(table.passRateWithRule) ?? 0,
        passRateWithoutRule: asNumber(table.passRateWithoutRule) ?? 0,
        ...(evalRunId ? { evalRunId } : {}),
        ...(measuredAt ? { measuredAt } : {}),
      });
    }
  }

  public save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const lines: string[] = ["# Sekhemet Project Playbook — Versioned Invariant Rules", ""];
    for (const rule of this.getAllRules()) {
      lines.push("[[rule]]");
      lines.push(`id = ${escapeTomlString(rule.id)}`);
      if (rule.originCard) lines.push(`originCard = ${escapeTomlString(rule.originCard)}`);
      if (rule.triggerGate) lines.push(`triggerGate = ${escapeTomlString(rule.triggerGate)}`);
      lines.push(`pattern = ${escapeTomlString(rule.pattern)}`);
      lines.push(`instruction = ${escapeTomlString(rule.instruction)}`);
      if (rule.effectiveDate) lines.push(`effectiveDate = ${escapeTomlString(rule.effectiveDate)}`);
      if (rule.evalPassRateDelta) {
        lines.push(`evalPassRateDelta = ${escapeTomlString(rule.evalPassRateDelta)}`);
      }
      lines.push("");
    }

    for (const perf of this.getAllPerformance()) {
      lines.push("[[performance]]");
      lines.push(`ruleId = ${escapeTomlString(perf.ruleId)}`);
      if (perf.evalRunId) lines.push(`evalRunId = ${escapeTomlString(perf.evalRunId)}`);
      lines.push(`samplesWithRule = ${perf.samplesWithRule}`);
      lines.push(`samplesWithoutRule = ${perf.samplesWithoutRule}`);
      lines.push(`passRateWithRule = ${perf.passRateWithRule}`);
      lines.push(`passRateWithoutRule = ${perf.passRateWithoutRule}`);
      if (perf.measuredAt) lines.push(`measuredAt = ${escapeTomlString(perf.measuredAt)}`);
      lines.push("");
    }

    writeFileSync(this.filePath, lines.join("\n"), "utf-8");
  }

  /** Sorted by id so the Zone 2 bytes never depend on insertion order. */
  public getAllRules(): PlaybookRule[] {
    return Array.from(this.rules.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  public addRule(rule: PlaybookRule): void {
    this.rules.set(rule.id, rule);
    this.save();
  }

  public retireRule(id: string): boolean {
    const deleted = this.rules.delete(id);
    if (deleted) {
      this.performance.delete(id);
      this.save();
    }
    return deleted;
  }

  /** Records (or replaces) the measured effect of a rule and persists it. */
  public setRulePerformance(performance: RulePerformance): void {
    this.performance.set(performance.ruleId, performance);
    this.save();
  }

  public getRulePerformance(ruleId: string): RulePerformance | undefined {
    return this.performance.get(ruleId);
  }

  public getAllPerformance(): RulePerformance[] {
    return Array.from(this.performance.values()).sort((a, b) =>
      a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0,
    );
  }

  public matchRules(options: {
    cardTitle?: string;
    scopeFiles?: string[];
    triggerGate?: string;
  }): PlaybookRule[] {
    const matched: PlaybookRule[] = [];
    const textToMatch =
      `${options.cardTitle ?? ""} ${(options.scopeFiles ?? []).join(" ")}`.toLowerCase();

    for (const rule of this.getAllRules()) {
      let isMatch = false;

      if (options.triggerGate && rule.triggerGate) {
        if (rule.triggerGate.toLowerCase() === options.triggerGate.toLowerCase()) {
          isMatch = true;
        }
      }

      if (rule.pattern && textToMatch.includes(rule.pattern.toLowerCase())) {
        isMatch = true;
      }

      if (isMatch) {
        matched.push(rule);
      }
    }

    return matched;
  }

  public estimateRuleTokens(rule: PlaybookRule): number {
    return estimateTokens(`${rule.pattern} ${rule.instruction}`);
  }

  /**
   * Context-debt audit (Design §1190).
   *
   * A rule is debt only when BOTH halves hold: it costs more than
   * `tokenThreshold` tokens AND it has not produced at least a
   * `minPassRateGain` improvement in measured pass rate. A rule with no
   * measurement at all cannot have earned its keep, so an expensive unmeasured
   * rule is flagged — that is the pressure that makes someone measure it.
   */
  public auditContextDebt(options: ContextDebtOptions = {}): ContextDebtEntry[] {
    const tokenThreshold = options.tokenThreshold ?? DEFAULT_TOKEN_THRESHOLD;
    const minPassRateGain = options.minPassRateGain ?? DEFAULT_MIN_PASS_RATE_GAIN;
    const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;

    const supplied = new Map<string, RulePerformance>();
    for (const perf of options.performance ?? []) supplied.set(perf.ruleId, perf);

    const results: ContextDebtEntry[] = [];
    for (const rule of this.getAllRules()) {
      const tokenEstimate = this.estimateRuleTokens(rule);
      const perf = supplied.get(rule.id) ?? this.performance.get(rule.id);

      let delta: number | undefined;
      let sampleSize = 0;
      if (perf) {
        sampleSize = Math.min(perf.samplesWithRule, perf.samplesWithoutRule);
        if (sampleSize >= minSamples) {
          delta = perf.passRateWithRule - perf.passRateWithoutRule;
        }
      }
      if (delta === undefined) {
        delta = parsePassRateDelta(rule.evalPassRateDelta);
      }

      const hasMeasurement = delta !== undefined;
      const earnsKeep = hasMeasurement && (delta as number) >= minPassRateGain;
      const overBudget = tokenEstimate > tokenThreshold;
      const flaggedDebt = overBudget && !earnsKeep;

      let reason: string;
      if (!overBudget) {
        reason = `within the ${tokenThreshold}-token allowance`;
      } else if (!hasMeasurement) {
        reason = `costs ${tokenEstimate} tokens and has no measured pass-rate effect`;
      } else if (earnsKeep) {
        reason = `costs ${tokenEstimate} tokens but gained ${(delta as number).toFixed(3)} pass rate`;
      } else {
        reason = `costs ${tokenEstimate} tokens for only ${(delta as number).toFixed(3)} pass-rate gain`;
      }

      results.push({
        ruleId: rule.id,
        tokenEstimate,
        ...(delta !== undefined ? { passRateDelta: delta } : {}),
        hasMeasurement,
        sampleSize,
        flaggedDebt,
        reason,
      });
    }

    return results;
  }
}
