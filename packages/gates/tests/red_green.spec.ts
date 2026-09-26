import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARD_CHANGES } from "@sekhemet/kernel";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RED_GREEN_RULES,
  buildRepairRedCheck,
  judgeRedFirst,
  redGreenRule,
} from "../src/red_green.js";

// GT-N8-2: one red/green table in code (rule 6b), chosen by the card's
// `change` and nothing else.

const red = { passed: false, onlyNotRun: false };
const green = { passed: true, onlyNotRun: false };
const couldNotRun = { passed: false, onlyNotRun: true };
const tests = ["tests/a.spec.ts"];

describe("the red/green table (rule 6b, GT-N8-2)", () => {
  it("has exactly one rule per change kind", () => {
    expect(Object.keys(RED_GREEN_RULES).sort()).toEqual([...CARD_CHANGES].sort());
    for (const change of CARD_CHANGES) expect(RED_GREEN_RULES[change].change).toBe(change);
  });

  it("a card with no change is a feature", () => {
    expect(redGreenRule(undefined)).toBe(RED_GREEN_RULES.feature);
  });

  it("feature and fix need red on the base; green there is vacuous", () => {
    for (const change of ["feature", "fix"] as const) {
      expect(judgeRedFirst(change, red, tests).status, change).toBe("fails");
      const v = judgeRedFirst(change, green, tests);
      expect(v.status, change).toBe("vacuous");
      expect(v.stopReason, change).toBe("vacuous_tests");
    }
  });

  it("characterize, refactor and upgrade need green on the base: it is the proof, never vacuous", () => {
    for (const change of ["characterize", "refactor", "upgrade"] as const) {
      const v = judgeRedFirst(change, green, tests);
      expect(v.status, change).toBe("green");
      expect(v.stopReason, change).toBeUndefined();
    }
  });

  it("characterize, refactor and upgrade tests that fail on the base are refused, naming them", () => {
    for (const change of ["characterize", "refactor", "upgrade"] as const) {
      const v = judgeRedFirst(change, red, tests);
      expect(v.status, change).toBe("refused");
      expect(v.stopReason, change).toBe("base_not_green");
      expect(v.detail, change).toContain("tests/a.spec.ts");
    }
  });

  it("gates that could not run say nothing about the tests, whatever the change", () => {
    for (const change of CARD_CHANGES) {
      expect(judgeRedFirst(change, couldNotRun, tests).status, change).toBe("unknown");
    }
  });
});

describe("the build-repair red check (rule 6b, DEC-43)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "build-repair-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("is red when the declared build command fails on the base, recording its exit code and failing step", async () => {
    writeFileSync(
      join(root, "build.sh"),
      "echo 'step 1 ok'\necho 'error: step 2 missing module' >&2\nexit 3\n",
    );
    const v = await buildRepairRedCheck(new ProcessSandbox(), {
      command: "sh",
      args: ["build.sh"],
      cwd: root,
    });
    expect(v.status).toBe("fails");
    expect(v.exitCode).toBe(3);
    expect(v.failingStep).toContain("step 2 missing module");
  });

  it("refuses a build-repair card whose build already succeeds on the base, as not red", async () => {
    writeFileSync(join(root, "build.sh"), "echo built\n");
    const v = await buildRepairRedCheck(new ProcessSandbox(), {
      command: "sh",
      args: ["build.sh"],
      cwd: root,
    });
    expect(v.status).toBe("refused");
    expect(v.stopReason).toBe("tests_not_red_for_reason");
    expect(v.detail).toContain("sh build.sh");
  });

  it("a build that timed out is unknown, not red", async () => {
    const v = await buildRepairRedCheck(new ProcessSandbox(), {
      command: "sh",
      args: ["-c", "sleep 5"],
      cwd: root,
      timeoutMs: 300,
    });
    expect(v.status).toBe("unknown");
    expect(v.detail).toMatch(/timed out/);
  });

  it("a build the sandbox denied is unknown, not red", async () => {
    const denied = {
      execute: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "mkdir: /Users/me/.cache/tool: Operation not permitted\n",
        durationMs: 5,
        oomKilled: false,
        timedOut: false,
      }),
    } as unknown as ProcessSandbox;
    const v = await buildRepairRedCheck(denied, { command: "make", args: [], cwd: root });
    expect(v.status).toBe("unknown");
    expect(v.detail).toMatch(/sandbox/);
  });

  it("runs the build with no network", async () => {
    const seen: { allowNetwork?: boolean }[] = [];
    const sandbox = new ProcessSandbox();
    const spy = {
      execute: (cmd: string, args: string[], opts: Parameters<ProcessSandbox["execute"]>[2]) => {
        seen.push(opts);
        return sandbox.execute(cmd, args, opts);
      },
    } as unknown as ProcessSandbox;
    await buildRepairRedCheck(spy, { command: "true", args: [], cwd: root });
    expect(seen[0]?.allowNetwork).toBe(false);
  });
});
