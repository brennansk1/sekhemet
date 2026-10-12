import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";

/**
 * Wave 8 A1, A5 (measurement: every number re-derivable from the ledger,
 * scoped to the project asked; kernel rule 38a: a workspace holds projects;
 * planner-pm rule 16, "recorded per project"; dashboard §2.8 item 2, a
 * forecast needs five days of history). `/api/metrics/pm` counted every
 * project's open cards and forecast from a zero-padded 60-day series, so a
 * one-day project got p50/p85 dates Status withholds; `/api/metrics/flow`
 * served every project's throughput, cycle times, WIP and CFD under
 * `?project=`. Each test re-derives its figure from the ledger's events.
 */
const DAY = 86_400_000;
const ISSUE = (tier: string | undefined) => tier !== "epic" && tier !== "initiative";
const BUCKET: Record<string, string | undefined> = {
  backlog: "backlog",
  ready: "ready",
  planning: "ready",
  in_progress: "in_progress",
  verify: "verify",
  review: "review",
  done: "done",
};

interface Fixture {
  db: DatabaseSync;
  log: EventLog;
  server: { port: number; close: () => Promise<void> };
  base: string;
  dirs: string[];
}

async function serve(db: DatabaseSync, log: EventLog, store: CardStore, repo: string) {
  const server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(store),
    cardStore: store,
    repoPath: repo,
    port: 0,
    streamIntervalMs: 1000,
  });
  return { server, base: `http://127.0.0.1:${server.port}` };
}

/** Each card's project, tier and current status, replayed from the ledger. */
async function replay(log: EventLog) {
  const cards = new Map<string, { projectId?: string; tier?: string; status?: string }>();
  const toDone: { id: string; at: string }[] = [];
  for (const e of await log.getEventsByTypes(["card/created", "card/status_changed"])) {
    const p = e.payload as {
      id?: string;
      projectId?: string;
      tier?: string;
      status?: string;
      toStatus?: string;
    };
    const id = String(p.id ?? e.cardId);
    if (e.type === "card/created") {
      cards.set(id, { projectId: p.projectId, tier: p.tier, status: p.status });
      continue;
    }
    const row = cards.get(id);
    if (!row) continue;
    if (p.toStatus === "done" && row.status !== "done") toDone.push({ id, at: e.createdAt });
    row.status = p.toStatus;
  }
  return { cards, toDone };
}

