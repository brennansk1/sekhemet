import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { GITIGNORE_BLOCK } from "./init.js";
import { atLoginPath, defaultRunner, readAtLogin } from "./login_service.js";
import { SEARXNG_CONTAINER } from "./research/searxng.js";
import { userDir, userPaths } from "./user_dir.js";
import { readWorkspaces } from "./workspaces.js";

/**
 * What an install wrote outside its package (surface item 33,
 * NEW-surface-7, SUR-58; DESIGN_GAPS_C1 b8, FINDINGS_C1 INS-03): the user
 * directory, the Crawl4AI environment, the link `scripts/install.sh` makes,
 * each recorded workspace's and project's `.sekhemet/` with its card
 * worktrees, the start-at-login units, the keychain items of the
 * integrations' settings (by account, never by value), and the SearXNG
 * container when research started one. Read only: nothing is changed here.
 *
 * A project's ledger (`events.db` and its WAL, blobs, evidence and the
 * pre-migration backups beside it) and the backup sets in the user directory
 * are marked `ledger`: `uninstall --yes` keeps them unless `--include-ledgers`.
 * A `.sekhemet/` entry the repository owns — one its git tracks, or one of
 * the team's shared files init's `.gitignore` block brings back into git —
 * is never removed, with or without `--include-ledgers` (`keep`).
 */

export type InventoryKind = "path" | "unit" | "keychain" | "container";

export interface InventoryItem {
  kind: InventoryKind;
  /** A path, a keychain item's `service / account`, or a container's name. */
  name: string;
  /** What it is, in words. */
  what: string;
  /** Bytes on disk, for a path. */
  bytes?: number;
  /** Kept unless `--include-ledgers` (SUR-59). */
  ledger?: boolean;
  /** For a path: entries of it that are listed (and kept) separately. */
  except?: string[];
  /** For a path: entries of it that are the repository's own, never removed. */
  keep?: string[];
  /** For a start-at-login unit: the workspace folder it serves. */
  folder?: string;
}

/** The entries of a `.sekhemet/` folder that are the project's record (SUR-59). */
export const LEDGER_ENTRIES = (name: string): boolean =>
  name.startsWith("events.db") || ["blobs", "evidence", "backups"].includes(name);

/**
 * The team's shared files under `.sekhemet/`, as init's `.gitignore` block
 * names them (`!.sekhemet/config.toml`, `!.sekhemet/skills/`, ...).
 */
export const SHARED_ENTRIES: readonly string[] = GITIGNORE_BLOCK.filter((l) =>
  l.startsWith("!.sekhemet/"),
).map((l) => l.slice("!.sekhemet/".length).replace(/\/$/, ""));

/**
 * The entries of `<root>/.sekhemet/` the repository owns: each shared file
 * present, and every entry holding a file its git tracks (real git; none
 * outside a repository).
 */
export function repositoryEntries(root: string): string[] {
  const dot = join(root, ".sekhemet");
  const own = new Set(SHARED_ENTRIES.filter((n) => existsSync(join(dot, n))));
  const listed = defaultRunner("git", ["-C", root, "ls-files", "-z", "--", ".sekhemet"]);
  if (listed.status === 0)
    for (const f of listed.stdout.split("\0")) {
      const entry = f.split("/")[1];
      if (f.startsWith(".sekhemet/") && entry && existsSync(join(dot, entry))) own.add(entry);
    }
  return [...own].sort();
}

/** Bytes under a path, symlinks not followed; 0 when it is gone. */
export function sizeOf(path: string): number {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  let names: string[] = [];
  try {
    names = readdirSync(path);
  } catch {
    return total;
  }
  for (const n of names) total += sizeOf(join(path, n));
  return total;
}

export interface InventoryOptions {
  userDir?: string;
  home?: string;
  workspacesPath?: string;
  atLoginPath?: string;
}

/** The folders whose `.sekhemet/` this install wrote: each recorded workspace and project. */
export function recordedRoots(opts: InventoryOptions = {}): string[] {
  const roots = new Set<string>();
  const list = readWorkspaces(opts.workspacesPath ?? userPaths().workspaces);
  for (const w of list) {
    if (w.folder) roots.add(resolve(w.folder));
    for (const r of w.projectRoots ?? []) roots.add(resolve(r));
  }
  for (const r of readAtLogin(opts.atLoginPath ?? atLoginPath())) roots.add(resolve(r.folder));
  return [...roots].filter((r) => existsSync(join(r, ".sekhemet")));
}

