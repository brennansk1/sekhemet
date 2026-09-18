import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { GitCommandError, git, isGitRepository, resolveCommitSha } from "./git.js";
import type { WorkspaceMode } from "./types.js";

const WORKSPACE_PREFIX = "sekhemet-eval";

export interface WorkspaceRequest {
  /** Source repository the workspace is cut from. */
  repoPath: string;
  /** Revision to check out. Resolved to a full sha before checkout. */
  commit: string;
  /** Short identifier folded into the directory name; sanitised. */
  label: string;
  /** Parent directory for the workspace. Defaults to the OS temp dir. */
  root?: string | undefined;
  mode?: WorkspaceMode | undefined;
  /** Paths relative to the source repo symlinked into the workspace. */
  linkPaths?: string[] | undefined;
  /** Leave the directory on disk when disposed. */
  keep?: boolean | undefined;
}

function sanitizeLabel(label: string): string {
  const cleaned = label.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48);
  return cleaned.length > 0 ? cleaned : "task";
}

/**
 * An isolated checkout of one commit, used for exactly one benchmark attempt.
 *
 * Isolation is the whole point: two attempts at the same task must not be able
 * to see each other's edits, or pass@k measures contamination rather than
 * sampling. `worktree` mode shares the source object store and is fast;
 * `clone` mode copies it and is used when the source repo will not admit
 * another worktree (bare repos, locked administrative state).
 */
export class EphemeralWorkspace {
  /** The checkout root handed to the executor as its worktree. */
  public readonly path: string;
  public readonly mode: WorkspaceMode;
  public readonly commitSha: string;

  private readonly container: string;
  private readonly sourceRepo: string;
  private readonly keep: boolean;
  private disposed = false;

  private constructor(params: {
    path: string;
    container: string;
    mode: WorkspaceMode;
    commitSha: string;
    sourceRepo: string;
    keep: boolean;
  }) {
    this.path = params.path;
    this.container = params.container;
    this.mode = params.mode;
    this.commitSha = params.commitSha;
    this.sourceRepo = params.sourceRepo;
    this.keep = params.keep;
  }

  public static create(request: WorkspaceRequest): EphemeralWorkspace {
    const sourceRepo = resolve(request.repoPath);
    if (!isGitRepository(sourceRepo)) {
      throw new Error(`Benchmark source is not a git repository: ${sourceRepo}`);
    }

    const commitSha = resolveCommitSha(sourceRepo, request.commit);

    const root = request.root ? resolve(request.root) : join(tmpdir(), WORKSPACE_PREFIX);
    mkdirSync(root, { recursive: true });

    // The container is created by mkdtemp; the checkout goes one level below it
    // because `git worktree add` refuses a path that already exists.
    const container = realpathSync(mkdtempSync(join(root, `${sanitizeLabel(request.label)}-`)));
    const path = join(container, "repo");

    const requested = request.mode ?? "worktree";
    let mode = requested;
    try {
      EphemeralWorkspace.checkout(requested, sourceRepo, path, commitSha);
    } catch (error) {
      if (requested !== "worktree" || !(error instanceof GitCommandError)) {
        rmSync(container, { recursive: true, force: true });
        throw error;
      }
      // A repo that will not admit another worktree still admits a clone.
      rmSync(path, { recursive: true, force: true });
      EphemeralWorkspace.checkout("clone", sourceRepo, path, commitSha);
      mode = "clone";
    }

    const workspace = new EphemeralWorkspace({
      path,
      container,
      mode,
      commitSha,
      sourceRepo,
      keep: request.keep ?? false,
    });

    try {
      workspace.link(request.linkPaths ?? []);
    } catch (error) {
      workspace.dispose();
      throw error;
    }

    return workspace;
  }

  private static checkout(
    mode: WorkspaceMode,
    sourceRepo: string,
    path: string,
    commitSha: string,
  ): void {
    if (mode === "worktree") {
      git(["worktree", "add", "--detach", "--quiet", path, commitSha], sourceRepo);
      return;
    }
    git(["clone", "--no-hardlinks", "--quiet", sourceRepo, path], sourceRepo);
    git(["checkout", "--detach", "--quiet", commitSha], path);
  }

  /**
   * Symlink heavyweight, commit-external directories into the checkout.
   *
   * A fresh checkout has no `node_modules`, so without this every attempt pays
   * a full dependency install before it can run a single test. The links are
   * read paths for subprocesses only — the executor's path confinement
   * resolves symlinks and refuses to write through them.
   */
  private link(paths: string[]): void {
    for (const relative of paths) {
      const source = join(this.sourceRepo, relative);
      const target = join(this.path, relative);
      if (!existsSync(source) || existsSync(target)) continue;
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(realpathSync(source), target);
    }
  }

  /** Remove the workspace and, in worktree mode, deregister it from the source repo. */
  public dispose(): void {
    if (this.disposed || this.keep) return;
    this.disposed = true;

    if (this.mode === "worktree") {
      try {
        git(["worktree", "remove", "--force", this.path], this.sourceRepo);
      } catch {
        // Already gone, or the source repo moved; the rmSync below still cleans up.
      }
    }

    rmSync(this.container, { recursive: true, force: true });

    if (this.mode === "worktree") {
      try {
        git(["worktree", "prune"], this.sourceRepo);
      } catch {
        // Pruning is best-effort bookkeeping on the source repo.
      }
    }
  }
}
