import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatesConfigTamperError, loadGatesConfig } from "../src/config.js";
import {
  type GateStage,
  boundsStage,
  builtinStage,
  declaredStage,
  externalStage,
  runGatePipeline,
} from "../src/pipeline.js";
import { missingFailureFields } from "../src/rank.js";
import { DeterministicGateRunner } from "../src/runner.js";

// T1: one gate pipeline that fails closed (gates rules 8-9, 20, 35).

describe("one gate pipeline (T1)", () => {
  let root: string;
  const git = (...a: string[]) =>
    execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const diff = () => {
    git("add", "-A");
    return git("diff", "--cached", "--unified=0", "main");
  };
  const gates = (body: string) => {
    mkdirSync(join(root, ".sekhemet"), { recursive: true });
    writeFileSync(join(root, ".sekhemet", "gates.toml"), body);
  };
  const shGate = (id: string, rung: string, script: string, extra = "") =>
    `[[gate]]\nid = "${id}"\nrung = "${rung}"\ncommand = "sh"\nargs = ["-c", ${JSON.stringify(script)}]\nparser = "generic"\ntimeout_s = 20\n${extra}\n`;
  const runner = () =>
    new DeterministicGateRunner(new ProcessSandbox(), {
      repoRoot: root,
      maxFailuresReported: Number.POSITIVE_INFINITY,
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pipeline-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "CHANGELOG.md"), "# Changes\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    git("checkout", "-q", "-b", "card");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("GT-T1-2: a gate that throws is unavailable with its error, fails a blocking verdict, and every other outcome is still recorded", async () => {
    gates(shGate("unit", "test", "exit 0"));
    const crashing: GateStage = {
      id: "reachability",
      rung: "lint",
      layer: "static",
      run: async () => {
        throw new Error("the index could not be read");
      },
    };
    const r = await runGatePipeline(
      [
        declaredStage(runner(), ["test"], root),
        crashing,
        boundsStage({
          base: "main",
          perFile: [{ file: "a.ts", added: 1, removed: 0 }],
          maxFiles: 3,
          maxLines: 200,
        }),
      ],
      { cwd: root },
    );
    expect(r.passed).toBe(false);
    const byGate = new Map(r.rungResults.map((o) => [o.gate, o]));
    expect(byGate.get("reachability")).toMatchObject({ passed: false, unavailable: true });
    expect(byGate.get("reachability")?.reason).toContain("the index could not be read");
    expect(byGate.get("unit")).toMatchObject({ passed: true });
    expect(byGate.get("bounds")).toMatchObject({ passed: true });
    const f = r.failures.find((x) => x.gate === "reachability");
    expect(f?.notRun).toBe(true);
    expect(missingFailureFields(f ?? {})).toEqual([]);
  });

  it("GT-T1-2: a non-blocking gate that throws is unavailable and advisory, not a failure", async () => {
    const r = await runGatePipeline(
      [
        {
          id: "vision",
          rung: "visual",
          layer: "visual",
          blocking: false,
          run: async () => {
            throw new Error("no browser");
          },
        },
      ],
      { cwd: root },
    );
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.rungResults[0]).toMatchObject({ gate: "vision", unavailable: true, passed: false });
    expect(r.advisories.join("\n")).toContain("vision");
  });

  it("GT-T1-2: a gates.toml changed after the card started still aborts the verification", async () => {
    gates(shGate("unit", "test", "exit 0"));
    const pinned = new DeterministicGateRunner(new ProcessSandbox(), {
      repoRoot: root,
      expectedConfigSha256: loadGatesConfig(root).sha256,
    });
    gates(shGate("unit", "test", "exit 0", "blocking = false"));
    await expect(
      runGatePipeline([declaredStage(pinned, ["test"], root)], { cwd: root }),
    ).rejects.toBeInstanceOf(GatesConfigTamperError);
  });

  it("GT-T1-4: more than three failures across declared, built-in and project gates reach the model as exactly three, ranked once, a test failure before hygiene", async () => {
    gates(
      shGate("unit", "test", "echo 'unit failed' >&2; exit 1") +
        shGate("lint", "lint", "echo 'lint failed' >&2; exit 1"),
    );
    writeFileSync(join(root, "a.ts"), "export const a = 1;\ndebugger;\nconsole.debug(a);\n");
    const project: GateStage = {
      id: "architecture",
      rung: "lint",
      layer: "static",
      run: async () => ({
        outcomes: [
          {
            gate: "architecture",
            rung: "lint",
            layer: "static",
            passed: false,
            exitCode: 1,
            durationMs: 0,
          },
        ],
        failures: [
          {
            rung: "lint",
            gate: "architecture",
            layer: "static",
            exitCode: 1,
            errorExcerpt: "a.ts imports b",
            suggestedFixFiles: ["a.ts"],
            location: { file: "a.ts", line: 1 },
            expected: "no import of b",
            actual: "imports b",
            minimalRepro: "check",
            suggestedAction: "Remove the import of b from a.ts.",
          },
        ],
      }),
    };
    const r = await runGatePipeline(
      [
        declaredStage(runner(), ["test", "lint"], root),
        project,
        builtinStage({
          root,
          base: "main",
          diff: diff(),
          project: { protected: [], maxFiles: 3, maxDiffLines: 200 },
          gates: ["hygiene"],
          which: () => false,
        }),
      ],
      { cwd: root },
    );
    expect(r.allFailures.length).toBeGreaterThan(3);
    expect(
      r.allFailures.some((f) => f.gate === "hygiene" && /CHANGELOG/.test(f.errorExcerpt)),
    ).toBe(true);
    expect(r.failures).toHaveLength(3);
    expect(r.failures[0]?.gate).toBe("unit");
    expect(r.failures.some((f) => f.gate === "hygiene")).toBe(false);
    expect(r.passed).toBe(false);
  });

  it("GT-T1-7: a gate whose declared need the host cannot provide is unavailable, names the need, and never starts", async () => {
    const marker = join(root, "ran.txt");
    gates(
      shGate(
        "db-tests",
        "test",
        `touch ${JSON.stringify(marker)}`,
        'needs = ["env:SEKHEMET_T1_NEVER_SET", "postgres"]',
      ),
    );
    const r = await runGatePipeline(
      [
        declaredStage(
          new DeterministicGateRunner(new ProcessSandbox(), {
            repoRoot: root,
            host: { provides: [] },
          }),
          ["test"],
          root,
        ),
      ],
      { cwd: root },
    );
    expect(existsSync(marker)).toBe(false);
    const o = r.rungResults.find((x) => x.gate === "db-tests");
    expect(o).toMatchObject({ passed: false, unavailable: true });
    expect(o?.reason).toContain("env:SEKHEMET_T1_NEVER_SET");
    expect(o?.reason).toContain("postgres");
    expect(r.passed).toBe(false);
    expect(r.failures[0]?.notRun).toBe(true);
  });

  it("GT-T1-7: a need the host provides lets the gate run", async () => {
    const marker = join(root, "ran.txt");
    gates(shGate("db-tests", "test", `touch ${JSON.stringify(marker)}`, 'needs = ["postgres"]'));
    const r = await runGatePipeline(
      [
        declaredStage(
          new DeterministicGateRunner(new ProcessSandbox(), {
            repoRoot: root,
            host: { provides: ["postgres"] },
          }),
          ["test"],
          root,
        ),
      ],
      { cwd: root },
    );
    expect(existsSync(marker)).toBe(true);
    expect(r.passed).toBe(true);
  });

  it("GT-T1-11: a gate that did not run is never a passing outcome", async () => {
    gates(shGate("unit", "test", "exit 0"));
    const r = await runGatePipeline(
      [
        // No parse gate is declared or defaulted.
        declaredStage(runner(), ["parse", "test"], root),
        // git could not produce the numstat.
        boundsStage({ base: "main", perFile: undefined, maxFiles: 3, maxLines: 200 }),
        // Scanners that are not installed are skipped.
        builtinStage({
          root,
          base: "main",
          diff: diff(),
          project: { protected: [], maxFiles: 3, maxDiffLines: 200 },
          gates: ["osv", "semgrep"],
          which: () => false,
        }),
      ],
      { cwd: root },
    );
    for (const o of r.rungResults) {
      if (o.passed) expect(o.skipped || o.unavailable, o.gate).toBeFalsy();
    }
    expect(r.rungResults.find((o) => o.gate === "parse")).toMatchObject({
      passed: false,
      skipped: true,
    });
    expect(r.rungResults.find((o) => o.gate === "parse")?.reason).toBeTruthy();
    expect(r.rungResults.find((o) => o.gate === "bounds")).toMatchObject({
      passed: false,
      unavailable: true,
    });
    for (const gate of ["osv", "semgrep"]) {
      expect(
        r.rungResults.find((o) => o.gate === gate),
        gate,
      ).toMatchObject({
        passed: false,
        skipped: true,
      });
    }
  });

  it("GT-T1-12: an external check not declared blocking is advisory; one on another head sha is left out, saying why", async () => {
    gates(
      `[[gate]]\nid = "ci-unit"\nrung = "test"\ncommand = "true"\nexternal = "ci/unit"\n\n[[gate]]\nid = "ci-e2e"\nrung = "test"\ncommand = "true"\nexternal = "ci/e2e"\nblocking = true\n`,
    );
    const declared = loadGatesConfig(root).gates;
    const head = "a".repeat(40);
    const r = await runGatePipeline(
      [
        externalStage({
          gates: declared,
          headSha: head,
          results: [
            { check: "ci/unit", passed: false, headSha: head, url: "https://ci/1" },
            { check: "ci/e2e", passed: false, headSha: "b".repeat(40), url: "https://ci/2" },
          ],
        }),
      ],
      { cwd: root },
    );
    // ci/unit failed, but it is advisory: not declared blocking.
    expect(r.passed).toBe(true);
    const unit = r.rungResults.find((o) => o.gate === "ci-unit");
    expect(unit?.source).toMatchObject({ kind: "external", check: "ci/unit", headSha: head });
    expect(r.advisories.some((a) => a.includes("ci/unit"))).toBe(true);
    // ci/e2e ran on another head: out of the verdict, and the evidence says why.
    expect(r.rungResults.some((o) => o.gate === "ci-e2e")).toBe(false);
    expect(r.advisories.some((a) => a.includes("ci/e2e") && a.includes("b".repeat(12)))).toBe(true);
  });

  it("GT-T1-12: a failing external check declared blocking on the branch head fails the verdict", async () => {
    gates(
      `[[gate]]\nid = "ci-e2e"\nrung = "test"\ncommand = "true"\nexternal = "ci/e2e"\nblocking = true\n`,
    );
    const head = "c".repeat(40);
    const r = await runGatePipeline(
      [
        externalStage({
          gates: loadGatesConfig(root).gates,
          headSha: head,
          results: [{ check: "ci/e2e", passed: false, headSha: head, url: "https://ci/3" }],
        }),
      ],
      { cwd: root },
    );
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toMatchObject({ gate: "ci-e2e" });
    expect(missingFailureFields(r.failures[0] ?? {})).toEqual([]);
  });
  it("GT-T1-2: a runner that reports a failure without naming one fails closed, unavailable", async () => {
    const silent = {
      runGates: async () => ({ passed: false, failures: [], durationMs: 0 }),
    };
    const r = await runGatePipeline([declaredStage(silent, ["test"], root)], { cwd: root });
    expect(r.passed).toBe(false);
    const test = r.rungResults.find((o) => o.gate === "test");
    expect(test).toMatchObject({ passed: false, unavailable: true });
    expect(test?.reason).toContain("without naming one");
    expect(r.failures[0]).toMatchObject({ gate: "test", notRun: true });
  });

  it("GT-T1-2: a runner that says it passed while an outcome failed fails closed (inconsistent reply)", async () => {
    const inconsistent = {
      runGates: async () => ({
        passed: true,
        failures: [],
        durationMs: 0,
        rungResults: [
          {
            gate: "unit",
            rung: "test" as const,
            layer: "functional" as const,
            passed: false,
            exitCode: 1,
            durationMs: 1,
          },
        ],
      }),
    };
    const r = await runGatePipeline([declaredStage(inconsistent, ["test"], root)], { cwd: root });
    expect(r.passed).toBe(false);
    expect(r.rungResults.find((o) => o.gate === "unit")).toMatchObject({
      passed: false,
      unavailable: true,
    });
  });

  it("GT-T1-2: a failed outcome the runner reported without a failure is unavailable, not a silent fail", async () => {
    const silent = {
      runGates: async () => ({
        passed: false,
        failures: [],
        durationMs: 0,
        rungResults: [
          {
            gate: "unit",
            rung: "test" as const,
            layer: "functional" as const,
            passed: false,
            exitCode: 1,
            durationMs: 1,
          },
        ],
      }),
    };
    const r = await runGatePipeline([declaredStage(silent, ["test"], root)], { cwd: root });
    expect(r.passed).toBe(false);
    expect(r.rungResults.filter((o) => o.gate === "unit")).toHaveLength(1);
    expect(r.rungResults[0]).toMatchObject({ gate: "unit", unavailable: true });
  });

  it.each([
    ["an empty reply", {}],
    ["no verdict", { failures: [], durationMs: 0 }],
    ["failures not a list", { passed: true, failures: "none", durationMs: 0 }],
  ])("GT-T1-2: a malformed runner reply (%s) fails closed, unavailable", async (_name, reply) => {
    const malformed = { runGates: async () => reply as never };
    const r = await runGatePipeline([declaredStage(malformed, ["test"], root)], { cwd: root });
    expect(r.passed).toBe(false);
    const test = r.rungResults.find((o) => o.gate === "test");
    expect(test).toMatchObject({ passed: false, unavailable: true });
    expect(test?.reason).toContain("malformed");
  });
});
