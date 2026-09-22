import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { GateFailure, GateResult, GateRung, GateRunner, RungOutcome } from "@sekhemet/gates";
import { changedSources } from "./reachability_gate.js";

/**
 * The regression gate: a card may not take away what `main` already
 * guarantees.
 *
 * Every accepted card leaves its tests on `main`, so `main`'s tests are the
 * project's accumulated promise. The test rung already runs them, and a card
 * that breaks one already fails — but it failed as an anonymous test failure
 * whose suggested fix pointed at the test file: protected, and belonging to
 * work that is finished. The Worker was told to fix the one thing it may not
 * touch. This gate names the failure for what it is and points at the card's
 * own change, where the fix is.
 *
 * It also catches what a test run cannot: a test that is gone does not fail.
 * Not every project protects its tests in `gates.toml`, so a card that deletes
 * or empties a test `main` had is refused here, whatever the test run says.
 *
 * Like reachability, it judges only what the card changed relative to `main`,
 * and outside a git repository it judges nothing rather than guess.
 */

const TEST = /(^|\/)(tests?|__tests__)\/|\.(spec|test)\.[cm]?[jt]sx?$/;
/**
 * A test is source code. Suite run 3 found the first version treating every
 * file under tests/ as one — including the empty tests/.gitkeep every fixture
 * has — and failing every card for "emptying" a placeholder.
 */
const CODE = /\.(?:[cm]?[jt]sx?|py|rs|go|java|rb)$/;
/** Content up to this size travels in the failure, so restoring it is one write. */
const CARRY_LIMIT = 4000;
/** The acceptance library is staged from, not run; later cards' tests live there. */
const LIBRARY = /(^|\/)acceptance\//;

export interface RegressionOptions {
  /** The card's own acceptance tests: failing those is the card's work, not a regression. */
  ownTests?: readonly string[];
  base?: string;
}

/** Test files committed on `base`, or undefined when there is no such base. */
function testsOnBase(root: string, base: string): Set<string> | undefined {
  try {
    const out = execFileSync("git", ["ls-tree", "-r", "--name-only", base], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(
      out
        .split("\n")
        .map((f) => f.trim())
        .filter((f) => f && TEST.test(f) && CODE.test(f) && !LIBRARY.test(f)),
    );
  } catch {
    return undefined;
  }
}

const normalise = (file: string): string => file.replace(/^\.\//, "");

function contentOnBase(root: string, base: string, file: string): string {
  try {
    return execFileSync("git", ["show", `${base}:${file}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

/**
 * The inner gates' failures, with every failure of a test `main` already
 * guarantees restated as a regression, plus one failure per test the card
 * removed or emptied.
 */
export function regressionFailures(
  root: string,
  failures: readonly GateFailure[],
  options: RegressionOptions = {},
): GateFailure[] {
  const base = options.base ?? "main";
  const guaranteed = testsOnBase(root, base);
  if (!guaranteed) return [...failures];
  const own = new Set((options.ownTests ?? []).map((t) => basename(t)));
  const changed = changedSources(root, base);

  const restated = failures.map((f): GateFailure => {
    const file = f.location?.file ? normalise(f.location.file) : undefined;
    if (f.rung !== "test" || !file || !guaranteed.has(file) || own.has(basename(file))) return f;
    const where = changed.length ? changed.join(", ") : "the source this card changed";
    return {
      ...f,
      gate: "regression",
      suggestedFixFiles: changed,
      suggestedAction: `${file} passed on main and fails with this card's change, so the change broke work that was already finished. The fix is in what you changed (${where}): make it keep ${file}'s behaviour while doing what this card asks. Do not edit the test.`,
    };
  });

  const removed: GateFailure[] = [];
  for (const file of guaranteed) {
    const path = join(root, file);
    const gone = !existsSync(path) || readFileSync(path, "utf8").trim() === "";
    if (!gone) continue;
    const original = contentOnBase(root, base, file);
    // Empty on main too: nothing was taken away.
    if (original.trim() === "") continue;
    // The Worker has write_file, not git: the failure carries what to write.
    const restore =
      original.length <= CARRY_LIMIT
        ? `Restore it in one step: write_file ${file} with exactly this content, as it is on main:\n${original}`
        : `It is ${original.split("\n").length} lines on main, too long to restore by hand here: say with note that ${file} was removed and needs restoring, and finish.`;
    removed.push({
      rung: "hygiene",
      gate: "regression",
      layer: "hygiene",
      exitCode: 1,
      errorExcerpt: `${file} exists on main and has been removed or emptied`,
      suggestedFixFiles: [file],
      location: { file },
      expected: "every test main has still exists",
      actual: `${file} is gone`,
      suggestedAction: `${file} is a test main already has, and this card removed or emptied it. A test that no longer exists cannot fail, which is why removing one is refused; if it is genuinely obsolete, say so with note and let a human remove it. ${restore}`,
    });
  }
  return [...restated, ...removed];
}

/** Wrap a gate runner so every verification protects what main guarantees. */
export function withRegressionGate(inner: GateRunner, options: RegressionOptions = {}): GateRunner {
  return {
    runGates: async (rungs: GateRung[], cwd: string): Promise<GateResult> => {
      const res = await inner.runGates(rungs, cwd);
      const started = Date.now();
      const failures = regressionFailures(cwd, res.failures, options);
      const regressions = failures.filter((f) => f.gate === "regression");
      const outcome: RungOutcome = {
        // It runs no tests itself — it reads the tree and the other gates'
        // results — so it reports as hygiene, like reachability. Reporting as
        // functional made a static-only audit look as if it had run tests.
        gate: "regression",
        rung: "hygiene",
        layer: "hygiene",
        passed: regressions.length === 0,
        exitCode: regressions.length === 0 ? 0 : 1,
        durationMs: Date.now() - started,
      };
      return {
        ...res,
        passed: res.passed && regressions.length === 0,
        failures,
        rungResults: [...(res.rungResults ?? []), outcome],
      };
    },
  };
}
