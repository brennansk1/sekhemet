import { runProfileHash } from "./run_profile.js";
import {
  PLANNING_DISCORDANCE,
  binomialTailAtLeast,
  describeDetectable,
  median,
  minDetectableDifference,
  seededRandom,
  wilcoxonSignedRankLess,
} from "./stats.js";
import { type SuiteRunResult, pairOutcomes } from "./suite.js";

/**
 * Admission: one rule for what the system learns (measurement.md §2 rules
 * 16a–16c, DEC-28; T8). A harness change is admitted by a significant paired
 * gain on the frozen suite; an inconclusive A/B is adopted only on a
 * deterministic "simpler" or a measured "cheaper"; a project rule is kept or
 * retired by its paired credit at fixed looks. Everything here reads
 * recorded results; nothing runs a model.
 */

/** The suite's resolution: a gain under this share of the paired cards is not claimed (rule 11). */
export const MIN_ADMITTED_GAIN = 0.2;
const ALPHA = 0.05;

/** What a harness change removes or adds, counted from the change itself (rule 16c). */
export interface ChangeFootprint {
  /** Stable-zone (Zones 1–2) prompt tokens, counted with the Worker's tokenizer. */
  stablePromptTokens: number;
  tools: number;
  switches: number;
  linesOfCode: number;
}

/** The A/B's entry, written before its first card runs. */
export interface AbEntry {
  /** The one cost measure (rule 16c): median tokens per card. */
  costMeasure: "median tokens per card";
  /** When the entry was written; must precede every run's first card. */
  recordedAt: string;
}

export type HarnessVerdict =
  | "admitted"
  | "not established — simpler"
  | "not established — cheaper"
  | "not adopted";

export interface HarnessChangeResult {
  verdict: HarnessVerdict;
  /** The context version or harness commit the verdict is about. */
  version: string;
  /** Paired card outcomes across the paired runs. */
  pairedCards: number;
  gained: number;
  lost: number;
  /** One-sided exact p-values: "no gain" and "no loss". */
  gainP: number;
  lossP: number;
  /**
   * The smallest paired loss (a share of the paired cards) a one-sided exact
   * test detects at 80% power, at the planning disagreement of 20%; null
   * when none is detectable.
   */
  minDetectableLoss: number | null;
  /** Cards blocked in both arms of a paired run, left out (review B1). */
  droppedBlocked: number;
  baselineMedianTokens: number;
  candidateMedianTokens: number;
  /** One-sided paired Wilcoxon signed-rank p that the candidate uses fewer tokens per card. */
  wilcoxonP: number;
  simpler: boolean;
  reason: string;
}

/** The one cost measure rule 16c allows, named before the run with a date that parses (review M2). */
function validateEntry(entry: AbEntry): void {
  if (entry?.costMeasure !== "median tokens per card") {
    throw new Error(
      `the A/B entry's cost measure must be "median tokens per card" (rule 16c), not ${JSON.stringify(entry?.costMeasure)}`,
    );
  }
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
  if (
    typeof entry.recordedAt !== "string" ||
    !iso.test(entry.recordedAt) ||
    Number.isNaN(Date.parse(entry.recordedAt))
  ) {
    throw new Error(
      `the A/B entry's recordedAt is not an ISO date (${JSON.stringify(entry?.recordedAt)}); it must show the entry was written before the first card`,
    );
  }
}

/**
 * The arms ran the recorded profiles rule 16c compares (review M3): every
 * run records one, each arm has one, and the arms differ only in the arm
 * under test or the settings file that names it. A run whose cards ran with
 * different profiles is refused.
 */
