import {
  applyTestPatch,
  changedFiles,
  commitMessage,
  parentCommitSha,
  resolveCommitSha,
} from "./git.js";
import type { CommandSpec, SyntheticTask, VerificationSnapshot, WorkspaceMode } from "./types.js";
import { TestVerifier, preconditionViolations } from "./verifier.js";
import { EphemeralWorkspace } from "./workspace.js";

/** Path-shaped tokens, e.g. `packages/eval/src/benchmark.ts`. */
const PATH_TOKEN = /(?:[\w.@-]+\/)+[\w.-]+/g;
/**
 * Bare filenames, e.g. `benchmark.ts`.
 *
 * An extension allowlist rather than `\w+\.\w+`, which would also eat version
 * numbers and abbreviations out of the prose the statement is made of.
 */
const FILENAME_TOKEN =
  /\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|c|h|cpp|hpp|cs|swift|kt|sh|bash|sql|json|toml|yaml|yml|ini|cfg|conf|env|lock|md|txt|css|scss|html|xml|csv|proto|graphql|vue|svelte)\b/g;

const TEST_FILE_PATTERN = /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:spec|test)\.[\w]+$/;

/**
 * Remove file-path hints from a synthesized problem statement.
 *
 * A statement mined from a fixing commit otherwise names the exact files the
 * fix touched, which turns a localisation task into a transcription task and
 * inflates every pass rate measured against it.
 */
export function scrubFilePaths(text: string): string {
  return text.replace(PATH_TOKEN, "<path>").replace(FILENAME_TOKEN, "<file>");
}

export interface FailToPassCheckRequest {
  repoPath: string;
  /** The commit that fixed the issue — C₀. */
  fixCommit: string;
  /** Defaults to the first parent of `fixCommit` — C₋₁. */
  parentCommit?: string | undefined;
  failToPassTests: string[];
  passToPassTests?: string[] | undefined;
  testCommand?: CommandSpec | undefined;
  setupCommands?: CommandSpec[] | undefined;
  workspaceRoot?: string | undefined;
  workspaceMode?: WorkspaceMode | undefined;
  linkPaths?: string[] | undefined;
  keepWorkspaces?: boolean | undefined;
  /**
   * Test files to take from the fix commit into the parent checkout (the
   * test patch), for fix commits that add or change their own tests.
   */
  testFiles?: string[] | undefined;
}

export interface FailToPassValidation {
  /** True only when C₋₁ fails the oracle and C₀ passes it in full. */
  valid: boolean;
  parentCommit: string;
  fixCommit: string;
  /** Oracle state at C₋₁. */
  before?: VerificationSnapshot | undefined;
  /** Oracle state at C₀. */
  after?: VerificationSnapshot | undefined;
  violations: string[];
}

export interface TaskSynthesisRequest extends FailToPassCheckRequest {
  id: string;
  /** Defaults to the commit message with file paths scrubbed. */
  issueDescription?: string | undefined;
  /** Defaults to the non-test files the fixing commit touched. */
  scopeFiles?: string[] | undefined;
  stepBudget?: number | undefined;
}

export interface TaskSynthesisResult {
  /** Absent when the invariant does not hold: the task is discarded, not shipped. */
  task?: SyntheticTask | undefined;
  validation: FailToPassValidation;
}

/**
 * Mines and validates benchmark tasks from a repository's own history.
 *
 * The one invariant that makes a mined task admissible is fail-to-pass: the
 * test must genuinely fail at C₋₁ and genuinely pass at C₀. Without it a
 * "benchmark" is a pile of tasks of unknown solvability, and a model's score
 * against them means nothing.
 */
export class TaskSynthesizer {
  private readonly verifier: TestVerifier;

  constructor(verifier?: TestVerifier) {
    this.verifier = verifier ?? new TestVerifier();
  }

