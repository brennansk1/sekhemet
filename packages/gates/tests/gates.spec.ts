import { ProcessSandbox } from "@sekhemet/sandbox";
import { describe, expect, it } from "vitest";
import { parseErrorToGateFailure } from "../src/fallback_parser.js";
import { DeterministicGateRunner } from "../src/runner.js";
import type { GateRung } from "../src/types.js";

describe("@sekhemet/gates", () => {
  const sandbox = new ProcessSandbox();
  const runner = new DeterministicGateRunner(sandbox);

  it("extracts typed GateFailure from TypeScript compiler error output", () => {
    const tscOutput = `
src/index.ts(14,5): error TS2322: Type 'string' is not assignable to type 'number'.
src/utils.ts(20,10): error TS2554: Expected 2 arguments, but got 1.
Found 2 errors in 2 files.
`;
    const failure = parseErrorToGateFailure("typecheck", 2, tscOutput);
    expect(failure.rung).toBe("typecheck");
    expect(failure.exitCode).toBe(2);
    expect(failure.suggestedFixFiles).toContain("src/index.ts");
    expect(failure.suggestedFixFiles).toContain("src/utils.ts");
    expect(failure.errorExcerpt).toContain("Type 'string' is not assignable to type 'number'");
  });

  it("extracts typed GateFailure from Vitest test failure output", () => {
    const vitestOutput = `
 ❯ tests/auth.spec.ts:42:15
   AssertionError: expected false to be true
      at tests/auth.spec.ts:42:15
`;
    const failure = parseErrorToGateFailure("test", 1, vitestOutput);
    expect(failure.rung).toBe("test");
    expect(failure.suggestedFixFiles).toContain("tests/auth.spec.ts");
    expect(failure.errorExcerpt).toContain("AssertionError");
  });

  it("enforces Bounds Gate and flags cards exceeding LOC or file limits", () => {
    const check1 = runner.checkBounds({
      filesTouched: ["src/a.ts", "src/b.ts"],
      linesAdded: 50,
      linesRemoved: 10,
      maxFiles: 3,
      maxLines: 200,
    });
    expect(check1.passed).toBe(true);

    const check2 = runner.checkBounds({
      filesTouched: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
      linesAdded: 50,
      linesRemoved: 10,
      maxFiles: 3,
      maxLines: 200,
    });
    expect(check2.passed).toBe(false);
    expect(check2.failure?.errorExcerpt).toContain(
      "Exceeded file limit: touched 4 files (limit: 3)",
    );

    const check3 = runner.checkBounds({
      filesTouched: ["src/a.ts"],
      linesAdded: 250,
      linesRemoved: 10,
      maxFiles: 3,
      maxLines: 200,
    });
    expect(check3.passed).toBe(false);
    expect(check3.failure?.errorExcerpt).toContain(
      "Exceeded LOC diff limit: 260 diff lines (limit: 200)",
    );
  });

  it("runs gate sequence and returns overall GateResult", async () => {
    // Custom test with echo command
    const res = await runner.runCustomCommandGate(
      "test",
      "node",
      ["-e", "console.log('Tests passed!');"],
      process.cwd(),
    );

    expect(res.passed).toBe(true);
    expect(res.failures.length).toBe(0);
  });
});