/** The keychain accounts the integrations' settings name (security item 35). */
function keychainAccounts(dir: string): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(join(dir, "repos")).filter((n) => n.endsWith(".json"));
  } catch {
    return out;
  }
  for (const n of names) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, "repos", n), "utf8")) as {
        keychain?: unknown;
      };
      if (Array.isArray(parsed.keychain))
        for (const a of parsed.keychain) if (typeof a === "string") out.push(a);
    } catch {
      // An unreadable settings file names no item.
    }
  }
  return out;
}

/** Whether `~/.local/bin/sekhemet` is the link `scripts/install.sh` makes. */
function installLink(home: string): string | undefined {
  const link = join(home, ".local", "bin", "sekhemet");
  try {
    if (!lstatSync(link).isSymbolicLink()) return undefined;
    return readlinkSync(link).endsWith(join("apps", "harness", "dist", "index.js"))
      ? link
      : undefined;
  } catch {
    return undefined;
  }
}

export function installInventory(opts: InventoryOptions = {}): InventoryItem[] {
  const dir = opts.userDir ?? userDir();
  const home = opts.home ?? homedir();
  const items: InventoryItem[] = [];
  if (existsSync(dir)) {
    const backups = join(dir, "backups");
    // DEC-60: the machine's own ledger is a ledger, kept unless --include-ledgers.
    const machine = join(dir, "machine");
    items.push({
      kind: "path",
      name: dir,
      what: "the user directory: configuration, model registry and downloaded models, trust records, credentials, logs",
      bytes: sizeOf(dir) - sizeOf(backups) - sizeOf(machine),
      except: [backups, machine].filter((p) => existsSync(p)).map((p) => p.slice(dir.length + 1)),
    });
    if (existsSync(machine))
      items.push({
        kind: "path",
        name: machine,
        what: "the machine's own ledger: what was downloaded outside any project",
        bytes: sizeOf(machine),
        ledger: true,
      });
    if (existsSync(backups))
      items.push({
        kind: "path",
        name: backups,
        what: "the backup sets of every workspace",
        bytes: sizeOf(backups),
        ledger: true,
      });
  }
  const crawl = join(home, ".local", "share", "sekhemet");
  if (existsSync(crawl))
    items.push({
      kind: "path",
      name: crawl,
      what: "the Crawl4AI environment research reads pages with",
      bytes: sizeOf(crawl),
    });
  const link = installLink(home);
  if (link)
    items.push({ kind: "path", name: link, what: "the link scripts/install.sh made", bytes: 0 });
  for (const r of readAtLogin(opts.atLoginPath ?? join(dir, "at-login.json")))
    if (existsSync(r.unit))
      items.push({
        kind: "unit",
        name: r.unit,
        what: `starts ${r.folder}'s dashboard at login`,
        bytes: sizeOf(r.unit),
        folder: r.folder,
      });
  const roots = recordedRoots({
    workspacesPath: opts.workspacesPath ?? join(dir, "workspaces.json"),
    atLoginPath: opts.atLoginPath ?? join(dir, "at-login.json"),
  });
  for (const root of roots) {
    const dot = join(root, ".sekhemet");
    const names = readdirSync(dot);
    const own = repositoryEntries(root);
    const kept = names.filter((n) => LEDGER_ENTRIES(n) && !own.includes(n));
    const keptBytes = kept.reduce((n, k) => n + sizeOf(join(dot, k)), 0);
    const ownBytes = own.reduce((n, k) => n + sizeOf(join(dot, k)), 0);
    const worktrees = existsSync(join(dot, "worktrees"))
      ? readdirSync(join(dot, "worktrees")).length
      : 0;
    items.push({
      kind: "path",
      name: dot,
      what: `${root}'s Sekhemet folder${worktrees ? `, with ${worktrees} card worktree${worktrees === 1 ? "" : "s"}` : ""}`,
      bytes: sizeOf(dot) - keptBytes - ownBytes,
      except: kept,
      ...(own.length ? { keep: own } : {}),
    });
    if (kept.length)
      items.push({
        kind: "path",
        name: dot,
        what: `${root}'s ledger: ${kept.join(", ")}`,
        bytes: keptBytes,
        ledger: true,
        ...(own.length ? { keep: own } : {}),
      });
  }
  for (const account of keychainAccounts(dir))
    items.push({
      kind: "keychain",
      name: `sekhemet / ${account}`,
      what: "an integration's secret",
    });
  if (existsSync(join(dir, "searxng")))
    items.push({
      kind: "container",
      name: SEARXNG_CONTAINER,
      what: "the SearXNG search container research started",
    });
  return items;
}
