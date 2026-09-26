import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CardChange } from "@sekhemet/kernel";
import type { ProcessSandbox } from "@sekhemet/sandbox";
import { gitShow } from "./builtin.js";
import { RERUN_GATES, gateCopy } from "./copy.js";
import { factsOfText } from "./index/source_index.js";
import type { JUnitCase } from "./junit.js";
import { unavailableGate } from "./pipeline.js";
import { runTestCases } from "./test_strength.js";
import type { CompleteGateFailure, GateDefinition, RungOutcome } from "./types.js";

/**
 * The checks particular to a card's `change` beyond its red/green rule
 * (gates rules 6b and 32a; DoD §5.1 item 1): a refactor keeps the exported
 * surface of its scope (GT-TQ-8), and an upgrade keeps a named list of
 * tests passing (GT-TQ-11). A characterize card's stand-ins are part of the
 * strength check (`test_strength.ts`, GT-TQ-10).
 */

/** A test file: its exports are not the project's surface. */
const REFACTOR_TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(spec|test)\.[cm]?[jt]sx?$/;

/** How one scope file's exported surface differs from the base's. */
export interface SurfaceChange {
  file: string;
  added: string[];
  removed: string[];
}

/**
 * A file's exported surface as the source index reads it: its own export
 * names and each re-export (a named one by the name it exports and its
 * source, `export *` by its source). Kinds and bodies are not surface: a
 * type alias that becomes an interface of the same name keeps it.
 */
function surface(file: string, text: string): Set<string> {
  const facts = factsOfText(file, text);
  const out = new Set<string>(facts.exports.map((e) => e.name));
  for (const r of facts.reExports) {
    if (r.namespace) out.add(`${r.namespace} (from ${r.specifier})`);
    else if (r.names.length > 0) {
      for (const n of r.names) out.add(`${n.exported} (from ${r.specifier})`);
    } else out.add(`* (from ${r.specifier})`);
  }
  return out;
}

/**
 * GT-TQ-8: the scope files' exported surface on the change against the
 * base's. Any difference fails the card with `refactor-surface`, naming
 * every added and removed name, unless the card declares the surface change.
 * (That the characterization and existing tests pass on the base and on the
 * change is the red/green table's and the test gate's.)
 */
export function checkRefactorSurface(opts: {
  root: string;
  base: string;
  scope: readonly string[];
  declaredSurfaceChange?: boolean;
}): { changes: SurfaceChange[]; failure?: CompleteGateFailure } {
  const changes: SurfaceChange[] = [];
  for (const file of [...opts.scope].sort()) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const abs = join(opts.root, file);
    const now = existsSync(abs) ? surface(file, readFileSync(abs, "utf8")) : new Set<string>();
    const baseText = gitShow(opts.root, opts.base, file);
    const was = baseText === undefined ? new Set<string>() : surface(file, baseText);
    const added = [...now].filter((n) => !was.has(n)).sort();
    const removed = [...was].filter((n) => !now.has(n)).sort();
    if (added.length > 0 || removed.length > 0) changes.push({ file, added, removed });
  }
  if (changes.length === 0 || opts.declaredSurfaceChange) return { changes };
  const said = changes.map(
    (c) =>
      `${c.file}: ${[
        c.removed.length > 0 ? `removed ${c.removed.join(", ")}` : "",
        c.added.length > 0 ? `added ${c.added.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ")}`,
  );
  const first = changes[0] as SurfaceChange;
  return {
    changes,
    failure: {
      gate: "refactor-surface",
      rung: "test",
      layer: "functional",
      exitCode: 1,
      errorExcerpt: `a refactor changed the exported surface of its scope: ${said.join(" | ")}`,
      suggestedFixFiles: changes.map((c) => c.file),
      location: { file: first.file },
      expected: "the scope files export exactly what they exported on the base",
      actual: said.join(" | "),
      minimalRepro: RERUN_GATES,
      suggestedAction: gateCopy.refactorSurface(first.file),
    },
  };
}

/**
 * GT-TQ-11: the tests an upgrade card must keep passing — the ones it names,
 * or by default the project's tests that pass on the base. An empty list is
 * refused: the card may not start.
 */
export function upgradeTestList(opts: {
  named?: readonly string[];
  passingOnBase: readonly string[];
}): { tests: string[]; refused?: undefined } | { tests?: undefined; refused: string } {
  const tests = [...new Set(opts.named ?? opts.passingOnBase)].sort();
  if (tests.length === 0) {
    return {
      refused:
        "an upgrade card has no test to keep passing: name the tests it must keep, or give the project tests that pass on the base",
    };
  }
  return { tests };
}

/**
 * GT-TQ-11: after the upgrade, every kept test must pass. A kept test that
 * fails, or reported no result, fails the card's verification, before any
 * child `fix` card is proposed.
 */
