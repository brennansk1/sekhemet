import { existsSync, readdirSync, realpathSync } from "node:fs";
import { platform } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import type { SandboxOptions } from "./types.js";

/**
 * Security item 10a, NEW-security-13 (DEC-57): a card sees only its own
 * project. A server hosts many projects, and a person's level can be
 * overridden per project, so a card's command, gate and background process
 * may neither read nor write three sets of paths, named one by one and never
 * the whole `.sekhemet/` folder — a card's own worktree lives inside one:
 *
 * - (a) the workspace's state beside its ledger: every database there with
 *   its WAL and SHM files, the blob, evidence, transcript, observation, live,
 *   log, run, process and backup folders, the locks and `daemon.json`;
 * - (b) every other card's worktree, in any project's root;
 * - (c) every other project's root.
 *
 * The card's own worktree stays its granted root. Every engine reads the
 * same list (`SandboxOptions.denyPaths`), so Seatbelt, bubblewrap and srt
 * cannot drift.
 */

/** Item 10a (a): the workspace's state beside its ledger, by name. */
export const WORKSPACE_STATE_NAMES = [
  "blobs",
  "evidence",
  "transcripts",
  "observations",
  "live",
  "logs",
  "runs",
  "processes",
  "backups",
  "slots",
  "runner.lock",
  "admit.lock",
  "sekhemet-accept.lock",
  "daemon.json",
  "daemon.log",
  "queue_report.json",
  "traces.db",
] as const;

export interface ProjectIsolation {
  /** The folder whose `.sekhemet/events.db` is the workspace's ledger. */
  workspaceFolder: string;
  /** Every project root of the workspace, the card's own included. */
  projectRoots: readonly string[];
  /** The card's own project's root. */
  ownRoot: string;
  /** The card's own worktree: never denied. */
  ownWorktree: string;
}

/** The real path, or for a path not made yet its nearest existing ancestor's real path and the rest. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), basename(path));
  }
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** The paths item 10a denies a card, at its start (real paths). */
export function projectIsolationDenies(p: ProjectIsolation): string[] {
  const ws = real(p.workspaceFolder);
  const ownRoot = real(p.ownRoot);
  const own = real(p.ownWorktree);
  const out = new Set<string>();
  // (a) The workspace's state, wherever the workspace folder lies.
  const state = join(ws, ".sekhemet");
  for (const name of WORKSPACE_STATE_NAMES) out.add(join(state, name));
  if (existsSync(state)) {
    try {
      for (const f of readdirSync(state)) {
        if (/\.db(-wal|-shm|-journal)?$/i.test(f)) out.add(join(state, f));
      }
    } catch {
      // Unreadable: nothing to list.
    }
  }
  // A database created after the card started is still covered on macOS.
  if (platform() === "darwin") out.add(join(state, "*.db*"));
  // (b) Every other card's worktree, in every project's root.
  const roots = [...new Set([...p.projectRoots.map(real), ws])];
  for (const root of roots) {
    const dir = join(root, ".sekhemet", "worktrees");
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        const wt = join(dir, name);
        if (wt !== own) out.add(wt);
      }
    } catch {
      // Unreadable: nothing to list.
    }
  }
  // (c) Every other project's root (the workspace folder, when it is one).
  for (const root of new Set(p.projectRoots.map(real))) {
    if (root !== ownRoot) out.add(root);
  }
  // The card's own worktree is never inside a denied path (roots never nest,
  // TEAM-60); a path that would hide it is dropped rather than break the card.
  return [...out].filter((d) => d.includes("*") || !within(own, d));
}

/** The isolation of each running card, by its worktree's real path. */
const registered = new Map<string, readonly string[]>();

/**
 * Item 10a at a card's start: every confined command whose working
 * directory or granted root lies in this worktree gets these denies. Returns
 * the release, called when the card's run ends.
 */
export function registerCardIsolation(worktree: string, denies: readonly string[]): () => void {
  const key = real(worktree);
  registered.set(key, [...denies]);
  return () => {
    if (registered.get(key) !== undefined) registered.delete(key);
  };
}

/** The options with the denies of the card whose worktree they run in. */
export function withCardIsolation(options: SandboxOptions): SandboxOptions {
  if (registered.size === 0) return options;
  const places = [options.cwd, ...options.allowedPaths].map(real);
  const extra = new Set<string>(options.denyPaths ?? []);
  for (const [worktree, denies] of registered) {
    if (places.some((p) => within(p, worktree))) for (const d of denies) extra.add(d);
  }
  return extra.size === (options.denyPaths?.length ?? 0)
    ? options
    : { ...options, denyPaths: [...extra] };
}
