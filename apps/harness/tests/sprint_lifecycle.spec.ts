import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SPRINT_REPORT_TYPES, completeSprint, sprintReport } from "../src/pm/sprints.js";
import { PmStore } from "../src/pm/store.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

type Cycle = {
  id: string;
  name: string;
  state: string;
  startsOn: string;
  endsOn: string;
  projectId?: string;
};
type Bucket = { issues: string[]; points: number };
type Report = {
  cycleId: string;
  unit: "issues" | "points";
  committed: Bucket;
  added: Bucket;
  removed: Bucket;
  completed: Bucket;
  carriedOver: Bucket & { to: Record<string, string> };
};

/**
 * The sprint lifecycle (C2b; planner-pm §2.7 item 7a, PM-N13-1, -2, -3, -5;
 * dashboard NEW-dashboard-11, DB-N11-1..4; FINDINGS_C1 PRC-02, DESIGN_GAPS_C1
 * b6) over HTTP against a real server on a real SQLite file (DoD §2A): Start
 * sprint records the committed issues and the active state as one group and
 * is refused while another sprint of the project is active; Complete sprint
 * carries the open issues to the next sprint, a new one or Backlog with the
 * close, all or nothing; the report is computed from the ledger alone; and
 * Seshat's `close_cycle` proposal is applied only by a person. No model.
 */
