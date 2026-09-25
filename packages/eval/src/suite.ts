import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { loadAssetManifest, verifyAsset } from "./eval_assets.js";
import type { RunProfile } from "./run_profile.js";
import {
  PLANNING_DISCORDANCE,
  clopperPearson,
  describeDetectable,
  exactMcNemar,
  minDetectableDifference,
  passAtK,
  passHatK,
} from "./stats.js";

/**
 * The frozen suite: the fixed set of tasks every claim about this harness is
 * checked against.
 *
 * "Frozen" is not a promise, it is a hash. The suite's identity covers its
 * manifest and every byte of every fixture it names, so editing a task to
 * make a result look better changes the hash and the two runs stop being
 * comparable. Adding a task is allowed and deliberate; quietly changing one
 * is the thing this prevents.
 *
 * One number comes out of a run — tasks passed — with the cost that bought
 * it. A change to the harness that does not move that number, or moves it
 * down, is not an improvement however well it is argued.
 *
 * Running a task needs a model, so this module does not do it: `runFrozenSuite`
 * takes the runner as an argument. That keeps the suite's definition, its
 * hash and its arithmetic testable without weights, which is what lets the
 * suite exist before the harness can run it.
 */

export interface SuiteTask {
  /** The fixture the task lives in, e.g. `chronicle`. */
  suite: string;
  /** The card id within that fixture. */
  cardId: string;
  title: string;
}

export interface FrozenSuite {
  /** Bumped by hand when a task is added or removed, never when one changes. */
  version: string;
  tasks: SuiteTask[];
  /** Covers the manifest, the fixtures' contents and the registered reference solutions. */
  hash: string;
  /** The registered reference solutions the hash covers (MS-T7-2), when registered. */
  referenceSolutions?: { version: string; hash: string; items: number };
}

export interface TaskOutcome {
  task: SuiteTask;
  passed: boolean;
  /** Why it did not pass, for the report; never used in the arithmetic. */
  stopReason?: string;
  wallClockSeconds: number;
  tokens: number;
  /** Repair rungs spent. A pass at rung 0 is worth more than a pass at rung 3. */
  rungs: number;
  /**
   * Blocked on a dependency an earlier failed card never delivered (rule 3):
   * unmeasured, not failed. Counted apart and never paired.
   */
  blocked?: boolean;
  /**
   * Never run: the runner stopped the queue before reaching it, or the queue
   * wrote no report (review M4). Unmeasured, like a blocked card.
   */
  notRun?: boolean;
}

/** Unmeasured in its run: blocked on a dependency, or never run. */
export const unmeasured = (o: { blocked?: boolean; notRun?: boolean }): boolean =>
  o.blocked === true || o.notRun === true;

export interface SuiteRunResult {
  suiteHash: string;
  version: string;
  passed: number;
  total: number;
  outcomes: TaskOutcome[];
  cost: { wallClockSeconds: number; tokens: number; rungs: number };
  /** Passes that needed no repair, which is the number that should grow. */
  firstTry: number;
  /** When the run's first card started: an A/B's cost measure must be named before it (rule 16c). */
  startedAt?: string;
  at: string;
  /** The run's one RunProfile, as the suite runner recorded it (rule 9a). */
  runProfile?: RunProfile & { hash?: string };
  /** How the cards ran: all of a fixture in one queue, or each alone (MS-T7-3). */
  mode?: "sequential" | "independent";
  /** The Worker the run was started with. */
  worker?: string;
  /** Cards whose evidence records a different profile from the run's. */
  profileMismatch?: string[];
  /** Each fixture's model load, apart from the cards' wall clock (MS-T7-1). */
  modelLoads?: {
    fixture: string;
    modelId: string;
    loadMs?: { count: number; totalMs: number; firstMs: number };
    spawnToHealthyMs?: { count: number; totalMs: number; firstMs: number };
  }[];
  /** The A/B entry the run was started under (`--ab-entry`), by hash (rule 16c). */
  abEntry?: { sha256: string; costMeasure: string; recordedAt: string };
}

interface Manifest {
  version: string;
  fixtures: { name: string; tasks: number }[];
}

const SKIP = new Set(["node_modules", ".git", "dist", ".sekhemet"]);

/** Every file under a directory, hashed by path and content, order-stable. */
function hashTree(dir: string, into: ReturnType<typeof createHash>, root = dir): void {
  for (const entry of readdirSync(dir).sort()) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) hashTree(full, into, root);
    else into.update(`${relative(root, full)}\0`).update(readFileSync(full));
  }
}