function checkProfiles(
  baseline: readonly SuiteRunResult[],
  candidate: readonly SuiteRunResult[],
): void {
  const hashOf = (arm: string, runs: readonly SuiteRunResult[]) => {
    const hashes = new Set<string>();
    for (const r of runs) {
      if (r.profileMismatch?.length) {
        throw new Error(
          `a ${arm} run has cards that ran with a different profile (${r.profileMismatch.join(", ")}); it is not one arm`,
        );
      }
      if (!r.runProfile) {
        throw new Error(`a ${arm} run records no RunProfile (rule 9a); it cannot be compared`);
      }
      hashes.add(runProfileHash(r.runProfile));
    }
    if (hashes.size > 1) {
      throw new Error(`more than one RunProfile within the ${arm} arm; an arm runs one profile`);
    }
    return runs[0]?.runProfile;
  };
  const modes = new Set([...baseline, ...candidate].map((r) => r.mode ?? "sequential"));
  if (modes.size > 1) {
    throw new Error(
      "sequential and independent runs are not comparable: every run of an A/B uses one mode (MS-T7-3)",
    );
  }
  const b = hashOf("baseline", baseline);
  const c = hashOf("candidate", candidate);
  if (!b || !c || runProfileHash(b) === runProfileHash(c)) return;
  const named =
    (b.armUnderTest ?? null) !== (c.armUnderTest ?? null) ||
    (b.settingsFile?.sha256 ?? null) !== (c.settingsFile?.sha256 ?? null);
  if (!named) {
    throw new Error(
      "the arms' RunProfiles differ in more than the arm under test: name the arm with --arm or a settings file",
    );
  }
}

/**
 * The arms were interleaved in time (rule 10, MS-T7-4): each paired run of
 * the baseline and the candidate started before either run of the next pair,
 * so time — a warmer cache, a busier host, a later build — cannot pass for
 * the arm. Two runs that started at the same moment, or a run without its
 * start, cannot be ordered and are refused.
 */
function checkInterleaved(
  baseline: readonly SuiteRunResult[],
  candidate: readonly SuiteRunResult[],
  runs: number,
): void {
  const pairs: [number, number][] = [];
  for (let i = 0; i < runs; i++) {
    const b = Date.parse(baseline[i]?.startedAt ?? "");
    const c = Date.parse(candidate[i]?.startedAt ?? "");
    if (Number.isNaN(b) || Number.isNaN(c) || b === c) {
      throw new Error(
        `the arms are not interleaved: paired run ${i + 1} cannot be ordered (the two runs record no distinct start)`,
      );
    }
    pairs.push([Math.min(b, c), Math.max(b, c)]);
  }
  for (let i = 1; i < pairs.length; i++) {
    if ((pairs[i - 1] as [number, number])[1] >= (pairs[i] as [number, number])[0]) {
      throw new Error(
        `the arms are not interleaved: paired run ${i + 1} began before both arms of paired run ${i} had started (run them A, B, A, B, rule 10)`,
      );
    }
  }
}

/**
 * Each card's two arms, adjacent, in an order drawn from a fixed seed (rule
 * 10, MS-T7-4): the schedule for running a comparison card by card in
 * independent mode (MS-T7-3).
 */
export function interleaveArms<T>(
  tasks: readonly T[],
  seed: number,
): { task: T; arm: "baseline" | "candidate" }[] {
  const next = seededRandom(seed);
  return tasks.flatMap((task) => {
    const first = next() < 0.5 ? "baseline" : "candidate";
    const second = first === "baseline" ? "candidate" : "baseline";
    return [
      { task, arm: first },
      { task, arm: second },
    ];
  });
}

/**
 * A sequential test with a stated error rate (rule 10, MS-T7-4): a
 * comparison may stop early only at one of its planned looks. Each look is
 * tested once, at the first count of pairs at or past it, with a one-sided
 * exact test per direction at `alpha / (looks × directions)`, so the chance
 * of a false stop in a direction, over all looks, is at most `alpha / 2`
 * when both are tested and `alpha` when one is (Bonferroni).
 */
