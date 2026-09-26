import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { type ProcessSandbox, matchesGlob } from "@sekhemet/sandbox";
import { gitEnvFor } from "@sekhemet/sync";
import { onPath } from "./builtin.js";
import {
  DEFAULT_GATES,
  DEFAULT_PROJECT_CONFIG,
  loadGatesConfig,
  verifyGatesConfig,
} from "./config.js";
import { gateCopy } from "./copy.js";
import { type JUnitCase, parseJUnit } from "./junit.js";
import { parseErrorToGateFailure } from "./parser.js";
import { type ParseContext, defaultParserRegistry } from "./parsers.js";
import { FAILURES_SHOWN, completeFailures, rankFailures } from "./rank.js";
import { acceptanceCommand } from "./test_strength.js";
import type {
  BoundsCheckOptions,
  BoundsCheckResult,
  GateDefinition,
  GateFailure,
  GateLayer,
  GateResult,
  GateRung,
  GateRunner,
  GatesConfig,
  QuarantinePolicy,
  QuarantinedTest,
  RungOutcome,
} from "./types.js";

export interface GateRunnerOptions {
  /** Repo root used to locate `.sekhemet/gates.toml`. */
  repoRoot?: string;
  /** Pinned config hash; when set, a changed gates.toml aborts the run. */
  expectedConfigSha256?: string;
  /** Stop after the first blocking failure instead of collecting every gate. */
  failFast?: boolean;
  /**
   * Maximum failures handed back per run (default 3). The cap that reaches the
   * model is applied once more, over every gate's failures together, by
   * `finalizeFailures` (rule 20, F14).
   */
  maxFailuresReported?: number;
  /** What this host can provide to a gate's declared `needs` (rule 10, GT-T1-7). */
  host?: HostCapabilities;
  /**
   * Cache each verdict by the tree it ran on and the gate's definition
   * (rule 33, GT-N3-1); default on. The cache lives as long as the runner:
   * one card's run.
   */
  verdictCache?: boolean;
  /**
   * When a flaky test may be quarantined (rule 34, GT-N3-4). A policy the
   * card runner set for the worktree (`setQuarantinePolicy`) takes
   * precedence; with neither, no quarantine begins.
   */
  quarantine?: QuarantinePolicy;
}

