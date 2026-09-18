import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { factKeysOf, keysCovered } from "./facts.js";
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
  /**
   * Error scope (Integration review A4). A regular expression (case
   * insensitive) or a diagnostic code. When set, the rule matches only while
   * a standing failure's text matches it, and never rides in the card-stable
   * prefix.
   */
  errorPattern?: string;
  /**
   * What the rule is about, for duplicate detection (see `facts.ts`).
   * Inferred from the instruction when absent.
   */
  factKey?: string;
}

export interface MatchRulesOptions {
  cardTitle?: string;
  scopeFiles?: string[];
  /**
   * The failing gate. It no longer pulls a rule in on its own (a typecheck
   * failure used to add every typecheck rule of every card); rules whose
   * `triggerGate` matches are ranked first among those the scope matched.
   */
  triggerGate?: string;
  /**
   * The standing failure's text (excerpts, codes). Error-scoped rules match
   * only while this matches their `errorPattern`. Absent: none match.
   */
  failureText?: string;
  /**
   * Fact keys the prompt already carries from elsewhere (a gate remedy, a
   * higher-priority rule). A rule all of whose keys are covered is left out.
   */
  coveredKeys?: Iterable<string>;
  /** Only rules without `errorPattern` (the card-stable set) or only those with one. */
  scope?: "card" | "error" | "all";
}

/** The fact keys a rule is about: its declared key, else those its text names. */
export function ruleFactKeys(rule: PlaybookRule): string[] {
  if (rule.factKey) return [rule.factKey];
  return factKeysOf(rule.instruction);
}

