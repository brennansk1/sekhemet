import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BuiltinGateId, runBuiltinGates } from "../src/builtin.js";
import { missingFailureFields } from "../src/rank.js";
import { DeterministicGateRunner } from "../src/runner.js";
import type { GateProjectConfig } from "../src/types.js";

// Gates rules 9 and 17; B2.3 "built-in gates never vanish": a built-in gate
// that cannot run reports that it did not run, and is never silently absent.

const project: GateProjectConfig = { protected: [], maxFiles: 3, maxDiffLines: 200 };
const none = () => false;

describe("built-in gates never vanish", () => {
  let root: string;
  let bin: string;
  const git = (...a: string[]) =>
    execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const diff = () => {
    git("add", "-A");
    return git("diff", "--cached", "--unified=0", "main");
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vanish-"));
    bin = mkdtempSync(join(tmpdir(), "vanish-bin-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    git("checkout", "-q", "-b", "card");
    writeFileSync(
      join(root, "a.ts"),
      "export const a = 1;\nexport const big = (n: number) => n > 10;\n",
    );
  });
  afterEach(() => {
    for (const d of [root, bin]) rmSync(d, { recursive: true, force: true });
  });

  it("reports a layer that throws as not run, and still runs the others", async () => {
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project: { ...project, mutation: true },
      gates: ["secrets", "hygiene"],
      which: none,
      runTests: async () => {
        throw new Error("the test runner crashed");
      },
    });
    const mutation = r.failures.find((f) => f.gate === "mutation");
    expect(mutation?.actual).toContain("the test runner crashed");
    expect(mutation?.notRun).toBe(true);
    expect(missingFailureFields(mutation ?? ({} as never))).toEqual([]);
    const byGate = new Map(r.outcomes.map((o) => [o.gate, o]));
    expect(byGate.get("mutation")).toMatchObject({ passed: false });
    expect(byGate.get("secrets")).toMatchObject({ passed: true });
    expect(byGate.get("hygiene")).toBeDefined();
  });

  it("records osv as skipped, not passed, when there is no lockfile", async () => {
    const osv = join(bin, "osv-scanner");
    writeFileSync(osv, "#!/bin/sh\nexit 0\n");
    chmodSync(osv, 0o755);
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project,
      gates: ["osv"],
      programs: { "osv-scanner": [osv] },
    });
    expect(r.outcomes.find((o) => o.gate === "osv")).toMatchObject({
      skipped: true,
      reason: "no lockfile to scan",
    });
  });

  it("reports every diff-based layer as not run when the diff could not be read", async () => {
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: undefined,
      project: { ...project, mutation: true },
      gates: ["secrets", "dependencies", "hygiene"],
      which: none,
      runTests: async () => true,
    });
    const gates = r.failures.filter((f) => f.notRun).map((f) => f.gate);
    expect(gates.sort()).toEqual(["dependencies", "hygiene", "mutation", "secrets"]);
    for (const o of r.outcomes) expect(o.passed, o.gate).toBe(false);
  });

  it("gives every enabled layer exactly one outcome", async () => {
    const gates: BuiltinGateId[] = ["secrets", "dependencies", "osv", "semgrep", "hygiene"];
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project: { ...project, mutation: true },
      gates,
      which: none,
    });
    expect(r.outcomes.map((o) => o.gate).sort()).toEqual([...gates, "mutation"].sort());
    // What did not run says so, and why.
    for (const gate of ["osv", "semgrep", "mutation"]) {
      expect(r.outcomes.find((o) => o.gate === gate)?.skipped, gate).toBe(true);
    }
    expect(r.outcomes.find((o) => o.gate === "osv")?.reason).toBe("osv-scanner is not installed");
    expect(r.outcomes.find((o) => o.gate === "semgrep")?.reason).toBe("semgrep is not installed");
  });

  it("gives every built-in failure all six fields (GT-M6-6)", async () => {
    writeFileSync(
      join(root, "a.ts"),
      `export const a = 1;\nexport const k = "AKIA${"ABCDEFGHIJKLMNOP"}";\nconsole.log(a);\n`,
    );
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project: {
        ...project,
        debugPatterns: ["console.log("],
        mutation: true,
        mutationBlocking: true,
      },
      which: none,
      runTests: async () => true,
    });
    expect(r.failures.length).toBeGreaterThanOrEqual(2);
    for (const f of r.failures) expect(missingFailureFields(f), f.errorExcerpt).toEqual([]);
  });

  it("never asks the implementer for a test it cannot write (GT-M6-4, rule 17)", async () => {
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project: { ...project, mutation: true, mutationBlocking: true },
      which: none,
      runTests: async () => true,
    });
    // GT-TQ-5 (which replaces GT-M6-4's note remedy): a survivor never
    // reaches the Worker as a failure; it is a test gap routed to a person.
    expect(r.failures.filter((f) => f.gate === "mutation")).toEqual([]);
    expect(r.testGaps.length).toBeGreaterThan(0);
    for (const gap of r.testGaps) {
      expect(gap).not.toMatch(/add a test|write a test/i);
      expect(gap).toMatch(/a test gap for a person/);
    }
  });

  describe.runIf(platform() === "darwin")("a scanner that errors is not a clean result", () => {
    function fake(name: string, stdout: string, exit: number): string {
      const path = join(bin, name);
      writeFileSync(path, `#!/bin/sh\necho '${stdout}'\necho 'scanner broke' >&2\nexit ${exit}\n`);
      chmodSync(path, 0o755);
      return path;
    }

    it("gitleaks exiting with an error is reported as not run", async () => {
      const r = await runBuiltinGates({
        root,
        base: "main",
        diff: diff(),
        project,
        gates: ["secrets"],
        programs: { gitleaks: [fake("gitleaks", "", 2)] },
      });
      const f = r.failures.find((x) => x.gate === "secrets");
      expect(f?.errorExcerpt).toMatch(/gitleaks not run/);
      expect(f?.notRun).toBe(true);
      expect(r.outcomes.find((o) => o.gate === "secrets")?.passed).toBe(false);
    });

    it("gitleaks reporting leaks it cannot print is still a finding", async () => {
      const r = await runBuiltinGates({
        root,
        base: "main",
        diff: diff(),
        project,
        gates: ["secrets"],
        programs: { gitleaks: [fake("gitleaks", "not json", 1)] },
      });
      expect(r.failures.some((x) => x.gate === "secrets")).toBe(true);
    });

    it("semgrep exiting with an error and no results is reported as not run", async () => {
      mkdirSync(join(root, ".sekhemet"));
      writeFileSync(join(root, ".sekhemet", "semgrep.yml"), "rules: []\n");
      const r = await runBuiltinGates({
        root,
        base: "main",
        diff: diff(),
        project,
        gates: ["semgrep"],
        programs: { semgrep: [fake("semgrep", '{"results":[],"errors":[{"message":"bad"}]}', 2)] },
      });
      const f = r.failures.find((x) => x.gate === "semgrep");
      expect(f?.errorExcerpt).toMatch(/semgrep not run/);
      expect(r.outcomes.find((o) => o.gate === "semgrep")?.passed).toBe(false);
    });
  });
});

