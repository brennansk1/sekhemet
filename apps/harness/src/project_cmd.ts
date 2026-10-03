import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CardStore, EventLog, ProjectRecord } from "@sekhemet/kernel";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { readLocator, realPath, removeLocator, writeLocator } from "./workspace_locator.js";

/**
 * `sekhemet project list` and `sekhemet project move <id> <path>` (surface
 * item 20d, NEW-surface-11; DEC-57). Listed under `sekhemet dev --help`.
 * Adding a project is New project in the dashboard, or `sekhemet` in the
 * project's folder (item 8a).
 */

export interface ProjectCmdEnv {
  workspaceFolder: string;
  /** The project whose root holds the folder the command runs in, if any. */
  folderProjectId?: string;
  cardStore: CardStore;
  log: EventLog;
  principal: string;
  print: (line: string) => void;
  printErr: (line: string) => void;
}

export interface ProjectListRow {
  id: string;
  name: string;
  root: string;
  state: ProjectRecord["status"];
  /** Whether this is the project of the folder the command ran in. */
  current: boolean;
}

/** SUR-77: the workspace's projects, oldest first. */
export function projectRows(
  projects: readonly ProjectRecord[],
  folderProjectId: string | undefined,
): ProjectListRow[] {
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    root: p.rootPath,
    state: p.status,
    current: p.id === folderProjectId,
  }));
}

/**
 * K-N12-7's check: the new folder holds the same repository — every merge
 * the ledger records for the project's accepted cards — or, with none, the
 * person confirmed. Returns the reason it fails.
 */
export async function moveCheck(
  cardStore: CardStore,
  project: ProjectRecord,
  root: string,
  confirmed: boolean,
): Promise<string | undefined> {
  if (!existsSync(root)) return `${root} does not exist.`;
  if (!existsSync(resolve(root, ".git"))) return `${root} is not a git repository.`;
  const ids = new Set(
    (await cardStore.listCards()).filter((c) => c.projectId === project.id).map((c) => c.id),
  );
  const merges = (await cardStore.eventsOfType(["card/accepted"]))
    .filter((e) => ids.has(String((e.payload as { id?: unknown }).id)))
    .map((e) => (e.payload as { sha?: string }).sha)
    .filter((sha): sha is string => typeof sha === "string" && sha !== "");
  if (merges.length === 0) {
    return confirmed
      ? undefined
      : `${project.name} has no accepted merge to check the folder against, so the move needs your confirmation: run it again with --yes.`;
  }
  const git = new NodeGitSyncAdapter(root);
  const missing = merges.filter((sha) => !git.reachesCommit(sha));
  return missing.length === 0
    ? undefined
    : `${root} is not the same repository: its history lacks ${missing.length === 1 ? "the accepted merge" : `${missing.length} accepted merges, among them`} ${missing[0]?.slice(0, 12)}.`;
}

export async function projectCommand(args: string[], env: ProjectCmdEnv): Promise<number> {
  const [verb, ...rest] = args.filter((a) => a !== "--json" && a !== "--yes");
  const json = args.includes("--json");
  if (verb === "list" || verb === undefined) {
    const rows = projectRows(env.cardStore.listProjects(), env.folderProjectId);
    if (json) {
      env.print(
        JSON.stringify({
          command: "project list",
          ok: true,
          exitCode: 0,
          workspace: { folder: env.workspaceFolder, id: env.log.workspaceId() ?? null },
          projects: rows,
        }),
      );
      return 0;
    }
    if (rows.length === 0) {
      env.print("This workspace has no project yet. Start one from New project on the dashboard.");
      return 0;
    }
    for (const r of rows) {
      env.print(`${r.current ? "*" : " "} ${r.id}  ${r.name}  ${r.state}  ${r.root}`);
    }
    return 0;
  }
  if (verb === "move") {
    const [ref, target] = rest;
    if (!ref || !target) {
      env.printErr("Usage: sekhemet project move <project id or name> <new folder> [--yes]");
      return 2;
    }
    const project = env.cardStore.listProjects().find((p) => p.id === ref || p.name === ref);
    if (!project) {
      env.printErr(
        `sekhemet: no project ${ref} in this workspace. \`sekhemet project list\` names them.`,
      );
      return 1;
    }
    const root = realPath(resolve(target));
    const confirmed = args.includes("--yes");
    const reason = await moveCheck(env.cardStore, project, root, confirmed);
    try {
      const moved = await env.cardStore.moveProject(project.id, root, {
        principal: env.principal,
        check: () => reason,
      });
      const workspaceId = env.log.workspaceId();
      // The locator at both places (kernel rule 38a): written at the new
      // root, removed from the old one when it still names this workspace.
      if (workspaceId) {
        writeLocator(moved.rootPath, { workspaceFolder: env.workspaceFolder, workspaceId });
        const old = readLocator(project.rootPath);
        if (old && old.workspaceId === workspaceId) removeLocator(project.rootPath);
      }
      env.print(`${moved.name} is now at ${moved.rootPath}.`);
      return 0;
    } catch (err) {
      env.printErr(`sekhemet: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  env.printErr(
    `sekhemet: no project command "${verb}". Use \`project list\` or \`project move <id> <path>\`.`,
  );
  return 2;
}