/** Whether an `errorPattern` matches failure text: a code by word, else a regex. */
export function errorPatternMatches(errorPattern: string, failureText: string): boolean {
  if (/^(?:TS\d{4,5}|lint\/[\w/]+)$/.test(errorPattern)) {
    return new RegExp(`\\b${errorPattern.replace(/\//g, "\\/")}\\b`).test(failureText);
  }
  try {
    return new RegExp(errorPattern, "i").test(failureText);
  } catch {
    // Not a valid regex: treat it as a literal.
    return failureText.toLowerCase().includes(errorPattern.toLowerCase());
  }
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
  /** Rules added for this process only; never written to playbook.toml. */
  private transient: Map<string, PlaybookRule> = new Map();
  /** The file's leading comment block, kept across saves. */
  private header: string | undefined;
  private performance: Map<string, RulePerformance> = new Map();
  private filePath: string;

  constructor(repoRoot: string) {
    this.filePath = join(repoRoot, ".sekhemet", "playbook.toml");
    this.load();
  }

  public load(): void {
    // Transient rules live apart from the file's rules: reloading keeps them.
    this.rules.clear();
    this.performance.clear();
    if (!existsSync(this.filePath)) {
      return;
    }

    let document: TomlTable;
    try {
      const text = readFileSync(this.filePath, "utf-8");
      const lead = /^(?:[ \t]*#[^\n]*\n|[ \t]*\n)+/.exec(text)?.[0];
      this.header = lead?.includes("#") ? lead.trimEnd() : undefined;
      document = parseToml(text);
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
      const errorPattern = asString(table.errorPattern);
      const factKey = asString(table.factKey);

      this.rules.set(id, {
        id,
        pattern,
        instruction,
        ...(originCard ? { originCard } : {}),
        ...(triggerGate ? { triggerGate } : {}),
        ...(effectiveDate ? { effectiveDate } : {}),
        ...(delta ? { evalPassRateDelta: delta } : {}),
        ...(errorPattern ? { errorPattern } : {}),
        ...(factKey ? { factKey } : {}),
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

    const lines: string[] = [
      this.header ?? "# Sekhemet Project Playbook — Versioned Invariant Rules",
      "",
    ];
    for (const rule of this.getPersistentRules()) {
      lines.push("[[rule]]");
      lines.push(`id = ${escapeTomlString(rule.id)}`);
      if (rule.originCard) lines.push(`originCard = ${escapeTomlString(rule.originCard)}`);
      if (rule.triggerGate) lines.push(`triggerGate = ${escapeTomlString(rule.triggerGate)}`);
      lines.push(`pattern = ${escapeTomlString(rule.pattern)}`);
      lines.push(`instruction = ${escapeTomlString(rule.instruction)}`);
      if (rule.errorPattern) lines.push(`errorPattern = ${escapeTomlString(rule.errorPattern)}`);
      if (rule.factKey) lines.push(`factKey = ${escapeTomlString(rule.factKey)}`);
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

  /**
   * Every rule in force: the file's, with transient rules added (a transient
   * rule shadows a file rule with the same id). Sorted by id so the prompt
   * bytes never depend on insertion order.
   */
  public getAllRules(): PlaybookRule[] {
    const merged = new Map(this.rules);
    for (const [id, rule] of this.transient) merged.set(id, rule);
    return Array.from(merged.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Rules that belong to playbook.toml (what the Playbook screen calls seeded). */
  public getPersistentRules(): PlaybookRule[] {
    return Array.from(this.rules.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  public isTransient(id: string): boolean {
    return this.transient.has(id);
  }

  /**
   * Add a rule to playbook.toml. For a human's decision to keep a rule in
   * the project; learned or explored rules for a run use `addTransientRule`.
   */
  public addRule(rule: PlaybookRule): void {
    this.rules.set(rule.id, rule);
    this.save();
  }

  /**
   * Add a rule for this process only (Integration review A5). It matches like
   * any other rule but is never written to playbook.toml, so learned rules no
   * longer leak into the project's file, and retiring one in the
   * LearningStore is enough. A persistent rule with the same id is shadowed
   * for this process, not overwritten on disk.
   */
  public addTransientRule(rule: PlaybookRule): void {
    this.transient.set(rule.id, rule);
  }

  /** Drop every transient rule (between cards or runs). */
  public clearTransientRules(): void {
    this.transient.clear();
  }

  /** Retire a rule: a transient one from memory only, a file rule from the file. */
  public retireRule(id: string): boolean {
    if (this.transient.delete(id)) return true;
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

  /**
   * Rules for a card (Integration review A4, item 3).
   *
   * - `pattern` must match the card's title or scope files.
   * - A rule with `errorPattern` also needs `failureText` to match it, so an
   *   error-scoped rule rides in the prompt only while that error stands.
   * - `triggerGate` ranks; it no longer adds a rule by itself.
   * - Rules whose every fact key is in `coveredKeys` are left out, and of
   *   two matched rules about the same fact only the first (by rank) stays.
   */
  public matchRules(options: MatchRulesOptions): PlaybookRule[] {
    const textToMatch =
      `${options.cardTitle ?? ""} ${(options.scopeFiles ?? []).join(" ")}`.toLowerCase();
    const scope = options.scope ?? "all";
    const gate = options.triggerGate?.toLowerCase();

    const matched = this.getAllRules().filter((rule) => {
      if (scope === "card" && rule.errorPattern) return false;
      if (scope === "error" && !rule.errorPattern) return false;
      if (!rule.pattern || !textToMatch.includes(rule.pattern.toLowerCase())) return false;
      if (rule.errorPattern) {
        return (
          options.failureText !== undefined &&
          errorPatternMatches(rule.errorPattern, options.failureText)
        );
      }
      return true;
    });

    // Stable: gate-matching rules first, then id order.
    const ranked = gate
      ? [
          ...matched.filter((r) => r.triggerGate?.toLowerCase() === gate),
          ...matched.filter((r) => r.triggerGate?.toLowerCase() !== gate),
        ]
      : matched;

    const covered = new Set(options.coveredKeys ?? []);
    const out: PlaybookRule[] = [];
    for (const rule of ranked) {
      const keys = ruleFactKeys(rule);
      if (keysCovered(keys, covered)) continue;
      for (const k of keys) covered.add(k);
      out.push(rule);
    }
    return out;
  }

  /**
   * The rule already stating the fact `text` is about, if any. For
   * deduplicating a proposed learned rule, or a remedy, against the file's
   * rules by fact key rather than by wording (Integration review A3).
   */
  public coveringRule(text: string): PlaybookRule | undefined {
    const keys = factKeysOf(text);
    if (keys.length === 0) return undefined;
    return this.getAllRules().find((rule) => keysCovered(keys, new Set(ruleFactKeys(rule))));
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

/**
 * What to do about each audited rule (C12, design "Skill & playbook
 * diagnostics"): the audit's two halves (over 300 tokens, under +3% pass
 * rate) become a recommendation the doctor prints and a human applies.
 *
 * - `retire`: over budget and measured under the gain bar, or measured as
 *   harmful at any size.
 * - `shorten`: over budget and earning its keep; worth condensing.
 * - `measure`: over budget with no measurement yet; run it both ways.
 * - `keep`: within budget and not harmful.
 */
export interface ContextDebtRecommendation {
  ruleId: string;
  action: "retire" | "shorten" | "measure" | "keep";
  tokens: number;
  reason: string;
}

export function contextDebtRecommendations(
  entries: readonly ContextDebtEntry[],
): ContextDebtRecommendation[] {
  return entries
    .map((e): ContextDebtRecommendation => {
      const harmful = e.hasMeasurement && (e.passRateDelta ?? 0) < 0;
      const overBudget = e.reason.startsWith("costs");
      let action: ContextDebtRecommendation["action"];
      if (harmful || e.flaggedDebt) action = e.hasMeasurement ? "retire" : "measure";
      else if (overBudget) action = "shorten";
      else action = "keep";
      const reason = harmful
        ? `measured harmful (${(e.passRateDelta as number).toFixed(3)} pass rate)`
        : e.reason;
      return { ruleId: e.ruleId, action, tokens: e.tokenEstimate, reason };
    })
    .sort((a, b) => {
      const order = { retire: 0, measure: 1, shorten: 2, keep: 3 } as const;
      return (
        order[a.action] - order[b.action] || b.tokens - a.tokens || a.ruleId.localeCompare(b.ruleId)
      );
    });
}