describe("Seshat's measures and flow are the project's own (wave 8 A1, A5)", () => {
  let f: Fixture;
  let p1: string;
  let p2: string;

  beforeAll(async () => {
    const repo = mkdtempSync(join(tmpdir(), "metrics-scope-"));
    const other = `${repo}-other`;
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    const store = new CardStore(db, log);
    // Ten days of history: the cards are made ten days ago, one finished a day after.
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now() - 10 * DAY;
    vi.setSystemTime(start);
    try {
      p1 = (await store.ensureProject({ name: "Timesheets", rootPath: repo })).id;
      p2 = (await store.ensureProject({ name: "Recipes", rootPath: other })).id;
      const mk = (id: string, projectId: string, tier = "task") =>
        store.createCard({ id, tier: tier as never, title: id, status: "ready", projectId });
      const move = (id: string, to: string) =>
        store.updateCardStatus(id, to as never, "setup", "human", { override: true });
      for (const id of ["t1", "t2", "t3", "t4", "t5", "o1", "o2", "o3"]) await mk(id, p1);
      await mk("e1", p1, "epic");
      for (const id of ["r1", "r2", "r3", "r4"]) await mk(id, p2);
      for (const [i, id] of ["t1", "t2", "t3", "t4", "t5"].entries()) {
        vi.setSystemTime(start + (i + 1) * DAY);
        await move(id, "in_progress");
        await move(id, "done");
      }
      vi.setSystemTime(start + 2 * DAY);
      for (const id of ["r3", "r4"]) {
        await move(id, "in_progress");
        await move(id, "done");
      }
      await move("e1", "in_progress");
      vi.setSystemTime(start + 7 * DAY);
      await move("o1", "in_progress");
      await move("r1", "in_progress");
    } finally {
      vi.useRealTimers();
    }
    const s = await serve(db, log, store, repo);
    f = { db, log, ...s, dirs: [repo, other] };
  });

  afterAll(async () => {
    await f?.server.close();
    f?.db.close();
    for (const d of f?.dirs ?? []) rmSync(d, { recursive: true, force: true });
  });

  const get = async <T>(path: string) => (await (await fetch(`${f.base}${path}`)).json()) as T;

  it("/api/metrics/pm?project= forecasts the project's open issues, as Status does", async () => {
    const { cards } = await replay(f.log);
    const open = [...cards.values()].filter(
      (c) =>
        c.projectId === p1 &&
        ISSUE(c.tier) &&
        !["done", "rejected", "parked"].includes(c.status ?? ""),
    ).length;
    expect(open).toBe(3);
    const q = `project=${encodeURIComponent(p1)}`;
    const pm = await get<{ forecast?: { remaining: number; p50Days: number; p85Days: number } }>(
      `/api/metrics/pm?${q}`,
    );
    expect(pm.forecast?.remaining).toBe(open);
    // One project says one forecast everywhere, and the same ledger says the same days.
    const status = await get<{ facts: { forecast: { p50Days?: number; p85Days?: number } } }>(
      `/api/status?${q}`,
    );
    expect(status.facts.forecast.p50Days).toBeDefined();
    expect(pm.forecast?.p50Days).toBe(status.facts.forecast.p50Days);
    expect(pm.forecast?.p85Days).toBe(status.facts.forecast.p85Days);
    const again = await get<{ forecast?: { p50Days: number; p85Days: number } }>(
      `/api/metrics/pm?${q}`,
    );
    expect(again.forecast).toEqual(pm.forecast);
  });

  it("/api/metrics/flow?project= serves only the project's issues", async () => {
    const { cards, toDone } = await replay(f.log);
    const mine = (id: string) => {
      const c = cards.get(id);
      return c?.projectId === p1 && ISSUE(c.tier);
    };
    const flow = await get<{
      throughput: { date: string; done: number }[];
      cycleTime: { cardId: string }[];
      wipAge: { cardId: string }[];
      cfd: Record<string, number | string>[];
    }>(`/api/metrics/flow?days=30&project=${encodeURIComponent(p1)}`);
    // Throughput: the project's issues' moves into Done, by day.
    const byDay = new Map<string, number>();
    for (const d of toDone.filter((d) => mine(d.id))) {
      const k = d.at.slice(0, 10);
      byDay.set(k, (byDay.get(k) ?? 0) + 1);
    }
    expect(flow.throughput).toEqual([...byDay].sort().map(([date, done]) => ({ date, done })));
    expect(flow.cycleTime.map((c) => c.cardId).sort()).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(flow.wipAge.map((w) => w.cardId)).toEqual(["o1"]);
    // The last day's cumulative flow: the project's issues by column.
    const counts: Record<string, number> = {};
    for (const [id, c] of cards) {
      const b = BUCKET[c.status ?? ""];
      if (mine(id) && b) counts[b] = (counts[b] ?? 0) + 1;
    }
    const last = flow.cfd.at(-1) ?? {};
    for (const b of ["backlog", "ready", "in_progress", "verify", "review", "done"])
      expect([b, last[b]]).toEqual([b, counts[b] ?? 0]);
  });
});

describe("no forecast below five days of history (wave 8 A1)", () => {
  let f: Fixture;

  beforeAll(async () => {
    const repo = mkdtempSync(join(tmpdir(), "metrics-short-"));
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    const store = new CardStore(db, log);
    const p = (await store.ensureProject({ name: "Timesheets", rootPath: repo })).id;
    for (const id of ["a", "b", "c"])
      await store.createCard({ id, tier: "task", title: id, status: "ready", projectId: p });
    await store.updateCardStatus("a", "in_progress", "setup", "human", { override: true });
    await store.updateCardStatus("a", "done", "setup", "human", { override: true });
    const s = await serve(db, log, store, repo);
    f = { db, log, ...s, dirs: [repo] };
  });

  afterAll(async () => {
    await f?.server.close();
    f?.db.close();
    for (const d of f?.dirs ?? []) rmSync(d, { recursive: true, force: true });
  });

  it("one day of history: Status says not enough, and /api/metrics/pm gives no dates", async () => {
    const status = (await (await fetch(`${f.base}/api/status`)).json()) as {
      facts: { forecast: { historyDays: number; minimum: number; p50Days?: number } };
    };
    expect(status.facts.forecast.historyDays).toBeLessThan(status.facts.forecast.minimum);
    expect(status.facts.forecast.p50Days).toBeUndefined();
    const pm = (await (await fetch(`${f.base}/api/metrics/pm`)).json()) as {
      forecast?: unknown;
    };
    expect(pm.forecast).toBeUndefined();
  });
});
