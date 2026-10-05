import { createHash } from "node:crypto";
import type { EventLog, EventRecord } from "@sekhemet/kernel";
import { MODEL_ROLES, type ModelRole, type RoleSettingValues } from "@sekhemet/models";
import type {
  CacheKey,
  Combination,
  CombinationResult,
  ItemScore,
  PairedComparison,
  RoleScore,
  Score,
} from "./combination_types.js";
import { type RunProfile, runProfileHash } from "./run_profile.js";
import type { ScreeningItem, ScreeningSets } from "./screening_sets.js";
import { exactMcNemar } from "./stats.js";

/**
 * The quick benchmark of a model combination (measurement NEW-measurement-5,
 * rules 30–36; MS-N5-1–8): role by role, each role's screening set run once
 * per candidate model, cached, compared item by item with the exact sign
 * test, and recorded as one `measure/benchmarked` event of tier `quick`.
 *
 * It runs models, so it takes its runner as an argument and every run goes
 * through `measurementRun` (Smart Swap's `withMeasurementRun`, DEC-45: the
 * policy is bypassed and the models are unloaded when it ends). A quick
 * score is never a bake-off: no admission, qualification, baseline or
 * shipped-default decision reads it (MS-N5-8; `assignments.ts` refuses it).
 */

export const MEASURE_BENCHMARKED = "measure/benchmarked";

/** Rule 32's targets, each including load, in minutes. */
export const SCREEN_TARGET_MINUTES = {
  worker: 17,
  planner: 5,
  reviewer: 5,
  researcher: 5,
  endToEnd: 10,
  total: 45,
} as const;

/** A load when nothing is recorded or registered: the reference machine's USB drive (rule 32). */
export const DEFAULT_LOAD_SECONDS = 300;
/** Role switches the end-to-end check makes across its two cards (Planner → Worker → Reviewer each). */
const END_TO_END_SWITCHES = 4;
const ALPHA = 0.05;

// ── scoring (MS-N5-3) ───────────────────────────────────────────────────

/** What one screening item produced, by role (rule 31). */
export type ItemOutcome =
  /** A Worker card: its acceptance tests passing when it finished or hit its cap. */
  | { kind: "tests"; passed: number; total: number }
  /** A Planner brief: the annotated requirements its plan covers. */
  | { kind: "recall"; covered: number; annotated: number }
  /** A Reviewer defect: found at its location; false findings reported beside. */
  | { kind: "detection"; detectedAtLocation: boolean; falseFindings?: number }
  /** A Researcher answer: wrong or unsourced, partly right, right and sourced. */
  | { kind: "grade"; grade: 0 | 0.5 | 1 };

/** An item's graded score, 0–1 (MS-N5-3). */
export function scoreItem(o: ItemOutcome): number {
  switch (o.kind) {
    case "tests":
      return o.total > 0 ? Math.min(1, Math.max(0, o.passed / o.total)) : 0;
    case "recall":
      return o.annotated > 0 ? Math.min(1, Math.max(0, o.covered / o.annotated)) : 0;
    case "detection":
      return o.detectedAtLocation ? 1 : 0;
    case "grade":
      if (o.grade !== 0 && o.grade !== 0.5 && o.grade !== 1)
        throw new Error(`A Researcher answer is graded 0, ½ or 1, not ${o.grade} (MS-N5-3)`);
      return o.grade;
  }
}

// ── the paired comparison (MS-N5-4, rule 35) ────────────────────────────

/**
 * Two candidates for a role compared on the items both scored, by the exact
 * two-sided sign test on the per-item differences, ties set aside (rule 35,
 * MS-N5-4). `indistinguishable` when the test does not reject at 0.05; then
 * neither is ranked above the other. Never interval overlap.
 */
export function compareOnItems(
  role: ModelRole,
  a: { model: string; items: readonly ItemScore[] },
  b: { model: string; items: readonly ItemScore[] },
  alpha = ALPHA,
): PairedComparison {
  const other = new Map(b.items.map((i) => [i.id, i.score]));
  let better = 0;
  let worse = 0;
  let ties = 0;
  for (const item of a.items) {
    const theirs = other.get(item.id);
    if (theirs === undefined) continue;
    if (item.score > theirs) better++;
    else if (item.score < theirs) worse++;
    else ties++;
  }
  const p = exactMcNemar(better, worse);
  return { role, a: a.model, b: b.model, better, worse, ties, p, indistinguishable: !(p < alpha) };
}

/**
 * Two role scores compared, or why the role is left out (MS-N5-4b): a role
 * not measured on a complete set is in no comparison.
 */
export function compareRoleScores(
  a: RoleScore,
  b: RoleScore,
): PairedComparison | { role: RoleScore["role"]; excluded: string } {
  const missing = [a, b].find((s) => s.state !== "measured" || !s.items?.length);
  if (missing)
    return {
      role: a.role,
      excluded: `${missing.model} is not measured for the ${missing.role} on a complete screening set, so this role is left out of the comparison`,
    };
  return compareOnItems(a.role as ModelRole, a as Required<RoleScore>, b as Required<RoleScore>);
}

// ── settings in the combination (NEW-measurement-8, rule 39) ────────────

/**
 * The values a run applies without its own load (rule 39): per request
 * (temperature, reasoning level and thinking cap) or through the run's
 * `RunProfile` (thinking policy, working method, evidence check, step
 * budget), and the tool arm the run's adapter offers. Everything else —
 * context, KV type, the engine's values — needs its own load and is a
 * person's choice on Customize (models MD-N21-1).
 */