export function sequentialLook(o: {
  plannedPairs: number;
  looks: readonly number[];
  alpha: number;
  pairs: number;
  gained: number;
  lost: number;
  /** Looks already tested, which are never tested again. */
  testedLooks?: readonly number[];
  /** Which way a stop may go: both (a comparison), or loss only (a watch). */
  directions?: "both" | "loss" | "gain";
  /** How the counts read in the reason, when the looks are not counted in pairs. */
  describe?: (look: number) => string;
}): {
  stop: boolean;
  verdict?: "gain" | "loss" | "no difference resolved";
  look?: number;
  alphaPerLook: number;
  reason: string;
} {
  const looks = o.looks;
  if (looks.some((l, i) => i > 0 && l <= (looks[i - 1] as number)) || looks.some((l) => l <= 0))
    throw new Error(`looks must rise strictly from above zero (${looks.join(", ")})`);
  if (looks.at(-1) !== o.plannedPairs)
    throw new Error(`looks must end at the planned ${o.plannedPairs} pairs (${looks.join(", ")})`);
  const directions = o.directions ?? "both";
  const sides = directions === "both" ? 2 : 1;
  const alphaPerLook = o.alpha / (looks.length * sides);
  const perDirection = sides === 2 ? o.alpha / 2 : o.alpha;
  const stated = `error rate in each direction at most ${perDirection} over ${looks.length} looks (${alphaPerLook.toFixed(4)} each)`;
  const tested = new Set(o.testedLooks ?? []);
  const look = [...looks].reverse().find((l) => l <= o.pairs);
  if (look === undefined || tested.has(look)) {
    return {
      stop: false,
      alphaPerLook,
      reason: `no look yet at ${o.pairs} pairs (looks at ${looks.join(", ")}); ${stated}`,
    };
  }
  const n = o.gained + o.lost;
  const gainP = n ? binomialTailAtLeast(o.gained, n) : 1;
  const lossP = n ? binomialTailAtLeast(o.lost, n) : 1;
  const counts =
    o.describe?.(look) ?? `${o.gained} gained, ${o.lost} lost at ${o.pairs} pairs (look ${look})`;
  if (directions !== "loss" && gainP <= alphaPerLook)
    return {
      stop: true,
      verdict: "gain",
      look,
      alphaPerLook,
      reason: `stopped: ${counts}, p = ${gainP.toFixed(4)}; ${stated}`,
    };
  if (directions !== "gain" && lossP <= alphaPerLook)
    return {
      stop: true,
      verdict: "loss",
      look,
      alphaPerLook,
      reason: `stopped: ${counts}, p = ${lossP.toFixed(4)}; ${stated}`,
    };
  const last = look === looks.at(-1);
  return {
    stop: last,
    ...(last ? { verdict: "no difference resolved" as const } : {}),
    look,
    alphaPerLook,
    reason: `${last ? "ended" : "continues"}: ${counts}; ${stated}`,
  };
}

/** Simpler, deterministically: nothing added, and at least one of the four removed (MS-T8-13). */
export function isSimpler(before: ChangeFootprint, after: ChangeFootprint): boolean {
  const keys: (keyof ChangeFootprint)[] = [
    "stablePromptTokens",
    "tools",
    "switches",
    "linesOfCode",
  ];
  return keys.every((k) => after[k] <= before[k]) && keys.some((k) => after[k] < before[k]);
}

const cardKey = (o: { task: { suite: string; cardId: string } }) =>
  `${o.task.suite}/${o.task.cardId}`;

/**
 * Decide a harness change from its paired A/B (rules 16c, 19; MS-T8-1, -2,
 * -13). Run i of the baseline is paired with run i of the candidate, card by
 * card (interleaved, rule 10). Refused without two paired runs per arm, on
 * mismatched suite hashes, or when the cost measure was written after the
 * first card ran.
 */