/** The key a worktree's quarantine state is held under: its real path. */
function worktreeKey(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

/** Quarantine policies by worktree, set by the card runner through any wrapper (rule 34). */
const QUARANTINE_POLICIES = new Map<string, QuarantinePolicy>();
/** Every quarantine begun in a worktree, for the card's evidence (rule 34). */
const QUARANTINE_RECORDS = new Map<string, QuarantinedTest[]>();

/**
 * Open or close quarantine for a card's worktree (rule 34): open for the
 * card's first verification only — never during red-first, never after the
 * first repair rung. `undefined` forgets the worktree's policy and records.
 */
export function setQuarantinePolicy(cwd: string, policy: QuarantinePolicy | undefined): void {
  const key = worktreeKey(cwd);
  if (policy) {
    QUARANTINE_POLICIES.set(key, {
      ...policy,
      ...(policy.never ? { never: [...policy.never] } : {}),
    });
  } else {
    QUARANTINE_POLICIES.delete(key);
    QUARANTINE_RECORDS.delete(key);
  }
}

/** Close quarantine for a worktree, keeping what it protects (after the first verification). */
export function closeQuarantine(cwd: string): void {
  const key = worktreeKey(cwd);
  const current = QUARANTINE_POLICIES.get(key);
  QUARANTINE_POLICIES.set(key, { ...(current ?? {}), open: false });
}

/** Every test quarantined in this worktree, for the evidence (count and tests). */
export function quarantinedTests(cwd: string): QuarantinedTest[] {
  return structuredClone(QUARANTINE_RECORDS.get(worktreeKey(cwd)) ?? []);
}

/**
 * What the functional gate's evidence says until the source index can name
 * the tests reachable from a card's scope (rule 33, GT-N3-2): it runs the
 * full suite every time.
 */
export const IMPACTED_TESTS_NO_INDEX = "impacted tests first: no source index";

/**
 * The hash of the tree a gate runs on (rule 33, GT-N3-1): tracked and
 * untracked files as they are on disk, ignored files excluded, written
 * through a copy of the index so the card's own index is never touched.
 * Undefined outside a git repository: then nothing is cached.
 */
export function worktreeTreeHash(cwd: string): string | undefined {
  const git = (args: string[], env: NodeJS.ProcessEnv = gitEnvFor(cwd)) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 60_000,
      env,
    }).trim();
  const scratch = mkdtempSync(join(tmpdir(), "sekhemet-tree-"));
  const tmp = join(scratch, "index");
  const objects = join(scratch, "objects");
  try {
    const top = git(["rev-parse", "--show-toplevel"]);
    const abs = (p: string) => (isAbsolute(p) ? p : join(cwd, p));
    const index = abs(git(["rev-parse", "--git-path", "index"]));
    const store = abs(git(["rev-parse", "--git-path", "objects"]));
    // The real index's stat cache makes `add` hash only what changed.
    if (existsSync(index)) copyFileSync(index, tmp);
    mkdirSync(objects);
    // A card's worktree gets the guarded git environment: no hook, monitor
    // or helper the worktree names runs (security items 18-22). New blobs
    // and trees go to a scratch object directory, never the shared store;
    // the repository's objects are read through it as an alternate.
    const env = {
      ...gitEnvFor(cwd),
      GIT_INDEX_FILE: tmp,
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: store,
    };
    git(["add", "-A", "--", top], env);
    const tree = git(["write-tree"], env);
    return `${tree}:${relative(top, cwd)}`;
  } catch {
    return undefined;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Environment variables that change what a gate's tools do (rule 33, GT-N3-1). */
const VERDICT_ENV = [
  "PATH",
  "NODE_OPTIONS",
  "NODE_ENV",
  "CI",
  "TZ",
  "LANG",
  "LC_ALL",
  "PYTHONPATH",
  "VIRTUAL_ENV",
  "CARGO_HOME",
  "RUSTFLAGS",
  "GOFLAGS",
];

/** Installed-dependency markers outside the tree hash (node_modules is ignored). */
const INSTALL_MARKERS = [
  "node_modules/.modules.yaml",
  "node_modules/.package-lock.json",
  "node_modules/.yarn-state.yml",
];

/** A file's identity as far as a version goes: size, change time and inode; undefined when absent. */
function fileStamp(path: string): string | undefined {
  try {
    const st = statSync(path);
    return `${st.size}:${st.mtimeMs}:${st.ino}`;
  } catch {
    return undefined;
  }
}

/** The program a command runs, resolved as the sandbox would: a path, else the first on PATH. */
function resolveCommand(command: string, cwd: string): string | undefined {
  if (command.includes("/")) return resolve(cwd, command);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (fileStamp(candidate)) return candidate;
  }
  return undefined;
}

/**
 * What the tree hash cannot see but a verdict depends on (rule 33,
 * GT-N3-1): the gate's program and the files its arguments name (their
 * versions, by stamp), the installed dependencies' markers, and the
 * environment that changes what the tools do.
 */
function toolchainKey(gate: GateDefinition, cwd: string, repoRoot: string | undefined): string {
  const program = resolveCommand(gate.command, cwd);
  const argFiles = gate.args
    .filter((a) => !a.startsWith("-") && (isAbsolute(a) || a.includes("/")))
    .map((a) => resolve(cwd, a));
  const roots = [...new Set([cwd, ...(repoRoot ? [repoRoot] : [])])];
  const key = {
    program: program ? [program, fileStamp(program)] : gate.command,
    args: argFiles.map((p) => [p, fileStamp(p)]),
    installed: roots.flatMap((r) => INSTALL_MARKERS.map((m) => fileStamp(join(r, m)) ?? "")),
    env: [
      ...VERDICT_ENV,
      ...(gate.needs ?? []).filter((n) => n.startsWith("env:")).map((n) => n.slice(4)),
    ].map((name) => [name, process.env[name] ?? null]),
  };
  return createHash("sha256").update(JSON.stringify(key)).digest("hex");
}

