import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

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
  /** Covers the manifest and the fixtures' contents. */
  hash: string;
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
}

export interface SuiteRunResult {
  suiteHash: string;
  version: string;
  passed: number;
  total: number;
  outcomes: TaskOutcome[];
  cost: { wallClockSeconds: number; tokens: number; rungs: number };
  /** Passes that needed no repair, which is the number that should grow. */
  firstTry: number;
  at: string;
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

  return { version: manifest.version, tasks, hash: hash.digest("hex") };
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
    at: new Date().toISOString(),
  };
}

/**
 * Whether a candidate beat a baseline. Two runs of different suites are not
 * comparable at all, so a hash mismatch is refused rather than reported as a
 * regression — the alternative silently compares a change against a different
 * set of tasks, which is worse than having no comparison.
 */
export function compareRuns(
  baseline: SuiteRunResult,
  candidate: SuiteRunResult,
): { comparable: boolean; improved: boolean; delta: number; reason: string } {
  if (baseline.suiteHash !== candidate.suiteHash) {
    return {
      comparable: false,
      improved: false,
      delta: 0,
      reason: `different suites (${baseline.suiteHash.slice(0, 8)} against ${candidate.suiteHash.slice(0, 8)}); the tasks or a fixture changed between the runs`,
    };
  }
  const delta = candidate.passed - baseline.passed;
  if (delta !== 0) {
    return {
      comparable: true,
      improved: delta > 0,
      delta,
      reason: `${delta > 0 ? "+" : ""}${delta} task(s) against the baseline's ${baseline.passed}/${baseline.total}`,
    };
  }
  // Equal scores are separated by what the score cost: the same number of
  // passes with fewer repair rungs is a better harness, and is the usual
  // shape of a real improvement on a small suite.
  const rungs = candidate.cost.rungs - baseline.cost.rungs;
  return {
    comparable: true,
    improved: rungs < 0,
    delta: 0,
    reason:
      rungs === 0
        ? `no change: ${candidate.passed}/${candidate.total} at the same cost`
        : `${candidate.passed}/${candidate.total} either way, ${Math.abs(rungs)} ${rungs < 0 ? "fewer" : "more"} repair rung(s)`,
  };
}

/** One line for a terminal, and the only summary a person should need. */
export function summarise(r: SuiteRunResult): string {
  const hours = r.cost.wallClockSeconds / 3600;
  return [
    `${r.passed}/${r.total} passed (${r.firstTry} first try)`,
    `suite ${r.version} ${r.suiteHash.slice(0, 8)}`,
    `${hours >= 1 ? `${hours.toFixed(1)} h` : `${Math.round(r.cost.wallClockSeconds / 60)} min`}`,
    `${Math.round(r.cost.tokens / 1000)}k tokens`,
    `${r.cost.rungs} repair rung(s)`,
  ].join(" · ");
}
