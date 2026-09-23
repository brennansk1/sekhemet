import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * Raised when a tool attempts to touch a path outside its worktree.
 *
 * This is a hard containment failure, not a recoverable tool error: it means an
 * agent tried to escape its sandbox. Callers surface it to the model as a denial
 * observation but never retry it silently.
 */
export class PathEscapeError extends Error {
  public readonly attemptedPath: string;
  public readonly worktreeRoot: string;

  constructor(attemptedPath: string, worktreeRoot: string, detail: string) {
    super(
      `Path confinement violation: "${attemptedPath}" resolves outside worktree "${worktreeRoot}" (${detail})`,
    );
    this.name = "PathEscapeError";
    this.attemptedPath = attemptedPath;
    this.worktreeRoot = worktreeRoot;
  }
}

/**
 * Resolve the realpath of `p`, walking up to the nearest ancestor that exists.
 *
 * Files an agent is about to create do not exist yet, so we cannot realpath them
 * directly. We resolve the deepest existing ancestor (collapsing any symlinks in
 * it) and re-append the non-existent tail. This closes the symlink-escape hole
 * where `link -> /etc` makes `link/passwd` look contained by string comparison.
 */
function realpathNearestExisting(p: string): string {
  let cursor = p;
  const tail: string[] = [];

  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      return p;
    }
    tail.unshift(basename(cursor));
    cursor = parent;
  }

  let real: string;
  try {
    real = realpathSync(cursor);
  } catch {
    real = cursor;
  }

  return tail.length > 0 ? join(real, ...tail) : real;
}

/** Realpath a worktree root once, so callers can reuse it across many resolutions. */
export function canonicalizeRoot(worktreeRoot: string): string {
  return realpathNearestExisting(resolve(worktreeRoot));
}

/**
 * Resolve `candidate` against `worktreeRoot`, guaranteeing the result stays inside it.
 *
 * Rejects NUL bytes, `../` traversal, and absolute paths that land outside the
 * root — including via symlinks. Absolute paths that genuinely resolve *inside*
 * the root are permitted, since tools legitimately echo back absolute paths.
 */
export function resolveInWorktree(worktreeRoot: string, candidate: string): string {
  if (candidate.includes("\0")) {
    throw new PathEscapeError(candidate, worktreeRoot, "path contains a NUL byte");
  }

  const root = canonicalizeRoot(worktreeRoot);
  const joined = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const resolved = realpathNearestExisting(joined);

  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new PathEscapeError(candidate, root, `escapes to ${resolved}`);
  }
  // Git metadata is never the tools' to touch, however it is reached: the
  // harness runs git outside the sandbox in this worktree, so a write into
  // `.git` — directly, nested (`sub/.git`), in another case (`.GIT` on a
  // case-insensitive disk) or through a symlink, which `resolved` already
  // followed — could aim that git at configuration the Worker controls
  // (security findings S1/G1/G2, 2026-09-22).
  const inside = resolved === root ? "" : resolved.slice(root.length + 1);
  if (inside.split(sep).some((segment) => segment.toLowerCase() === ".git")) {
    throw new PathEscapeError(candidate, root, "resolves into git metadata");
  }

  return resolved;
}

/** True when `candidate` is safely inside the worktree. Never throws. */
export function isInsideWorktree(worktreeRoot: string, candidate: string): boolean {
  try {
    resolveInWorktree(worktreeRoot, candidate);
    return true;
  } catch {
    return false;
  }
}