export function evaluateHarnessChange(options: {
  baseline: readonly SuiteRunResult[];
  candidate: readonly SuiteRunResult[];
  entry: AbEntry;
  /**
   * The entry file's SHA-256. When given, every run must carry it (the
   * suite runner's `--ab-entry`), which proves the entry existed before the
   * run started (review M2).
   */
  entrySha256?: string;
  change: { before: ChangeFootprint; after: ChangeFootprint };
  version: string;
}): HarnessChangeResult {
  const { baseline, candidate, entry } = options;
  const runs = Math.min(baseline.length, candidate.length);
  if (runs < 2) {
    throw new Error(
      `a harness change needs at least two paired runs per arm on the suite path (${baseline.length} baseline, ${candidate.length} candidate)`,
    );
  }
  const hashes = new Set([...baseline, ...candidate].map((r) => r.suiteHash));
  if (hashes.size !== 1) {
    throw new Error(
      `the runs are on different suite hashes (${[...hashes].join(", ")}); they are not comparable`,
    );
  }
  validateEntry(entry);
  if (options.entrySha256) {
    for (const r of [...baseline, ...candidate]) {
      if (r.abEntry?.sha256 !== options.entrySha256) {
        throw new Error(
          `a run started ${r.startedAt ?? "(unknown)"} does not carry the A/B entry ${options.entrySha256.slice(0, 12)}; run the suite with --ab-entry <file>`,
        );
      }
    }
  }
  checkProfiles(baseline, candidate);
  checkInterleaved(baseline, candidate, runs);
  const firstCard = [...baseline, ...candidate]
    .map((r) => r.startedAt)
    .filter((t): t is string => typeof t === "string")
    .sort()[0];
  if (!firstCard) {
    throw new Error(
      "the runs do not record when their first card started, so the cost measure cannot be shown to precede them",
    );
  }
  if (Date.parse(entry.recordedAt) > Date.parse(firstCard)) {
    throw new Error(
      `the cost measure was recorded after the first card ran (${entry.recordedAt} > ${firstCard}); an A/B names it before its first card`,
    );
  }

  let pairedCards = 0;
  let gained = 0;
  let lost = 0;
  let droppedBlocked = 0;
  const tokens = new Map<string, { base: number[]; cand: number[] }>();
  for (let i = 0; i < runs; i++) {
    // A card blocked in one arm is that arm's failure; blocked in both, left out (review B1).
    const pair = pairOutcomes(
      (baseline[i] as SuiteRunResult).outcomes,
      (candidate[i] as SuiteRunResult).outcomes,
    );
    pairedCards += pair.paired;
    lost += pair.baselineOnly;
    gained += pair.candidateOnly;
    droppedBlocked += pair.droppedBlocked;
    // The cost measure only over cards measured in both arms.
    for (const { baseline: b, candidate: c } of pair.bothMeasured) {
      const t = tokens.get(cardKey(b)) ?? { base: [], cand: [] };
      t.base.push(b.tokens);
      t.cand.push(c.tokens);
      tokens.set(cardKey(b), t);
    }
  }
  const discordant = gained + lost;
  const gainP = binomialTailAtLeast(gained, discordant);
  const lossP = binomialTailAtLeast(lost, discordant);
  const minDetectableLoss = minDetectableDifference(pairedCards, PLANNING_DISCORDANCE, {
    sided: "one",
  });
  // The cost measure over the cards run in both arms: each card's median tokens per arm.
  const perCard = [...tokens.values()].map((t) => ({ base: median(t.base), cand: median(t.cand) }));
  const baselineMedianTokens = median(perCard.map((c) => c.base));
  const candidateMedianTokens = median(perCard.map((c) => c.cand));
  const wilcoxonP = wilcoxonSignedRankLess(perCard.map((c) => c.cand - c.base));
  const simpler = isSimpler(options.change.before, options.change.after);

  const effect = pairedCards ? (gained - lost) / pairedCards : 0;
  const counts = `${gained} gained, ${lost} lost over ${pairedCards} paired cards in ${runs} paired runs`;
  const detectable = `${describeDetectable(minDetectableLoss, pairedCards, "paired loss")}${droppedBlocked ? `; ${droppedBlocked} card(s) blocked in both arms left out` : ""}`;
  const base = {
    version: options.version,
    pairedCards,
    gained,
    lost,
    gainP,
    lossP,
    minDetectableLoss,
    droppedBlocked,
    baselineMedianTokens,
    candidateMedianTokens,
    wilcoxonP,
    simpler,
  };
  if (gainP < ALPHA && effect >= MIN_ADMITTED_GAIN) {
    return {
      ...base,
      verdict: "admitted",
      reason: `admitted: ${counts}; one-sided exact p = ${gainP.toFixed(4)}, ${Math.round(effect * 100)} points`,
    };
  }
  if (lossP < ALPHA) {
    return {
      ...base,
      verdict: "not adopted",
      reason: `not adopted: ${counts} is a loss the suite resolves (one-sided exact p = ${lossP.toFixed(4)})`,
    };
  }
  const inconclusive = `inconclusive: ${counts}`;
  if (simpler) {
    return {
      ...base,
      verdict: "not established — simpler",
      reason: `not established — simpler (${options.version}): ${inconclusive}; it removes and adds nothing else; ${detectable}`,
    };
  }
  if (wilcoxonP < ALPHA && candidateMedianTokens < baselineMedianTokens) {
    return {
      ...base,
      verdict: "not established — cheaper",
      reason: `not established — cheaper (${options.version}): ${inconclusive}; median tokens per card ${candidateMedianTokens} against ${baselineMedianTokens}, one-sided paired Wilcoxon p = ${wilcoxonP.toFixed(4)}; ${detectable}`,
    };
  }
  return {
    ...base,
    verdict: "not adopted",
    reason: `not adopted: ${inconclusive}; not simpler, and not shown cheaper (median tokens per card ${candidateMedianTokens} against ${baselineMedianTokens}, Wilcoxon p = ${wilcoxonP.toFixed(4)}); ${detectable}`,
  };
}

