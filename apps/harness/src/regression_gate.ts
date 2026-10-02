import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type GateFailure,
  type GateResult,
  type GateRung,
  type GateRunner,
  RERUN_GATES,
  type RunGatesOptions,
  type RungOutcome,
  gateCopy,
} from "@sekhemet/gates";
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
  /**
   * Base tests the card declares superseded, as `file > name` or a whole
   * file (gates rule 25a, GT-BF-1): their failure is accepted once the card's
   * new versions are staged (`ownTests` non-empty), and listed.
   */
  superseded?: readonly string[];
}

/** A supersession the gate accepted: the base test, and the staged tests that replace it. */
export interface Supersession {
  test: string;
  staged: string[];
}

/** A failing test's name as its failure names it: the first line without its location. */
function testTitle(f: GateFailure): string {
  return (f.errorExcerpt.split("\n")[0] ?? "").replace(/^\S+\s*/, "");
}

/**
 * The declared supersession a failure of a base test falls under, if any:
 * `file > name` matches that test exactly. A declaration names tests: a bare
 * file supersedes nothing (minor 2).
 */
function supersessionOf(
  file: string,
  f: GateFailure,
  declared: readonly string[],
): string | undefined {
  const title = testTitle(f);
  return declared.find((d) => {
    const at = d.indexOf(" > ");
    if (at === -1) return false;
    return normalise(d.slice(0, at).trim()) === file && d.slice(at + 3).trim() === title;
  });
}

/** A staged acceptance test's text, read where the harness stages it; "" when absent. */
function stagedText(root: string, test: string): string {
  for (const p of [test, test.startsWith("tests/") ? test : `tests/${test}`]) {
    try {
      return readFileSync(join(root, p), "utf8");
    } catch {
      // Not here.
    }
  }
  return "";
}

/**
 * The staged acceptance tests that hold the new version of a superseded test
 * (rule 25a, minor 2): those declaring a test of the same name — its last
 * `>`-separated part — through `it`, `test` or their modifiers.
 */
function newVersionsOf(root: string, declared: string, staged: readonly string[]): string[] {
  const name =
    declared
      .slice(declared.indexOf(" > ") + 3)
      .split(" > ")
      .pop()
      ?.trim() ?? "";
  if (!name) return [];
  const quoted = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declares = new RegExp(`\\b(?:it|test)(?:\\.\\w+)*\\(\\s*(["'\`])${quoted}\\1`);
  return staged.filter((t) => declares.test(stagedText(root, t)));
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
  return judgeRegressions(root, failures, options).failures;
}

/**
 * The regression gate's judgement: the failures, restated and added, and
 * the supersessions it accepted (rule 25a) — whose failures are removed.
 */
