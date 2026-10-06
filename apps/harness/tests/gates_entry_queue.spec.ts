import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { decodePng } from "@sekhemet/gates";
import { CardStore } from "@sekhemet/kernel";
import { findChrome } from "@sekhemet/sandbox";
import { describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { cli, ledgerRows } from "./support/g2_cli.js";
import { lastTurn, startEngine, workerRequests } from "./support/g4_engine.js";
import { type Evidence, evidenceBundles, latestEvidence } from "./support/g4_gate.js";
import { FINISH, gateCard, queueProject, runQueue, runQueueOn, write } from "./support/g4_queue.js";

/**
 * The gates inside a card's run (FINISH_LINE_PLAN C2d; FINDINGS_C1 TST-01):
 * `sekhemet queue` spawned as the built binary (`apps/harness/dist/index.js`,
 * through `support/g2_cli.ts`) over a real repository and ledger, its Worker a
 * scripted model at the HTTP boundary (`support/g2_model.ts`; no model is
 * loaded). Every assertion is on what the binary printed, the evidence bundle
 * it wrote under `.sekhemet/evidence/`, the files its gates left in the card's
 * worktree, or its ledger.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const VITEST = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");

const card = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  tier: "story" as const,
  title: "Write a",
  scopeFiles: ["src/**"],
  stepBudget: 4,
  spec: "Export a from src/a.ts",
  ...over,
});

/** The base every card here changes: `src/a.ts`, imported by production code. */
const BASE = {
  "src/a.ts": "",
  "src/main.ts": 'import { a } from "./a.js";\nconsole.log(a);\n',
};
const WRITE_A = write("src/a.ts", "export const a = 1;\n");

const gate = (id: string, extra: string, command = "sh", args = '["-c", "exit 0"]') =>
  `[[gate]]\nid = "${id}"\ncommand = "${command}"\nargs = ${args}\n${extra}\n`;

const outcome = (e: Evidence | undefined, g: string) => e?.rungResults.find((o) => o.gate === g);
const statuses = (repo: string) =>
  ledgerRows(repo)
    .filter((r) => r.type === "card/status_changed" && r.cardId === "c1")
    .map((r) => String(r.payload.toStatus));

describe("the evidence of a card's gates (gates rules 9, 35; T1)", () => {
  it("GT-T1-13: the evidence records as gatesConfigSha256 the SHA-256 of .sekhemet/gates.toml's bytes, the same as sha256sum's", async () => {
    const toml = `# the project's gates\n${gate("unit", 'rung = "test"\nparser = "generic"')}`;
    const p = await queueProject({
      files: { ...BASE, ".sekhemet/gates.toml": toml },
      cards: [card()],
    });
    const r = await runQueue(p, [[...WRITE_A, ...FINISH]]);
    expect(r.stdout, r.stderr).toMatch(/PASSED \(gate_passed\)/);
    const file = join(p.repo, ".sekhemet", "gates.toml");
    const sum = (
      spawnSync("sha256sum", [file], { encoding: "utf8" }).stdout ||
      execFileSync("shasum", ["-a", "256", file], { encoding: "utf8" })
    ).split(/\s+/)[0];
    expect(sum).toMatch(/^[0-9a-f]{64}$/);
    expect(latestEvidence(p.repo, "c1")?.gatesConfigSha256).toBe(sum);
  });

  it("GT-T1-6: a gate with parser gitleaks, stryker or playwright and no layer runs in the security, robustness or visual layer", async () => {
    const toml =
      gate("leaks", 'parser = "gitleaks"') +
      gate("mutants", 'parser = "stryker"') +
      gate("screens", 'parser = "playwright"');
    const p = await queueProject({
      files: { ...BASE, ".sekhemet/gates.toml": toml },
      cards: [card()],
    });
    const r = await runQueue(p, [[...WRITE_A, ...FINISH]]);
    expect(r.stdout, r.stderr).toMatch(/PASSED \(gate_passed\)/);
    const e = latestEvidence(p.repo, "c1");
    expect(outcome(e, "leaks")?.layer).toBe("security");
    expect(outcome(e, "mutants")?.layer).toBe("robustness");
    expect(outcome(e, "screens")?.layer).toBe("visual");
  });

  it("GT-T1-7: a blocking gate the host cannot provide for keeps the card out of Review: it stops done_pending_gates, the gate unavailable naming the need", async () => {
    const toml = gate("db", 'rung = "test"\nparser = "generic"\nneeds = ["postgres"]');
    const p = await queueProject({
      files: { ...BASE, ".sekhemet/gates.toml": toml },
      cards: [card()],
    });
    const r = await runQueue(p, [[...WRITE_A, ...FINISH], FINISH, FINISH]);
    expect(r.stdout, r.stderr).toMatch(/FAILED \(done_pending_gates\)/);
    expect(r.stdout).toMatch(/db not run: needs postgres, which this host does not provide/);
    const e = latestEvidence(p.repo, "c1");
    expect(e?.stopReason).toBe("done_pending_gates");
    expect(outcome(e, "db")).toMatchObject({ passed: false, unavailable: true });
    expect(outcome(e, "db")?.reason).toContain("postgres");
    expect(statuses(p.repo)).not.toContain("review");
  });

  it("GT-T1-11: the evidence never records a gate that did not run as passing — no synthesised parse, every skip and outage with its reason", async () => {
    const toml = gate("unit", 'rung = "test"\nparser = "generic"');
    const p = await queueProject({
      files: { ...BASE, ".sekhemet/gates.toml": toml },
      cards: [card()],
    });
    const r = await runQueue(p, [[...WRITE_A, ...FINISH]]);
    expect(r.stdout, r.stderr).toMatch(/PASSED \(gate_passed\)/);
    const e = latestEvidence(p.repo, "c1") as Evidence;
    expect(e.rungResults.find((o) => o.gate === "parse" || o.rung === "parse")).toBeUndefined();
    for (const o of e.rungResults) {
      if (o.passed) expect(o.skipped || o.unavailable, o.gate).toBeFalsy();
      if (o.skipped || o.unavailable) expect(o.reason, o.gate).toBeTruthy();
    }
    expect(e.skipped).toEqual(
      expect.arrayContaining([
        { gate: "osv", reason: "osv-scanner is not installed" },
        { gate: "semgrep", reason: "semgrep is not installed" },
      ]),
    );
    for (const s of e.skipped) expect(outcome(e, s.gate)?.passed, s.gate).toBe(false);
  });

  it("GT-T1-1, IX-3: `sekhemet gate <card>` in a fresh process, with no cached source facts, gives the card run's verdict and set of gate outcomes on the same tree", async () => {
    const toml = gate("unit", 'rung = "test"\nparser = "generic"');
    const p = await queueProject({
      files: { ...BASE, "src/b.ts": "", ".sekhemet/gates.toml": toml },
      cards: [card()],
    });
    // The run verifies twice in one process (the cache warm the second time).
    const r = await runQueue(p, [
      [...WRITE_A, ...write("src/b.ts", "export const dead = 1;\n"), ...FINISH],
      [...write("src/b.ts", "const kept = 1;\nconsole.log(kept);\n"), ...FINISH],
    ]);
    expect(r.stdout, r.stderr).toMatch(/PASSED \(gate_passed\)/);
    const warm = latestEvidence(p.repo, "c1") as Evidence;
    const fresh = await gateCard(p);
    expect(fresh.status, `${fresh.stdout}\n${fresh.stderr}`).toBe(0);
    for (const o of warm.rungResults) {
      const mark = o.skipped ? "-" : o.unavailable ? "!" : o.passed ? "✓" : "✗";
      expect(fresh.stdout, o.gate).toMatch(
        new RegExp(`^\\s+${mark === "-" ? "-" : mark} ${o.gate} \\(`, "m"),
      );
    }
    // The same set: no gate printed that the card run did not record.
    const printed = [...fresh.stdout.matchAll(/^\s+[✓✗!-] (\S+) \(\d+ ms\)/gm)]
      .map((m) => m[1])
      .sort();
    expect(printed).toEqual(warm.rungResults.map((o) => o.gate).sort());
  });
});

describe("what reaches the model of many failures (GT-T1-4, GT-M6-6)", () => {
  it("GT-T1-4, GT-M6-6: of more than three failures across declared, built-in and project gates, exactly three reach the Worker, ranked once, a test failure before hygiene; each with all six fields", async () => {
    const toml =
      gate(
        "unit",
        `rung = "test"\nparser = "generic"`,
        "sh",
        `["-c", "echo 'error: unit failed' >&2; exit 1"]`,
      ) +
      gate(
        "lint",
        `rung = "lint"\nparser = "generic"`,
        "sh",
        `["-c", "echo 'error: lint failed' >&2; exit 1"]`,
      );
    const p = await queueProject({
      files: { ...BASE, "src/b.ts": "", ".sekhemet/gates.toml": toml },
      cards: [card()],
    });
    const engine = await startEngine(p.home, [
      // A debug statement (hygiene) and an export nothing uses (reachability) on top of two failing gates.
      {
        calls: [
          { name: "read_file", arguments: { path: "src/a.ts" } },
          {
            name: "write_file",
            arguments: {
              path: "src/a.ts",
              content: "export const a = 1;\ndebugger;\nexport const unused = 2;\n",
            },
          },
          { name: "finish_card" },
        ],
      },
      { calls: [{ name: "finish_card" }] },
    ]);
    const r = await runQueueOn(p, engine);
    expect(r.stdout, r.stderr).toMatch(/gate: gates FAILED/);
    const e = evidenceBundles(p.repo, "c1").at(-1) as Evidence;
    expect(String(e.diff), r.stdout).toContain("debugger;");
    const failing = e.rungResults.filter((o) => !o.passed && !o.skipped).map((o) => o.gate);
    expect(failing).toEqual(expect.arrayContaining(["unit", "lint", "hygiene", "reachability"]));
    expect(e.failures).toHaveLength(3);
    expect(e.failures[0]?.gate).toBe("unit");
    expect(e.failures.some((f) => f.gate === "hygiene")).toBe(false);
    for (const f of e.failures) {
      for (const k of ["gate", "expected", "actual", "minimalRepro", "suggestedAction"] as const)
        expect(String(f[k] ?? "").trim(), `${f.gate} ${k}`).not.toBe("");
      expect(f.location?.file, `${f.gate} location`).toBeTruthy();
    }
    // What the Worker was shown next: those three, the test failure first.
    const shown = lastTurn(workerRequests(engine)[1]);
    expect(shown.indexOf("unit failed")).toBeGreaterThan(-1);
    expect(shown).not.toMatch(/debugger|debug output/i);
  });
});

describe("a wrong gate is a person's call (GT-M6-5)", () => {
  it("GT-M6-5: the Worker's note naming a gate stops the card with gate_suspected, naming the gate and the reason, and parks it", async () => {
    const toml = gate(
      "unit",
      `rung = "test"\nparser = "generic"`,
      "sh",
      `["-c", "echo 'error: old api' >&2; exit 1"]`,
    );
    const p = await queueProject({
      files: { ...BASE, ".sekhemet/gates.toml": toml },
      cards: [card()],
    });
    const reason = "unit asserts the old API this card replaces";
    const r = await runQueue(p, [
      [...WRITE_A, ...FINISH],
      [{ name: "note", arguments: { message: reason, gate: "unit" } }],
    ]);
    expect(r.stdout, r.stderr).toMatch(/FAILED \(gate_suspected\)/);
    expect(r.stdout).toContain(`The Worker suspects the unit gate: ${reason}.`);
    expect(statuses(p.repo).at(-1)).toBe("parked");
    const parked = ledgerRows(p.repo).find((e) => e.type === "card/parked");
    expect(parked?.payload.stopReason).toBe("gate_suspected");
  });
});

describe("gate economics in the card's run (gates rules 33, 34, 34b)", () => {
  it("GT-N3-1: a gate run again on the identical tree with the identical definition returns the cached verdict without starting the process", async () => {
    const toml = gate(
      "unit",
      `rung = "test"\nparser = "generic"`,
      "sh",
      `["-c", "mkdir -p .sekhemet && echo ran >> .sekhemet/unit-starts.log; echo 'error: always' >&2; exit 1"]`,
    );
    const p = await queueProject({
      files: { ...BASE, ".sekhemet/gates.toml": toml },
      cards: [card()],
    });
    // The Worker writes once, then finishes twice more without changing anything.
    const r = await runQueue(p, [[...WRITE_A, ...FINISH], FINISH, FINISH]);
    expect(r.stdout.match(/gate: gates FAILED: error: always/g), r.stdout).toHaveLength(3);
    const starts = readFileSync(
      join(p.repo, ".sekhemet", "worktrees", "c1", ".sekhemet", "unit-starts.log"),
      "utf8",
    );
    expect(starts.split("\n").filter(Boolean)).toHaveLength(1);
    const e = latestEvidence(p.repo, "c1");
    expect(outcome(e, "unit")).toMatchObject({ passed: false, cached: true });
  });

  it("GT-N3-2: the functional gate runs the tests reachable from the card's change first and stops at their failure; when they pass it runs the full suite", async () => {
    // A test runner in Vitest's output format that logs each run's files.
    const RUNNER = `import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
const args = process.argv.slice(2).filter((a) => !a.startsWith("-") && a !== "run");
const walk = (d) => readdirSync(d).flatMap((n) => {
  if (n === "node_modules" || n.startsWith(".")) return [];
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : /\\.spec\\.ts$/.test(n) ? [relative(process.cwd(), p)] : [];
});
const files = args.length ? args : walk(process.cwd());
mkdirSync(".sekhemet", { recursive: true });
appendFileSync(".sekhemet/runs.log", files.slice().sort().join(",") + "\\n");
let failed = 0, passed = 0, failedFiles = 0;
for (const f of files) {
  let bad = false;
  for (const line of readFileSync(f, "utf8").split("\\n")) {
    const m = /check: (.+?) \\| (.+?) \\| (.+)$/.exec(line);
    if (!m) continue;
    if (readFileSync(m[2], "utf8").includes(m[3])) { passed++; continue; }
    failed++; bad = true;
    console.log(" FAIL  " + f + " > " + m[1]);
    console.log("AssertionError: expected " + m[2] + " to contain " + m[3]);
  }
  if (bad) failedFiles++;
}
console.log(" Test Files  " + (failedFiles ? failedFiles + " failed | " : "") + (files.length - failedFiles) + " passed (" + files.length + ")");
console.log("      Tests  " + (failed ? failed + " failed | " : "") + passed + " passed (" + (failed + passed) + ")");
process.exit(failed ? 1 : 0);
`;
    const p = await queueProject({
      files: {
        ...BASE,
        "src/b.ts": "export const b = 2;\n",
        "tools/vitest.mjs": RUNNER,
        "tests/a.spec.ts":
          'import { a } from "../src/a.js";\n// check: a is two | src/a.ts | two\nvoid a;\n',
        "tests/b.spec.ts":
          'import { b } from "../src/b.js";\n// check: b stays | src/b.ts | b = 2\nvoid b;\n',
        ".sekhemet/gates.toml": gate(
          "unit",
          `rung = "test"\nparser = "vitest"\ntimeout_s = 60`,
          "node",
          '["tools/vitest.mjs", "run"]',
        ),
      },
      cards: [card({ spec: "Export a (two) from src/a.ts" })],
    });
    const r = await runQueue(p, [
      [{ name: "read_file", arguments: { path: "src/a.ts" } }, ...WRITE_A, ...FINISH],
      [...write("src/a.ts", "export const a = 2; // two\n"), ...FINISH],
    ]);
    expect(r.stdout, r.stderr).toMatch(/PASSED \(gate_passed\)/);
    const runs = readFileSync(
      join(p.repo, ".sekhemet", "worktrees", "c1", ".sekhemet", "runs.log"),
      "utf8",
    )
      .split("\n")
      .filter(Boolean);
    // First verification: only the reachable test, which failed (then its file alone
    // re-run once for flakiness, rule 34, failing again). Second: it passed, then the full suite.
    expect(runs).toEqual([
      "tests/a.spec.ts",
      "tests/a.spec.ts",
      "tests/a.spec.ts",
      "tests/a.spec.ts,tests/b.spec.ts",
    ]);
    expect(outcome(latestEvidence(p.repo, "c1"), "unit")?.note).toBe(
      "impacted tests first: 1 test file reachable from the card's changes passed; the full suite ran",
    );
    expect(r.stdout).toMatch(/gate: gates FAILED/);
  });

  it("GT-N3-4: a test that fails at the first verification and passes its JUnit re-run on the unchanged tree is quarantined, recorded and reported as flaky", async () => {
    // Fails on its first run in a tree, passes after.
    const FLAKY = `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
it("is flaky", () => {
  mkdirSync(".flaky", { recursive: true });
  const runs = (existsSync(".flaky/runs") ? Number(readFileSync(".flaky/runs", "utf8")) : 0) + 1;
  writeFileSync(".flaky/runs", String(runs));
  expect(runs).not.toBe(1);
});
`;
    const p = await queueProject({
      files: {
        ...BASE,
        ".gitignore": ".sekhemet/\n.flaky/\nnode_modules/\n",
        "package.json": '{ "name": "s", "type": "module", "private": true }\n',
        "tests/flaky.spec.ts": FLAKY,
        ".sekhemet/gates.toml": gate(
          "unit",
          `rung = "test"\nparser = "vitest"\ntimeout_s = 120`,
          "node",
          `[${JSON.stringify(VITEST)}, "run", "--reporter=default"]`,
        ),
      },
      cards: [card()],
    });
    const r = await runQueue(p, [[...WRITE_A, ...FINISH], FINISH]);
    expect(r.stdout, r.stderr).toMatch(/PASSED \(gate_passed\)/);
    const e = latestEvidence(p.repo, "c1") as Evidence & {
      quarantined?: { count: number; tests: { test: string }[] };
    };
    expect(e.quarantined?.count).toBe(1);
    expect(e.quarantined?.tests[0]?.test).toMatch(/tests\/flaky\.spec\.ts.*is flaky/);
  });

  it("GT-N3-5: with several style_fix_rules, each verification starts one style-fix process selecting every rule, and one autofix", async () => {
    const FIX = (name: string) =>
      `import { appendFileSync, mkdirSync } from "node:fs";\nmkdirSync(".sekhemet", { recursive: true });\nappendFileSync(".sekhemet/fixers.log", ${JSON.stringify(name)} + " " + process.argv.slice(2).join(" ") + "\\n");\n`;
    const p = await queueProject({
      files: {
        ...BASE,
        "tools/format.mjs": FIX("autofix"),
        "tools/style.mjs": FIX("style"),
        ".sekhemet/gates.toml": `[project]\nautofix = ["node", "tools/format.mjs"]\nstyle_fix = ["node", "tools/style.mjs"]\nstyle_fix_rules = ["style/useTemplate", "style/noVar", "complexity/useLiteralKeys"]\n\n${gate("unit", 'rung = "test"\nparser = "generic"')}`,
      },
      cards: [card()],
    });
    const r = await runQueue(p, [[...WRITE_A, ...FINISH]]);
    expect(r.stdout, r.stderr).toMatch(/PASSED \(gate_passed\)/);
    const log = readFileSync(
      join(p.repo, ".sekhemet", "worktrees", "c1", ".sekhemet", "fixers.log"),
      "utf8",
    )
      .split("\n")
      .filter(Boolean);
    expect(log.filter((l) => l.startsWith("autofix "))).toHaveLength(1);
    const style = log.filter((l) => l.startsWith("style "));
    expect(style).toHaveLength(1);
    expect(style[0]).toContain(
      "--only=style/useTemplate --only=style/noVar --only=complexity/useLiteralKeys",
    );
  });
});

describe("the repair contract from a real tool (GT-M6-1)", () => {
  it("GT-M6-1: a real `vitest --reporter=json` run with one failing test gives one failure at the test's file and line, whose minimalRepro selects a test and exits non-zero", async () => {
    const p = await queueProject({
      files: {
        "package.json": '{ "name": "s", "type": "module", "private": true }\n',
        "src/math.ts": "export const add = (a: number, b: number): number => a + b;\n",
        "tests/math.spec.ts":
          'import { expect, it } from "vitest";\nimport { add } from "../src/math.js";\nit("adds", () => {\n  expect(add(2, 3)).toBe(5);\n});\nit("adds zero", () => {\n  expect(add(2, 0)).toBe(2);\n});\n',
        ".sekhemet/gates.toml": gate(
          "unit",
          `rung = "test"\nparser = "vitest"\ntimeout_s = 120`,
          "node",
          `[${JSON.stringify(VITEST)}, "run", "--reporter=json"]`,
        ),
      },
      cards: [
        card({ scopeFiles: ["src/math.ts"], spec: "Rewrite add in src/math.ts", stepBudget: 1 }),
      ],
    });
    const r = await runQueue(p, [
      [
        ...write("src/math.ts", "export const add = (a: number, b: number): number => a - b;\n"),
        ...FINISH,
      ],
    ]);
    expect(r.stdout, r.stderr).toMatch(/gate: gates FAILED/);
    const e = evidenceBundles(p.repo, "c1").at(-1) as Evidence;
    // One failing test is one failure (the regression gate restates it: the test is the base's).
    const unit = e.failures.filter((f) => f.rung === "test");
    expect(unit).toHaveLength(1);
    expect(unit[0]?.location).toMatchObject({ file: "tests/math.spec.ts", line: 4 });
    // The repro, run where the gate ran, selects the failing test and fails.
    const wt = join(p.repo, ".sekhemet", "worktrees", "c1");
    const repro = spawnSync("sh", ["-c", unit[0]?.minimalRepro ?? "false"], {
      cwd: wt,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(repro.status, `${unit[0]?.minimalRepro}\n${repro.stdout}\n${repro.stderr}`).not.toBe(0);
    // Vitest's JSON report (or its default summary): the failing test was selected and failed.
    expect(`${repro.stdout}${repro.stderr}`).toMatch(/"numFailedTests":1\b|\b1 failed\b/);
  });
});

describe("tools other than the model (GT-N5-2)", () => {
  it("GT-N5-2: an installed language mutation tool runs as a subprocess over the diff; a language whose tool is absent is recorded as not measured", async () => {
    const p = await queueProject({
      files: {
        "calc.py": "def add(a, b):\n    return a\n",
        "src/lib.rs": "pub fn add(a: i32, b: i32) -> i32 { a }\n",
        ".sekhemet/gates.toml": `[project]\nmutation = true\n\n${gate("unit", 'rung = "test"\nparser = "generic"')}`,
      },
      cards: [card({ scopeFiles: ["calc.py", "src/lib.rs"], spec: "Fix add" })],
    });
    // cargo-mutants where `cargo install` puts it (~/.cargo/bin), in the person's home.
    const bin = join(p.home, ".cargo", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "cargo-mutants"),
      `#!/bin/sh
out=""; prev=""; for a in "$@"; do [ "$prev" = "--output" ] && out="$a"; prev="$a"; done
case "$*" in *"mutants --in-diff "*) ;; *) echo "not scoped to the diff: $*" >&2; exit 9 ;; esac
mkdir -p "$out/mutants.out"
cat > "$out/mutants.out/outcomes.json" <<'J'
{"outcomes":[{"scenario":"Baseline","summary":"Success"},{"scenario":{"Mutant":{"file":"src/lib.rs","span":{"start":{"line":1}},"function":{"function_name":"add"},"replacement":"0","genre":"FnValue"}},"summary":"CaughtMutant"}]}
J
exit 0
`,
    );
    chmodSync(join(bin, "cargo-mutants"), 0o755);
    const r = await runQueue(p, [
      [
        ...write("calc.py", "def add(a, b):\n    return a + b\n"),
        ...write("src/lib.rs", "pub fn add(a: i32, b: i32) -> i32 { a + b }\n"),
        ...FINISH,
      ],
    ]);
    expect(r.stdout, r.stderr).toMatch(/PASSED \(gate_passed\)/);
    const m = outcome(latestEvidence(p.repo, "c1"), "mutation")?.mutation as {
      killed: number;
      total: number;
      notMeasured: { file: string; reason: string }[];
      tools: { tool: string; files: string[] }[];
    };
    expect(m.tools).toEqual([{ tool: "cargo-mutants", files: ["src/lib.rs"] }]);
    expect([m.killed, m.total]).toEqual([1, 1]);
    expect(m.notMeasured).toEqual([
      { file: "calc.py", reason: "mutation not measured: mutmut not installed" },
    ]);
  });
});

describe("the onboarding baseline and superseded tests in the run (GT-BF)", () => {
  it("GT-BF-2: a card that removes a baselined diagnostic shrinks the baseline: the run records what is gone", async () => {
    const CHECK = `const fs = require("node:fs");
const lines = fs.existsSync("errors.txt") ? fs.readFileSync("errors.txt", "utf8").split("\\n").filter(Boolean) : [];
for (const l of lines) console.log(l);
process.exit(lines.length ? 2 : 0);
`;
    const OLD = "src/a.ts(1,1): error TS2304: Cannot find name 'missing'.";
    const p = await queueProject({
      files: {
        ...BASE,
        "check.cjs": CHECK,
        "errors.txt": `${OLD}\n`,
        ".sekhemet/gates.toml": gate(
          "typecheck",
          'rung = "typecheck"\nparser = "tsc"',
          "node",
          '["check.cjs"]',
        ),
      },
      cards: [card({ scopeFiles: ["src/a.ts", "errors.txt"] })],
    });
    const onboard = await cli(["onboard", "--trust"], {
      cwd: p.repo,
      env: p.env,
      timeoutMs: 120_000,
    });
    expect(onboard.stdout, onboard.stderr).toMatch(/8\. Baseline: 1 pre-existing finding/);
    // The card fixes the old error: the check now prints nothing.
    const r = await runQueue(p, [[...WRITE_A, ...write("errors.txt", ""), ...FINISH]]);
    expect(r.stdout, r.stderr).toMatch(/PASSED \(gate_passed\)/);
    const shrink = ledgerRows(p.repo).filter(
      (e) => e.type === "project/baseline" && e.payload.kind !== "recorded",
    );
    const recorded = ledgerRows(p.repo).find(
      (e) => e.type === "project/baseline" && e.payload.kind === "recorded",
    )?.payload.entries as { fingerprint: string; rule: string }[];
    expect(recorded.map((x) => x.rule)).toEqual(["TS2304"]);
    expect(shrink.at(-1)?.payload).toMatchObject({
      kind: "shrink",
      fingerprints: [recorded[0]?.fingerprint],
      card: "c1",
      gates: ["typecheck"],
    });
  });

  it("GT-BF-1: the run accepts a declared superseded base test whose new version is staged, and lists the supersession in the evidence", async () => {
    const NEW =
      'import { expect, it } from "vitest";\nimport { greet } from "../src/greet.js";\nit("greets", () => { expect(greet("a")).toBe("hello a"); });\n';
    const p = await queueProject({
      files: {
        "package.json": '{ "name": "s", "type": "module", "private": true }\n',
        "src/greet.ts": "export const greet = (n: string): string => `hi ${n}`;\n",
        "tests/greet.spec.ts":
          'import { expect, it } from "vitest";\nimport { greet } from "../src/greet.js";\nit("greets", () => { expect(greet("a")).toBe("hi a"); });\nit("keeps the name", () => { expect(greet("a")).toContain("a"); });\n',
        "acceptance/greet_hello.spec.ts": NEW,
        ".sekhemet/gates.toml": gate(
          "unit",
          `rung = "test"\nparser = "vitest"\ntimeout_s = 120`,
          "node",
          `[${JSON.stringify(VITEST)}, "run", "--reporter=default"]`,
        ),
      },
      cards: [
        card({
          scopeFiles: ["src/greet.ts"],
          spec: "Greet with hello",
          acceptanceTests: ["greet_hello.spec.ts"],
          supersedes: ["tests/greet.spec.ts > greets"],
          change: "feature",
        }),
      ],
    });
    const r = await runQueue(p, [
      [
        ...write("src/greet.ts", "export const greet = (n: string): string => `hello ${n}`;\n"),
        ...FINISH,
      ],
    ]);
    expect(r.stdout, r.stderr).toMatch(/PASSED \(gate_passed\)/);
    const e = latestEvidence(p.repo, "c1") as Evidence & { superseded?: unknown };
    expect(e.superseded).toEqual([
      {
        test: "tests/greet.spec.ts > greets",
        staged: [expect.stringContaining("greet_hello.spec.ts")],
      },
    ]);
    expect(existsSync(join(p.repo, ".sekhemet", "worktrees", "c1"))).toBe(true);
  });
});

// The visual layer in the card's run: headless Chromium, confined, against the
// project's page (served here by the test as the project's dev server would).
// The headless shell is named by SEKHEMET_CHROME: under a throwaway HOME the
// binary would otherwise not be found where Playwright installed it.
describe.runIf(findChrome() !== undefined)("the visual layer in the card's run (GT-N4)", () => {
  it("GT-N4-5, GT-N4-3: animations off and dynamic regions masked, two runs on an unchanged page differ by 0 pixels; a changed page's screenshot, baseline and diff are attached to the evidence", async () => {
    let html = "";
    const server = createServer((_q, res) => {
      res.setHeader("content-type", "text/html");
      res.end(html);
    });
    const port: number = await new Promise((r) =>
      server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)),
    );
    try {
      // A box whose colour animates, and a clock that differs on every request.
      const page = (color: string) =>
        `<!doctype html><html lang="en"><head><title>t</title><style>@keyframes pulse{from{background:#f00}to{background:#00f}} #box{animation:pulse 0.3s infinite alternate}</style></head><body style="margin:0;background:#fff"><div id="wrap" style="width:120px;height:60px"><div id="box" style="width:30px;height:30px;background:${color}"></div><span id="clock">${Date.now()} ${Math.random()}</span></div></body></html>`;
      const toml = `[visual]\nurl = "http://127.0.0.1:${port}/"\nviewports = [1280]\na11y = false\nbaseline_approval = "auto"\n\n[[visual.snapshot]]\nname = "box"\nselector = "#wrap"\nmask = ["#clock"]\n\n${gate("unit", 'rung = "test"\nparser = "generic"')}`;
      const mk = (id: string, stepBudget = 4) =>
        card({ id, title: `Write ${id}`, spec: `Export ${id} from src/${id}.ts`, stepBudget });
      const p = await queueProject({
        files: {
          "src/c1.ts": "",
          "src/c2.ts": "",
          "src/c3.ts": "",
          "src/main.ts":
            'import { c1 } from "./c1.js";\nimport { c2 } from "./c2.js";\nimport { c3 } from "./c3.js";\nconsole.log(c1, c2, c3);\n',
          ".sekhemet/gates.toml": toml,
        },
        cards: [mk("c1")],
      });
      const next = async (id: string, stepBudget?: number) => {
        const { db, log } = openLocalLedger(p.repo);
        try {
          await new CardStore(db, log).createCard(mk(id, stepBudget));
        } finally {
          db.close();
        }
      };
      const env = { SEKHEMET_CHROME: findChrome() ?? "" };
      const shot = join(p.repo, ".sekhemet", "visual", "actual", "box-1280.png");

      html = page("#000");
      const r1 = await runQueue(
        p,
        [[...write("src/c1.ts", "export const c1 = 1;\n"), ...FINISH]],
        env,
      );
      expect(r1.stdout, r1.stderr).toMatch(/PASSED \(gate_passed\)/);
      const first = readFileSync(shot);

      // The same page again, served afresh (a new clock), in another card's run.
      html = page("#000");
      await next("c2");
      const r2 = await runQueue(
        p,
        [[...write("src/c2.ts", "export const c2 = 1;\n"), ...FINISH]],
        env,
      );
      expect(r2.stdout, r2.stderr).toMatch(/PASSED \(gate_passed\)/);
      const [a, b] = [decodePng(first), decodePng(readFileSync(shot))];
      expect([b.width, b.height]).toEqual([a.width, a.height]);
      let differing = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        if (
          a.data[i] !== b.data[i] ||
          a.data[i + 1] !== b.data[i + 1] ||
          a.data[i + 2] !== b.data[i + 2]
        )
          differing++;
      }
      expect(differing).toBe(0);
      expect(outcome(latestEvidence(p.repo, "c2"), "visual-snapshot")?.passed).toBe(true);

      // A changed page: the snapshot fails, its three images in the evidence.
      html = page("#fff");
      await next("c3", 1);
      const r3 = await runQueue(
        p,
        [[...write("src/c3.ts", "export const c3 = 1;\n"), ...FINISH]],
        env,
      );
      expect(r3.stdout, r3.stderr).not.toMatch(/PASSED \(gate_passed\)/);
      const e3 = latestEvidence(p.repo, "c3") as Evidence;
      expect(outcome(e3, "visual-snapshot")?.passed).toBe(false);
      const kinds = e3.artifacts.map((x) => x.kind).sort();
      expect(kinds).toEqual(["screenshot", "visual-baseline", "visual-diff"]);
      for (const x of e3.artifacts) expect(existsSync(String(x.ref)), String(x.ref)).toBe(true);
    } finally {
      server.close();
    }
  }, 180_000);
});
