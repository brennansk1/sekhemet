import { MockInferenceAdapter } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { BenchmarkHarness } from "../src/benchmark.js";
import type { SyntheticTask } from "../src/types.js";

describe("@sekhemet/eval", () => {
  it("runs a benchmark suite and computes Pass@1 metrics", async () => {
    const mockModel = new MockInferenceAdapter("mock-llama", [
      {
        text: "fixed",
        toolCalls: [
          {
            id: "1",
            name: "write_file",
            arguments: { path: "src/calc.ts", content: "export const add = (a, b) => a + b;" },
          },
          { id: "2", name: "finish_card", arguments: {} },
        ],
        usage: { promptTokens: 200, completionTokens: 50, durationMs: 40 },
      },
    ]);

    const tasks: SyntheticTask[] = [
      {
        id: "task_01",
        repoCommit: "commit_abc",
        issueDescription: "Fix addition logic in calc.ts",
        failToPassTests: ["tests/calc.spec.ts:addition_works"],
        passToPassTests: ["tests/calc.spec.ts:multiplication_works"],
      },
    ];

    const harness = new BenchmarkHarness();
    const result = await harness.runBenchmark(tasks, mockModel);

    expect(result.taskCount).toBe(1);
    expect(result.passAt1).toBe(1.0);
    expect(result.totalTokens).toBeGreaterThan(0);
  });
});