/** A gate's definition, as far as it decides the verdict (rule 33, GT-N3-1). */
function gateDefinitionHash(gate: GateDefinition): string {
  const def = {
    id: gate.id,
    rung: gate.rung,
    layer: gate.layer,
    command: gate.command,
    args: gate.args,
    parser: gate.parser,
    timeoutMs: gate.timeoutMs,
    needs: gate.needs ?? [],
  };
  return createHash("sha256").update(JSON.stringify(def)).digest("hex");
}

/** Static gates first, then by layer, each layer cheapest first (rule 33, GT-N3-3). */
const LAYER_ORDER: Record<GateLayer, number> = {
  static: 0,
  functional: 1,
  robustness: 2,
  security: 3,
  visual: 4,
  hygiene: 5,
};

/** The order gates run in: by layer, then by their timeout as the cost we know, then as declared. */
export function costOrder(gates: readonly GateDefinition[]): GateDefinition[] {
  return gates
    .map((g, i) => ({ g, i }))
    .sort(
      (a, b) =>
        LAYER_ORDER[a.g.layer] - LAYER_ORDER[b.g.layer] ||
        a.g.timeoutMs - b.g.timeoutMs ||
        a.i - b.i,
    )
    .map(({ g }) => g);
}

/** A repository-relative path in one spelling. */
function normPath(p: string, cwd: string): string {
  const rel = isAbsolute(p) ? relative(cwd, p) : p;
  return rel.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** A failing test's title as its failure names it: the first line without its location. */
function testTitle(f: GateFailure): string {
  return (f.errorExcerpt.split("\n")[0] ?? "").replace(/^\S+\s*/, "");
}

/** A failing test's identity across runs: its gate, file and name, without the line. */
function testIdentity(f: GateFailure): string | undefined {
  if (!f.location.file || f.location.file === "." || f.notRun) return undefined;
  const title = testTitle(f);
  // A file that failed to load is not one test: never quarantined.
  if (!title || title === "(the file failed)") return undefined;
  return `${f.gate}|${f.location.file}|${title}`;
}

/** Whether a JUnit case is this failing test, by its file and its full title. */
function isCaseOf(c: JUnitCase, f: GateFailure, cwd: string): boolean {
  if (c.fileLevel) return false;
  const file = normPath(f.location.file, cwd);
  const caseFile = normPath(c.file, cwd);
  const classFile = normPath(c.classname, cwd);
  return (caseFile === file || classFile === file) && c.name === testTitle(f);
}

/**
 * What a host provides to the gates that declare needs (rule 10): names it
 * declares (a service, a port, credentials), plus `env:NAME` when the
 * variable is set and `cmd:program` when the program is on its PATH.
 */
export interface HostCapabilities {
  provides?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
}

/** The needs a host cannot provide, in the order declared (GT-T1-7). */
export function missingNeeds(needs: readonly string[], host: HostCapabilities = {}): string[] {
  const provided = new Set(host.provides ?? []);
  const env = host.env ?? process.env;
  return needs.filter((need) => {
    if (provided.has(need)) return false;
    if (need.startsWith("env:")) return !env[need.slice(4)];
    if (need.startsWith("cmd:")) return !onPath(need.slice(4));
    return true;
  });
}

/**
 * The card-size gate (design: 3 files, 200 changed lines by default).
 *
 * A standalone function so the loop can run it on the measured diff at every
 * verification; the runner method delegates here.
 */
export function checkBounds(options: BoundsCheckOptions): BoundsCheckResult {
  const maxFiles = options.maxFiles ?? DEFAULT_PROJECT_CONFIG.maxFiles;
  const maxLines = options.maxLines ?? DEFAULT_PROJECT_CONFIG.maxDiffLines;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || !Number.isInteger(maxLines) || maxLines < 1) {
    throw new Error(
      `Bounds limits must be positive integers (files ${maxFiles}, lines ${maxLines})`,
    );
  }
  if (options.linesAdded < 0 || options.linesRemoved < 0) {
    throw new Error("Diff line counts cannot be negative");
  }
  const totalLines = options.linesAdded + options.linesRemoved;
  const minimalRepro = `git diff --numstat ${options.base ?? "main"}`;
  const location = { file: options.filesTouched[0] ?? "." };

  if (options.filesTouched.length > maxFiles) {
    return {
      passed: false,
      failure: {
        rung: "bounds",
        gate: "bounds",
        layer: "hygiene",
        exitCode: 1,
        errorExcerpt: `Exceeded file limit: touched ${options.filesTouched.length} files (limit: ${maxFiles}): ${options.filesTouched.join(", ")}`,
        suggestedFixFiles: options.filesTouched,
        location,
        expected: `at most ${maxFiles} files changed`,
        actual: `${options.filesTouched.length} files changed`,
        minimalRepro,
        suggestedAction: gateCopy.boundsFiles(
          String(options.filesTouched.length),
          String(maxFiles),
        ),
      },
    };
  }

  if (totalLines > maxLines) {
    return {
      passed: false,
      failure: {
        rung: "bounds",
        gate: "bounds",
        layer: "hygiene",
        exitCode: 1,
        errorExcerpt: `Exceeded LOC diff limit: ${totalLines} diff lines (limit: ${maxLines}) across ${options.filesTouched.length} files`,
        suggestedFixFiles: options.filesTouched,
        location,
        expected: `at most ${maxLines} diff lines`,
        actual: `${totalLines} diff lines`,
        minimalRepro,
        suggestedAction: gateCopy.boundsLines(String(totalLines), String(maxLines)),
      },
    };
  }

  return { passed: true };
}