describe("the sprint lifecycle over HTTP", () => {
  let dir: string;
  let db: DatabaseSync;
  let log: EventLog;
  let store: CardStore;
  let server: { port: number; close: () => Promise<void> };
  let base: string;
  let projectA: string;
  let projectB: string;
  const ids: Record<string, string> = {};

  const send = async (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async <T>(r: Response) => (await r.json()) as T;
  const count = () =>
    Number((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number | bigint }).n);
  const eventsOf = (type: string) => log.getEventsByTypes([type]);
  const sprint = async (name: string, startsOn: string, endsOn: string, projectId = projectA) => {
    const r = await send("POST", "/api/cycles", { name, startsOn, endsOn, projectId });
    expect(r.status).toBe(200);
    return (await json<{ cycle: Cycle }>(r)).cycle;
  };
  const assign = async (card: string, cycleId: string | null) => {
    const r = await send("PATCH", `/api/cards/${card}`, { cycleId });
    expect(r.status).toBe(200);
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-sprints-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    log = new EventLog(db);
    store = new CardStore(db, log);
    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, "b"));
    projectA = (await store.ensureProject({ rootPath: join(dir, "a"), name: "Timesheet" })).id;
    projectB = (await store.ensureProject({ rootPath: join(dir, "b"), name: "Payroll" })).id;
    const card = async (key: string, title: string, estimate?: number) => {
      const c = await store.createCard({
        tier: "story",
        title,
        status: "ready",
        projectId: projectA,
        ...(estimate ? { estimate } : {}),
      });
      ids[key] = c.id;
    };
    await card("a", "Record a day's hours", 3);
    await card("b", "Flag hours past 40 as overtime", 5);
    await card("c", "Export the week to CSV", 2);
    await card("d", "Show the weekly total", 1);
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 1000,
      pressureLevel: () => 1,
    });
    base = `http://127.0.0.1:${server.port}`;
    const est = await send("PATCH", `/api/projects/${projectA}/settings`, {
      estimation: "points",
    });
    expect(est.status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  let s1: Cycle;
  let s2: Cycle;

  it("DB-N11-1, PM-N13-1: Start sprint records the committed issues, their points and the active state as one group", async () => {
    s1 = await sprint("Sprint 1", "2026-09-21", "2026-10-02");
    expect(s1.projectId).toBe(projectA);
    for (const k of ["a", "b", "d"]) await assign(ids[k] as string, s1.id);
    const r = await send("POST", `/api/cycles/${s1.id}/start`, {});
    expect(r.status).toBe(200);
    expect((await json<{ cycle: Cycle }>(r)).cycle.state).toBe("active");
    const [started] = await eventsOf("cycle/started");
    expect(started?.payload).toEqual({
      id: s1.id,
      issues: [ids.a, ids.b, ids.d].sort(),
      points: { [ids.a as string]: 3, [ids.b as string]: 5, [ids.d as string]: 1 },
    });
    expect(started?.actor).toBe("human");
    expect(started?.principal).toBe(log.localPrincipal());
    const updated = (await eventsOf("cycle/updated")).at(-1);
    expect(updated?.payload).toEqual({ id: s1.id, state: "active" });
    // One recorded group: the two events are consecutive on the chain.
    expect(updated?.seq).toBe((started?.seq ?? 0) + 1);
    const board = await json<{ cycles: Cycle[] }>(
      await fetch(`${base}/api/board?project=${projectA}`),
    );
    expect(board.cycles.find((c) => c.id === s1.id)?.state).toBe("active");
  });

  it("PM-N13-2: `next` with no planned sprint is refused, naming a new sprint and Backlog, and records nothing", async () => {
    const before = count();
    const r = await send("POST", `/api/cycles/${s1.id}/complete`, { carryTo: "next" });
    expect(r.status).toBe(409);
    const { error } = await json<{ error: string }>(r);
    expect(error).toMatch(/new sprint/);
    expect(error).toMatch(/Backlog/);
    expect(error).not.toMatch(/\/api\//);
    expect(count()).toBe(before);
  });

  it("DB-N11-1, PM-N13-1: a second start while a sprint of the project is active is refused, naming it, and records nothing", async () => {
    s2 = await sprint("Sprint 2", "2026-10-05", "2026-10-16");
    const before = count();
    const r = await send("POST", `/api/cycles/${s2.id}/start`, {});
    expect(r.status).toBe(409);
    expect((await json<{ error: string }>(r)).error).toMatch(/Sprint 1 is active/);
    expect(count()).toBe(before);
    // So is creating one already active, and setting the state by PATCH.
    const made = await send("POST", "/api/cycles", {
      name: "Sprint X",
      startsOn: "2026-10-05",
      endsOn: "2026-10-16",
      projectId: projectA,
      state: "active",
    });
    expect(made.status).toBe(409);
    const patched = await send("PATCH", `/api/cycles/${s2.id}`, { state: "active" });
    expect(patched.status).toBe(409);
    expect(count()).toBe(before);
    // Another project's sprint is not this one's: it starts.
    const other = await sprint("Payroll 1", "2026-09-21", "2026-10-02", projectB);
    expect((await send("POST", `/api/cycles/${other.id}/start`, {})).status).toBe(200);
    const boardA = await json<{ cycles: Cycle[] }>(
      await fetch(`${base}/api/board?project=${projectA}`),
    );
    expect(boardA.cycles.map((c) => c.id)).not.toContain(other.id);
  });

  it("PM-N13-2: when a write in the completion's group fails, none of it is recorded", async () => {
    // Scope changes during the sprint: C added, D removed, A done.
    await assign(ids.c as string, s1.id);
    await assign(ids.d as string, null);
    await store.updateCardStatus(ids.a as string, "done", "accepted", "human", { override: true });
    db.exec(
      "CREATE TRIGGER refuse_completion BEFORE INSERT ON events WHEN NEW.type = 'cycle/completed' BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    const before = count();
    try {
      const r = await send("POST", `/api/cycles/${s1.id}/complete`, { carryTo: "next" });
      expect(r.status).toBeGreaterThanOrEqual(400);
    } finally {
      db.exec("DROP TRIGGER refuse_completion");
    }
    expect(count()).toBe(before);
    expect((await store.getCard(ids.b as string))?.cycleId).toBe(s1.id);
    expect((await store.getCard(ids.c as string))?.cycleId).toBe(s1.id);
    const cycles = await json<{ cycles: Cycle[] }>(await fetch(`${base}/api/cycles`));
    expect(cycles.cycles.find((c) => c.id === s1.id)?.state).toBe("active");
  });

  it("DB-N11-2, PM-N13-2: Complete sprint to the next planned sprint moves the open issues and closes it, as one group", async () => {
    const r = await send("POST", `/api/cycles/${s1.id}/complete`, { carryTo: "next" });
    expect(r.status).toBe(200);
    const body = await json<{ cycle: Cycle; report: Report }>(r);
    expect(body.cycle.state).toBe("closed");
    expect((await store.getCard(ids.b as string))?.cycleId).toBe(s2.id);
    expect((await store.getCard(ids.c as string))?.cycleId).toBe(s2.id);
    expect((await store.getCard(ids.a as string))?.cycleId).toBe(s1.id);
    const [completed] = await eventsOf("cycle/completed");
    expect(completed?.payload).toEqual({
      id: s1.id,
      done: [ids.a],
      carried: [
        { issue: ids.b, to: s2.id },
        { issue: ids.c, to: s2.id },
      ].sort((x, y) => (x.issue as string).localeCompare(y.issue as string)),
    });
    expect(completed?.principal).toBe(log.localPrincipal());
    // The moves, the completion and the close are consecutive on the chain.
    const all = await log.getEventsByTypes(["card/updated", "cycle/completed", "cycle/updated"]);
    const at = all.findIndex((e) => e.type === "cycle/completed");
    expect(all.slice(at - 2, at + 2).map((e) => e.type)).toEqual([
      "card/updated",
      "card/updated",
      "cycle/completed",
      "cycle/updated",
    ]);
    const seqs = all.slice(at - 2, at + 2).map((e) => e.seq);
    expect(seqs).toEqual([seqs[0], (seqs[0] ?? 0) + 1, (seqs[0] ?? 0) + 2, (seqs[0] ?? 0) + 3]);
    // Seshat's measures of a closed sprint are recorded once (PM-P6-12).
    expect(
      (await eventsOf("pm/sprint_measured")).filter(
        (e) => (e.payload as { cycleId: string }).cycleId === s1.id,
      ),
    ).toHaveLength(1);
  });

  it("DB-N11-3, PM-N13-3: the report is computed from the ledger alone, and the same ledger gives the same report", async () => {
    const r = await fetch(`${base}/api/cycles/${s1.id}/report`);
    expect(r.status).toBe(200);
    const { report } = await json<{ report: Report }>(r);
    expect(report.unit).toBe("points");
    expect(report.committed).toEqual({ issues: [ids.a, ids.b, ids.d].sort(), points: 9 });
    expect(report.added).toEqual({ issues: [ids.c], points: 2 });
    expect(report.removed).toEqual({ issues: [ids.d], points: 1 });
    expect(report.completed).toEqual({ issues: [ids.a], points: 3 });
    expect(report.carriedOver.issues).toEqual([ids.b, ids.c].sort());
    expect(report.carriedOver.points).toBe(7);
    expect(report.carriedOver.to).toEqual({ [ids.b as string]: s2.id, [ids.c as string]: s2.id });
    // A copy of the ledger, read by a fresh log, gives the same report.
    const copy = join(dir, "copy.db");
    db.exec(`VACUUM INTO '${copy}'`);
    const db2 = new DatabaseSync(copy);
    try {
      const events = await new EventLog(db2).getEventsByTypes([...SPRINT_REPORT_TYPES]);
      expect(sprintReport(events, s1.id)).toEqual(report);
    } finally {
      db2.close();
    }
    expect((await fetch(`${base}/api/cycles/nope/report`)).status).toBe(404);
  });

  it("DB-N11-2, PM-N13-2: `new` creates the next sprint in the same group and carries the open issues there", async () => {
    expect((await send("POST", `/api/cycles/${s2.id}/start`, {})).status).toBe(200);
    const r = await send("POST", `/api/cycles/${s2.id}/complete`, { carryTo: "new" });
    expect(r.status).toBe(200);
    const body = await json<{ cycle: Cycle; next: Cycle }>(r);
    expect(body.next).toMatchObject({
      name: "Sprint 3",
      state: "planned",
      projectId: projectA,
      startsOn: "2026-10-17",
      endsOn: "2026-10-28",
    });
    expect((await store.getCard(ids.b as string))?.cycleId).toBe(body.next.id);
    const created = (await eventsOf("cycle/created")).at(-1);
    const completed = (await eventsOf("cycle/completed")).at(-1);
    expect((created?.payload as Cycle).id).toBe(body.next.id);
    expect(created?.seq).toBeLessThan(completed?.seq ?? 0);
    expect((completed?.seq ?? 0) - (created?.seq ?? 0)).toBe(3);
  });

  it("DB-N11-2, PM-N13-2: `backlog` takes the open issues out of every sprint", async () => {
    const s3 = (await json<{ cycles: Cycle[] }>(await fetch(`${base}/api/cycles`))).cycles.find(
      (c) => c.name === "Sprint 3",
    ) as Cycle;
    expect((await send("POST", `/api/cycles/${s3.id}/start`, {})).status).toBe(200);
    const r = await send("POST", `/api/cycles/${s3.id}/complete`, { carryTo: "backlog" });
    expect(r.status).toBe(200);
    expect((await store.getCard(ids.b as string))?.cycleId).toBeUndefined();
    expect((await eventsOf("cycle/completed")).at(-1)?.payload).toMatchObject({
      carried: [
        { issue: ids.b, to: "backlog" },
        { issue: ids.c, to: "backlog" },
      ].sort((x, y) => (x.issue as string).localeCompare(y.issue as string)),
    });
    // A completed sprint does not complete again, and a bad destination is a 400.
    expect(
      (await send("POST", `/api/cycles/${s3.id}/complete`, { carryTo: "backlog" })).status,
    ).toBe(409);
    expect((await send("POST", `/api/cycles/${s3.id}/complete`, { carryTo: "later" })).status).toBe(
      400,
    );
  });

  it("DB-N11-4, PM-N13-5: Seshat's close_cycle proposal is applied by a person through the same path; Seshat never records the completion", async () => {
    const s4 = await sprint("Sprint 4", "2026-10-29", "2026-11-09");
    await assign(ids.b as string, s4.id);
    expect((await send("POST", `/api/cycles/${s4.id}/start`, {})).status).toBe(200);
    // Seshat completing it itself is refused, whatever path it takes.
    const pmStore = new PmStore(log);
    await expect(
      completeSprint({ log, cardStore: store, pmStore }, s4.id, "backlog", { actor: "planner" }),
    ).rejects.toThrow(/person completes it/);
    const reply = await pmStore.appendReply({
      replyTo: [],
      text: "Sprint 4's issues are all waiting on review.",
      proposals: [
        {
          kind: "close_cycle",
          summary: "Suggested: complete Sprint 4 and move its open issues to Backlog.",
          why: "its end date has passed",
          patch: { cycleId: s4.id, carryTo: "backlog" },
        },
      ],
    });
    const proposal = reply.proposals?.[0];
    const before = (await eventsOf("cycle/completed")).length;
    const applied = await send("POST", `/api/pm/proposals/${proposal?.id}/apply`, {});
    expect(applied.status).toBe(200);
    const done = await eventsOf("cycle/completed");
    expect(done).toHaveLength(before + 1);
    expect(done.at(-1)?.actor).toBe("human");
    expect(done.at(-1)?.principal).toBe(log.localPrincipal());
    expect((await store.getCard(ids.b as string))?.cycleId).toBeUndefined();
    // A proposal for a sprint that is no longer active changes nothing.
    const stale = await pmStore.appendReply({
      replyTo: [],
      text: "Close it.",
      proposals: [
        {
          kind: "close_cycle",
          summary: "Suggested: complete Sprint 4.",
          why: "every issue in it is Done",
          patch: { cycleId: s4.id, carryTo: "backlog" },
        },
      ],
    });
    expect(
      (await send("POST", `/api/pm/proposals/${stale.proposals?.[0]?.id}/apply`, {})).status,
    ).toBe(409);
    expect(await eventsOf("cycle/completed")).toHaveLength(before + 1);
  });

  it("DEC-57: a new sprint is one project's — without a project in a workspace of two it is refused, recording nothing", async () => {
    const before = count();
    const r = await send("POST", "/api/cycles", {
      name: "Loose",
      startsOn: "2026-12-01",
      endsOn: "2026-12-12",
    });
    expect(r.status).toBe(400);
    expect((await json<{ error: string }>(r)).error).toMatch(/one project's/);
    expect(count()).toBe(before);
  });

  it("DEC-57, DB-N11-5: Seshat's create_cycle plans the sprint in its issues' project, and one naming none is refused", async () => {
    const pmStore = new PmStore(log);
    const reply = await pmStore.appendReply({
      replyTo: [],
      text: "Plan the next sprint.",
      proposals: [
        {
          kind: "create_cycle",
          summary: "Suggested: plan Sprint 7 with one issue.",
          patch: {
            name: "Sprint 7",
            startsOn: "2026-12-14",
            endsOn: "2026-12-25",
            cardIds: [ids.c as string],
          },
        },
        {
          kind: "create_cycle",
          summary: "Suggested: plan Sprint 8.",
          patch: { name: "Sprint 8", startsOn: "2026-12-28", endsOn: "2027-01-08", cardIds: [] },
        },
      ],
    });
    const [withIssue, empty] = reply.proposals ?? [];
    expect((await send("POST", `/api/pm/proposals/${withIssue?.id}/apply`, {})).status).toBe(200);
    const cycles = (await json<{ cycles: Cycle[] }>(await send("GET", "/api/cycles"))).cycles;
    expect(cycles.find((c) => c.name === "Sprint 7")?.projectId).toBe(projectA);
    const before = count();
    const refused = await send("POST", `/api/pm/proposals/${empty?.id}/apply`, {});
    expect(refused.status).toBe(409);
    expect(count()).toBe(before);
    expect(
      (await json<{ cycles: Cycle[] }>(await send("GET", "/api/cycles"))).cycles.some(
        (c) => c.name === "Sprint 8",
      ),
    ).toBe(false);
  });
});