// ------------------------------------------------------ rule credit (rule 16b)

/** The fields of an `attempt/finished` record the credit reads (worker-loop rule 39, WL-N5-1). */
export interface AttemptFinished {
  cardId: string;
  projectId: string;
  /** The card class, `kind:ext` (models rule 31). */
  cardClass: string;
  attemptNumber: number;
  builtBy?: "worker" | "person";
  stopReason: string;
  /** Rules in the attempt's prompt. */
  rules: readonly string[];
  /** Rules whose scope matched the card but were withheld by rotation. */
  withheldRules: readonly string[];
}

/** The looks at which a rule is tested for harm, and their shared error rate (rule 16b). */
export const RULE_LOOKS = [20, 40, 80] as const;
export const RULE_LOOK_ALPHA = 0.05 / RULE_LOOKS.length;

export interface RuleCredit {
  ruleId: string;
  pairs: number;
  helpful: number;
  harmful: number;
  credit: number;
  status: "insufficient data" | "kept" | "retired";
  /** Each look reached: the counts then, the one-sided exact p of "no harm", and whether it retired the rule. */
  looks: { look: number; helpful: number; harmful: number; p: number; retired: boolean }[];
  retiredAt?: { look: number; p: number };
}

/**
 * A rule's paired credit (rule 16b, MS-T8-14), from `attempt/finished`
 * records alone, in ledger (start) order. Comparable cards are first
 * attempts, not built by a person, of one project and card class, whose
 * scope the rule matched — in the prompt or withheld by rotation. A pair is
 * two consecutive comparable cards, one with the rule and one without;
 * credit is helpful minus harmful pairs. It is tested for harm only when the
 * pair count first reaches 20, 40 and 80, and retired at the first look
 * where a one-sided exact binomial test on the discordant pairs gives
 * P ≤ 0.05/3; below 20 pairs it reports "insufficient data".
 */
export function ruleCredit(records: readonly AttemptFinished[], ruleId: string): RuleCredit {
  const pending = new Map<string, { with: boolean; passed: boolean }>();
  let pairs = 0;
  let helpful = 0;
  let harmful = 0;
  const looks: RuleCredit["looks"] = [];
  let retiredAt: RuleCredit["retiredAt"];
  for (const r of records) {
    if (retiredAt) break;
    if (r.attemptNumber !== 1 || r.builtBy === "person") continue;
    const isWith = r.rules.includes(ruleId);
    if (!isWith && !r.withheldRules.includes(ruleId)) continue;
    const group = `${r.projectId}\u0000${r.cardClass}`;
    const passed = r.stopReason === "gate_passed";
    const open = pending.get(group);
    if (!open || open.with === isWith) {
      pending.set(group, { with: isWith, passed });
      continue;
    }
    pending.delete(group);
    pairs++;
    const withPassed = isWith ? passed : open.passed;
    const withoutPassed = isWith ? open.passed : passed;
    if (withPassed && !withoutPassed) helpful++;
    if (!withPassed && withoutPassed) harmful++;
    if ((RULE_LOOKS as readonly number[]).includes(pairs)) {
      const p = binomialTailAtLeast(harmful, helpful + harmful);
      const retired = p <= RULE_LOOK_ALPHA;
      looks.push({ look: pairs, helpful, harmful, p, retired });
      if (retired) retiredAt = { look: pairs, p };
    }
  }
  return {
    ruleId,
    pairs,
    helpful,
    harmful,
    credit: helpful - harmful,
    status: retiredAt ? "retired" : pairs < RULE_LOOKS[0] ? "insufficient data" : "kept",
    looks,
    ...(retiredAt ? { retiredAt } : {}),
  };
}

