import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { toCsv } from "../src/integrations.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * Loop waves 5–6 review (teams item 6, dashboard DB-N9-17): what the server
 * itself gives and refuses a person below the level that may start a
 * project, so the page's gates follow the server's rules rather than stand
 * alone. A Viewer is shown no folder of the server's disk on any read, and
 * a project-start conversation is refused to them (`project.converse`); a
 * Stakeholder may start one. An import names only a project the person may
 * create issues in. A real git repository, an on-disk ledger and the real
 * HTTP server; no model is loaded.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanup.length) await (cleanup.pop() as () => Promise<void> | void)();
});

async function setup() {
  const repoPath = realpathSync(mkdtempSync(join(tmpdir(), "sek-viewer-rules-")));
  const cfg = mkdtempSync(join(tmpdir(), "sek-viewer-rules-cfg-"));
  process.env.SEKHEMET_CONFIG_DIR = cfg;
  cleanup.push(() => {
    Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repoPath, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  git("commit", "-q", "--allow-empty", "-m", "chore: empty");
  mkdirSync(join(repoPath, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(repoPath, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const cardStore = new CardStore(db, log);
  for (const [principal, level] of [
    ["p_admin", "admin"],
    ["p_member", "member"],
    ["p_stake", "stakeholder"],
    ["p_view", "viewer"],
  ]) {
    log.appendNow({
      actor: "system",
      type: "member/joined",
      principal,
      payload: { principal, level, via: "invite", pending: false },
    });
  }
  const project = await cardStore.ensureProject({ name: "Chronicle", rootPath: repoPath });
  const server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(cardStore),
    cardStore,
    repoPath,
    port: 0,
    streamIntervalMs: 10_000,
    setup: "team",
    requester: (req) => {
      const h = req.headers["x-test-principal"];
      return typeof h === "string" && h ? h : undefined;
    },
    pressureLevel: () => 1,
  });
  cleanup.push(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const get = (path: string, who: string) =>
    fetch(`${base}${path}`, { headers: { "X-Test-Principal": who } });
  const post = async (path: string, who: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await pageWriteHeaders(base)),
        "X-Test-Principal": who,
      },
      body: JSON.stringify(body),
    });
  /** A second project, so no request is read as the workspace's only one. */
  const another = async () => {
    const root = mkdtempSync(join(tmpdir(), "sek-viewer-rules-2-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    return cardStore.ensureProject({ name: "Atlas", rootPath: root });
  };
  return { repoPath, project, log, get, post, another };
}

const READS = (project: string) => [
  "/api/projects",
  "/api/projects/overview",
  `/api/config?project=${project}`,
];

describe("a Viewer is shown no folder of the server's disk (W6 review, teams item 6)", () => {
  it("GET /api/projects, /api/projects/overview and /api/config carry no absolute path for a Viewer", async () => {
    const s = await setup();
    const tail = basename(s.repoPath);
    for (const path of READS(s.project.id)) {
      const res = await s.get(path, "p_view");
      expect(res.status, path).toBe(200);
      const text = await res.text();
      expect(text, path).not.toContain(s.repoPath);
      expect(text, path).not.toMatch(/"rootPath"/);
      // The same read for an Admin still names the repository (DB-N25-1).
      expect(await (await s.get(path, "p_admin")).text(), path).toContain(s.repoPath);
    }
    // Two projects of one name are still told apart: by the folder's last part only.
    const overview = (await (await s.get("/api/projects/overview", "p_view")).json()) as {
      overview: { projects: { folder?: string }[] };
    };
    expect(overview.overview.projects[0]?.folder).toBe(tail);
  });

  it("a Stakeholder, who may start a project conversation, still sees the folder", async () => {
    const s = await setup();
    const text = await (await s.get("/api/projects/overview", "p_stake")).text();
    expect(text).toContain(s.repoPath);
  });
});

describe("a project-start conversation is the server's to refuse (W6 review, project.converse)", () => {
  it("refuses a Viewer's Start a new project with the level note, records it, and queues nothing", async () => {
    const s = await setup();
    const before = (await s.log.getEventsByTypes(["pm/message"])).length;
    const res = await s.post("/api/pm/messages", "p_view", {
      text: "Start a new project: a todo app",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; permission: string; level: string };
    expect(body).toMatchObject({ permission: "project.converse", level: "viewer" });
    expect(body.error).toMatch(/Viewer/);
    expect(body.error).toMatch(/start a project conversation/);
    expect(await s.log.getEventsByTypes(["pm/message"])).toHaveLength(before);
    const refused = await s.log.getEventsByTypes(["access/refused"]);
    expect(refused.at(-1)?.payload).toMatchObject({ permission: "project.converse" });
  });

  it("a Viewer may still ask Seshat a question, and a Stakeholder may start a project", async () => {
    const s = await setup();
    expect((await s.post("/api/pm/messages", "p_view", { text: "What is next?" })).status).toBe(
      200,
    );
    expect(
      (await s.post("/api/pm/messages", "p_stake", { text: "Start a new project: a todo app" }))
        .status,
    ).toBe(200);
  });
});

describe("an import names only a project the person may create issues in (W6 review)", () => {
  it("in a workspace of two projects, a Member with no access to one is answered 404 there, an Admin 200", async () => {
    const s = await setup();
    await s.another();
    s.log.appendNow({
      actor: "human",
      type: "member/level_changed",
      principal: "p_admin",
      payload: { principal: "p_member", level: "none", project: s.project.id },
    });
    const body = {
      format: "linear-csv",
      content: toCsv([["Title"], ["Brand new row"]]),
      projectId: s.project.id,
    };
    const r = await s.post("/api/import", "p_member", body);
    expect(r.status, await r.clone().text()).toBe(404);
    expect((await s.post("/api/import", "p_admin", body)).status).toBe(200);
  });
});
