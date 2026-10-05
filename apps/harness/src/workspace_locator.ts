import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type CardStore, type EventLog, type ProjectRecord, workspaceIdOf } from "@sekhemet/kernel";

/**
 * Which workspace a folder belongs to (kernel rule 38a, surface item 8a,
 * NEW-surface-11; DEC-57). A server is a workspace of many projects with one
 * ledger, the `.sekhemet/events.db` of the workspace folder. Every project
 * root that does not hold the ledger holds a **locator**,
 * `.sekhemet/workspace.json` (the workspace folder and id). The locator is
 * derived, never state: it is trusted only once the ledger it names
 * registers that root, and `sekhemet doctor` rewrites it from the ledger.
 */

export const LOCATOR_PATH = join(".sekhemet", "workspace.json");

export interface Locator {
  workspaceFolder: string;
  workspaceId: string;
}

/** A folder's real path, or the path as given when it does not exist. */
export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export const ledgerPathOf = (folder: string): string => join(folder, ".sekhemet", "events.db");

/** Whether the folder holds a workspace's ledger. */
export function holdsLedger(folder: string): boolean {
  return existsSync(ledgerPathOf(folder));
}

/** The locator in a project root, or undefined when there is none or it is unreadable. */
export function readLocator(root: string): Locator | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(root, LOCATOR_PATH), "utf8")) as Partial<Locator>;
    return typeof parsed.workspaceFolder === "string" && typeof parsed.workspaceId === "string"
      ? { workspaceFolder: parsed.workspaceFolder, workspaceId: parsed.workspaceId }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write the locator in a project root (SUR-78), unless that root holds the
 * ledger itself. True when the file changed.
 */
export function writeLocator(root: string, locator: Locator): boolean {
  if (realPath(root) === realPath(locator.workspaceFolder)) return false;
  const have = readLocator(root);
  if (
    have &&
    have.workspaceId === locator.workspaceId &&
    realPath(have.workspaceFolder) === realPath(locator.workspaceFolder)
  ) {
    return false;
  }
  mkdirSync(join(root, ".sekhemet"), { recursive: true });
  writeFileSync(
    join(root, LOCATOR_PATH),
    `${JSON.stringify({ workspaceFolder: realPath(locator.workspaceFolder), workspaceId: locator.workspaceId }, null, 2)}\n`,
  );
  return true;
}

/** Remove a project root's locator (a project moved away from it, K-N12-7). */
export function removeLocator(root: string): void {
  rmSync(join(root, LOCATOR_PATH), { force: true });
}

/**
 * Where a project root's workspace state lives — the ledger, blobs,
 * evidence, transcripts, live files, locks and logs (kernel rule 38a,
 * runtime item 2): the folder itself when it holds the ledger, else the
 * workspace folder its locator names when that folder holds one, else the
 * folder itself (a first run, or a workspace from before DEC-57).
 */
export function workspaceFolderOf(repoPath: string): string {
  if (holdsLedger(repoPath)) return repoPath;
  const locator = readLocator(repoPath);
  if (locator && holdsLedger(locator.workspaceFolder)) return locator.workspaceFolder;
  return repoPath;
}

/** Whether `child` is `parent` or lies inside it. */
export function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

export type WorkspaceResolution =
  | {
      kind: "workspace";
      workspaceFolder: string;
      /** The project whose root holds the folder, when one does. */
      project?: { id: string; name: string; rootPath: string };
      via: "ledger" | "locator";
    }
  | { kind: "first-run"; folder: string }
  | { kind: "refused"; message: string };

/** The projects a ledger registers, read without writing. */
export function ledgerFacts(workspaceFolder: string): {
  workspaceId: string | undefined;
  projects: { id: string; name: string; rootPath: string }[];
} {
  const db = new DatabaseSync(ledgerPathOf(workspaceFolder), { readOnly: true });
  try {
    const projects = (() => {
      try {
        return db
          .prepare(
            "SELECT id, name, root_path AS rootPath FROM projects ORDER BY created_at, rowid",
          )
          .all() as unknown as { id: string; name: string; rootPath: string }[];
      } catch {
        return [];
      }
    })();
    // C-18: read without an EventLog, so a ledger not yet migrated is found too.
    return { workspaceId: workspaceIdOf(db), projects };
  } finally {
    db.close();
  }
}

