import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeterministicGateRunner } from "../src/runner.js";

/**
 * A gate failing inside a protected test must not tell the agent to edit that
 * test: the permission engine forbids it, so the suggestion only burns turns.
 */
describe("@sekhemet/gates protected-file redirect", () => {
  let repo: string;

  const gatesWith = (message: string): void => {
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    writeFileSync(
      join(repo, ".sekhemet", "gates.toml"),
      `[project]
protected = ["tests/**"]

[[gate]]
id = "types"
rung = "typecheck"
layer = "static"
command = "${process.execPath}"
args = ["-e", "console.log(${JSON.stringify(message).replace(/"/g, '\\"')}); process.exit(2)"]
timeout_s = 30
parser = "tsc"
`,
    );
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "gates-redirect-"));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("redirects a failure located only in a protected test to the implementation", async () => {
    gatesWith(
      "tests/hasher.spec.ts(25,7): error TS2353: Object literal may only specify known properties.",
    );
    const result = await new DeterministicGateRunner(new ProcessSandbox(), {
      repoRoot: repo,
    }).runGates(["typecheck"], repo);

    expect(result.passed).toBe(false);
    const failure = result.failures[0];
    expect(failure?.suggestedFixFiles).toEqual([]);
    expect(failure?.suggestedAction).toContain("protected test you may not edit");
    // The location is still reported: where it failed is useful, what to edit is not the test.
    expect(failure?.location?.file).toBe("tests/hasher.spec.ts");
  });

  it("leaves a failure in an editable source file pointed at that file", async () => {
    gatesWith("src/hasher.ts(3,1): error TS2322: Type string is not assignable to type number.");
    const result = await new DeterministicGateRunner(new ProcessSandbox(), {
      repoRoot: repo,
    }).runGates(["typecheck"], repo);
    expect(result.failures[0]?.suggestedFixFiles).toEqual(["src/hasher.ts"]);
    expect(result.failures[0]?.suggestedAction).not.toContain("protected");
  });
});