describe("a declared gate that cannot start fails closed (rule 9)", () => {
  it("is reported as not run, never as absent or passed", async () => {
    const root = mkdtempSync(join(tmpdir(), "vanish-runner-"));
    try {
      const sandbox = {
        execute: async () => {
          throw new Error("spawn pnpm ENOENT");
        },
      } as unknown as ProcessSandbox;
      const r = await new DeterministicGateRunner(sandbox, { repoRoot: root }).runGates(
        ["typecheck"],
        root,
      );
      expect(r.passed).toBe(false);
      expect(r.rungResults?.[0]).toMatchObject({ gate: "typecheck", passed: false });
      expect(r.failures[0]?.errorExcerpt).toBe("typecheck not run: spawn pnpm ENOENT");
      expect(r.failures[0]?.notRun).toBe(true);
      expect(missingFailureFields(r.failures[0] ?? ({} as never))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a requested rung with no gate is not silently absent", () => {
  it("records a not-run outcome naming the rung and how to declare a gate", async () => {
    const root = mkdtempSync(join(tmpdir(), "vanish-rung-"));
    try {
      const sandbox = {
        execute: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
      } as unknown as ProcessSandbox;
      const r = await new DeterministicGateRunner(sandbox, { repoRoot: root }).runGates(
        ["parse", "typecheck"],
        root,
      );
      const parse = r.rungResults?.find((o) => o.rung === "parse");
      expect(parse).toMatchObject({ gate: "parse", passed: false, skipped: true, exitCode: -1 });
      expect(parse?.reason).toBe(
        'no gate is declared for the parse rung: add a [[gate]] with rung = "parse" to .sekhemet/gates.toml',
      );
      expect(r.rungResults?.find((o) => o.rung === "typecheck")?.passed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the ids a gate can emit are listed from the same source", () => {
  it("lists the enabled built-in layers, mutation and the visual ids", async () => {
    const { builtinGateIds } = await import("../src/builtin.js");
    expect(builtinGateIds({ ...project, builtin: ["secrets"], mutation: true })).toEqual([
      "mutation",
      "secrets",
    ]);
    const withVisual = builtinGateIds({
      ...project,
      builtin: [],
      visual: { url: "http://localhost:{port}", viewports: [1280], checks: [] } as never,
    });
    expect(withVisual).toEqual([
      "visual",
      "visual-a11y",
      "visual-confinement",
      "visual-console",
      "visual-dom",
      "visual-layout",
      "visual-snapshot",
      "visual-vision",
    ]);
  });
});

describe("a declared gate whose program is missing, through the real sandbox", () => {
  it("is not run, never a failure the model is charged with", async () => {
    const root = mkdtempSync(join(tmpdir(), "vanish-missing-"));
    try {
      mkdirSync(join(root, ".sekhemet"));
      writeFileSync(
        join(root, ".sekhemet", "gates.toml"),
        '[[gate]]\nid = "typecheck"\nrung = "typecheck"\ncommand = "definitely-not-a-binary-xyz"\nparser = "tsc"\n',
      );
      const r = await new DeterministicGateRunner(new ProcessSandbox(), {
        repoRoot: root,
      }).runGates(["typecheck"], root);
      expect(r.failures).toHaveLength(1);
      expect(r.failures[0]?.notRun).toBe(true);
      expect(r.failures[0]?.errorExcerpt).toMatch(/^typecheck not run:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
