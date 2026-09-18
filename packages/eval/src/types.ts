import type { LocalInferenceAdapter } from "@sekhemet/models";

export interface SyntheticTask {
  id: string;
  repoCommit: string;
  issueDescription: string;
  failToPassTests: string[];
  passToPassTests: string[];
}

export interface EvalBenchmarkResult {
  taskCount: number;
  passAt1: number;
  totalTokens: number;
  totalTimeMs: number;
}

export interface EvalHarness {
  runBenchmark(
    tasks: SyntheticTask[],
    modelAdapter: LocalInferenceAdapter,
  ): Promise<EvalBenchmarkResult>;
}