  /** Assert C₋₁ fails the fail-to-pass tests and C₀ passes everything. */
  public async validateFailToPass(request: FailToPassCheckRequest): Promise<FailToPassValidation> {
    const fixCommit = resolveCommitSha(request.repoPath, request.fixCommit);
    const parentCommit = request.parentCommit
      ? resolveCommitSha(request.repoPath, request.parentCommit)
      : parentCommitSha(request.repoPath, fixCommit);

    const validation: FailToPassValidation = {
      valid: false,
      parentCommit,
      fixCommit,
      violations: [],
    };

    if (request.failToPassTests.length === 0) {
      validation.violations.push("no fail-to-pass tests declared; the task has no oracle");
      return validation;
    }

    const before = await this.snapshotAt(request, parentCommit, "parent");
    validation.before = before;
    // At C₋₁ the bug is present: the fail-to-pass tests must fail, and every
    // pass-to-pass test must already pass.
    validation.violations.push(...preconditionViolations(before));

    const after = await this.snapshotAt(request, fixCommit, "fix");
    validation.after = after;
    for (const record of after.failToPass) {
      if (record.outcome !== "pass") {
        validation.violations.push(
          `fail-to-pass test does not pass at the fixing commit (exit ${record.exitCode}): ${record.test}`,
        );
      }
    }
    for (const record of after.passToPass) {
      if (record.outcome !== "pass") {
        validation.violations.push(
          `pass-to-pass test does not pass at the fixing commit (exit ${record.exitCode}): ${record.test}`,
        );
      }
    }

    validation.valid = validation.violations.length === 0;
    return validation;
  }

  /**
   * Build a task from a fixing commit, or discard it.
   *
   * The returned task is present only when the fail-to-pass invariant holds, so
   * a caller cannot accidentally benchmark against an unsolvable task.
   */
  public async synthesizeFromCommit(request: TaskSynthesisRequest): Promise<TaskSynthesisResult> {
    const validation = await this.validateFailToPass(request);
    if (!validation.valid) return { validation };

    const scopeFiles =
      request.scopeFiles ??
      changedFiles(request.repoPath, validation.fixCommit).filter(
        (file) => !TEST_FILE_PATTERN.test(file),
      );

    const issueDescription =
      request.issueDescription ??
      scrubFilePaths(commitMessage(request.repoPath, validation.fixCommit));

    const task: SyntheticTask = {
      id: request.id,
      repoPath: request.repoPath,
      repoCommit: validation.parentCommit,
      fixCommit: validation.fixCommit,
      issueDescription,
      failToPassTests: [...request.failToPassTests],
      passToPassTests: [...(request.passToPassTests ?? [])],
      scopeFiles,
      ...(request.testCommand !== undefined ? { testCommand: request.testCommand } : {}),
      ...(request.setupCommands !== undefined ? { setupCommands: request.setupCommands } : {}),
      ...(request.stepBudget !== undefined ? { stepBudget: request.stepBudget } : {}),
      ...(request.testFiles?.length
        ? { testPatch: { commit: validation.fixCommit, files: [...request.testFiles] } }
        : {}),
    };

    return { task, validation };
  }

  /** Provision a throwaway checkout at one commit and run the oracle against it. */
  private async snapshotAt(
    request: FailToPassCheckRequest,
    commit: string,
    label: string,
  ): Promise<VerificationSnapshot> {
    const workspace = EphemeralWorkspace.create({
      repoPath: request.repoPath,
      commit,
      label: `synth-${label}`,
      ...(request.workspaceRoot !== undefined ? { root: request.workspaceRoot } : {}),
      ...(request.workspaceMode !== undefined ? { mode: request.workspaceMode } : {}),
      ...(request.linkPaths !== undefined ? { linkPaths: request.linkPaths } : {}),
      ...(request.keepWorkspaces !== undefined ? { keep: request.keepWorkspaces } : {}),
    });

    try {
      if (request.testFiles?.length && label === "parent") {
        applyTestPatch(workspace.path, { commit: request.fixCommit, files: request.testFiles });
      }
      // Dependencies are installed in this task's own throwaway workspace
      // (MS-T8-12); a task whose install fails is discarded, not run bare.
      if (request.setupCommands && request.setupCommands.length > 0) {
        const setup = await this.verifier.runSetup(workspace.path, request.setupCommands);
        if (!setup.ok) {
          throw new Error(`dependency install failed at the ${label} commit: ${setup.failure}`);
        }
      }
      return await this.verifier.snapshot(workspace.path, {
        id: `synthesis-${label}`,
        repoCommit: commit,
        issueDescription: "",
        failToPassTests: request.failToPassTests,
        passToPassTests: request.passToPassTests ?? [],
        ...(request.testCommand !== undefined ? { testCommand: request.testCommand } : {}),
      });
    } finally {
      workspace.dispose();
    }
  }
}
