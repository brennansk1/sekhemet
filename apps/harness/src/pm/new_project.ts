import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CardStore, EventLog, ProjectRecord } from "@sekhemet/kernel";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { effectiveConfig } from "../config_apply.js";
import { writeGitignoreBlock } from "../init.js";
import {
  holdsLedger,
  ledgerPathOf,
  readLocator,
  realPath,
  registerProject,
  within,
} from "../workspace_locator.js";
import { NEW_FOLDER_REFUSAL } from "./pm_copy.js";

/**
 * New project in a workspace of many (teams item 5, NEW-teams-14; design-stage
 * §2.11 item 6, NEW-design-stage-8; DEC-57). A server is a workspace of many
 * projects, so New project, in a workspace that already holds one, creates a
 * new folder under the workspace's projects folder, runs `git init` there and
 * records the project — only once its plan is approved (TEAM-54, DS-N8-1).
 * A folder that already holds a project, here or in another workspace on
 * this machine, is refused with its name (TEAM-55); one inside a project's
 * root, or containing one, is refused (TEAM-60); one holding code is offered
 * the take-over instead.
 */

/** `~` and a path relative to the workspace folder, made absolute. */
export function absolute(workspaceFolder: string, path: string): string {
  const home = process.env.HOME ?? "";
  const expanded = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(workspaceFolder, expanded);
}

/**
 * `[workspace] projects_dir` (teams §3): the folder New project creates
 * projects in. By default `<workspace folder>/projects` when the workspace
 * folder holds no project, else the workspace folder's parent directory.
 */
export function projectsDirOf(workspaceFolder: string, cardStore: CardStore): string {
  const configured = effectiveConfig(workspaceFolder).config.workspace.projectsDir.trim();
  if (configured) return absolute(workspaceFolder, configured);
  const ws = realPath(workspaceFolder);
  const own = cardStore.listProjects().some((p) => realPath(p.rootPath) === ws);
  return own ? dirname(ws) : join(ws, "projects");
}

/** A folder name from a project's name: lower case, words joined by hyphens. */
export function folderNameOf(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "project";
}

/** The folder a new project's approval creates: `<projects dir>/<name>`, made unique. */
export function suggestedFolder(
  workspaceFolder: string,
  cardStore: CardStore,
  name: string,
): string {
  const dir = projectsDirOf(workspaceFolder, cardStore);
  const base = folderNameOf(name);
  for (let n = 1; ; n++) {
    const candidate = join(dir, n === 1 ? base : `${base}-${n}`);
    if (!existsSync(candidate) && checkNewFolder(workspaceFolder, cardStore, candidate).ok) {
      return candidate;
    }
    if (n > 99) return candidate;
  }
}

export type FolderVerdict =
  | { ok: true; folder: string }
  | {
      ok: false;
      folder: string;
      kind: "has_project" | "nested" | "has_code" | "not_a_folder";
      reason: string;
      /** The project the folder holds or nests with; `here` when it is this workspace's. */
      project?: { id?: string; name: string; workspace: string; here: boolean };
    };

/** The workspace's display name: the Team setup's name, else its folder's. */
export function workspaceNameOf(workspaceFolder: string): string {
  const team = effectiveConfig(workspaceFolder).config.team;
  return (team.mode === "team" && team.workspace.trim()) || basename(realPath(workspaceFolder));
}

/** The project another workspace on this machine keeps in `folder`, read without writing. */
function foreignProject(folder: string): { name: string; workspace: string } | undefined {
  const locator = readLocator(folder);
  const ledgerFolder = holdsLedger(folder)
    ? folder
    : locator && holdsLedger(locator.workspaceFolder)
      ? locator.workspaceFolder
      : undefined;
  if (!ledgerFolder)
    return locator
      ? { name: basename(folder), workspace: basename(locator.workspaceFolder) }
      : undefined;
  try {
    const db = new DatabaseSync(ledgerPathOf(ledgerFolder), { readOnly: true });
    try {
      const row = db
        .prepare("SELECT name FROM projects WHERE root_path = ? LIMIT 1")
        .get(realPath(folder)) as { name?: string } | undefined;
      return {
        name: row?.name ?? basename(folder),
        workspace: workspaceNameOf(ledgerFolder),
      };
    } finally {
      db.close();
    }
  } catch {
    return { name: basename(folder), workspace: basename(ledgerFolder) };
  }
}

/** Entries that do not make a folder hold code. */
const NOT_CODE = new Set([".git", ".sekhemet", ".DS_Store", ".gitignore"]);

