import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import {
  BASELINE_EVENT,
  baselineFromEvents,
  captureBaseline,
  failureFingerprint,
  withBaseline,
} from "../src/baseline.js";
import { loadGatesConfig } from "../src/config.js";
import { DeterministicGateRunner } from "../src/runner.js";

// NEW-gates-7, GT-BF-2 (gates rule 15a): the onboarding baseline. Real git,
// real processes and real Vitest: pre-existing type errors and failing and
// flaky tests are recorded once (the suite run twice), and a gate then
// reports only what is absent from the baseline.

const REPO = join(import.meta.dirname, "..", "..", "..");
const VITEST = join(REPO, "node_modules", "vitest", "vitest.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A typecheck gate that prints, in tsc's format, one error per line of `errors.txt`. */
const CHECK = `import { existsSync, readFileSync } from "node:fs";
const lines = existsSync("errors.txt") ? readFileSync("errors.txt", "utf8").split("\\n").filter(Boolean) : [];
for (const l of lines) console.log(l);
// More output than the sandbox keeps (10 MB): the rest is cut.
if (existsSync("junk")) process.stdout.write("x".repeat(11 * 1024 * 1024));
process.exitCode = lines.length ? 2 : 0;
`;

const GATES = `
[[gate]]
id = "typecheck"
rung = "typecheck"
command = "node"
args = ["check.mjs"]
parser = "tsc"

[[gate]]
id = "unit"
rung = "test"
command = "node"
args = [${JSON.stringify(VITEST)}, "run", "--reporter=default"]
parser = "vitest"
timeout_s = 120
`;

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "baseline-")));
  dirs.push(root);
  const all: Record<string, string> = {
    "package.json": '{ "name": "b", "type": "module", "private": true }\n',
    ".gitignore": ".sekhemet/state/\nnode_modules/\n.log/\n",
    ".sekhemet/gates.toml": GATES,
    "check.mjs": CHECK,
    ...files,
  };
  for (const [p, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@t.t");
  git(root, "config", "user.name", "T");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed");
  return root;
}

const runner = (root: string) =>
  new DeterministicGateRunner(new ProcessSandbox(), {
    repoRoot: root,
    maxFailuresReported: Number.POSITIVE_INFINITY,
    // The baseline runs the suite twice on one tree: never a cached verdict.
    verdictCache: false,
  });

const SRC = "export function a(): number {\n  return missing;\n}\n";
const OLD_ERROR = "src/a.ts(2,10): error TS2304: Cannot find name 'missing'.";
// Fails on every other run: a counter under .log/ (ignored) flips it.
const FLAKY = `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
it("sometimes", () => {
  mkdirSync(".log", { recursive: true });
  const n = existsSync(".log/n") ? Number(readFileSync(".log/n", "utf8")) : 0;
  writeFileSync(".log/n", String(n + 1));
  expect(n % 2).toBe(1);
});
`;
const BROKEN = `import { expect, it } from "vitest";
it("always broken", () => { expect(1).toBe(2); });
it("fine", () => { expect(1).toBe(1); });
`;

describe("capturing the onboarding baseline (GT-BF-2)", () => {
  it("records pre-existing type errors once and failing and flaky tests from two runs", async () => {
    const root = repo({
      "src/a.ts": SRC,
      "errors.txt": `${OLD_ERROR}\n`,
      "tests/flaky.spec.ts": FLAKY,
      "tests/broken.spec.ts": BROKEN,
    });
    const baseline = await captureBaseline({
      runner: runner(root),
      root,
      rungs: ["typecheck", "test"],
      gates: loadGatesConfig(root).gates,
    });
    const byRule = baseline.entries.map((e) => `${e.rung}|${e.file}|${e.rule}`);
    expect(byRule.sort()).toEqual([
      "test|tests/broken.spec.ts|always broken",
      "typecheck|src/a.ts|TS2304",
    ]);
    // Minor 1: a test flaky at onboarding is not baselined — quarantine judges
    // it (rule 34) — and is recorded apart, for the person to read.
    expect(baseline.flaky.map((e) => `${e.file}|${e.rule}`)).toEqual([
      "tests/flaky.spec.ts|sometimes",
    ]);
    // The suite ran twice, and each run is recorded with its exit code.
    expect(baseline.runs.filter((r) => r.rung === "test").map((r) => r.run)).toEqual([1, 2]);
    expect(baseline.runs.find((r) => r.gate === "typecheck")?.command).toBe("node check.mjs");
    expect(baseline.runs.every((r) => typeof r.exitCode === "number")).toBe(true);
  });

  it("keys a diagnostic by file, rule and a fingerprint that survives a line move", async () => {
    const root = repo({ "src/a.ts": SRC });
    const f = (line: number) => ({
      rung: "typecheck" as const,
      gate: "typecheck",
      exitCode: 2,
      errorExcerpt: `src/a.ts:${line}:10 TS2304: Cannot find name 'missing'.`,
      suggestedFixFiles: ["src/a.ts"],
      location: { file: "src/a.ts", line, column: 10 },
      expected: "e",
      actual: "a",
      minimalRepro: "r",
      suggestedAction: "s",
    });
    const before = failureFingerprint(f(2), root);
    writeFileSync(join(root, "src", "a.ts"), `// a comment\n// another\n${SRC}`);
    const after = failureFingerprint(f(4), root);
    expect(before?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(after?.fingerprint).toBe(before?.fingerprint);
    expect(after?.rule).toBe("TS2304");
    // A failure about no one file is never baselined.
    expect(failureFingerprint({ ...f(2), location: { file: "." } }, root)).toBeUndefined();
  });
});

describe("gates read the baseline (GT-BF-2)", () => {
  it("reports only diagnostics and failing tests absent from the baseline", async () => {
    const root = repo({
      "src/a.ts": SRC,
      "errors.txt": `${OLD_ERROR}\n`,
      "tests/broken.spec.ts": BROKEN,
    });
    const baseline = await captureBaseline({
      runner: runner(root),
      root,
      rungs: ["typecheck", "test"],
    });
    const wrapped = withBaseline(runner(root), { baseline: baseline.entries });

    // Unchanged tree: nothing new, so every gate passes and the evidence says why.
    const same = await wrapped.runGates(["typecheck", "test"], root);
    expect(same.passed).toBe(true);
    expect(same.failures).toEqual([]);
    const tc = same.rungResults?.find((o) => o.gate === "typecheck");
    expect(tc?.passed).toBe(true);
    expect(tc?.note).toMatch(/1 pre-existing finding .*onboarding baseline/);

    // The card moves the old error down and adds a new one: only the new one counts.
    writeFileSync(join(root, "src", "a.ts"), `export const b: string = 1;\n${SRC}`);
    writeFileSync(
      join(root, "errors.txt"),
      "src/a.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.\nsrc/a.ts(3,10): error TS2304: Cannot find name 'missing'.\n",
    );
    const next = await wrapped.runGates(["typecheck", "test"], root);
    expect(next.passed).toBe(false);
    expect(next.failures.map((f) => f.errorExcerpt.split("\n")[0])).toEqual([
      "src/a.ts:1:14 TS2322: Type 'number' is not assignable to type 'string'.",
    ]);
  });

  it("shrinks the baseline when a baselined diagnostic disappears, never a flaky test", async () => {
    const root = repo({ "src/a.ts": SRC, "errors.txt": `${OLD_ERROR}\n` });
    const baseline = await captureBaseline({
      runner: runner(root),
      root,
      rungs: ["typecheck"],
    });
    const gone: string[] = [];
    const wrapped = withBaseline(runner(root), {
      baseline: [
        ...baseline.entries,
        {
          fingerprint: "f".repeat(64),
          gate: "unit",
          rung: "test",
          file: "tests/x.spec.ts",
          rule: "x",
          flaky: true,
        },
      ],
      onShrink: (entries) => {
        gone.push(...entries.map((e) => `${e.file}|${e.rule}`));
      },
    });
    writeFileSync(join(root, "errors.txt"), "");
    const r = await wrapped.runGates(["typecheck"], root);
    expect(r.passed).toBe(true);
    expect(gone).toEqual(["src/a.ts|TS2304"]);
  });
});

describe("the baseline on the ledger (GT-BF-2)", () => {
  it("folds the recorded baseline and applies a shrink only once its card is accepted", () => {
    const e = (fp: string) => ({
      fingerprint: fp.repeat(64),
      gate: "typecheck",
      rung: "typecheck" as const,
      file: "src/a.ts",
      rule: "TS2304",
    });
    const events = [
      {
        type: BASELINE_EVENT,
        payload: { kind: "recorded", entries: [e("a"), e("a"), e("b"), e("c")] },
      },
      {
        type: BASELINE_EVENT,
        payload: { kind: "shrink", card: "c1", fingerprints: ["a".repeat(64)] },
      },
      {
        type: BASELINE_EVENT,
        payload: { kind: "shrink", card: "c2", fingerprints: ["b".repeat(64)] },
      },
      { type: BASELINE_EVENT, payload: { kind: "shrink", fingerprints: ["c".repeat(64)] } },
      // c1's next verification finds the same diagnostic gone again: counted once.
      {
        type: BASELINE_EVENT,
        payload: { kind: "shrink", card: "c1", fingerprints: ["a".repeat(64)] },
      },
      { type: "card/accepted", payload: { id: "c1" } },
    ];
    expect(baselineFromEvents(events)?.entries.map((x) => x.fingerprint[0])).toEqual(["a", "b"]);
    expect(baselineFromEvents([])).toBeUndefined();
  });
});

// Review B1: a run of the impacted tests only did not run the full suite, so
// the baseline never forgives it into a pass; when every failure it found is
// baselined, the full suite runs and is judged instead.
describe("the baseline never forgives an impacted-only run (B1)", () => {
  it("runs the full suite when every impacted failure is baselined", async () => {
    const root = repo({
      "src/a.ts": "export const a = (): number => 1;\n",
      "tests/a.spec.ts":
        'import { expect, it } from "vitest";\nimport { a } from "../src/a.js";\nit("a broken", () => { expect(a()).toBe(2); });\n',
      "tests/c.spec.ts":
        'import { readFileSync } from "node:fs";\nimport { expect, it } from "vitest";\nit("data", () => { expect(readFileSync("data.txt", "utf8").trim()).toBe("one"); });\n',
      "data.txt": "one\n",
    });
    const baseline = await captureBaseline({ runner: runner(root), root, rungs: ["test"] });
    expect(baseline.entries.map((e) => e.rule)).toEqual(["a broken"]);
    // The card touches src/a.ts (a.spec is reachable) and data.txt (c.spec reads it).
    writeFileSync(join(root, "src", "a.ts"), "export const a = (): number => 1; // same\n");
    writeFileSync(join(root, "data.txt"), "two\n");
    const inner = new DeterministicGateRunner(new ProcessSandbox(), {
      repoRoot: root,
      maxFailuresReported: Number.POSITIVE_INFINITY,
      verdictCache: false,
      quarantine: { open: false, base: "main" },
    });
    const r = await withBaseline(inner, { baseline: baseline.entries }).runGates(["test"], root);
    expect(r.passed).toBe(false);
    expect(r.failures.map((f) => f.location.file)).toEqual(["tests/c.spec.ts"]);
    expect(r.rungResults?.[0]?.fullSuite).not.toBe(false);
  });
});

// Review M1: a non-zero exit is forgiven only when every failure in its
// output was read; otherwise the failure stands, with a note saying why.
describe("the baseline forgives only a run read in full (M1)", () => {
  it("keeps the failure when the runner reports an unhandled error beside a baselined test", async () => {
    const root = repo({ "tests/broken.spec.ts": BROKEN });
    const baseline = await captureBaseline({ runner: runner(root), root, rungs: ["test"] });
    expect(baseline.entries.map((e) => e.rule)).toEqual(["always broken"]);
    writeFileSync(
      join(root, "tests", "leak.spec.ts"),
      'import { it } from "vitest";\nit("leaks", async () => { setTimeout(() => { throw new Error("boom"); }, 0); await new Promise((r) => setTimeout(r, 50)); });\n',
    );
    const r = await withBaseline(runner(root), { baseline: baseline.entries }).runGates(
      ["test"],
      root,
    );
    expect(r.passed).toBe(false);
    const unit = r.rungResults?.find((o) => o.gate === "unit");
    expect(unit?.passed).toBe(false);
    expect(unit?.note).toMatch(/not read in full .*error outside any test/);
  });

  it("keeps the failure when the output was cut at the output cap", async () => {
    const root = repo({ "src/a.ts": SRC, "errors.txt": `${OLD_ERROR}\n` });
    const baseline = await captureBaseline({ runner: runner(root), root, rungs: ["typecheck"] });
    writeFileSync(join(root, "junk"), "1");
    const r = await withBaseline(runner(root), { baseline: baseline.entries }).runGates(
      ["typecheck"],
      root,
    );
    expect(r.passed).toBe(false);
    const tc = r.rungResults?.find((o) => o.gate === "typecheck");
    expect(tc?.passed).toBe(false);
    expect(tc?.note).toMatch(/not read in full .*output cap/);
  }, 60_000);
});

// Review M4: a card's shrink is its last judged run's, recorded even when
// nothing disappeared, so a diagnostic an early run missed but a later run
// found again is never removed when the card is accepted.
describe("a shrink is the card's last judged run (M4)", () => {
  it("reports every judged run to onShrink, an empty one too", async () => {
    const root = repo({ "src/a.ts": SRC, "errors.txt": `${OLD_ERROR}\n` });
    const baseline = await captureBaseline({ runner: runner(root), root, rungs: ["typecheck"] });
    const calls: { gone: string[]; gates: string[] }[] = [];
    const wrapped = withBaseline(runner(root), {
      baseline: baseline.entries,
      onShrink: (gone, gates) => {
        calls.push({ gone: gone.map((e) => e.rule), gates });
      },
    });
    writeFileSync(join(root, "errors.txt"), "");
    await wrapped.runGates(["typecheck"], root);
    writeFileSync(join(root, "errors.txt"), `${OLD_ERROR}\n`);
    await wrapped.runGates(["typecheck"], root);
    expect(calls).toEqual([
      { gone: ["TS2304"], gates: ["typecheck"] },
      { gone: [], gates: ["typecheck"] },
    ]);
  });

  it("folds each card's last judged run per gate", () => {
    const e = (fp: string, gate = "typecheck") => ({
      fingerprint: fp.repeat(64),
      gate,
      rung: "typecheck" as const,
      file: "src/a.ts",
      rule: "TS2304",
    });
    const shrink = (fps: string[], gates: string[]) => ({
      type: BASELINE_EVENT,
      payload: { kind: "shrink", card: "c1", gates, fingerprints: fps.map((f) => f.repeat(64)) },
    });
    const events = [
      { type: BASELINE_EVENT, payload: { kind: "recorded", entries: [e("a"), e("b", "lint")] } },
      // An early run found both gone; a later typecheck run found a again.
      shrink(["a", "b"], ["typecheck", "lint"]),
      shrink([], ["typecheck"]),
      { type: "card/accepted", payload: { id: "c1" } },
    ];
    expect(baselineFromEvents(events)?.entries.map((x) => x.fingerprint[0])).toEqual(["a"]);
  });
});

// Minor 4: a baseline taken with another gates.toml is not applied; the
// evidence says a re-baseline is needed.
describe("a baseline from another gates.toml is not applied (minor 4)", () => {
  it("counts every failure and says re-baseline needed", async () => {
    const root = repo({ "src/a.ts": SRC, "errors.txt": `${OLD_ERROR}\n` });
    const baseline = await captureBaseline({ runner: runner(root), root, rungs: ["typecheck"] });
    const r = await withBaseline(runner(root), {
      baseline: baseline.entries,
      gatesSha256: "0".repeat(64),
      currentGatesSha256: loadGatesConfig(root).sha256,
    }).runGates(["typecheck"], root);
    expect(r.passed).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.rungResults?.find((o) => o.gate === "typecheck")?.note).toMatch(/re-baseline needed/);
  });
});