/**
 * Parse `git diff --numstat` output into per-file line deltas. Binary files
 * ("-\t-\tpath") count as touched with zero lines.
 */
export function parseNumstat(text: string): { file: string; added: number; removed: number }[] {
  const out: { file: string; added: number; removed: number }[] = [];
  for (const line of text.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!m) continue;
    const [, add, del, rawFile] = m as unknown as [string, string, string, string];
    // Renames print as "old => new" or "dir/{old => new}"; count the new path.
    const file = rawFile.includes("=>")
      ? rawFile.replace(/\{[^}]*=> ([^}]*)\}/, "$1").replace(/^.* => /, "")
      : rawFile;
    out.push({
      file: file.replace(/\/\//g, "/"),
      added: add === "-" ? 0 : Number(add),
      removed: del === "-" ? 0 : Number(del),
    });
  }
  return out;
}

/** The layer a rung belongs to, for an outcome with no gate to say. */
const LAYER_OF_RUNG: Record<GateRung, GateLayer> = {
  parse: "static",
  typecheck: "static",
  lint: "static",
  test: "functional",
  bounds: "hygiene",
  hygiene: "hygiene",
  visual: "visual",
  security: "security",
  robustness: "robustness",
};

export class DeterministicGateRunner implements GateRunner {
  private config: GatesConfig | undefined;
  /** Defects found while completing parser output during the current run. */
  private defects: string[] = [];
  /** Verdicts by tree hash and gate definition, for this runner's card (GT-N3-1). */
  private readonly verdicts = new Map<string, { outcome: RungOutcome; failures: GateFailure[] }>();
  /** Flaky tests quarantined for this card, by identity, each on the tree it holds on (GT-N3-4). */
  private readonly quarantine = new Map<string, QuarantinedTest & { tree: string }>();
  /** Failing tests already re-run once on this card. */
  private readonly rerunOnce = new Set<string>();

  constructor(
    private sandbox: ProcessSandbox,
    private options: GateRunnerOptions = {},
  ) {}