/**
 * Read the suite from `fixtures/suite.json` and the fixtures it names.
 *
 * A fixture whose task count disagrees with the manifest is an error rather
 * than a smaller suite: a task that vanishes silently is exactly the failure
 * the hash exists to catch, and it would otherwise read as a clean run over
 * fewer tasks.
 */
export function loadFrozenSuite(repoRoot: string): FrozenSuite {
  const manifestPath = join(repoRoot, "fixtures", "suite.json");
  const raw = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as Manifest;
  const hash = createHash("sha256").update(raw);
  const tasks: SuiteTask[] = [];

  for (const fixture of manifest.fixtures) {
    const dir = join(repoRoot, "fixtures", fixture.name);
    if (!existsSync(dir)) throw new Error(`frozen suite: no fixture ${fixture.name}`);
    hashTree(dir, hash);

    const cardsFile = join(dir, "cards.json");
    const found: SuiteTask[] = existsSync(cardsFile)
      ? (JSON.parse(readFileSync(cardsFile, "utf8")) as { id: string; title: string }[]).map(
          (c) => ({ suite: fixture.name, cardId: c.id, title: c.title }),
        )
      : // A fixture without cards.json is seeded by a script; the manifest's
        // count is its declaration, and the run reports what it actually ran.
        Array.from({ length: fixture.tasks }, (_, i) => ({
          suite: fixture.name,
          cardId: `${fixture.name}_${i + 1}`,
          title: `${fixture.name} task ${i + 1}`,
        }));

    if (found.length !== fixture.tasks) {
      throw new Error(
        `frozen suite: ${fixture.name} declares ${fixture.tasks} tasks, found ${found.length}`,
      );
    }
    tasks.push(...found);
  }

  // MS-T7-2: the registered, verified reference solutions are part of what
  // "the suite" is. A set changed without a new registered version is an
  // error (verifyAsset throws), and an unregistered set is not included.
  const references = loadAssetManifest(repoRoot).assets.find(
    (a) => a.name === "reference-solutions",
  );
  if (references) {
    const verified = verifyAsset(repoRoot, "reference-solutions");
    hash.update(`reference-solutions\0${references.version}\0${verified.hash}\0`);
  }

  return {
    version: manifest.version,
    tasks,
    hash: hash.digest("hex"),
    ...(references
      ? {
          referenceSolutions: {
            version: references.version,
            hash: references.hash,
            items: references.items,
          },
        }
      : {}),
  };
}

/**
 * Run every task and reduce it to one number and its cost. Failures do not
 * stop the run: a partial score is the measurement, and stopping early would
 * make a worse change look like a shorter one.
 */
