import { describe, expect, it } from "vitest";
import { ContextCondenser, compactHistory } from "../src/condenser.js";
import type { TurnHistoryItem } from "../src/prompts.js";

describe("@sekhemet/context ContextCondenser", () => {
  it("condenses long command outputs and strips ANSI escape codes and progress bars", () => {
    const rawOutput = `\u001b[32mPASS\u001b[39m tests/auth.spec.ts
[====>    ] 50% done
${Array.from({ length: 100 }, (_, i) => `log line ${i + 1}`).join("\n")}
Done in 1.2s`;

    const condensed = ContextCondenser.condenseOutput(rawOutput, 20);
    expect(condensed).not.toContain("\u001b[32m");
    expect(condensed).not.toContain("50% done");
    expect(condensed).toContain("omitted for context efficiency");
    expect(condensed.split("\n").length).toBeLessThanOrEqual(22);
  });

  it("applies in-place observation masking to older turns while preserving recent ones", () => {
    const history: TurnHistoryItem[] = [
      {
        turn: 1,
        action: "read_file",
        result: Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"),
      },
      {
        turn: 2,
        action: "read_symbol",
        result: Array.from({ length: 30 }, (_, i) => `code ${i}`).join("\n"),
      },
      {
        turn: 3,
        action: "write_file",
        result: "file written successfully",
      },
      {
        turn: 4,
        action: "run_cmd",
        result: "tests passed: 4/4",
      },
    ];

    const masked = ContextCondenser.maskOlderObservations(history, 2);

    // Turns 1 and 2 should be masked into compact pointers
    expect(masked[0]?.result).toMatch(
      /50 lines, \S+ tokens, omitted; recall\(ref\) returns them\. EvidenceRef: ev_/,
    );
    expect(masked[1]?.result).toMatch(/30 lines, \S+ tokens, omitted/);
    // No internal jargon (CX-M1-1): the store is not named.
    expect(masked[0]?.result).not.toMatch(/\bWAL\b/);

    // Turns 3 and 4 should be preserved intact
    expect(masked[2]?.result).toBe("file written successfully");
    expect(masked[3]?.result).toBe("tests passed: 4/4");
  });

  it("points at recall only when recall is offered (CX-M1-1)", () => {
    const history = [
      { turn: 1, action: "read_file", result: Array(20).fill("a line of the file").join("\n") },
      { turn: 2, action: "note", result: "ok" },
      { turn: 3, action: "note", result: "ok" },
    ];
    const masked = ContextCondenser.maskOlderObservations(history, 2, { recallOffered: false });
    expect(masked[0]?.result).toMatch(
      /^\[Observation #1: read_file: a line of the file\. 20 lines, \S+ tokens, omitted\.\]$/,
    );
    const many = Array.from({ length: 10 }, (_, i) => ({
      turn: i + 1,
      action: "note",
      result: `r${i}`,
    }));
    const compacted = compactHistory(many, 3, { recallOffered: false }).turns[0]?.result ?? "";
    expect(compacted).not.toMatch(/recall|\[ref /);
    expect(compactHistory(many, 3).turns[0]?.result).toMatch(/recall\(ref\)/);
  });
});
