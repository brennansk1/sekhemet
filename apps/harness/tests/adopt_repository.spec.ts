import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { runTakeover } from "../src/takeover.js";
import { readLocator } from "../src/workspace_locator.js";
import { pageWriteHeaders } from "./page_headers.js";
import { buildTakeoverFixture, fakeTracker } from "./takeover_fixtures.js";

/**
 * *Add an existing repository* in a workspace of many (DEC-57): teams TEAM-55,
 * TEAM-56 and TEAM-60, design-stage DS-N8-2. The take-over runs on the named
 * repository, a folder that holds a project or nests with one is refused
 * before anything runs, and the repository is recorded as the workspace's
 * project `via: "adopted"` only when its take-over plan is approved. A real
 * ledger, real git repositories and the real HTTP server; no model is loaded.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanup.length) await (cleanup.pop() as () => Promise<void> | void)();
});

async function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sek-adopt-")));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  vi.stubEnv("SEKHEMET_TRUST_DIR", join(dir, "trust"));
  const ws = join(dir, "alpha");
  mkdirSync(join(ws, ".sekhemet"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  const db = new DatabaseSync(join(ws, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const cardStore = new CardStore(db, log);
  await cardStore.ensureProject({ rootPath: ws, name: "Alpha" });
  const server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(cardStore),
    cardStore,
    repoPath: ws,
    port: 0,
    streamIntervalMs: 10_000,
  });
  cleanup.push(async () => {
    await server.close();
    db.close();
  });
  const base = `http://127.0.0.1:${server.port}`;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  return { dir, ws, db, log, cardStore, post };
}

describe("Add an existing repository (TEAM-55, TEAM-56, TEAM-60, DS-N8-2)", () => {
  it("refuses a folder that holds a project, nests with one, or is no repository, before anything runs", async () => {
    const s = await setup();
    const inventories = async () => (await s.log.getEventsByTypes(["takeover/inventory"])).length;
    const here = await s.post("/api/takeover", { path: s.ws });
    expect(here.status).toBe(409);
    expect(here.data.refusal).toMatchObject({
      kind: "has_project",
      project: { name: "Alpha", here: true },
    });
    const inside = join(s.ws, "vendor", "lib");
    mkdirSync(inside, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: inside });
    const nested = await s.post("/api/takeover", { path: inside });
    expect(nested.status).toBe(409);
    expect(nested.data.refusal).toMatchObject({ kind: "nested", project: { name: "Alpha" } });
    const plain = join(s.dir, "plain");
    mkdirSync(plain);
    const notRepo = await s.post("/api/takeover", { path: plain });
    expect(notRepo.status).toBe(409);
    expect(String(notRepo.data.error)).toContain("not a git repository");
    expect(await inventories()).toBe(0);
    expect(s.cardStore.listProjects()).toHaveLength(1);
  });

  it("takes over the named repository untrusted (recon only), recording no project", async () => {
    const s = await setup();
    const fx = buildTakeoverFixture("inherited-issues");
    cleanup.push(() => rmSync(fx.root, { recursive: true, force: true }));
    const res = await s.post("/api/takeover", { path: fx.root });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data).toMatchObject({ trusted: false, path: fx.root });
    const [inventory] = await s.log.getEventsByTypes(["takeover/inventory"]);
    expect((inventory as { private?: { root?: string } }).private?.root).toBe(fx.root);
    expect(s.cardStore.listProjects()).toHaveLength(1);
  });

  it("records the repository as the workspace's project via adopted only when its plan is approved, and plans into it", async () => {
    const s = await setup();
    const fx = buildTakeoverFixture("inherited-issues");
    cleanup.push(() => rmSync(fx.root, { recursive: true, force: true }));
    await runTakeover(fx.root, {
      store: s.cardStore,
      log: s.log,
      principal: s.log.localPrincipal(),
      trusted: true,
      gitleaks: false,
      osvScanner: false,
      tracker: fakeTracker(fx.issues),
      say: () => undefined,
    });
    // Planned, not approved: no project yet (DS-TO-14, TEAM-56).
    expect(s.cardStore.listProjects()).toHaveLength(1);
    const approved = await s.post("/api/takeover/approve", { proposalId: "TOP-1" });
    expect(approved.status, JSON.stringify(approved.data)).toBe(200);
    const created = (await s.log.getEventsByTypes(["project/created"])).at(-1);
    expect(created?.payload).toMatchObject({ via: "adopted", rootPath: fx.root });
    expect(created?.principal).toBe(s.log.localPrincipal());
    const adopted = s.cardStore.listProjects().find((p) => p.rootPath === fx.root);
    expect(adopted).toBeDefined();
    expect(readLocator(fx.root)?.workspaceFolder).toBe(realpathSync(s.ws));
    const cards = (await s.cardStore.listCards()).filter((c) => c.tier !== "epic");
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((c) => c.projectId === adopted?.id)).toBe(true);
    // Approving again creates nothing more, and no second project.
    expect((await s.post("/api/takeover/approve", { proposalId: "TOP-1" })).status).toBe(200);
    expect(s.cardStore.listProjects()).toHaveLength(2);
  });

  it("SEC-N13-1: a trusted take-over's install and build see only the repository taken over", async () => {
    const s = await setup();
    // Something of the workspace's own project a take-over's build must not read.
    writeFileSync(join(s.ws, "secret.txt"), "alpha's\n");
    const repo = join(s.dir, "beta");
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    const reads = (path: string) =>
      `node -e "try { require('fs').readFileSync(${JSON.stringify(path).replace(/"/g, "'")}); process.exit(1) } catch { process.exit(0) }"`;
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        name: "beta",
        version: "1.0.0",
        private: true,
        scripts: {
          build: `${reads(join(s.ws, "secret.txt"))} && ${reads(join(s.ws, ".sekhemet", "events.db"))}`,
        },
      }),
    );
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    const report = await runTakeover(repo, {
      store: s.cardStore,
      log: s.log,
      principal: s.log.localPrincipal(),
      trusted: true,
      gitleaks: false,
      osvScanner: false,
      say: () => undefined,
    });
    const build = report.runs.find((r) => r.step === "build");
    expect(build, JSON.stringify(report.runs)).toMatchObject({ ok: true });
  }, 120_000);
});
