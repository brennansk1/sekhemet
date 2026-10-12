import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";

/**
 * Wave 2 A3, review finding 4 (dashboard §2.10 item 6, DB-N9-8): Insights'
 * finished count and Status's are one count from one source — each issue
 * once, at its last move to Done, only issues (never an epic), and only the
 * page's project. Insights summed every move into Done across all projects,
 * so an issue reverted and accepted again, a done epic, or a second project
 * made it say "this period has 3" beside Status's "there are 2".
 */
describe("one finished count for Status and Insights (A3)", () => {
  let repo: string;
  let other: string;
  let db: DatabaseSync;
  let server: { port: number; close: () => Promise<void> };
  let base: string;
  let p1: string;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "flow-finished-"));
    other = `${repo}-other`;
    db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    const store = new CardStore(db, log);
    p1 = (await store.ensureProject({ name: "Timesheets", rootPath: repo })).id;
    const p2 = (await store.ensureProject({ name: "Recipes", rootPath: other })).id;
    const move = (id: string, to: string) =>
      store.updateCardStatus(id, to as never, "setup", "human", { override: true });
    const card = async (id: string, projectId: string, tier = "task") => {
      await store.createCard({ id, tier: tier as never, title: id, status: "ready", projectId });
      await move(id, "in_progress");
      await move(id, "done");
    };
    // An issue accepted, reverted and accepted again: one finished issue.
    await card("card_again", p1);
    await move("card_again", "ready");
    await move("card_again", "in_progress");
    await move("card_again", "done");
    await card("card_once", p1);
    // An epic moved to Done is not an issue.
    await card("card_epic", p1, "epic");
    // Another project's issue is not this page's.
    await card("card_other", p2);
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 1000,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server?.close();
    db?.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  const get = async <T>(path: string) => (await (await fetch(`${base}${path}`)).json()) as T;

  it("a project's page: Status and Insights both count its 2 finished issues", async () => {
    const q = `project=${encodeURIComponent(p1)}`;
    const status = await get<{ facts: { flow: { finished: number; days: number } } }>(
      `/api/status?${q}`,
    );
    expect(status.facts.flow.finished).toBe(2);
    const flow = await get<{ finished: number }>(
      `/api/metrics/flow?days=${status.facts.flow.days}&${q}`,
    );
    expect(flow.finished).toBe(2);
  });

  it("the workspace's page: both count every visible issue once, never an epic", async () => {
    const status = await get<{ facts: { flow: { finished: number } } }>("/api/status");
    const flow = await get<{ finished: number }>("/api/metrics/flow?days=30");
    expect(status.facts.flow.finished).toBe(3);
    expect(flow.finished).toBe(3);
  });
});
