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

/**
 * Where a failure occurred. `file` is repository-relative; `.` names the
 * whole change, for a failure about no one file (bounds, a gate that could
 * not run).
 */
export interface FailureLocation {
  file: string;
  line?: number;
  column?: number;
}

/**
 * The one shape a failure reaches the model in (gates rule 19). The six
 * fields `gate`, `location`, `expected`, `actual`, `minimalRepro` and
 * `suggestedAction` are required and non-empty (GT-M6-6); the pipeline also
 * checks them at run time (`assertCompleteFailures`, `finalizeFailures`).
 */
export interface GateFailure {
  rung: GateRung;
  exitCode: number;
  /** Compact, repair-relevant excerpt. Never the raw log. */
  errorExcerpt: string;
  suggestedFixFiles: string[];

  /** Identifier of the gate that produced this failure. */
  gate: string;
  layer?: GateLayer;
  location: FailureLocation;
  /** What the gate required. */
  expected: string;
  /** What it observed instead. */
  actual: string;
  /**
   * The exact command that reproduces this failure; for a harness-run layer
   * with no command of its own, `check`, the tool that runs every gate again.
   *
   * A description is not sufficient: the agent must be able to re-run it
   * verbatim to confirm a repair.
   */
  minimalRepro: string;
  /** What to do next, completable in one step (rule 21), from the gates copy module. */
  suggestedAction: string;
  /**
   * The gate could not run (rule 9): it is not the card's work and never
   * counts against the model. Ranked after every real failure; when only
   * such failures remain, the card stops with `done_pending_gates`.
   */
  notRun?: boolean;
}

/** The same type: every `GateFailure` is complete. Kept as a name for readers of rank.ts. */
export type CompleteGateFailure = GateFailure;

export interface GateResult {
  passed: boolean;
  failures: GateFailure[];
  durationMs: number;
  /** Harness defects found while finalizing failures (an incomplete failure, filled in). */
  defects?: string[];
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
  /**
   * The gate could not produce a verdict (rule 9): it threw, crashed, timed
   * out without a result, its output could not be read, or a need it declares
   * is missing. Never a pass; a blocking unavailable gate blocks Review, and
   * `reason` says why (GT-T1-2, GT-T1-3, GT-T1-7).
   */
  unavailable?: boolean;
  /** Why a gate did not run, for the evidence: a skipped or not-run outcome says so. */
  reason?: string;
  /**
   * Where the result came from (rule 35, GT-T1-12): this machine's run, or an
   * external CI check with its name, run URL and head sha. Absent means local.
   */
  source?: GateResultSource;
  /** The mutation gate's measurement, for the evidence (measurement MS-M10-4). */
  mutation?: MutationMeasure;
  /**
   * The verdict came from the cache: the same tree and the same gate
   * definition already ran on this card, so no process started (rule 33,
   * GT-N3-1).
   */
  cached?: boolean;
  /** What the evidence should say about how the gate ran ("impacted tests first: no source index", GT-N3-2). */
  note?: string;
  /** Tests that failed, then passed on a re-run of the unchanged tree: flaky, quarantined for the card (rule 34, GT-N3-4). */
  quarantined?: QuarantinedTest[];
}

/** A flaky test, quarantined for the card with both runs attached (rule 34, GT-N3-4). */
export interface QuarantinedTest {
  /** The test as its failure names it (`file > name`). */
  test: string;
  /** The first run's failure. */
  firstRun: string;
  /** What the re-run of the unchanged tree found: the test's own JUnit result. */
  rerun: string;
  /** The tree the quarantine holds on; it ends when the tree changes. */
  tree?: string;
}

/**
 * When a flaky test may be quarantined (rule 34, GT-N3-4). Closed unless a
 * card's first verification opens it: never during red-first, never after
 * the first repair rung.
 */