  /**
   * Resolve the gate configuration, re-verifying its hash when one is pinned.
   *
   * Re-verification happens per run rather than once at load: a gates file that
   * can be edited mid-card turns verification into whatever the agent decides
   * it should be.
   */
  public resolveConfig(cwd: string): GatesConfig {
    const root = this.options.repoRoot ?? cwd;
    if (this.options.expectedConfigSha256) {
      return verifyGatesConfig(root, this.options.expectedConfigSha256);
    }
    if (!this.config) this.config = loadGatesConfig(root);
    return this.config;
  }

  public checkBounds(options: BoundsCheckOptions): BoundsCheckResult {
    return checkBounds(options);
  }

  /** Execute one declared gate and parse its output into typed failures. */
  public async runGate(
    gate: GateDefinition,
    cwd: string,
  ): Promise<{
    outcome: RungOutcome;
    failures: GateFailure[];
  }> {
    const start = performance.now();
    const minimalRepro = [gate.command, ...gate.args].join(" ");
    // A need the host cannot provide: the gate never starts, and it is
    // unavailable, naming what is missing (rule 10, GT-T1-7).
    const missing = missingNeeds(gate.needs ?? [], this.options.host);
    if (missing.length > 0) {
      const reason = `needs ${missing.join(", ")}, which this host does not provide`;
      return {
        outcome: {
          gate: gate.id,
          rung: gate.rung,
          layer: gate.layer,
          passed: false,
          exitCode: -1,
          durationMs: 0,
          unavailable: true,
          reason,
        },
        failures: [
          {
            rung: gate.rung,
            gate: gate.id,
            layer: gate.layer,
            exitCode: -1,
            errorExcerpt: `${gate.id} not run: ${reason}`,
            suggestedFixFiles: [],
            location: { file: "." },
            expected: `${gate.id} to run and exit 0`,
            actual: reason,
            minimalRepro,
            suggestedAction: gateCopy.gateNotRun(gate.id),
            notRun: true,
          },
        ],
      };
    }
    let result: Awaited<ReturnType<ProcessSandbox["execute"]>>;
    try {
      result = await this.sandbox.execute(gate.command, gate.args, {
        allowedPaths: [cwd],
        allowNetwork: false,
        timeoutMs: gate.timeoutMs,
        cwd,
      });
    } catch (err) {
      // Fail closed (rule 9): a gate that could not start is not a pass, and
      // it is never silently absent.
      const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
      return {
        outcome: {
          gate: gate.id,
          rung: gate.rung,
          layer: gate.layer,
          passed: false,
          exitCode: -1,
          durationMs: Math.round(performance.now() - start),
        },
        failures: [
          {
            rung: gate.rung,
            gate: gate.id,
            layer: gate.layer,
            exitCode: -1,
            errorExcerpt: `${gate.id} not run: ${reason}`,
            suggestedFixFiles: [],
            location: { file: "." },
            expected: `${gate.id} to run and exit 0`,
            actual: reason || "the gate could not start",
            minimalRepro,
            suggestedAction: gateCopy.gateNotRun(gate.id),
            notRun: true,
          },
        ],
      };
    }
    const durationMs = Math.round(performance.now() - start);
    // The sandbox says the program never started (a missing binary): not run,
    // never a failure the model is charged with (gates rule 9).
    if (result.notStarted) {
      const reason = (result.stderr.split("\n").find((l) => l.trim()) ?? "").trim();
      return {
        outcome: {
          gate: gate.id,
          rung: gate.rung,
          layer: gate.layer,
          passed: false,
          exitCode: result.exitCode,
          durationMs,
        },
        failures: [
          {
            rung: gate.rung,
            gate: gate.id,
            layer: gate.layer,
            exitCode: result.exitCode,
            errorExcerpt: `${gate.id} not run: ${reason || `${gate.command} did not start`}`,
            suggestedFixFiles: [],
            location: { file: "." },
            expected: `${gate.id} to run and exit 0`,
            actual: reason || `${gate.command} did not start`,
            minimalRepro,
            suggestedAction: gateCopy.gateNotRun(gate.id),
            notRun: true,
          },
        ],
      };
    }

    const outcome: RungOutcome = {
      gate: gate.id,
      rung: gate.rung,
      layer: gate.layer,
      passed: result.exitCode === 0,
      exitCode: result.exitCode,
      durationMs,
    };

    if (result.exitCode === 0) return { outcome, failures: [] };

    const ctx: ParseContext = {
      gate,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      minimalRepro,
      cwd,
    };

    // A parser that leaves a field empty is a harness defect: the gap is
    // filled and recorded, never thrown mid-turn.
    const failures = completeFailures(defaultParserRegistry.parse(ctx), (d) =>
      this.defects.push(`the ${gate.parser} parser: ${d}`),
    );
    if (result.timedOut) {
      for (const f of failures) {
        f.actual = `timed out after ${gate.timeoutMs}ms`;
      }
    }

    return { outcome, failures };
  }