// ------------------------------------------------ MS-T8-3: paired rollback

export interface WatchVerdict {
  changeId: string;
  status: "rolled back" | "kept" | "insufficient data";
  pairedCards: number;
  gained: number;
  lost: number;
  /** One-sided exact p for "no loss" over the discordant pairs. */
  lossP: number;
  minDetectableLoss: number | null;
  /** Cards blocked in both arms, left out (review B1). */
  droppedBlocked: number;
  reason: string;
}

/**
 * Watch an admitted change (rule 18, MS-T8-3): later suite runs with the
 * change are paired card by card with runs without it (run i with run i),
 * and the change is rolled back — and flagged — when a one-sided exact test
 * resolves a loss at 0.05. With no paired runs the verdict is "insufficient
 * data", never a comparison against an assumed 1.0. The live ten-card
 * window is advisory only and never reaches here.
 */
export function watchAdmittedChange(options: {
  changeId: string;
  withChange: readonly SuiteRunResult[];
  without: readonly SuiteRunResult[];
}): WatchVerdict {
  const { withChange, without, changeId } = options;
  const hashes = new Set([...withChange, ...without].map((r) => r.suiteHash));
  if (hashes.size > 1) {
    throw new Error(
      `the runs are on different suite hashes (${[...hashes].join(", ")}); they are not comparable`,
    );
  }
  for (const r of [...withChange, ...without]) {
    if (r.profileMismatch?.length) {
      throw new Error(
        `a run has cards that ran with a different profile (${r.profileMismatch.join(", ")}); it is not one arm`,
      );
    }
  }
  let pairedCards = 0;
  let gained = 0;
  let lost = 0;
  let droppedBlocked = 0;
  for (let i = 0; i < Math.min(withChange.length, without.length); i++) {
    const pair = pairOutcomes(
      (without[i] as SuiteRunResult).outcomes,
      (withChange[i] as SuiteRunResult).outcomes,
    );
    pairedCards += pair.paired;
    lost += pair.baselineOnly;
    gained += pair.candidateOnly;
    droppedBlocked += pair.droppedBlocked;
  }
  const discordant = gained + lost;
  const lossP = discordant ? binomialTailAtLeast(lost, discordant) : 1;
  const minDetectableLoss = minDetectableDifference(pairedCards, PLANNING_DISCORDANCE, {
    sided: "one",
  });
  const counts = `${changeId} lost ${lost} and gained ${gained} over ${pairedCards} paired cards`;
  if (pairedCards === 0) {
    return {
      changeId,
      status: "insufficient data",
      pairedCards,
      gained,
      lost,
      lossP,
      minDetectableLoss,
      droppedBlocked,
      reason: `insufficient data: no suite run of ${changeId} pairs with one without it`,
    };
  }
  if (lossP < ALPHA) {
    return {
      changeId,
      status: "rolled back",
      pairedCards,
      gained,
      lost,
      lossP,
      minDetectableLoss,
      droppedBlocked,
      reason: `rolled back: ${counts}; one-sided exact p = ${lossP.toFixed(4)} resolves a loss (rule 18)`,
    };
  }
  return {
    changeId,
    status: "kept",
    pairedCards,
    gained,
    lost,
    lossP,
    minDetectableLoss,
    droppedBlocked,
    reason: `kept: ${counts}; no loss resolved (one-sided exact p = ${lossP.toFixed(4)}); ${describeDetectable(minDetectableLoss, pairedCards, "paired loss")}`,
  };
}