export const RUN_SETTING_KEYS = [
  "temperature",
  "reasoningLevel",
  "reasoningCapTokens",
  "reasoningPolicy",
  "method",
  "evidenceGate",
  "toolArm",
  "stepBudget",
] as const;
export type RunSettingKey = (typeof RUN_SETTING_KEYS)[number];
export type RunSettings = Pick<RoleSettingValues, RunSettingKey>;

/** A combination with, per role, the run-level settings it is measured at (rule 39). */
export interface SettingsCombination extends Combination {
  settings?: Partial<Record<ModelRole, RunSettings>>;
}

/** A combination naming a value a run cannot apply, or a value out of range (MS-N8-1). */
export class SettingsRefusal extends Error {
  constructor(
    message: string,
    readonly key: string,
    readonly role: ModelRole,
  ) {
    super(message);
    this.name = "SettingsRefusal";
  }
}

const CHOICES: Partial<Record<RunSettingKey, readonly string[]>> = {
  reasoningLevel: ["off", "low", "medium", "high"],
  reasoningPolicy: ["off", "surgical", "all"],
  method: ["baseline", "strict"],
  evidenceGate: ["off", "on"],
  toolArm: ["auto", "arm_a_flat", "arm_b_json", "arm_c_sketch"],
};

const ROLE_WORDS: Record<ModelRole, string> = {
  worker: "Coding model",
  planner: "Planning model",
  reviewer: "Review model",
  researcher: "Research model",
};

/** Why a combination's settings cannot run (MS-N8-1), or undefined. Checked before anything loads. */
export function runSettingsRefusal(c: SettingsCombination): SettingsRefusal | undefined {
  for (const role of MODEL_ROLES) {
    const values = (c.settings?.[role] ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      if (!(RUN_SETTING_KEYS as readonly string[]).includes(key))
        return new SettingsRefusal(
          `${key} needs the ${ROLE_WORDS[role]} loaded with it, so a benchmark cannot try it run by run: set it on Configuration › Models › Customize, where the model is verified with it.`,
          key,
          role,
        );
      const choices = CHOICES[key as RunSettingKey];
      const ok = choices
        ? typeof value === "string" && choices.includes(value)
        : key === "temperature"
          ? typeof value === "number" && value >= 0 && value <= 2
          : typeof value === "number" && Number.isInteger(value) && value >= 1;
      if (!ok)
        return new SettingsRefusal(
          `${String(value)} is not a value for ${key}${choices ? `: it is one of ${choices.join(", ")}` : key === "temperature" ? ": it is 0 to 2" : ": it is a whole number of 1 or more"}.`,
          key,
          role,
        );
    }
  }
  return undefined;
}

/** One role's settings as one stable string, keys sorted: `reasoningLevel=medium,temperature=0`. */
export function settingsText(values: Readonly<Record<string, unknown>>): string {
  return Object.keys(values)
    .filter((k) => values[k] !== undefined)
    .sort()
    .map((k) => `${k}=${String(values[k])}`)
    .join(",");
}

/** A role's settings back from `settingsText`. */
export function parseSettingsText(text: string): RunSettings {
  const out: Record<string, string | number | boolean> = {};
  for (const part of text.split(",")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const key = part.slice(0, at);
    const raw = part.slice(at + 1);
    out[key] =
      raw === "true"
        ? true
        : raw === "false"
          ? false
          : /^-?\d+(\.\d+)?$/.test(raw)
            ? Number(raw)
            : raw;
  }
  return out as RunSettings;
}

const WORDS: Record<string, (v: unknown) => string> = {
  temperature: (v) => `temperature ${v}`,
  reasoningLevel: (v) => `reasoning ${v}`,
  reasoningCapTokens: (v) => `thinking cap ${Number(v).toLocaleString("en-US")}`,
  reasoningPolicy: (v) => `thinking policy ${v}`,
  method: (v) => `working method ${v}`,
  evidenceGate: (v) => `evidence check ${v}`,
  toolArm: (v) => `tool arm ${v}`,
  stepBudget: (v) => `step budget ${v}`,
};

/** A role's settings in words, as the page and the standup say them: `temperature 0.2, reasoning medium`. */
export function settingsWords(values: Readonly<Record<string, unknown>>): string {
  return Object.keys(values)
    .filter((k) => values[k] !== undefined)
    .map((k) =>
      WORDS[k] ? (WORDS[k] as (v: unknown) => string)(values[k]) : `${k} ${String(values[k])}`,
    )
    .join(", ");
}

/** The suffix a role's settings are recorded under beside its model: `worker.settings`. */
const SETTINGS_SUFFIX = ".settings";

/**
 * A combination as the ledger records it (`measure/benchmarked`'s and
 * `measure/benchmark_started`'s record of strings): each role's model, and
 * each role's settings as `<role>.settings` (rule 39).
 */
export function combinationRecord(c: SettingsCombination): Record<string, string> {
  const out: Record<string, string> = {};
  for (const role of MODEL_ROLES) {
    const model = modelFor(c, role);
    if (model) out[role] = model;
  }
  for (const role of MODEL_ROLES) {
    const text = settingsText(c.settings?.[role] ?? {});
    if (text && modelFor(c, role)) out[`${role}${SETTINGS_SUFFIX}`] = text;
  }
  return out;
}

