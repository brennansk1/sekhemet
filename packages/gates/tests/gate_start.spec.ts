import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { loadGatesConfig } from "../src/config.js";
import { gateStartProblems } from "../src/gate_start.js";
import { DeterministicGateRunner } from "../src/runner.js";

// SUR-12 (surface P10): a derived test gate that cannot start — its script
// missing from package.json, the program its script runs not installed, or
// the gate's own program absent — is found before the run starts, naming
// the file to edit; and when a script goes missing mid-run the gate is
// reported as not run, naming package.json, never a failure charged to the
// card (gates rule 9).

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function repo(pkg: Record<string, unknown> | undefined, gate: string): string {
  const root = mkdtempSync(join(tmpdir(), "sek-gate-start-"));
  dirs.push(root);
  if (pkg) writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
  mkdirSync(join(root, ".sekhemet"), { recursive: true });
  writeFileSync(join(root, ".sekhemet", "gates.toml"), gate);
  return root;
}

const npmTest = '[[gate]]\nid = "test"\nrung = "test"\ncommand = "npm"\nargs = ["run", "test"]\n';

describe("SUR-12: a derived test gate that cannot start", () => {
  it("names package.json when the gate's script is missing", () => {
    const root = repo({ name: "x", scripts: { build: "tsc" } }, npmTest);
    expect(gateStartProblems(loadGatesConfig(root), root)).toEqual([
      {
        gate: "test",
        file: "package.json",
        reason: 'package.json has no "test" script, which the test gate runs (npm run test)',
      },
    ]);
  });

  it("names package.json when the script runs a program that is not installed", () => {
    const root = repo(
      { name: "x", scripts: { test: "NODE_ENV=test no-such-runner-xyz run" } },
      npmTest,
    );
    const [p] = gateStartProblems(loadGatesConfig(root), root);
    expect(p?.file).toBe("package.json");
    expect(p?.reason).toMatch(/"test" script runs no-such-runner-xyz, which is not installed/);
  });

  it("names .sekhemet/gates.toml when the gate's own program is not found", () => {
    const root = repo(
      { name: "x" },
      '[[gate]]\nid = "unit"\nrung = "test"\ncommand = "no-such-program-xyz"\nargs = []\n',
    );
    expect(gateStartProblems(loadGatesConfig(root), root)).toEqual([
      {
        gate: "unit",
        file: ".sekhemet/gates.toml",
        reason: "the unit gate runs no-such-program-xyz, which is not installed",
      },
    ]);
  });

  it("finds nothing when the script and its program are there (an installed binary, or one on PATH)", () => {
    const root = repo({ name: "x", scripts: { test: "node --test" } }, npmTest);
    expect(gateStartProblems(loadGatesConfig(root), root)).toEqual([]);
    const local = repo({ name: "x", scripts: { test: "vitest run" } }, npmTest);
    mkdirSync(join(local, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(local, "node_modules", ".bin", "vitest"), "#!/bin/sh\n");
    expect(gateStartProblems(loadGatesConfig(local), local)).toEqual([]);
  });

  it("judges only a derived gates.toml: with none, the defaults are not checked", () => {
    const root = mkdtempSync(join(tmpdir(), "sek-gate-start-"));
    dirs.push(root);
    expect(gateStartProblems(loadGatesConfig(root), root)).toEqual([]);
  });

  it("reports a script that went missing at run time as not run, naming package.json (not charged to the card)", async () => {
    const root = repo({ name: "x", version: "1.0.0", scripts: {} }, npmTest);
    const gate = loadGatesConfig(root).gates.find((g) => g.id === "test");
    if (!gate) throw new Error("no test gate");
    const { failures } = await new DeterministicGateRunner(new ProcessSandbox()).runGate(
      gate,
      root,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.notRun).toBe(true);
    expect(failures[0]?.location.file).toBe("package.json");
    expect(failures[0]?.errorExcerpt).toMatch(/test not run: .*"test" script/);
  }, 60_000);

  // Review B3: a real failure whose output merely mentions a missing script
  // (another script's, or one package.json has) stays a failure charged to the card.
  it("a failing test script that prints another script's Missing script stays a failure, not a not-run", async () => {
    const root = repo({ name: "x", version: "1.0.0", scripts: { test: "node fail.js" } }, npmTest);
    writeFileSync(
      join(root, "fail.js"),
      "console.error('npm error Missing script: \"deploy\"');\nprocess.exit(1);\n",
    );
    const gate = loadGatesConfig(root).gates.find((g) => g.id === "test");
    if (!gate) throw new Error("no test gate");
    const { outcome, failures } = await new DeterministicGateRunner(new ProcessSandbox()).runGate(
      gate,
      root,
    );
    expect(outcome.passed).toBe(false);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((f) => f.notRun)).toBe(false);
  }, 60_000);

  it("a script that prints its own name as missing while package.json has it stays a failure", async () => {
    const root = repo({ name: "x", version: "1.0.0", scripts: { test: "node fail.js" } }, npmTest);
    writeFileSync(
      join(root, "fail.js"),
      "console.error('npm error Missing script: \"test\"');\nprocess.exit(1);\n",
    );
    const gate = loadGatesConfig(root).gates.find((g) => g.id === "test");
    if (!gate) throw new Error("no test gate");
    const { failures } = await new DeterministicGateRunner(new ProcessSandbox()).runGate(
      gate,
      root,
    );
    expect(failures.some((f) => f.notRun)).toBe(false);
  }, 60_000);
});
