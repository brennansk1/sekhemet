import { git } from "./git.js";
import { type TaskSynthesisResult, TaskSynthesizer } from "./synthesis.js";
import type { CommandSpec, SyntheticTask, WorkspaceMode } from "./types.js";

/**
 * Task synthesis from the repository's own history (E2, E12; design
 * "Per-repo bake-off" and loop 6). Commits that change both tests and
 * source are fail-to-pass candidates: at the parent (C-1) the changed tests
 * must fail and at the commit (C0) they must pass. Each candidate is
 * validated by actually running the oracle in throwaway checkouts; only
 * candidates that hold the invariant become tasks. Problem statements are
 * the commit message with file paths scrubbed.
 */
export interface CommitCandidate {
  sha: string;
  subject: string;
  testFiles: string[];
  sourceFiles: string[];
}

const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:spec|test)\.[\w]+$/;
const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go)$/;

/** Walk `git log` for commits that touch tests and source together. */
export function mineCommitCandidates(
  repoPath: string,
  options: { maxCommits?: number; revision?: string } = {},
): CommitCandidate[] {
  const raw = git(
    [
      "log",
      "--no-merges",
      `--max-count=${options.maxCommits ?? 200}`,
      "--name-only",
      "--format=%x1e%H%x1f%s",
      options.revision ?? "HEAD",
    ],
    repoPath,
  );
  const out: CommitCandidate[] = [];
  for (const block of raw.split("\x1e")) {
    const [header, ...rest] = block.trim().split("\n");
    if (!header) continue;
    const [sha, subject] = header.split("\x1f");
    if (!sha) continue;
    const files = rest.map((f) => f.trim()).filter(Boolean);
    const testFiles = files.filter((f) => TEST_FILE.test(f));
    const sourceFiles = files.filter((f) => SOURCE_FILE.test(f) && !TEST_FILE.test(f));
    // A commit with no parent cannot have a C-1 state.
    if (testFiles.length > 0 && sourceFiles.length > 0) {
      out.push({ sha, subject: subject ?? "", testFiles, sourceFiles });
    }
  }
  // The root commit has no parent: drop it.
  const root = git(["rev-list", "--max-parents=0", options.revision ?? "HEAD"], repoPath).trim();
  return out.filter((c) => !root.split("\n").includes(c.sha));
}

export interface HistorySynthesisOptions {
  maxCommits?: number;
  /** Most tasks to keep. Default 30 (the M0 protocol's task count). */
  maxTasks?: number;
  /** A test file's oracle command. Default: `node <file>` for JS, else the template. */
  testCommandFor?: (testFile: string) => string;
  testCommand?: CommandSpec;
  setupCommands?: CommandSpec[];
  workspaceRoot?: string;
  workspaceMode?: WorkspaceMode;
  linkPaths?: string[];
  synthesizer?: TaskSynthesizer;
}

export interface HistorySynthesisResult {
  tasks: SyntheticTask[];
  rejected: { sha: string; subject: string; violations: string[] }[];
  scanned: number;
}

function defaultCommand(file: string): string {
  if (/\.(?:mjs|cjs|js)$/.test(file)) return `node ${file}`;
  if (/\.(?:ts|tsx)$/.test(file)) return `node --experimental-strip-types ${file}`;
  if (/\.py$/.test(file)) return `python3 -m pytest -q ${file}`;
  return file;
}

export async function synthesizeTasksFromHistory(
  repoPath: string,
  options: HistorySynthesisOptions = {},
): Promise<HistorySynthesisResult> {
  const candidates = mineCommitCandidates(repoPath, {
    ...(options.maxCommits ? { maxCommits: options.maxCommits } : {}),
  });
  const synthesizer = options.synthesizer ?? new TaskSynthesizer();
  const tasks: SyntheticTask[] = [];
  const rejected: HistorySynthesisResult["rejected"] = [];
  const toCommand = options.testCommandFor ?? defaultCommand;
  for (const c of candidates) {
    if (tasks.length >= (options.maxTasks ?? 30)) break;
    let result: TaskSynthesisResult;
    try {
      result = await synthesizer.synthesizeFromCommit({
        id: `hist_${c.sha.slice(0, 10)}`,
        repoPath,
        fixCommit: c.sha,
        failToPassTests: c.testFiles.map(toCommand),
        scopeFiles: c.sourceFiles,
        testFiles: c.testFiles,
        ...(options.testCommand ? { testCommand: options.testCommand } : {}),
        ...(options.setupCommands ? { setupCommands: options.setupCommands } : {}),
        ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
        ...(options.workspaceMode ? { workspaceMode: options.workspaceMode } : {}),
        ...(options.linkPaths ? { linkPaths: options.linkPaths } : {}),
      });
    } catch (err) {
      rejected.push({ sha: c.sha, subject: c.subject, violations: [String(err)] });
      continue;
    }
    if (result.task) tasks.push(result.task);
    else
      rejected.push({ sha: c.sha, subject: c.subject, violations: result.validation.violations });
  }
  return { tasks, rejected, scanned: candidates.length };
}