/**
 * Whether `folder` can take a new project (TEAM-55, TEAM-60): not one of this
 * workspace's projects, nor another workspace's, nor inside or around a
 * project's root, and holding no code (that is the take-over's).
 */
export function checkNewFolder(
  workspaceFolder: string,
  cardStore: CardStore,
  given: string,
): FolderVerdict {
  const folder = realPath(absolute(workspaceFolder, given));
  const here = workspaceNameOf(workspaceFolder);
  const projects = cardStore.listProjects();
  const same = projects.find((p) => realPath(p.rootPath) === folder);
  if (same) {
    return {
      ok: false,
      folder,
      kind: "has_project",
      reason: NEW_FOLDER_REFUSAL.hasProject(same.name, here),
      project: { id: same.id, name: same.name, workspace: here, here: true },
    };
  }
  const nest = projects.find(
    (p) => within(folder, realPath(p.rootPath)) || within(realPath(p.rootPath), folder),
  );
  if (nest) {
    return {
      ok: false,
      folder,
      kind: "nested",
      reason: NEW_FOLDER_REFUSAL.nested(folder, nest.name, within(folder, realPath(nest.rootPath))),
      project: { id: nest.id, name: nest.name, workspace: here, here: true },
    };
  }
  if (existsSync(folder)) {
    if (!statSync(folder).isDirectory()) {
      return {
        ok: false,
        folder,
        kind: "not_a_folder",
        reason: NEW_FOLDER_REFUSAL.notAFolder(folder),
      };
    }
    const other = foreignProject(folder);
    if (other) {
      return {
        ok: false,
        folder,
        kind: "has_project",
        reason: NEW_FOLDER_REFUSAL.hasProject(other.name, other.workspace),
        project: { ...other, here: false },
      };
    }
    if (readdirSync(folder).some((f) => !NOT_CODE.has(f))) {
      return { ok: false, folder, kind: "has_code", reason: NEW_FOLDER_REFUSAL.hasCode(folder) };
    }
  }
  return { ok: true, folder };
}

/**
 * TEAM-55, TEAM-56, TEAM-60: whether *Add an existing repository* may take
 * over `given`: a git repository, holding code or not, that is no project's
 * here or in another workspace, and nests with none.
 */
export function checkAdoptFolder(
  workspaceFolder: string,
  cardStore: CardStore,
  given: string,
): FolderVerdict {
  const verdict = checkNewFolder(workspaceFolder, cardStore, given);
  if (!verdict.ok && verdict.kind !== "has_code") return verdict;
  const folder = verdict.folder;
  if (!existsSync(join(folder, ".git"))) {
    return {
      ok: false,
      folder,
      kind: "not_a_folder",
      reason: existsSync(folder)
        ? NEW_FOLDER_REFUSAL.notARepository(folder)
        : NEW_FOLDER_REFUSAL.missing(folder),
    };
  }
  return { ok: true, folder };
}

/** A path as a person reads it: the home folder as `~` (DS-N8-1's *~/Sekhemet/projects/chronicle*). */
export function shownPath(path: string): string {
  const home = process.env.HOME;
  return home && (path === home || path.startsWith(`${home}/`))
    ? `~${path.slice(home.length)}`
    : path;
}

/** Thrown when a new project's folder is refused; nothing was created. */
export class NewFolderRefusal extends Error {
  constructor(public readonly verdict: Extract<FolderVerdict, { ok: false }>) {
    super(verdict.reason);
    this.name = "NewFolderRefusal";
  }
}

/**
 * TEAM-54: on a new project's approval, create its folder, run `git init`
 * with an empty first commit, write the `.gitignore` block, and record
 * `project/created {via: "new_folder"}` with the person as principal and its
 * locator. Checked again first: nothing is created when it is refused.
 */
export async function createProjectFolder(
  deps: { workspaceFolder: string; cardStore: CardStore; log: EventLog },
  input: { folder: string; name: string; principal: string },
): Promise<ProjectRecord> {
  const verdict = checkNewFolder(deps.workspaceFolder, deps.cardStore, input.folder);
  if (!verdict.ok) throw new NewFolderRefusal(verdict);
  mkdirSync(verdict.folder, { recursive: true });
  const folder = realPath(verdict.folder);
  if (!existsSync(join(folder, ".git"))) {
    NodeGitSyncAdapter.initRepository(folder, {
      subject: `chore: start ${input.name}`.slice(0, 72),
      card: "new-project",
    });
  }
  writeGitignoreBlock(folder);
  return registerProject(deps.cardStore, deps.log, deps.workspaceFolder, {
    rootPath: folder,
    name: input.name,
    via: "new_folder",
    principal: input.principal,
  });
}