/** A combination back from its record, its settings included. */
export function combinationFromRecord(r: Readonly<Record<string, string>>): SettingsCombination {
  const settings: Partial<Record<ModelRole, RunSettings>> = {};
  for (const role of MODEL_ROLES) {
    const text = r[`${role}${SETTINGS_SUFFIX}`];
    if (text) settings[role] = parseSettingsText(text);
  }
  return {
    worker: r.worker ?? "",
    planner: r.planner ?? "",
    ...(r.reviewer ? { reviewer: r.reviewer } : {}),
    ...(r.researcher ? { researcher: r.researcher } : {}),
    ...(Object.keys(settings).length ? { settings } : {}),
  };
}

/** The settings part of a combination's identity: empty when it has none. */
function settingsIdentity(c: SettingsCombination): string {
  return MODEL_ROLES.map((role) => {
    const text = settingsText(c.settings?.[role] ?? {});
    return text ? `${role}:${text}` : "";
  })
    .filter(Boolean)
    .join(";");
}

// ── keys and ids ────────────────────────────────────────────────────────

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The one stable string a role's quick score is cached under (rule 33). */
export function cacheKeyString(key: CacheKey): string {
  return `ck_${sha(
    JSON.stringify([
      key.model,
      key.quantisation,
      key.engine,
      key.settings,
      key.host,
      key.contextVersion,
      key.setHash,
    ]),
  ).slice(0, 32)}`;
}

/**
 * A combination's id, derived from its four model ids and the host
 * (PM_CONTRACT), and its settings when it has any (rule 39): a combination
 * without settings keeps the id it had before settings existed.
 */
export function combinationId(c: SettingsCombination, host: string): string {
  const settings = settingsIdentity(c);
  return `cmb_${sha(
    JSON.stringify([
      c.worker,
      c.planner,
      c.reviewer ?? "",
      c.researcher ?? "",
      host,
      ...(settings ? [settings] : []),
    ]),
  ).slice(0, 16)}`;
}

/** A combination's model for a role. */
export function modelFor(c: Combination, role: ModelRole): string | undefined {
  return role === "worker"
    ? c.worker
    : role === "planner"
      ? c.planner
      : role === "reviewer"
        ? c.reviewer
        : c.researcher;
}

// ── the cache, read from the ledger (rule 33, MS-N5-2) ──────────────────

/** A recorded role entry of a `measure/benchmarked` event. */
interface RecordedRole {
  role: string;
  model: string;
  state: RoleScore["state"];
  cacheKey?: string;
  setHash?: string;
  score?: number | null;
  low?: number | null;
  high?: number | null;
  items?: ItemScore[];
  capped?: number;
  secondary?: {
    secondsPerItem?: number;
    validToolCallRate?: number | null;
    stepsToPass?: number;
    fits: boolean;
  };
}

interface BenchmarkedPayload {
  tier: "quick" | "overnight";
  profileHash: string;
  host?: string;
  combination?: Record<string, string>;
  partial: boolean;
  roles: RecordedRole[];
  comparisons: PairedComparison[];
  endToEnd?: { passed: number; total: number };
  resolved?: { role?: string; better: string; worse: string; p: number }[];
  indistinguishable?: { role?: string; a: string; b: string; p: number }[];
}

/** A cached quick score: the role's score with the key and set hash it is cached under. */
export type QuickScoreRecord = RoleScore & { key: string; setHash: string; seq: number };

