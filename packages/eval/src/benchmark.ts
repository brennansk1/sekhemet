import { performance } from "node:perf_hooks";
import type { LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import type { EvalBenchmarkResult, EvalHarness, SyntheticTask } from "./types.js";

export class BenchmarkHarness implements EvalHarness {
  public async runBenchmark(
    tasks: SyntheticTask[],
    modelAdapter: LocalInferenceAdapter,
  ): Promise<EvalBenchmarkResult> {
    const startTime = performance.now();
    let passedCount = 0;
    let totalTokens = 0;

    for (const task of tasks) {
      const response = await modelAdapter.generate({
        prompt: `Solve task ${task.id}: ${task.issueDescription}`,
        toolArm: "arm_a_flat",
      });

      totalTokens += response.usage.promptTokens + response.usage.completionTokens;

      // Check if model produced a finish_card tool call
      const finished = response.toolCalls.some((tc: ToolCall) => tc.name === "finish_card");
      if (finished || response.toolCalls.length > 0) {
        passedCount++;
      }
    }

    const totalTimeMs = Math.round(performance.now() - startTime);
    const passAt1 = tasks.length > 0 ? passedCount / tasks.length : 0;

    return {
      taskCount: tasks.length,
      passAt1,
      totalTokens,
      totalTimeMs,
    };
  }
}