/** The project whose root holds `folder` (the deepest one), if any. */
function projectHolding(
  projects: { id: string; name: string; rootPath: string }[],
  folder: string,
): { id: string; name: string; rootPath: string } | undefined {
  return projects
    .filter((p) => within(folder, realPath(p.rootPath)))
    .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
}

const LOCATOR_FIXES =
  "Run `sekhemet doctor` in the workspace folder to rewrite every project's locator from its Activity log; `sekhemet project move <id> <path>` there if this repository was moved; or restore the workspace from its backup.";

/**
 * Find the workspace a command run in `folder` acts on (surface item 8a,
 * SUR-73, SUR-80): the folder, or its nearest ancestor, holding a ledger;
 * else a locator whose ledger registers that root; else a first run. The
 * search stops at the enclosing git repository's root, so a repository
 * nested inside another workspace's folder is never taken for part of it.
 * The machine's list of workspaces is never read here (RUN-86).
 */
export function resolveWorkspace(folder: string): WorkspaceResolution {
  const start = realPath(folder);
  let dir = start;
  for (;;) {
    if (holdsLedger(dir)) {
      const { projects } = ledgerFacts(dir);
      const project = projectHolding(projects, start);
      return {
        kind: "workspace",
        workspaceFolder: dir,
        via: "ledger",
        ...(project ? { project } : {}),
      };
    }
    const locator = readLocator(dir);
    if (locator) return checkLocator(dir, locator);
    if (existsSync(join(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { kind: "first-run", folder: start };
}

/** SUR-73, SUR-80: a locator holds only when its ledger registers its root. */
function checkLocator(root: string, locator: Locator): WorkspaceResolution {
  const ws = realPath(locator.workspaceFolder);
  if (!holdsLedger(ws)) {
    return {
      kind: "refused",
      message: `${root} names the workspace folder ${locator.workspaceFolder}, which holds no Sekhemet workspace. ${LOCATOR_FIXES}`,
    };
  }
  const facts = ledgerFacts(ws);
  if (facts.workspaceId !== locator.workspaceId) {
    return {
      kind: "refused",
      message: `${root} names the workspace ${locator.workspaceId}, but the Activity log in ${ws} is the workspace's ${facts.workspaceId ?? "with no events yet"}. ${LOCATOR_FIXES}`,
    };
  }
  const project = facts.projects.find((p) => realPath(p.rootPath) === root);
  if (!project) {
    return {
      kind: "refused",
      message: `The workspace in ${ws} has no project whose folder is ${root}. ${LOCATOR_FIXES}`,
    };
  }
  return { kind: "workspace", workspaceFolder: ws, via: "locator", project };
}

/**
 * Register a project of this workspace (TEAM-54, TEAM-56, K-N12-6): record it
 * on the ledger, refused when its root nests with another's, then write its
 * locator (SUR-78). The workspace folder's own project needs none.
 */
export async function registerProject(
  cardStore: CardStore,
  log: EventLog,
  workspaceFolder: string,
  input: {
    rootPath: string;
    name: string;
    via?: "new_folder" | "adopted";
    principal?: string;
  },
): Promise<ProjectRecord> {
  const project = await cardStore.ensureProject(input);
  const workspaceId = log.workspaceId();
  if (workspaceId) writeLocator(project.rootPath, { workspaceFolder, workspaceId });
  return project;
}

/**
 * `sekhemet doctor` in the workspace folder (SUR-78): rewrite every project's
 * missing or disagreeing locator from the ledger. Returns one line per
 * locator written.
 */
export function rewriteLocators(
  workspaceFolder: string,
  projects: readonly Pick<ProjectRecord, "id" | "name" | "rootPath">[],
  workspaceId: string | undefined,
): string[] {
  if (!workspaceId) return [];
  const lines: string[] = [];
  for (const p of projects) {
    if (realPath(p.rootPath) === realPath(workspaceFolder)) continue;
    if (!existsSync(p.rootPath)) {
      lines.push(
        `${p.name}: its folder ${p.rootPath} is missing; run \`sekhemet project move ${p.id} <path>\` once you know where it went.`,
      );
      continue;
    }
    if (writeLocator(p.rootPath, { workspaceFolder, workspaceId })) {
      lines.push(`${p.name}: wrote its locator in ${p.rootPath}.`);
    }
  }
  return lines;
}