/**
 * A watch's planned looks, counted in later comparable suite runs: after the
 * 1st, 2nd and 4th (rule 18). Fixed by run count, never by pairs, so a look
 * cannot shift past one already tested as runs bring different numbers of
 * paired cards (confirmation check, B1).
 */
export const WATCH_LOOKS_RUNS = [1, 2, 4] as const;

/**
 * Watch an adopted change over every later comparable suite run, pooled
 * (rule 18, MS-T8-3, review B1): later run i is paired with baseline run
 * (i mod baselines), and a loss is tested only at the planned looks — after
 * the 1st, 2nd and 4th later run — each once, one-sided at `alpha / looks`
 * over every pair pooled so far. It is rolled back on a resolved loss, kept
 * when the last look resolves none, and otherwise watched further.
 */
export function watchPooled(o: {
  changeId: string;
  without: readonly SuiteRunResult[];
  withRuns: readonly SuiteRunResult[];
  testedLooks: readonly number[];
  alpha?: number;
}): {
  changeId: string;
  status: "rolled back" | "kept" | "watching" | "insufficient data";
  look?: number;
  /** The looks, in later runs, fixed for the whole watch. */
  looks: number[];
  testedLooks: number[];
  pairedCards: number;
  gained: number;
  lost: number;
  droppedBlocked: number;
  reason: string;
} {
  const looks = [...WATCH_LOOKS_RUNS];
  const base = {
    changeId: o.changeId,
    looks,
    pairedCards: 0,
    gained: 0,
    lost: 0,
    droppedBlocked: 0,
    testedLooks: [...o.testedLooks],
  };
  if (o.withRuns.length === 0 || o.without.length === 0) {
    return {
      ...base,
      status: "insufficient data",
      reason: `insufficient data: no later run of ${o.changeId} to pair with its baseline`,
    };
  }
  const hashes = new Set([...o.withRuns, ...o.without].map((r) => r.suiteHash));
  if (hashes.size > 1) {
    throw new Error(
      `the runs are on different suite hashes (${[...hashes].join(", ")}); they are not comparable`,
    );
  }
  let pairedCards = 0;
  let gained = 0;
  let lost = 0;
  let droppedBlocked = 0;
  for (const [i, later] of o.withRuns.entries()) {
    const pair = pairOutcomes(
      (o.without[i % o.without.length] as SuiteRunResult).outcomes,
      later.outcomes,
    );
    pairedCards += pair.paired;
    lost += pair.baselineOnly;
    gained += pair.candidateOnly;
    droppedBlocked += pair.droppedBlocked;
  }
  const runs = o.withRuns.length;
  const seq = sequentialLook({
    plannedPairs: looks.at(-1) as number,
    looks,
    alpha: o.alpha ?? ALPHA,
    pairs: runs,
    gained,
    lost,
    testedLooks: o.testedLooks,
    directions: "loss",
    describe: (look) =>
      `${gained} gained, ${lost} lost over ${pairedCards} paired cards after ${runs} later run${runs === 1 ? "" : "s"} (look ${look})`,
  });
  const counts = { pairedCards, gained, lost, droppedBlocked };
  if (seq.look === undefined) {
    return {
      ...base,
      ...counts,
      status: "watching",
      reason: `watching ${o.changeId}: ${seq.reason}`,
    };
  }
  // Every look at or below this one is spent.
  const testedLooks = [
    ...new Set([...o.testedLooks, ...looks.filter((l) => l <= (seq.look as number))]),
  ];
  const status = seq.verdict === "loss" ? "rolled back" : seq.stop ? "kept" : "watching";
  return {
    ...base,
    ...counts,
    testedLooks,
    look: seq.look,
    status,
    reason: `${status === "rolled back" ? `rolled back: ${o.changeId}` : status === "kept" ? `kept: ${o.changeId}` : `watching ${o.changeId}`}: ${seq.reason}`,
  };
}