  public async runCustomCommandGate(
    rung: GateRung,
    command: string,
    args: string[],
    cwd: string,
  ): Promise<GateResult> {
    const gate: GateDefinition = {
      id: rung,
      rung,
      layer: "functional",
      command,
      args,
      timeoutMs: 180_000,
      parser: "generic",
      blocking: true,
    };

    const start = performance.now();
    const { outcome, failures } = await this.runGate(gate, cwd);
    return {
      passed: failures.length === 0,
      failures,
      durationMs: Math.round(performance.now() - start),
      rungResults: [outcome],
    };
  }

  /**
   * One gate through the verdict cache (GT-N3-1), with the functional gate's
   * note (GT-N3-2) and flaky-test quarantine (GT-N3-4). A verdict is cached
   * only when the gate produced one: never a gate that could not run or
   * timed out.
   */
  private async runCached(
    gate: GateDefinition,
    cwd: string,
    tree: string | undefined,
  ): Promise<{ outcome: RungOutcome; failures: GateFailure[] }> {
    const key =
      tree && this.options.verdictCache !== false
        ? `${tree}|${gateDefinitionHash(gate)}|${toolchainKey(gate, cwd, this.options.repoRoot)}`
        : undefined;
    const hit = key ? this.verdicts.get(key) : undefined;
    if (hit) {
      return {
        outcome: { ...structuredClone(hit.outcome), cached: true },
        failures: structuredClone(hit.failures),
      };
    }
    let { outcome, failures } = await this.runGate(gate, cwd);
    if (gate.rung === "test") {
      // Until the source index exists, every functional run is the full suite (GT-N3-2).
      outcome = { ...outcome, note: IMPACTED_TESTS_NO_INDEX };
      ({ outcome, failures } = await this.quarantineFlaky(gate, cwd, outcome, failures, tree));
    }
    const verdict =
      !outcome.unavailable &&
      !outcome.skipped &&
      !failures.some((f) => f.notRun || /^timed out after/.test(f.actual));
    if (key && verdict) {
      this.verdicts.set(key, {
        outcome: structuredClone(outcome),
        failures: structuredClone(failures),
      });
    }
    return { outcome, failures };
  }

  /** The quarantine policy for this worktree: the card runner's, else this runner's, else closed. */
  private policyFor(cwd: string): QuarantinePolicy {
    return QUARANTINE_POLICIES.get(worktreeKey(cwd)) ?? this.options.quarantine ?? { open: false };
  }

  /**
   * The test files a quarantine never covers: the card's acceptance tests
   * and every file the card's diff changed or added. Undefined when the
   * diff cannot be read: then nothing is quarantined (fail closed).
   */
  private guardedFiles(cwd: string, policy: QuarantinePolicy): Set<string> | undefined {
    const guarded = new Set((policy.never ?? []).map((p) => normPath(p, cwd)));
    if (policy.base === undefined) return guarded;
    if (policy.base.startsWith("-")) return undefined;
    try {
      const git = (args: string[]) =>
        execFileSync("git", args, {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 60_000,
          env: gitEnvFor(cwd),
        });
      const top = git(["rev-parse", "--show-toplevel"]).trim();
      const changed = [
        ...git(["diff", "--name-only", "--no-renames", policy.base, "--"]).split("\n"),
        ...git(["ls-files", "--others", "--exclude-standard", "--full-name"]).split("\n"),
      ].filter(Boolean);
      for (const f of changed) guarded.add(normPath(relative(cwd, join(top, f)), cwd));
      return guarded;
    } catch {
      return undefined;
    }
  }