export async function runFrozenSuite(
  suite: FrozenSuite,
  runTask: (task: SuiteTask) => Promise<Omit<TaskOutcome, "task">>,
): Promise<SuiteRunResult> {
  const startedAt = new Date().toISOString();
  const outcomes: TaskOutcome[] = [];
  for (const task of suite.tasks) {
    try {
      outcomes.push({ task, ...(await runTask(task)) });
    } catch (err) {
      // A task that throws is a task that did not pass. Recording it keeps
      // the denominator honest, which a swallowed error would not.
      outcomes.push({
        task,
        passed: false,
        stopReason: `error: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
        wallClockSeconds: 0,
        tokens: 0,
        rungs: 0,
      });
    }
  }
  return {
    suiteHash: suite.hash,
    version: suite.version,
    passed: outcomes.filter((o) => o.passed).length,
    total: outcomes.length,
    firstTry: outcomes.filter((o) => o.passed && o.rungs === 0).length,
    outcomes,
    cost: {
      wallClockSeconds: outcomes.reduce((n, o) => n + o.wallClockSeconds, 0),
      tokens: outcomes.reduce((n, o) => n + o.tokens, 0),
      rungs: outcomes.reduce((n, o) => n + o.rungs, 0),
    },
    startedAt,
    at: new Date().toISOString(),
  };
}

/** The effect size below which a 30-card suite claims nothing (rule 11). */
export const MIN_CLAIMED_EFFECT = 0.2;

export interface RunComparison {
  comparable: boolean;
  /** An established gain: significant (exact McNemar, 0.05) and at least 20 points. */
  improved: boolean;
  /** Candidate passes minus baseline passes over the paired cards. */
  delta: number;
  /** Cards run and measured in both runs. */
  paired: number;
  /** Paired cards only the baseline passed, and only the candidate passed. */
  baselineOnly: number;
  candidateOnly: number;
  /** Two-sided exact McNemar p-value on the discordant pairs. */
  p: number;
  /**
   * The smallest difference (a share of the paired cards) detectable at 80%
   * power at the planning disagreement of 20%; null when none is.
   */
  minDetectable: number | null;
  /** Cards blocked in both runs, left out of the pairing. */
  droppedBlocked: number;
  verdict: "improved" | "worse" | "not established" | "no difference" | "incomparable";
  reason: string;
}

const cardKey = (t: SuiteTask) => `${t.suite}/${t.cardId}`;

export interface PairedOutcomes {
  /** Cards present in both runs and not blocked in both. */
  paired: number;
  /** Paired cards only the baseline passed, and only the candidate passed. */
  baselineOnly: number;
  candidateOnly: number;
  /** Cards blocked in both runs: unmeasured in both, so left out (rule 3). */
  droppedBlocked: number;
  /** Paired cards measured (not blocked) in both runs, for cost comparisons. */
  bothMeasured: { baseline: TaskOutcome; candidate: TaskOutcome }[];
}

/**
 * Pair two runs card by card. A card blocked in only one run counts as that
 * run's failure — its arm failed to deliver what the card needed — so a
 * change cannot hide a loss behind the cards it blocks; a card blocked in
 * both is left out and counted (review B1).
 */
export function pairOutcomes(
  baseline: readonly TaskOutcome[],
  candidate: readonly TaskOutcome[],
): PairedOutcomes {
  const cand = new Map(candidate.map((o) => [cardKey(o.task), o]));
  const out: PairedOutcomes = {
    paired: 0,
    baselineOnly: 0,
    candidateOnly: 0,
    droppedBlocked: 0,
    bothMeasured: [],
  };
  for (const b of baseline) {
    const c = cand.get(cardKey(b.task));
    if (!c) continue;
    if (unmeasured(b) && unmeasured(c)) {
      out.droppedBlocked++;
      continue;
    }
    out.paired++;
    const bPassed = b.passed && !unmeasured(b);
    const cPassed = c.passed && !unmeasured(c);
    if (bPassed && !cPassed) out.baselineOnly++;
    if (!bPassed && cPassed) out.candidateOnly++;
    if (!unmeasured(b) && !unmeasured(c)) out.bothMeasured.push({ baseline: b, candidate: c });
  }
  return out;
}

/**
 * Compare two runs of the same suite (measurement rules 10–11, MS-M12-2..4):
 * only cards run and measured in both are paired; the discordant pairs are
 * tested with the exact McNemar test; a gain is "improved" only when it is
 * significant at 0.05 **and** at least 20 points, and anything smaller or
 * not significant is "not established". Every verdict states the smallest
 * difference the pairing could have detected at 80% power. A different
 * suite hash is refused: two runs of different tasks are not comparable.
 */
export function compareRuns(baseline: SuiteRunResult, candidate: SuiteRunResult): RunComparison {
  const bMode = baseline.mode ?? "sequential";
  const cMode = candidate.mode ?? "sequential";
  if (bMode !== cMode) {
    return {
      comparable: false,
      improved: false,
      delta: 0,
      paired: 0,
      baselineOnly: 0,
      candidateOnly: 0,
      p: 1,
      minDetectable: null,
      droppedBlocked: 0,
      verdict: "incomparable",
      reason: `${bMode} against ${cMode}: a card run alone and a card run after its predecessors are different measurements (MS-T7-3)`,
    };
  }
  if (baseline.suiteHash !== candidate.suiteHash) {
    return {
      comparable: false,
      improved: false,
      delta: 0,
      paired: 0,
      baselineOnly: 0,
      candidateOnly: 0,
      p: 1,
      minDetectable: null,
      droppedBlocked: 0,
      verdict: "incomparable",
      reason: `different suites (${baseline.suiteHash.slice(0, 8)} against ${candidate.suiteHash.slice(0, 8)}); the tasks or a fixture changed between the runs`,
    };
  }
  const { paired, baselineOnly, candidateOnly, droppedBlocked } = pairOutcomes(
    baseline.outcomes,
    candidate.outcomes,
  );
  const delta = candidateOnly - baselineOnly;
  const p = exactMcNemar(baselineOnly, candidateOnly);
  // At the planning disagreement (rule 11), not the observed one: two
  // discordant pairs would otherwise claim a small detectable difference
  // exactly when nothing is detectable (review M1).
  const minDetectable = minDetectableDifference(paired, PLANNING_DISCORDANCE);
  const effect = paired ? delta / paired : 0;
  const significant = p < 0.05;
  const big = Math.abs(effect) >= MIN_CLAIMED_EFFECT;
  const verdict: RunComparison["verdict"] =
    delta === 0
      ? "no difference"
      : significant && big
        ? delta > 0
          ? "improved"
          : "worse"
        : "not established";
  const rungs = candidate.cost.rungs - baseline.cost.rungs;
  const cost =
    rungs === 0 ? "" : `; ${Math.abs(rungs)} ${rungs < 0 ? "fewer" : "more"} repair rung(s)`;
  const detectable = `${describeDetectable(minDetectable, paired, "difference")}${droppedBlocked ? `; ${droppedBlocked} card${droppedBlocked === 1 ? "" : "s"} blocked in both runs left out` : ""}`;
  const head =
    verdict === "no difference"
      ? `no difference on ${paired} paired card(s)`
      : `${delta > 0 ? "+" : ""}${delta} on ${paired} paired card(s) (${candidateOnly} gained, ${baselineOnly} lost; exact McNemar p = ${p.toFixed(4)})`;
  const tail =
    verdict === "not established"
      ? ` — not established: ${significant ? `under the ${MIN_CLAIMED_EFFECT * 100}-point effect the suite can claim` : "not significant at 0.05"}`
      : verdict === "improved" || verdict === "worse"
        ? ` — ${verdict}`
        : "";
  return {
    comparable: true,
    improved: verdict === "improved",
    delta,
    paired,
    baselineOnly,
    candidateOnly,
    p,
    minDetectable,
    droppedBlocked,
    verdict,
    reason: `${head}${tail}${cost}; ${detectable}`,
  };
}

/**
 * pass@k and pass^k per card over repeated runs of the same suite (MS-M12-5):
 * the chance at least one, and the chance all, of k runs pass. Blocked
 * outcomes are not runs of the card.
 */
export function passKByCard(
  runs: readonly SuiteRunResult[],
  k: number,
): {
  suite: string;
  cardId: string;
  runs: number;
  passes: number;
  passAtK: number;
  passHatK: number;
}[] {
  const byCard = new Map<string, { task: SuiteTask; runs: number; passes: number }>();
  for (const r of runs) {
    for (const o of r.outcomes) {
      if (unmeasured(o)) continue;
      const e = byCard.get(cardKey(o.task)) ?? { task: o.task, runs: 0, passes: 0 };
      e.runs++;
      if (o.passed) e.passes++;
      byCard.set(cardKey(o.task), e);
    }
  }
  return [...byCard.values()]
    .filter((e) => e.runs >= k)
    .map((e) => ({
      suite: e.task.suite,
      cardId: e.task.cardId,
      runs: e.runs,
      passes: e.passes,
      passAtK: passAtK(e.passes, e.runs, k),
      passHatK: passHatK(e.passes, e.runs, k),
    }));
}

/** The measured score (rule 4, MS-M12-1): passed over the measured cards, with its interval. */
export function runScore(r: SuiteRunResult): {
  passed: number;
  measured: number;
  blocked: number;
  notRun: number;
  interval: { low: number; high: number };
} {
  const blocked = r.outcomes.filter((o) => o.blocked).length;
  const notRun = r.outcomes.filter((o) => o.notRun && !o.blocked).length;
  const measured = r.outcomes.length ? r.outcomes.length - blocked - notRun : r.total;
  const passed = r.outcomes.length
    ? r.outcomes.filter((o) => o.passed && !unmeasured(o)).length
    : r.passed;
  return { passed, measured, blocked, notRun, interval: clopperPearson(passed, measured) };
}

/** One line for a terminal, and the only summary a person should need. */
export function summarise(r: SuiteRunResult): string {
  const hours = r.cost.wallClockSeconds / 3600;
  const s = runScore(r);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return [
    `${s.passed}/${s.measured} passed (95% CI ${pct(s.interval.low)}-${pct(s.interval.high)}; ${r.firstTry} first try)`,
    ...(s.blocked ? [`${s.blocked} blocked`] : []),
    ...(s.notRun ? [`${s.notRun} not run`] : []),
    `suite ${r.version} ${r.suiteHash.slice(0, 8)}`,
    `${hours >= 1 ? `${hours.toFixed(1)} h` : `${Math.round(r.cost.wallClockSeconds / 60)} min`}`,
    `${Math.round(r.cost.tokens / 1000)}k tokens`,
    `${r.cost.rungs} repair rung(s)`,
    ...(r.modelLoads?.length
      ? [
          `model load ${Math.round(r.modelLoads.reduce((n, l) => n + (l.spawnToHealthyMs?.totalMs ?? 0) + (l.loadMs?.totalMs ?? 0), 0) / 1000)} s over ${r.modelLoads.reduce((n, l) => n + (l.spawnToHealthyMs?.count ?? 0) + (l.loadMs?.count ?? 0), 0)} load(s), reported apart`,
        ]
      : []),
  ].join(" · ");
}