export function judgeRegressions(
  root: string,
  failures: readonly GateFailure[],
  options: RegressionOptions = {},
): { failures: GateFailure[]; superseded: Supersession[] } {
  const base = options.base ?? "main";
  const guaranteed = testsOnBase(root, base);
  if (!guaranteed) return { failures: [...failures], superseded: [] };
  const own = new Set((options.ownTests ?? []).map((t) => basename(t)));
  const changed = changedSources(root, base);
  // Rule 25a: a declared supersession counts only with the new version of
  // that test among the staged acceptance tests (minor 2).
  const staged = [...(options.ownTests ?? [])];
  const declared = (options.superseded ?? []).filter(
    (d) => newVersionsOf(root, d, staged).length > 0,
  );
  const accepted = new Map<string, Supersession>();

  const kept = failures.filter((f) => {
    const file = f.location?.file ? normalise(f.location.file) : undefined;
    if (f.rung !== "test" || !file || !guaranteed.has(file)) return true;
    const d = supersessionOf(file, f, declared);
    if (!d) return true;
    accepted.set(d, { test: d, staged: newVersionsOf(root, d, staged) });
    return false;
  });

  const restated = kept.map((f): GateFailure => {
    const file = f.location?.file ? normalise(f.location.file) : undefined;
    if (f.rung !== "test" || !file || !guaranteed.has(file) || own.has(basename(file))) return f;
    const where = changed.length ? changed.join(", ") : "the source this issue changed";
    return {
      ...f,
      gate: "regression",
      suggestedFixFiles: changed,
      suggestedAction: gateCopy.regressionBroken(file, where),
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
        ? gateCopy.regressionRestore(file, original)
        : gateCopy.regressionTooLong(file, String(original.split("\n").length));
    removed.push({
      rung: "hygiene",
      gate: "regression",
      layer: "hygiene",
      exitCode: 1,
      errorExcerpt: `${file} exists on ${base} and has been removed or emptied`,
      suggestedFixFiles: [file],
      location: { file },
      expected: `every test ${base} has still exists`,
      actual: `${file} is gone`,
      minimalRepro: RERUN_GATES,
      suggestedAction: gateCopy.regressionRemoved(file, restore),
    });
  }
  return { failures: [...restated, ...removed], superseded: [...accepted.values()] };
}

/** Wrap a gate runner so every verification protects what main guarantees. */
export function withRegressionGate(inner: GateRunner, options: RegressionOptions = {}): GateRunner {
  return {
    // GT-M6-5: the gate this wrapper adds, for `note`'s enum.
    gateIds: [...(inner.gateIds ?? []), "regression"],
    runGates: async (
      rungs: GateRung[],
      cwd: string,
      runOptions?: RunGatesOptions,
    ): Promise<GateResult> => {
      let res = await inner.runGates(rungs, cwd, runOptions);
      const started = Date.now();
      let { failures, superseded } = judgeRegressions(cwd, res.failures, options);
      // A test gate whose every failure is an accepted supersession.
      const forgiven = (o: RungOutcome, r: GateResult, left: readonly GateFailure[]) =>
        superseded.length > 0 &&
        !o.passed &&
        !o.skipped &&
        !o.unavailable &&
        o.rung === "test" &&
        r.failures.some((f) => f.gate === o.gate) &&
        !left.some((f) => f.gate === o.gate);
      // B1: an impacted-only run is never forgiven into a pass; when every
      // failure it found is a supersession, the full suite is judged instead.
      if (
        !runOptions?.fullSuite &&
        (res.rungResults ?? []).some((o) => o.fullSuite === false && forgiven(o, res, failures))
      ) {
        res = await inner.runGates(rungs, cwd, { ...(runOptions ?? {}), fullSuite: true });
        ({ failures, superseded } = judgeRegressions(cwd, res.failures, options));
      }
      const regressions = failures.filter((f) => f.gate === "regression");
      // A test gate whose only failures were accepted supersessions passes
      // (rule 25a) — when the full suite ran and its output was read in full
      // (B1, M1); otherwise the gate's failure stands, and says why.
      const judged = (res.rungResults ?? []).map((o) => {
        if (!forgiven(o, res, failures)) return o;
        if (o.fullSuite !== false && o.parsedInFull === true) return { ...o, passed: true };
        const why =
          o.fullSuite === false
            ? "only the impacted tests ran"
            : `its output was not read in full (${o.parseGap ?? "no reading of it was recorded"})`;
        return {
          ...o,
          note: `${o.note ? `${o.note}; ` : ""}every failure is an accepted supersession, but ${why}: the failure stands`,
        };
      });
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
        // Every accepted supersession, for the evidence and Review (rule 25a).
        ...(superseded.length > 0
          ? {
              superseded,
              note: `accepted as superseded, new versions staged: ${superseded.map((s) => s.test).join("; ")}`,
            }
          : {}),
      };
      const innerPassed =
        res.passed ||
        (superseded.length > 0 &&
          failures.length === 0 &&
          judged.every((o) => o.passed || (o.skipped && !o.unavailable)));
      // A stood failure with nothing left to name keeps its test failures.
      if (!innerPassed && failures.length === 0) failures = [...res.failures];
      return {
        ...res,
        passed: innerPassed && regressions.length === 0,
        failures,
        rungResults: [...judged, outcome],
      };
    },
  };
}