function roleScoreOf(r: RecordedRole, measuredAt: string): RoleScore {
  const n = r.items?.length ?? 0;
  return {
    role: r.role as ModelRole,
    model: r.model,
    state: r.state,
    ...(typeof r.score === "number"
      ? {
          score: {
            value: r.score,
            n,
            ...(typeof r.low === "number" ? { low: r.low } : {}),
            ...(typeof r.high === "number" ? { high: r.high } : {}),
            kind: "graded",
          } satisfies Score,
        }
      : {}),
    measuredAt,
    ...(r.items ? { items: r.items } : {}),
    ...(r.capped !== undefined ? { capped: r.capped } : {}),
    ...(r.secondary
      ? {
          secondary: {
            fits: r.secondary.fits,
            ...(r.secondary.secondsPerItem !== undefined
              ? { secondsPerItem: r.secondary.secondsPerItem }
              : {}),
            ...(typeof r.secondary.validToolCallRate === "number"
              ? { validToolCallRate: r.secondary.validToolCallRate }
              : {}),
            ...(r.secondary.stepsToPass !== undefined
              ? { stepsToPass: r.secondary.stepsToPass }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * The cached quick scores (rule 33): for each cache key, its latest role
 * score measured on a complete set. Only `tier: "quick"` events are read,
 * and only for the Configuration page and the recommendation (rule 36) —
 * never for admission, qualification or a baseline (MS-N5-8).
 */
export async function readQuickScores(
  log: EventLog,
  filter: { role?: ModelRole; model?: string } = {},
): Promise<QuickScoreRecord[]> {
  const latest = new Map<string, QuickScoreRecord>();
  for (const e of await log.getEventsByTypes([MEASURE_BENCHMARKED])) {
    const p = e.payload as BenchmarkedPayload;
    if (p.tier !== "quick") continue;
    for (const r of p.roles ?? []) {
      if (r.state !== "measured" || !r.cacheKey || !r.setHash) continue;
      if (filter.role && r.role !== filter.role) continue;
      if (filter.model && r.model !== filter.model) continue;
      latest.set(r.cacheKey, {
        ...roleScoreOf(r, e.createdAt),
        key: r.cacheKey,
        setHash: r.setHash,
        seq: e.seq,
      });
    }
  }
  return [...latest.values()].sort((a, b) => a.seq - b.seq);
}

/** Every quick `measure/benchmarked` event, oldest first (the page's history). */
export async function quickEvents(log: EventLog): Promise<EventRecord[]> {
  return (await log.getEventsByTypes([MEASURE_BENCHMARKED])).filter(
    (e) => (e.payload as BenchmarkedPayload).tier === "quick",
  );
}

// ── the estimate (MS-N5-1, rule 32) ─────────────────────────────────────

export interface Figure {
  seconds: number;
  /** Recorded on this host, else the registry's figures (rule 32). */
  source: "recorded" | "registry";
}

/** Where the estimate's numbers come from. */
export interface Throughput {
  secondsPerItem(role: ModelRole, model: string): Figure | undefined;
  loadSeconds(model: string): Figure | undefined;
}

/** Whether a role's model fits this host (models NEW-models-12; MS-N5-5). */
export interface FitCheck {
  fits: boolean;
  /** "Needs N GB" for a model that does not fit. */
  needsGb?: number;
  /** When the combination's models cannot co-reside: seconds per role switch. */
  swapSecondsPerSwitch?: number;
}

export interface RoleEstimate {
  role: ModelRole;
  model?: string;
  state: "to_measure" | "cached" | "not_measured" | "does_not_fit";
  minutes: number;
  loadMinutes: number;
  targetMinutes: number;
  overTarget: boolean;
  /** Where the per-item time came from; `cap` when nothing is recorded or registered. */
  source?: Figure["source"] | "cap";
  needsGb?: number;
  reason?: string;
}

export interface ScreenEstimate {
  roles: RoleEstimate[];
  endToEnd: { minutes: number; overTarget: boolean; cached: boolean; targetMinutes: number };
  totalMinutes: number;
  overTarget: boolean;
  estimateSeconds: number;
  toMeasure: { role: ModelRole; model: string }[];
  /** Seconds per role switch when the models cannot co-reside (MS-N5-5). */
  swapSecondsPerSwitch?: number;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * The estimate before anything loads (MS-N5-1, DB-N6-9): minutes per role
 * and model including load, from recorded throughput (else the registry's
 * figures, else each item at its cap), only for the roles not cached; each
 * over its target marked. Runs nothing.
 */
export function estimateScreen(
  combination: Combination,
  o: {
    sets: ScreeningSets;
    throughput: Throughput;
    cached: (role: ModelRole, model: string) => boolean;
    endToEndCached: boolean;
    fit: (role: ModelRole, model: string) => FitCheck;
  },
): ScreenEstimate {
  const roles: RoleEstimate[] = [];
  let swap = 0;
  for (const role of MODEL_ROLES) {
    const model = modelFor(combination, role);
    const set = o.sets.roles[role];
    const target = SCREEN_TARGET_MINUTES[role];
    const base = { role, ...(model ? { model } : {}), targetMinutes: target, overTarget: false };
    const fit = model ? o.fit(role, model) : undefined;
    if (fit && !fit.fits) {
      // MS-N5-5: listed as needing N GB, never loaded or run.
      roles.push({
        ...base,
        state: "does_not_fit",
        minutes: 0,
        loadMinutes: 0,
        ...(fit.needsGb !== undefined ? { needsGb: fit.needsGb } : {}),
        reason: `needs ${fit.needsGb ?? "more"} GB`,
      });
      continue;
    }
    if (!model || set.state !== "ready") {
      roles.push({
        ...base,
        state: "not_measured",
        minutes: 0,
        loadMinutes: 0,
        reason: model ? (set.reason ?? "not built") : "no model chosen for this role",
      });
      continue;
    }
    swap = Math.max(swap, fit?.swapSecondsPerSwitch ?? 0);
    if (o.cached(role, model)) {
      roles.push({ ...base, state: "cached", minutes: 0, loadMinutes: 0 });
      continue;
    }
    const per = o.throughput.secondsPerItem(role, model);
    const load = o.throughput.loadSeconds(model);
    const itemSeconds = Math.min(per?.seconds ?? set.capSeconds, set.capSeconds);
    const loadSeconds = load?.seconds ?? DEFAULT_LOAD_SECONDS;
    const minutes = round1((set.items.length * itemSeconds + loadSeconds) / 60);
    roles.push({
      ...base,
      state: "to_measure",
      minutes,
      loadMinutes: round1(loadSeconds / 60),
      overTarget: minutes > target,
      source: per?.source ?? "cap",
    });
  }
  const e2eSeconds = o.endToEndCached
    ? 0
    : o.sets.endToEnd.items.length * o.sets.endToEnd.capSeconds + END_TO_END_SWITCHES * swap;
  const e2eMinutes = round1(e2eSeconds / 60);
  const totalMinutes = round1(roles.reduce((s, r) => s + r.minutes, 0) + e2eMinutes);
  return {
    roles,
    endToEnd: {
      minutes: e2eMinutes,
      overTarget: e2eMinutes > SCREEN_TARGET_MINUTES.endToEnd,
      cached: o.endToEndCached,
      targetMinutes: SCREEN_TARGET_MINUTES.endToEnd,
    },
    totalMinutes,
    overTarget:
      totalMinutes > SCREEN_TARGET_MINUTES.total ||
      roles.some((r) => r.overTarget) ||
      e2eMinutes > SCREEN_TARGET_MINUTES.endToEnd,
    estimateSeconds: Math.round(totalMinutes * 60),
    toMeasure: roles
      .filter((r) => r.state === "to_measure" && r.model)
      .map((r) => ({ role: r.role, model: r.model as string })),
    ...(swap > 0 ? { swapSecondsPerSwitch: swap } : {}),
  };
}

/**
 * Throughput recorded on this host (rule 32): a role's latest seconds per
 * item from the quick scores, a model's median recorded load; else the
 * registry's figures when given.
 */
export async function recordedThroughput(
  log: EventLog,
  registry: {
    secondsPerItem?: (role: ModelRole, model: string) => number | undefined;
    loadSeconds?: (model: string) => number | undefined;
  } = {},
): Promise<Throughput> {
  const perItem = new Map<string, number>();
  for (const s of await readQuickScores(log))
    if (s.secondary?.secondsPerItem !== undefined)
      perItem.set(`${s.role}\0${s.model}`, s.secondary.secondsPerItem);
  const loads = new Map<string, number[]>();
  for (const e of await log.getEventsByTypes(["model/loaded"])) {
    const p = e.payload as { model: string; loadMs: number };
    loads.set(p.model, [...(loads.get(p.model) ?? []), p.loadMs]);
  }
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
  };
  return {
    secondsPerItem(role, model) {
      const r = perItem.get(`${role}\0${model}`);
      if (r !== undefined) return { seconds: r, source: "recorded" };
      const g = registry.secondsPerItem?.(role, model);
      return g !== undefined ? { seconds: g, source: "registry" } : undefined;
    },
    loadSeconds(model) {
      const r = loads.get(model);
      if (r?.length) return { seconds: median(r) / 1000, source: "recorded" };
      const g = registry.loadSeconds?.(model);
      return g !== undefined ? { seconds: g, source: "registry" } : undefined;
    },
  };
}

// ── the quick benchmark (MS-N5-2, -3, -5, -6, -7, -8) ───────────────────

/** One screening item as the runner reports it. */
export interface ItemRun {
  outcome: ItemOutcome;
  seconds: number;
  /** The runner stopped it at its cap (MS-N5-3). */
  capped?: boolean;
  stopReason?: string;
  toolCalls?: number;
  validToolCalls?: number;
  steps?: number;
}

/**
 * What runs the items: loads a role's model, runs one screening item under
 * its cap, and runs one end-to-end card through the combination. The
 * harness wires the real one; tests script it.
 */
export interface ScreenRunner {
  load(role: ModelRole, model: string): Promise<{ seconds: number }>;
  runItem(input: {
    role: ModelRole;
    model: string;
    item: ScreeningItem;
    capSeconds: number;
    /** The role's run-level settings for this item (rule 39), and its fixed seed when paired. */
    settings?: RunSettings & { seed?: number };
  }): Promise<ItemRun>;
  endToEnd(input: {
    combination: SettingsCombination;
    card: ScreeningItem;
    capSeconds: number;
  }): Promise<{
    passed: boolean;
    seconds: number;
    capped?: boolean;
    stopReason?: string;
    /** Why the card's AI review failed (F25): the card is then not passed. */
    reviewFailed?: string;
  }>;
  /** Unload what it loaded; called when the screen ends, inside the measurement run. */
  release?(): Promise<void>;
}

/** A refusal before anything loads (MS-N5-5): a model that does not fit, or another run. */
export class BenchmarkRefusal extends Error {
  constructor(
    message: string,
    readonly needsGb?: number,
  ) {
    super(message);
    this.name = "BenchmarkRefusal";
  }
}

export interface QuickProgress {
  role?: ModelRole;
  model?: string;
  done: number;
  total: number;
  elapsedSeconds: number;
}

export interface QuickBenchmarkInput {
  log: EventLog;
  sets: ScreeningSets;
  runner: ScreenRunner;
  /** The key a role's score is cached under (rule 33), its settings included (rule 39). */
  cacheKey: (role: ModelRole, model: string, setHash: string, settings?: RunSettings) => CacheKey;
  fit: (role: ModelRole, model: string) => FitCheck;
  runProfile: RunProfile;
  /** This host's fingerprint hash. */
  host: string;
  /** Smart Swap's `withMeasurementRun` (DEC-45): bypass the policy, unload after. */
  measurementRun: <T>(run: () => Promise<T>) => Promise<T>;
  now?: () => number;
  /** A person's Stop: honoured at the current item's end (MS-N5-6). */
  shouldStop?: () => boolean;
  onProgress?: (p: QuickProgress) => void;
}

export interface EndToEndResult {
  passed: number;
  total: number;
  cards: {
    id: string;
    passed: boolean;
    seconds: number;
    stopReason?: string;
    /** Why the card's AI review failed (F25): counted as not passed, never as clean. */
    reviewFailed?: string;
  }[];
}

export interface QuickResult {
  combinationId: string;
  roles: RoleScore[];
  /** Item by item, for the page: seconds, cap, stop reason. */
  itemRuns: { role: ModelRole; id: string; score: number; seconds: number; stopReason?: string }[];
  comparisons: PairedComparison[];
  endToEnd?: EndToEndResult;
  partial: boolean;
  cachedRoles: ModelRole[];
  eventSeq: number;
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/** The recorded role entry for the event. */
function recorded(s: RoleScore, key: string | undefined, setHash: string | undefined) {
  return {
    role: s.role,
    model: s.model,
    state: s.state,
    ...(key ? { cacheKey: key } : {}),
    ...(setHash ? { setHash } : {}),
    ...(s.score
      ? {
          score: s.score.value,
          ...(s.score.low !== undefined ? { low: s.score.low } : {}),
          ...(s.score.high !== undefined ? { high: s.score.high } : {}),
        }
      : {}),
    ...(s.items ? { items: s.items } : {}),
    ...(s.capped !== undefined ? { capped: s.capped } : {}),
    ...(s.secondary ? { secondary: s.secondary } : {}),
  };
}

const sameModels = (a: Record<string, string>, b: Record<string, string>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** The end-to-end check recorded for exactly this combination and these cached scores. */
async function cachedEndToEnd(
  log: EventLog,
  combination: SettingsCombination,
  keys: Map<ModelRole, string>,
): Promise<{ passed: number; total: number } | undefined> {
  const want = combinationRecord(combination);
  for (const e of (await quickEvents(log)).reverse()) {
    const p = e.payload as BenchmarkedPayload;
    if (!p.endToEnd || p.partial) continue;
    if (!sameModels(p.combination ?? {}, want)) continue;
    const same = [...keys].every(([role, key]) =>
      p.roles.some((r) => r.role === role && r.cacheKey === key && r.state === "measured"),
    );
    if (same) return p.endToEnd;
  }
  return undefined;
}

/**
 * Screen a combination (rules 31–36): each role's set run once for its
 * model unless its score is cached under the same key (MS-N5-2), then the
 * end-to-end check beside (MS-N5-7), then one `measure/benchmarked` event
 * of tier `quick` with the `RunProfile` (MS-N5-8). A person's Stop is
 * honoured at the current item's end; every completed role is kept and
 * cached and the screen is recorded as partial (MS-N5-6). A model that does
 * not fit is refused before anything loads (MS-N5-5).
 */
export async function quickBenchmark(
  combination: SettingsCombination,
  input: QuickBenchmarkInput,
): Promise<QuickResult> {
  const now = input.now ?? (() => Date.now());
  const started = now();
  // MS-N8-1: a value a run cannot apply is refused before anything loads.
  const refusal = runSettingsRefusal(combination);
  if (refusal) throw refusal;
  // MS-N5-5: a model that does not fit is never loaded.
  for (const role of MODEL_ROLES) {
    const model = modelFor(combination, role);
    if (!model) continue;
    const fit = input.fit(role, model);
    if (!fit.fits)
      throw new BenchmarkRefusal(
        `${model} does not fit this machine for the ${role}: it needs ${fit.needsGb ?? "more"} GB; it is not loaded or run`,
        fit.needsGb,
      );
  }
  const cached = new Map((await readQuickScores(input.log)).map((s) => [s.key, s]));
  const roles: RoleScore[] = [];
  const keys = new Map<ModelRole, string>();
  const setHashes = new Map<ModelRole, string>();
  const itemRuns: QuickResult["itemRuns"] = [];
  const cachedRoles: ModelRole[] = [];
  let stopped = false;
  const toRun = MODEL_ROLES.filter((r) => {
    const m = modelFor(combination, r);
    const set = input.sets.roles[r];
    return m && set.state === "ready" && set.hash;
  });
  const total = toRun.reduce((s, r) => s + input.sets.roles[r].items.length, 0);
  let done = 0;

  const body = async () => {
    for (const role of MODEL_ROLES) {
      const model = modelFor(combination, role);
      const set = input.sets.roles[role];
      if (!model) continue;
      if (set.state !== "ready" || !set.hash) {
        // Rule 30a, MS-N5-4b: never a score on a partial or unbuilt set.
        roles.push({ role, model, state: "not_measured" });
        continue;
      }
      const settings = combination.settings?.[role];
      const key = cacheKeyString(input.cacheKey(role, model, set.hash, settings));
      keys.set(role, key);
      setHashes.set(role, set.hash);
      const hit = cached.get(key);
      if (hit) {
        const { key: _k, setHash: _s, seq: _q, ...score } = hit;
        roles.push(score);
        cachedRoles.push(role);
        done += set.items.length;
        continue;
      }
      if (stopped || input.shouldStop?.()) {
        // Stopped before this role began: nothing of it was measured (MS-N5-6).
        stopped = true;
        roles.push({ role, model, state: "not_measured" });
        continue;
      }
      input.onProgress?.({ role, model, done, total, elapsedSeconds: (now() - started) / 1000 });
      await input.runner.load(role, model);
      const items: ItemScore[] = [];
      const runs: ItemRun[] = [];
      let capped = 0;
      for (const item of set.items) {
        if (input.shouldStop?.()) {
          stopped = true;
          break;
        }
        const run = await input.runner.runItem({
          role,
          model,
          item,
          capSeconds: set.capSeconds,
          ...(settings && Object.keys(settings).length ? { settings } : {}),
        });
        const isCapped = run.capped === true || run.seconds >= set.capSeconds;
        if (isCapped) capped++;
        const score = scoreItem(run.outcome);
        items.push({ id: item.id, score });
        runs.push(run);
        itemRuns.push({
          role,
          id: item.id,
          score,
          seconds: run.seconds,
          ...(isCapped
            ? { stopReason: "time_budget_exhausted" }
            : run.stopReason
              ? { stopReason: run.stopReason }
              : {}),
        });
        done++;
        input.onProgress?.({ role, model, done, total, elapsedSeconds: (now() - started) / 1000 });
      }
      const complete = items.length === set.items.length;
      if (items.length === 0) {
        roles.push({ role, model, state: "not_measured" });
        continue;
      }
      const calls = runs.reduce((s, r) => s + (r.toolCalls ?? 0), 0);
      const valid = runs.reduce((s, r) => s + (r.validToolCalls ?? 0), 0);
      const passedSteps = runs.filter((r, i) => items[i]?.score === 1 && r.steps !== undefined);
      const scores = items.map((i) => i.score);
      roles.push({
        role,
        model,
        state: complete ? "measured" : "partial",
        ...(complete
          ? {
              score: {
                value: mean(scores),
                n: scores.length,
                low: Math.min(...scores),
                high: Math.max(...scores),
                kind: "graded",
              },
            }
          : {}),
        measuredAt: new Date(now()).toISOString(),
        items,
        ...(role === "worker" ? { capped } : {}),
        secondary: {
          fits: true,
          ...(runs.length ? { secondsPerItem: round1(mean(runs.map((r) => r.seconds))) } : {}),
          ...(calls > 0 ? { validToolCallRate: valid / calls } : {}),
          ...(passedSteps.length
            ? { stepsToPass: mean(passedSteps.map((r) => r.steps as number)) }
            : {}),
        },
      });
    }

    // MS-N5-7: the end-to-end check, beside the role scores, never folded in.
    let endToEnd: EndToEndResult | undefined;
    if (!stopped) {
      const prior = await cachedEndToEnd(input.log, combination, keys);
      if (prior && cachedRoles.length === keys.size) {
        endToEnd = { ...prior, cards: [] };
      } else if (input.sets.endToEnd.items.length) {
        const cards: EndToEndResult["cards"] = [];
        for (const card of input.sets.endToEnd.items) {
          if (input.shouldStop?.()) {
            stopped = true;
            break;
          }
          const r = await input.runner.endToEnd({
            combination,
            card,
            capSeconds: input.sets.endToEnd.capSeconds,
          });
          cards.push({
            id: card.id,
            passed: r.passed,
            seconds: r.seconds,
            ...(r.capped
              ? { stopReason: "time_budget_exhausted" }
              : r.stopReason
                ? { stopReason: r.stopReason }
                : {}),
            ...(r.reviewFailed !== undefined ? { reviewFailed: r.reviewFailed } : {}),
          });
        }
        if (!stopped)
          endToEnd = { passed: cards.filter((c) => c.passed).length, total: cards.length, cards };
      }
    }
    return endToEnd;
  };

  const endToEnd = await input.measurementRun(async () => {
    try {
      return await body();
    } finally {
      await input.runner.release?.();
    }
  });

  // Each measured role against every other model screened on the same set (rule 35).
  const comparisons: PairedComparison[] = [];
  const history = await readQuickScores(input.log);
  for (const s of roles) {
    if (s.state !== "measured" || !s.items) continue;
    const others = new Map<string, QuickScoreRecord>();
    for (const h of history)
      if (
        h.role === s.role &&
        h.setHash === setHashes.get(s.role as ModelRole) &&
        h.model !== s.model
      )
        others.set(h.model, h);
    for (const o of others.values())
      comparisons.push(
        compareOnItems(s.role as ModelRole, s as Required<RoleScore>, o as Required<RoleScore>),
      );
  }

  const partial = stopped || roles.some((r) => r.state === "partial");
  const models = combinationRecord(combination);
  const event = await input.log.append({
    actor: "harness",
    type: MEASURE_BENCHMARKED,
    payload: {
      tier: "quick",
      profileHash: runProfileHash(input.runProfile),
      host: input.host,
      combination: models,
      partial,
      roles: roles.map((r) =>
        recorded(r, keys.get(r.role as ModelRole), setHashes.get(r.role as ModelRole)),
      ),
      comparisons,
      ...(endToEnd ? { endToEnd: { passed: endToEnd.passed, total: endToEnd.total } } : {}),
    },
    private: { runProfile: input.runProfile as unknown as Record<string, unknown> },
  });
  return {
    combinationId: combinationId(combination, input.host),
    roles,
    itemRuns,
    comparisons,
    ...(endToEnd ? { endToEnd } : {}),
    partial,
    cachedRoles,
    eventSeq: event.seq,
  };
}

// ── results keyed by combination (PM_CONTRACT `CombinationResult`) ──────

const combinationOf = (models: Record<string, string>): SettingsCombination =>
  combinationFromRecord(models);

/** One recorded `measure/benchmarked` event as a combination's result of its tier. */
export function benchmarkedResult(e: EventRecord): CombinationResult | undefined {
  if (e.type !== MEASURE_BENCHMARKED) return undefined;
  const p = e.payload as BenchmarkedPayload;
  if (!p.combination) return undefined;
  const combination = combinationOf(p.combination);
  const roles = (p.roles ?? []).map((r) => roleScoreOf(r, e.createdAt));
  const measured = roles.filter((r) => r.state === "measured" && r.score);
  const id = combinationId(combination, p.host ?? "");
  const resolvedAgainst = (p.resolved ?? []).map((r) =>
    r.better === id
      ? { combinationId: r.worse, outcome: "better" as const }
      : { combinationId: r.better, outcome: "worse" as const },
  );
  return {
    combinationId: id,
    combination,
    tier: p.tier,
    roles,
    ...(p.endToEnd ? { endToEnd: p.endToEnd } : {}),
    // Assembled from its roles' scores, never measured as a whole (rule 31).
    ...(measured.length
      ? {
          score: {
            value: mean(measured.map((r) => r.score?.value ?? 0)),
            n: measured.length,
            kind: "graded" as const,
          },
        }
      : {}),
    current: false,
    recommended: false,
    // Overnight: the pairs it could not resolve on some role (MS-N5-11).
    indistinguishableFrom: [
      ...new Set((p.indistinguishable ?? []).map((r) => (r.a === id ? r.b : r.a))),
    ],
    ...(p.tier === "overnight" ? { resolvedAgainst } : {}),
    // A screen of a few items cannot establish a difference from the frozen baseline.
    versusBaseline: "not established",
    date: e.createdAt,
  };
}

/**
 * Whether two combinations are ordered (rule 35): compared only on the roles
 * whose models differ and both measured, item by item; ordered only when at
 * least one role resolves and every resolved role favours the same one.
 */
export function orderCombinations(
  x: CombinationResult,
  y: CombinationResult,
): "x" | "y" | "indistinguishable" {
  const resolved: PairedComparison[] = [];
  const sx = (x.combination as SettingsCombination).settings ?? {};
  const sy = (y.combination as SettingsCombination).settings ?? {};
  for (const rx of x.roles) {
    const ry = y.roles.find((r) => r.role === rx.role);
    const role = rx.role as ModelRole;
    const sameSettings = settingsText(sx[role] ?? {}) === settingsText(sy[role] ?? {});
    // Compared only where the role's model or its settings differ (rule 39).
    if (!ry || (rx.model === ry.model && sameSettings)) continue;
    const c = compareRoleScores(rx, ry);
    if ("excluded" in c || c.indistinguishable) continue;
    resolved.push(c);
  }
  if (!resolved.length) return "indistinguishable";
  if (resolved.every((c) => c.better > c.worse)) return "x";
  if (resolved.every((c) => c.better < c.worse)) return "y";
  return "indistinguishable";
}

/**
 * Every recorded result keyed by combination, oldest first: each overnight
 * event as recorded, and each combination's latest quick screen with the
 * combinations the paired test cannot separate from it (DB-N6-12).
 */
export async function combinationResults(log: EventLog): Promise<CombinationResult[]> {
  const all = (await log.getEventsByTypes([MEASURE_BENCHMARKED]))
    .map(benchmarkedResult)
    .filter((r): r is CombinationResult => r !== undefined);
  const latestQuick = new Map<string, CombinationResult>();
  for (const r of all) if (r.tier === "quick") latestQuick.set(r.combinationId, r);
  const quick = [...latestQuick.values()];
  for (const x of quick)
    x.indistinguishableFrom = quick
      .filter((y) => y !== x && orderCombinations(x, y) === "indistinguishable")
      .map((y) => y.combinationId);
  return all.filter((r) => r.tier === "overnight" || latestQuick.get(r.combinationId) === r);
}

// ── the history (MS-N8-3) ───────────────────────────────────────────────

/** One recorded run of a combination, against the run before it. */
export interface HistoryRun {
  seq: number;
  date: string;
  tier: "quick" | "overnight";
  settings?: Partial<Record<ModelRole, RunSettings>>;
  score?: Score;
  roles: RoleScore[];
  partial: boolean;
  /** Against the combination's run before it, on the items both ran, by the exact sign test. */
  versusPrevious?: {
    outcome: "better" | "worse" | "no clear difference";
    better: number;
    worse: number;
    ties: number;
    p: number;
  };
}

export interface CombinationHistory {
  combinationId: string;
  combination: SettingsCombination;
  runs: HistoryRun[];
}

/** A run's measured items over every role, each id named by its role, for pairing. */
const pairedItems = (roles: readonly RoleScore[]): ItemScore[] =>
  roles
    .filter((r) => r.state === "measured")
    .flatMap((r) => (r.items ?? []).map((i) => ({ id: `${r.role}/${i.id}`, score: i.score })));

/**
 * Every recorded run of either tier per combination, oldest first, each
 * compared with the run before it on the items both ran by the exact sign
 * test (MS-N8-3): *better*, *worse* or *no clear difference*, never a bare
 * difference.
 */
export async function combinationHistory(log: EventLog): Promise<CombinationHistory[]> {
  const out = new Map<string, CombinationHistory>();
  for (const e of await log.getEventsByTypes([MEASURE_BENCHMARKED])) {
    const r = benchmarkedResult(e);
    if (!r) continue;
    const p = e.payload as BenchmarkedPayload;
    const combination = r.combination as SettingsCombination;
    let h = out.get(r.combinationId);
    if (!h) {
      h = { combinationId: r.combinationId, combination, runs: [] };
      out.set(r.combinationId, h);
    }
    const before = h.runs.at(-1);
    let versusPrevious: HistoryRun["versusPrevious"];
    if (before) {
      const c = compareOnItems(
        "worker",
        { model: "this", items: pairedItems(r.roles) },
        { model: "before", items: pairedItems(before.roles) },
      );
      if (c.better + c.worse + c.ties > 0)
        versusPrevious = {
          outcome: c.indistinguishable
            ? "no clear difference"
            : c.better > c.worse
              ? "better"
              : "worse",
          better: c.better,
          worse: c.worse,
          ties: c.ties,
          p: c.p,
        };
    }
    h.runs.push({
      seq: e.seq,
      date: e.createdAt,
      tier: p.tier,
      ...(combination.settings ? { settings: combination.settings } : {}),
      ...(r.score ? { score: r.score } : {}),
      roles: r.roles,
      partial: p.partial === true,
      ...(versusPrevious ? { versusPrevious } : {}),
    });
  }
  return [...out.values()];
}
