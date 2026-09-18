export type GateRung = "parse" | "typecheck" | "test" | "lint" | "bounds" | "visual";

export interface GateFailure {
  rung: GateRung;
  exitCode: number;
  errorExcerpt: string;
  suggestedFixFiles: string[];
}

export interface GateResult {
  passed: boolean;
  failures: GateFailure[];
  durationMs: number;
}

export interface BoundsCheckOptions {
  filesTouched: string[];
  linesAdded: number;
  linesRemoved: number;
  maxFiles?: number;
  maxLines?: number;
}

export interface BoundsCheckResult {
  passed: boolean;
  failure?: GateFailure;
}

export interface GateRunner {
  runGates(rungs: GateRung[], cwd: string): Promise<GateResult>;
}