export interface QuarantinePolicy {
  /** A quarantine may begin now: the card's first verification. */
  open: boolean;
  /** Test files never quarantined: the card's acceptance tests. */
  never?: readonly string[] | undefined;
  /** The card's base: a test file the card's diff changed or added is never quarantined. */
  base?: string | undefined;
}

/** Where a gate result came from (rule 35; kernel rule 37). */
export type GateResultSource =
  | { kind: "local" }
  | { kind: "external"; check: string; url?: string; headSha: string };

/**
 * What the mutation gate measured. `score` is killed over total, and `null`
 * when it is not measured: the tests fail on the unmutated change
 * (`refused`) or the change has no mutable lines. It is never 1 by default.
 */
export interface MutationMeasure {
  score: number | null;
  killed: number;
  total: number;
  /** Why the gate did not score. */
  refused?: string;
  /** Changed code in a language the gate cannot mutate, each with the reason. */
  notMeasured: { file: string; reason: string }[];
}

export interface BoundsCheckOptions {
  /** The integration branch the diff is measured against, for the repro (default `main`). */
  base?: string;
  filesTouched: string[];
  linesAdded: number;
  linesRemoved: number;
  maxFiles?: number;
  maxLines?: number;
}

export interface BoundsCheckResult {
  passed: boolean;
  failure?: CompleteGateFailure;
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
  /**
   * What the gate needs to run (rule 10): `env:NAME` (a variable set),
   * `cmd:program` (a program on the host), or any other name the host
   * declares it provides (a service, a port). A need the host cannot provide
   * makes the gate `unavailable`, naming it (GT-T1-7).
   */
  needs?: string[];
  /**
   * The external CI check this gate stands for (rule 35, GT-T1-12): its
   * result is advisory unless the gate is `blocking = true` in the file.
   */
  external?: string;
  /** True when `blocking` was written in `gates.toml`, not defaulted. */
  blockingDeclared?: boolean;
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
  /**
   * Require a CHANGELOG.md entry for source changes; default: when
   * CHANGELOG.md exists. `"advisory"` is set per card, never from the file:
   * a card whose scope does not hold CHANGELOG.md is told, not failed
   * (rule 17, GT-N2-2).
   */
  changelog?: boolean | "advisory";
  /**
   * The integration branch the card's change is judged against (rule 16,
   * GT-N2-3); default the project's `[review] integration_branch`.
   */
  baseBranch?: string;
  /** Diff-scoped mutation testing after the gates pass (G13); advisory unless blocking. */
  mutation?: boolean;
  mutationMax?: number;
  mutationBlocking?: boolean;
  /** Domains the Worker's commands may reach through the egress proxy (S5, S8). */
  networkAllow?: string[];
  /** pass@k with gate selection (G25): samples per card; default 1. */
  passAtK?: number;
  /** Cross-validate two passing samples against each other's tests (G26). */
  crossValidate?: boolean;
  /** A separate, mutually authenticated gate host (G24), from `[gate_host]`. */
  gateHost?: import("./gate_host.js").GateHostConfig;
  /** The visual layer (G17-G20), from the `[visual]` table. */
  visual?: import("./visual.js").VisualConfig;
}

export interface GatesConfig {
  project: GateProjectConfig;
  gates: GateDefinition[];
  /**
   * SHA-256 of the config file's bytes as loaded, verified on every card
   * start; `NO_GATES_CONFIG` when there is no `gates.toml` and the defaults
   * ran — never the hash of an empty string (GT-T1-10, GT-T1-13).
   */
  sha256: string;
  sourcePath: string;
  /** True when no `.sekhemet/gates.toml` exists (GT-T1-10). */
  empty?: boolean;
  /** An unknown rung, layer or parser, each naming the key and the value (GT-T1-6). */
  warnings?: string[];
}

export interface GateRunner {
  runGates(rungs: GateRung[], cwd: string): Promise<GateResult>;
  /**
   * The ids of the gates a wrapper adds around its inner runner, innermost
   * first (GT-M6-5: `note`'s enum is built from them, never from a hand copy).
   */
  gateIds?: readonly string[];
}
