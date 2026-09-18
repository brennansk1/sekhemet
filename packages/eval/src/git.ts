import { execFileSync } from "node:child_process";

/**
 * Raised when a git invocation exits non-zero.
 *
 * The stderr is carried verbatim: a benchmark that silently swallowed "unknown
 * revision" would report a model failure for what is actually a broken fixture.
 */
export class GitCommandError extends Error {
  public readonly argv: string[];
  public readonly cwd: string;
  public readonly output: string;

  constructor(argv: string[], cwd: string, output: string) {
    super(`git ${argv.join(" ")} failed in ${cwd}: ${output.trim() || "(no output)"}`);
    this.name = "GitCommandError";
    this.argv = argv;
    this.cwd = cwd;
    this.output = output;
  }
}

interface ExecError {
  stderr?: string | Buffer | undefined;
  stdout?: string | Buffer | undefined;
  message?: string | undefined;
}

function decode(value: string | Buffer | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}

/**
 * Run git and return trimmed stdout.
 *
 * Arguments are passed as an argv array rather than interpolated into a shell
 * string, so a path containing a space or a quote cannot alter the command.
 */
export function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const err = error as ExecError;
    const output = `${decode(err.stderr)}${decode(err.stdout)}` || (err.message ?? "");
    throw new GitCommandError(args, cwd, output);
  }
}

/** True when `path` sits inside a git working tree. */
export function isGitRepository(path: string): boolean {
  try {
    return git(["rev-parse", "--is-inside-work-tree"], path) === "true";
  } catch {
    return false;
  }
}

/** Resolve any revision expression to a full commit sha. */
export function resolveCommitSha(repoPath: string, revision: string): string {
  return git(["rev-parse", "--verify", `${revision}^{commit}`], repoPath);
}

/** Resolve the first parent of `revision` — C₋₁ for a fixing commit C₀. */
export function parentCommitSha(repoPath: string, revision: string): string {
  return resolveCommitSha(repoPath, `${revision}^`);
}

export function headSha(repoPath: string): string {
  return git(["rev-parse", "HEAD"], repoPath);
}

/** True when tracked files are modified or untracked files are present. */
export function isWorkingTreeDirty(repoPath: string): boolean {
  return git(["status", "--porcelain"], repoPath).length > 0;
}

/** Files changed by `revision` relative to its first parent. */
export function changedFiles(repoPath: string, revision: string): string[] {
  const output = git(
    ["diff-tree", "--no-commit-id", "--name-only", "-r", "-m", revision],
    repoPath,
  );
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The full commit message (subject and body) of `revision`. */
export function commitMessage(repoPath: string, revision: string): string {
  return git(["log", "-1", "--format=%B", revision], repoPath).trim();
}