  /**
   * Re-run the failing tests' files alone and read each test's own result
   * from a JUnit report. Undefined — "not re-run" — when the runner has no
   * JUnit path, could not start, timed out, or wrote no readable report.
   */
  private async rerunWithEvidence(
    gate: GateDefinition,
    cwd: string,
    files: string[],
  ): Promise<{ cases: JUnitCase[]; shown: string } | undefined> {
    let dir: string | undefined;
    try {
      dir = mkdtempSync(join(cwd, ".sekhemet-rerun-"));
      const report = join(dir, "junit.xml");
      const cmd = acceptanceCommand(gate, files, report, false);
      if (!cmd) return undefined;
      const r = await this.sandbox.execute(cmd.command, cmd.args, {
        allowedPaths: [cwd],
        allowNetwork: false,
        timeoutMs: gate.timeoutMs,
        cwd,
      });
      if (r.notStarted || r.timedOut || !existsSync(report)) return undefined;
      return {
        cases: parseJUnit(readFileSync(report, "utf8")),
        shown: [cmd.command, ...cmd.args.filter((a) => !a.startsWith("--outputFile="))].join(" "),
      };
    } catch {
      return undefined;
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Rule 34: at the card's first verification, before the first repair rung,
   * a test that failed is re-run once on the unchanged tree; one whose own
   * result in the re-run is a pass is quarantined — its result recorded,
   * both runs attached, no longer blocking — until the tree changes. The
   * card's acceptance tests and tests its diff changed or added are never
   * quarantined, and a re-run with no per-test result is no evidence.
   */
  private async quarantineFlaky(
    gate: GateDefinition,
    cwd: string,
    outcome: RungOutcome,
    failures: GateFailure[],
    tree: string | undefined,
  ): Promise<{ outcome: RungOutcome; failures: GateFailure[] }> {
    // A quarantine holds only on the tree it was found on.
    const held = (f: GateFailure) => {
      const q = this.quarantine.get(testIdentity(f) ?? "");
      return q && tree !== undefined && q.tree === tree ? q : undefined;
    };
    const policy = this.policyFor(cwd);
    const couldJudge =
      failures.length > 0 && !failures.some((f) => f.notRun || /^timed out after/.test(f.actual));
    if (policy.open && tree !== undefined && couldJudge) {
      const guarded = this.guardedFiles(cwd, policy);
      const fresh = guarded
        ? failures.filter((f) => {
            const id = testIdentity(f);
            return (
              id !== undefined &&
              !held(f) &&
              !this.rerunOnce.has(id) &&
              !guarded.has(normPath(f.location.file, cwd))
            );
          })
        : [];
      if (fresh.length > 0) {
        const files = [...new Set(fresh.map((f) => f.location.file))];
        const again = await this.rerunWithEvidence(gate, cwd, files);
        for (const f of fresh) {
          const id = testIdentity(f) as string;
          this.rerunOnce.add(id);
          const passed = again?.cases.some((c) => isCaseOf(c, f, cwd) && c.status === "passed");
          if (!again || !passed) continue;
          const q = {
            test: `${f.location.file} > ${testTitle(f)}`,
            firstRun: f.errorExcerpt.slice(0, 1_000),
            rerun: `passed (its own JUnit result) when \`${again.shown}\` ran it again on the unchanged tree`,
            tree,
          };
          this.quarantine.set(id, q);
          const key = worktreeKey(cwd);
          QUARANTINE_RECORDS.set(key, [...(QUARANTINE_RECORDS.get(key) ?? []), { ...q }]);
        }
      }
    }
    const quarantined = failures
      .map(held)
      .filter((q): q is QuarantinedTest & { tree: string } => q !== undefined)
      .map((q) => ({ ...q }));
    if (quarantined.length === 0) return { outcome, failures };
    const kept = failures.filter((f) => !held(f));
    return {
      outcome: {
        ...outcome,
        quarantined,
        ...(kept.length === 0 ? { passed: true } : {}),
      },
      failures: kept,
    };
  }

  /**
   * Run the requested rungs and return the complete result set.
   *
   * Every gate runs by default rather than stopping at the first failure: the
   * Review surface needs the whole picture to assemble evidence, and an agent
   * repairing one rung at a time cannot see that two rungs share a root cause.
   */
  public async runGates(rungs: GateRung[], cwd: string): Promise<GateResult> {
    const start = performance.now();
    this.defects = [];
    const config = this.resolveConfig(cwd);

    const requested = new Set(rungs);
    const selected =
      rungs.length > 0
        ? config.gates.filter((g) => requested.has(g.rung))
        : config.gates.filter((g) => g.blocking);

    // A requested rung with no declared gate falls back to the built-in default.
    for (const rung of requested) {
      if (!selected.some((g) => g.rung === rung)) {
        const fallback = DEFAULT_GATES.find((g) => g.rung === rung);
        if (fallback) selected.push({ ...fallback });
      }
    }

    const failures: GateFailure[] = [];
    const rungResults: RungOutcome[] = [];

    // A requested rung with neither a declared gate nor a default is never
    // silently absent: the evidence records that it did not run, and how to
    // declare one.
    for (const rung of requested) {
      if (selected.some((g) => g.rung === rung)) continue;
      rungResults.push({
        gate: rung,
        rung,
        layer: LAYER_OF_RUNG[rung],
        passed: false,
        exitCode: -1,
        durationMs: 0,
        skipped: true,
        reason: `no gate is declared for the ${rung} rung: add a [[gate]] with rung = "${rung}" to .sekhemet/gates.toml`,
      });
    }

    // Rule 33: one hash of the tree the gates start from keys every verdict
    // (and bounds a quarantine, rule 34).
    const tree = worktreeTreeHash(cwd);
    const ordered = costOrder(selected);
    for (const [i, gate] of ordered.entries()) {
      const { outcome, failures: gateFailures } = await this.runCached(gate, cwd, tree);
      rungResults.push(outcome);
      failures.push(...gateFailures);

      if (!outcome.passed && gate.blocking && this.options.failFast) {
        // Remaining gates are recorded as skipped so the evidence is honest
        // about what was and was not measured.
        // In the order they would have run, each once.
        for (const skipped of ordered.slice(i + 1)) {
          rungResults.push({
            gate: skipped.id,
            rung: skipped.rung,
            layer: skipped.layer,
            passed: false,
            exitCode: -1,
            durationMs: 0,
            skipped: true,
          });
        }
        break;
      }
    }

    // A failure reported inside a protected test must not send the agent to
    // edit that test: it cannot (the permission engine denies it), so the
    // suggestion is a dead end that burns turns. Point it at the implementation.
    for (const failure of failures) {
      const onlyProtected =
        failure.suggestedFixFiles.length > 0 &&
        failure.suggestedFixFiles.every((f) =>
          config.project.protected.some((pattern) => matchesGlob(f, pattern)),
        );
      if (onlyProtected) {
        const where = failure.suggestedFixFiles.join(", ");
        failure.suggestedFixFiles = [];
        failure.suggestedAction = gateCopy.protectedTest(where);
      }
    }

    return {
      passed: failures.length === 0,
      // Hand back only the highest-leverage failures, in dependency order
      // (rule 20): fixing the first usually clears the rest.
      failures: rankFailures(failures, this.options.maxFailuresReported ?? FAILURES_SHOWN, cwd),
      ...(this.defects.length > 0 ? { defects: [...this.defects] } : {}),
      durationMs: Math.round(performance.now() - start),
      rungResults,
    };
  }
}

export { parseErrorToGateFailure };
