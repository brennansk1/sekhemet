export type GateRung = "parse" | "typecheck" | "test" | "lint" | "bounds" | "visual";

/** The six verification layers a gate can belong to. */
export type GateLayer = "static" | "functional" | "robustness" | "security" | "visual" | "hygiene";

/** Where a failure occurred, when the parser can pin it down. */
export interface FailureLocation {
  file: string;
  line?: number;
  column?: number;
}

export interface GateFailure {
  rung: GateRung;
  exitCode: number;
  /** Compact, repair-relevant excerpt. Never the raw log. */
  errorExcerpt: string;
  suggestedFixFiles: string[];

  /** Identifier of the gate that produced this failure. */
  gate?: string;
  layer?: GateLayer;
  location?: FailureLocation;
  /** What the gate required. */
  expected?: string;
  /** What it observed instead. */
  actual?: string;
  /**
   * The exact command that reproduces this failure.
   *
   * A description is not sufficient: the agent must be able to re-run it
   * verbatim to confirm a repair.
   */
  minimalRepro?: string;
  suggestedAction?: string;
}

export interface GateResult {
  passed: boolean;
  failures: GateFailure[];
  durationMs: number;
  /** Per-gate outcomes, retained even when a later gate fails. */
  rungResults?: RungOutcome[];
}

export interface RungOutcome {
  gate: string;
  rung: GateRung;
  layer: GateLayer;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  skipped?: boolean;
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

/** One executable gate, as declared in `gates.toml`. */
export interface GateDefinition {
  id: string;
  rung: GateRung;
  layer: GateLayer;
  command: string;
  args: string[];
  timeoutMs: number;
  /** Failure parser to apply to this gate's output. */
  parser: string;
  /** Gate must be satisfied before the card can be accepted. */
  blocking: boolean;
  /** Changing this gate's baseline requires human sign-off. */
  baselineApproval?: "human" | "auto";
}

export interface GateProjectConfig {
  /** Glob patterns no implementer may modify. */
  protected: string[];
  maxFiles: number;
  maxDiffLines: number;
}

export interface GatesConfig {
  project: GateProjectConfig;
  gates: GateDefinition[];
  /** SHA-256 of the config file as loaded, verified on every card start. */
  sha256: string;
  sourcePath: string;
}

export interface GateRunner {
  runGates(rungs: GateRung[], cwd: string): Promise<GateResult>;
}
