import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { toProposals, withProjectGroups } from "../src/pm/agent.js";
import { type ProjectGroup, draftProjectGroup } from "../src/pm/pipeline.js";
import { PmStore } from "../src/pm/store.js";
import { startDashboardServer } from "../src/server.js";
import { LOCATOR_PATH, readLocator, registerProject } from "../src/workspace_locator.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * New project in a workspace of many (DEC-57): teams TEAM-54, TEAM-55,
 * TEAM-57 and TEAM-60; design-stage DS-N8-1 and DS-N8-3; dashboard DB-N26-1.
 * In a workspace that already holds a project, the start page names the
 * folder approval creates, says before any approval when a folder cannot
 * take the project, and approval creates the folder with `git init` and
 * records the project; nothing exists before. A real git repository, an
 * on-disk ledger and the real HTTP server; no model is loaded.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanup.length) await (cleanup.pop() as () => Promise<void> | void)();
});

function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  git("commit", "-q", "--allow-empty", "-m", "chore: empty");
  return realpathSync(dir);
}

async function setup(team = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sek-new-folder-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  // The workspace folder is project Alpha's root, as on every install before DEC-57.
  const ws = gitRepo(join(root, "alpha"));
  mkdirSync(join(ws, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(ws, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const cardStore = new CardStore(db, log);
  const alpha = await cardStore.ensureProject({ rootPath: ws, name: "Alpha" });
  // Alpha has work, so New project is another project (an empty folder's first takes it).
  await cardStore.createCard({
    id: "a1",
    tier: "task",
    title: "Alpha's work",
    projectId: alpha.id,
  });
  if (team) {
    for (const [principal, level] of [
      ["p_admin", "admin"],
      ["p_lead", "member"],
      ["p_member", "member"],
      ["p_stake", "stakeholder"],
    ]) {
      log.appendNow({
        actor: "system",
        type: "member/joined",
        principal,
        payload: { principal, level, via: "invite", pending: false },
      });
    }
    log.appendNow({
      actor: "human",
      type: "project/settings_changed",
      principal: "p_admin",
      payload: { project: alpha.id, lead: "p_lead" },
    });
  }
  const pmStore = new PmStore(log);
  const [draft] = await withProjectGroups(
    toProposals(
      [
        {
          id: "1",
          name: "start_project",
          arguments: { brief: "a timesheet app that applies overtime rules", reason: "r" },
        },
      ],
      [],
    ),
    (x) => draftProjectGroup({ repoPath: ws, cardStore, log }, x),
  );
  const reply = await pmStore.appendReply({
    replyTo: [],
    text: "x",
    proposals: draft ? [draft] : [],
  });
  const proposal = reply.proposals?.[0] as NonNullable<typeof reply.proposals>[number];
  const server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(cardStore),
    cardStore,
    repoPath: ws,
    port: 0,
    streamIntervalMs: 10_000,
    ...(team
      ? {
          setup: "team" as const,
          requester: (req: import("node:http").IncomingMessage) => {
            const h = req.headers["x-test-principal"];
            return typeof h === "string" && h ? h : undefined;
          },
        }
      : {}),
    pressureLevel: () => 1,
  });
  cleanup.push(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const get = async (path: string, who?: string) => {
    const res = await fetch(`${base}${path}`, {
      headers: who ? { "X-Test-Principal": who } : {},
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  const apply = async (choices: Record<string, unknown>, who?: string) => {
    const res = await fetch(`${base}/api/pm/proposals/${proposal.id}/apply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await pageWriteHeaders(base)),
        ...(who ? { "X-Test-Principal": who } : {}),
      },
      body: JSON.stringify({ choices }),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  const refs = () =>
    execFileSync("git", ["for-each-ref", "--format=%(refname) %(objectname)"], {
      cwd: ws,
      encoding: "utf8",
    });
  return {
    root,
    ws,
    db,
    log,
    cardStore,
    alpha,
    group: proposal.patch?.group as ProjectGroup,
    get,
    apply,
    refs,
  };
}

describe("New project in a workspace that holds projects (DS-N8-1, TEAM-54)", () => {
  it("names the folder approval creates under the projects folder and creates nothing before approval", async () => {
    const s = await setup();
    // The workspace folder is Alpha's root: projects go beside it (teams §3).
    expect(s.group.folder).toBe(join(s.root, "a-timesheet-app-that-applies-overtime-rules"));
    const page = await s.get("/api/projects/new?name=Chronicle");
    expect(page.status).toBe(200);
    expect(page.data).toMatchObject({
      allowed: true,
      newFolder: true,
      projectsDir: s.root,
      folder: join(s.root, "chronicle"),
      mayCreate: true,
    });
    expect(page.data.refusal).toBeUndefined();
    expect(existsSync(s.group.folder as string)).toBe(false);
    expect(await s.log.getEventsByTypes(["project/created"])).toHaveLength(1);
  });

  it("on approval creates the folder the person chose, runs git init, records project/created {via: new_folder} and plans into it; Alpha is untouched", async () => {
    const s = await setup();
    const before = s.refs();
    const folder = join(s.root, "chronicle");
    const res = await s.apply({ folder });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    // A git repository with one commit on main, its .gitignore block and locator.
    expect(
      execFileSync("git", ["rev-list", "--count", "main"], {
        cwd: folder,
        encoding: "utf8",
      }).trim(),
    ).toBe("1");
    expect(readLocator(folder)?.workspaceFolder).toBe(s.ws);
    expect(
      execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: folder,
        encoding: "utf8",
      }),
    ).not.toContain(LOCATOR_PATH);
    const created = (await s.log.getEventsByTypes(["project/created"])).at(-1);
    expect(created?.payload).toMatchObject({ via: "new_folder", rootPath: folder });
    expect(created?.principal).toBe(s.log.localPrincipal());
    const project = s.cardStore.listProjects().find((p) => p.rootPath === folder);
    expect(project).toBeDefined();
    // The plan went into the new project: its cards name it, its brief is its own.
    const cards = (await s.cardStore.listCards()).filter((c) => c.id !== "a1");
    expect(cards.length).toBeGreaterThan(2);
    expect(cards.every((c) => c.projectId === project?.id)).toBe(true);
    expect(existsSync(join(folder, ".sekhemet", "brief.md"))).toBe(true);
    expect(existsSync(join(s.ws, ".sekhemet", "brief.md"))).toBe(false);
    expect(s.refs()).toBe(before);
  });
});

describe("a folder that cannot take a new project is said so before approval (TEAM-55, TEAM-60, DS-N8-3)", () => {
  it("names this workspace's project in the folder, the project it nests with, code, and another workspace's project", async () => {
    const s = await setup();
    const check = async (folder: string) =>
      (await s.get(`/api/projects/new?folder=${encodeURIComponent(folder)}`)).data.refusal as
        | {
            kind: string;
            reason: string;
            project?: { name: string; workspace: string; here: boolean };
          }
        | undefined;
    expect(await check(s.ws)).toMatchObject({
      kind: "has_project",
      project: { name: "Alpha", here: true, workspace: "alpha" },
    });
    expect((await check(s.ws))?.reason).toContain("Alpha");
    expect(await check(join(s.ws, "sub"))).toMatchObject({
      kind: "nested",
      project: { name: "Alpha" },
    });
    // A folder around Alpha's root.
    expect(await check(s.root)).toMatchObject({ kind: "nested", project: { name: "Alpha" } });
    const code = join(s.root, "has-code");
    mkdirSync(code);
    writeFileSync(join(code, "index.ts"), "export {};\n");
    expect(await check(code)).toMatchObject({ kind: "has_code" });
    // Another workspace on this machine keeps a project in this folder.
    const otherWs = gitRepo(join(s.root, "other-ws"));
    mkdirSync(join(otherWs, ".sekhemet"), { recursive: true });
    const odb = new DatabaseSync(join(otherWs, ".sekhemet", "events.db"));
    initSchema(odb);
    const olog = new EventLog(odb);
    const ostore = new CardStore(odb, olog);
    await ostore.ensureProject({ rootPath: otherWs, name: "Ledger app" });
    const theirs = gitRepo(join(s.root, "their-project"));
    await registerProject(ostore, olog, otherWs, { rootPath: theirs, name: "Payroll" });
    odb.close();
    expect(await check(theirs)).toMatchObject({
      kind: "has_project",
      project: { name: "Payroll", workspace: "other-ws", here: false },
    });
  });

  it("refuses Apply into a refused folder with the reason and creates nothing", async () => {
    const s = await setup();
    const projects = s.cardStore.listProjects().length;
    const inside = join(s.ws, "inner");
    const res = await s.apply({ folder: inside });
    expect(res.status).toBe(409);
    expect(String(res.data.error)).toContain("Alpha");
    expect(existsSync(inside)).toBe(false);
    expect(s.cardStore.listProjects()).toHaveLength(projects);
    expect(await s.cardStore.listCards()).toHaveLength(1);
    expect(readdirSync(s.root).sort()).toEqual(["alpha"]);
  });
});

describe("who may create a project in the Team setup (TEAM-54, TEAM-57, DB-N26-1)", () => {
  it("a Member who leads a project creates one; a Member who leads none, or a Stakeholder, is refused naming project.create and told to send for approval", async () => {
    const s = await setup(true);
    expect((await s.get("/api/projects/new", "p_lead")).data.mayCreate).toBe(true);
    expect((await s.get("/api/projects/new", "p_member")).data.mayCreate).toBe(false);
    expect((await s.get("/api/projects/new", "p_stake")).data.mayCreate).toBe(false);
    const refused = await s.apply({}, "p_member");
    expect(refused.status).toBe(403);
    expect(refused.data.permission).toBe("project.create");
    expect(s.cardStore.listProjects()).toHaveLength(1);
    const ok = await s.apply({}, "p_lead");
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    const created = (await s.log.getEventsByTypes(["project/created"])).at(-1);
    expect(created?.principal).toBe("p_lead");
    expect(created?.payload).toMatchObject({ via: "new_folder", rootPath: s.group.folder });
  });
});