export function checkUpgradeTests(
  kept: readonly string[],
  results: readonly { test: string; passed: boolean }[],
): CompleteGateFailure[] {
  const byTest = new Map(results.map((r) => [r.test, r.passed]));
  const out: CompleteGateFailure[] = [];
  for (const test of kept) {
    const passed = byTest.get(test);
    if (passed === true) continue;
    const actual = passed === false ? "fails after it" : "did not run after it";
    out.push({
      gate: "upgrade-tests",
      rung: "test",
      layer: "functional",
      exitCode: 1,
      errorExcerpt: `${test}: kept by the upgrade, ${actual}`,
      suggestedFixFiles: [],
      location: { file: test.split(" > ")[0] || "." },
      expected: `${test} passes after the upgrade, as it did on the base`,
      actual,
      minimalRepro: RERUN_GATES,
      suggestedAction: gateCopy.upgradeKept(test),
    });
  }
  return out;
}

/** A case's name as the kept list records it: `file > name`. */
function caseName(c: JUnitCase): string {
  return `${c.file} > ${c.name}`;
}

/**
 * GT-TQ-11's default kept list: the project's tests that pass on the tree as
 * it stands (the base, before the upgrade's first step), each `file > name`,
 * from one run of the test gate's JUnit path. A runner without one, or a run
 * that wrote no report, is `unavailable`, never an empty list that passes.
 */
export async function passingTests(
  sandbox: ProcessSandbox,
  root: string,
  gate: GateDefinition,
): Promise<{ tests: string[] } | { unavailable: string }> {
  const run = await runTestCases(sandbox, root, gate, []);
  if ("unavailable" in run) return run;
  return {
    tests: [
      ...new Set(run.cases.filter((c) => c.status === "passed" && !c.fileLevel).map(caseName)),
    ].sort(),
  };
}

/** What the change-kind checks need beyond the tree (gates rule 6b). */
export interface ChangeKindInput {
  root: string;
  base: string;
  change: CardChange | undefined;
  /** The card's scope: a refactor's surface is its scope files' (GT-TQ-8). */
  scope: readonly string[];
  /**
   * The files the change touches (its diff), judged with the scope: a
   * refactor cannot change an export outside its declared scope unseen.
   * Undefined when the diff could not be read.
   */
  changed?: readonly string[] | undefined;
  /** The card declares its surface change (GT-TQ-8). */
  surfaceChange?: boolean | undefined;
  /** The tests an upgrade keeps passing, recorded on the card (GT-TQ-11). */
  keptTests?: readonly string[] | undefined;
  /** Runs the kept tests: the project's test gate, confined, through its JUnit path. */
  sandbox?: ProcessSandbox | undefined;
  testGate?: GateDefinition | undefined;
}

/**
 * The checks particular to a card's `change`, run by the card's
 * verification: a refactor's exported surface (GT-TQ-8) and an upgrade's
 * kept tests (GT-TQ-11). Other changes have none. A kept list that cannot be
 * run is not run, never passed (gates rule 9).
 */
export async function runChangeKindChecks(
  input: ChangeKindInput,
): Promise<{ outcomes: RungOutcome[]; failures: CompleteGateFailure[] }> {
  const started = Date.now();
  const outcome = (gate: string, passed: boolean, note?: string): RungOutcome => ({
    gate,
    rung: "test",
    layer: "functional",
    passed,
    exitCode: passed ? 0 : 1,
    durationMs: Date.now() - started,
    ...(note ? { note } : {}),
  });
  if (input.change === "refactor") {
    // GT-TQ-8: the scope and every source file the change touches, tests aside.
    const touched = (input.changed ?? []).filter((f) => !REFACTOR_TEST_FILE.test(f));
    const files = [...new Set([...input.scope, ...touched])];
    if (input.scope.length === 0 && input.changed === undefined) {
      const u = unavailableGate(
        "refactor-surface",
        "test",
        "functional",
        "the refactor card declares no scope and its diff could not be read, so there is no surface to compare",
      );
      return { outcomes: [u.outcome], failures: [u.failure as CompleteGateFailure] };
    }
    const r = checkRefactorSurface({
      root: input.root,
      base: input.base,
      scope: files,
      ...(input.surfaceChange ? { declaredSurfaceChange: true } : {}),
    });
    const declared =
      r.changes.length > 0 && !r.failure ? "the card declares its surface change" : undefined;
    return {
      outcomes: [outcome("refactor-surface", !r.failure, declared)],
      failures: r.failure ? [r.failure] : [],
    };
  }
  if (input.change === "upgrade") {
    const kept = [...(input.keptTests ?? [])];
    const notRun = (reason: string) => {
      const u = unavailableGate("upgrade-tests", "test", "functional", reason);
      return { outcomes: [u.outcome], failures: [u.failure as CompleteGateFailure] };
    };
    if (kept.length === 0) return notRun("the upgrade card records no test to keep passing");
    if (!input.sandbox || !input.testGate) return notRun("no test gate to run the kept tests");
    const files = [...new Set(kept.map((t) => t.split(" > ")[0] ?? t))].sort();
    const run = await runTestCases(input.sandbox, input.root, input.testGate, files);
    if ("unavailable" in run) return notRun(run.unavailable);
    const results = run.cases
      .filter((c) => !c.fileLevel)
      .map((c) => ({ test: caseName(c), passed: c.status === "passed" }));
    const failures = checkUpgradeTests(kept, results);
    return {
      outcomes: [outcome("upgrade-tests", failures.length === 0, `${kept.length} kept test(s)`)],
      failures,
    };
  }
  return { outcomes: [], failures: [] };
}
