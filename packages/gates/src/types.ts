export type GateRung =
  | "parse"
  | "typecheck"
  | "test"
  | "lint"
  | "bounds"
  | "visual"
  /** The harness's built-in layers (G3): secrets, dependencies, scanners. */
  | "security"
  | "hygiene"
  | "robustness";

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
  /**
   * Formatter run over the card's scope files before verification, as argv;
   * scope file paths are appended. Formatting is not worth a model's turns, and
   * running it only on scope files keeps protected tests untouched.
   */
  autofix?: string[];
  /**
   * A second fixer for purely stylistic rules whose fixes the tool marks
   * unsafe (Biome: noUnusedTemplateLiteral). It runs once per entry of
   * `styleFixRules` as argv + `--only=<rule>` + the scope files.
   * Chronicle run 5's ledger card was complete except for one template
   * literal, and exhausted its repair ladder on it.
   */
  styleFix?: string[];
  styleFixRules?: string[];
  /** Built-in gates to run (G3); default secrets, dependencies, osv, semgrep, hygiene. */
  builtin?: ("secrets" | "dependencies" | "osv" | "semgrep" | "hygiene" | "mutation")[];
  /** Extra debug-output markers the hygiene gate refuses (G22), e.g. "console.log(". */
  debugPatterns?: string[];
  /** Require a CHANGELOG.md entry for source changes; default: when CHANGELOG.md exists. */
  changelog?: boolean;
  /** Diff-scoped mutation testing after the gates pass (G13); advisory unless blocking. */
  mutation?: boolean;
  mutationMax?: number;
  mutationBlocking?: boolean;
  /** Domains the Worker's commands may reach through the egress proxy (S5, S8). */
  networkAllow?: string[];
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
