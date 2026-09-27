import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { tileModel } from "@sekhemet/ui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { burnupFromEvents } from "../src/pm/metrics.js";
import { startDashboardServer } from "../src/server.js";

/**
 * dashboard P3 on the server (DB-P3-12, DB-P3-14): the burn-up's series is
 * replayed from the ledger — done and scope per day, scope growth apart from
 * progress — and quick create posts a create proposal to Seshat's thread that,
 * applied, goes through the one planner pipeline (PM-P1-1). A real repository
 * and an on-disk ledger (DEFINITION_OF_DONE §2A); no model is loaded.
 */
const ev = (type: string, cardId: string, payload: Record<string, unknown>, day: string) => ({
  type,
  cardId,
  payload: { id: cardId, ...payload },
  createdAt: `${day}T10:00:00.000Z`,
});
const events = [
  ev(
    "card/created",
    "ep",
    { tier: "epic", status: "ready", cycleId: "cyc_3", estimate: 8 },
    "2026-09-20",
  ),
  ev(
    "card/created",
    "a",
    { tier: "story", status: "ready", cycleId: "cyc_3", estimate: 3 },
    "2026-09-20",
  ),
  ev(
    "card/created",
    "b",
    { tier: "story", status: "ready", cycleId: "cyc_3", estimate: null },
    "2026-09-21",
  ),
  ev(
    "card/created",
    "c",
    { tier: "task", status: "backlog", cycleId: null, estimate: 5 },
    "2026-09-21",
  ),
  ev("card/status_changed", "a", { fromStatus: "ready", toStatus: "done" }, "2026-09-22"),
  ev(
    "card/created",
    "d",
    { tier: "task", status: "ready", cycleId: "cyc_3", estimate: null },
    "2026-09-22",
  ),
  // Scope grows: c joins the cycle; b is estimated.
  ev("card/updated", "c", { patch: { cycleId: "cyc_3" } }, "2026-09-23"),
  ev("card/updated", "b", { patch: { estimate: 2 } }, "2026-09-23"),
  // Scope shrinks: b is rejected.
  ev("card/status_changed", "b", { fromStatus: "ready", toStatus: "rejected" }, "2026-09-24"),
  ev("card/status_changed", "c", { fromStatus: "review", toStatus: "done" }, "2026-09-25"),
];
const now = new Date("2026-09-25T12:00:00.000Z");

describe("the burn-up series, replayed from the ledger (DB-P3-14)", () => {
  it("a cycle: done and scope per day from its start, unestimated cards as 1 point", () => {
    expect(
      burnupFromEvents(events, {
        cycle: { id: "cyc_3", name: "Cycle 3", startsOn: "2026-09-21", endsOn: "2026-09-27" },
        now,
      }),
    ).toEqual({
      scope: "cycle",
      cycleId: "cyc_3",
      name: "Cycle 3",
      startsOn: "2026-09-21",
      endsOn: "2026-09-27",
      days: [
        { date: "2026-09-21", done: 0, scope: 4 },
        { date: "2026-09-22", done: 3, scope: 5 },
        { date: "2026-09-23", done: 3, scope: 11 },
        { date: "2026-09-24", done: 3, scope: 9 },
        { date: "2026-09-25", done: 8, scope: 9 },
      ],
      unestimated: 1,
    });
  });

  it("the project: every card but epics and rejected ones, from the first card's day", () => {
    expect(burnupFromEvents(events, { now })).toEqual({
      scope: "project",
      days: [
        { date: "2026-09-20", done: 0, scope: 3 },
        { date: "2026-09-21", done: 0, scope: 9 },
        { date: "2026-09-22", done: 3, scope: 10 },
        { date: "2026-09-23", done: 3, scope: 11 },
        { date: "2026-09-24", done: 3, scope: 9 },
        { date: "2026-09-25", done: 8, scope: 9 },
      ],
      unestimated: 1,
    });
  });

  it("one project's burn-up counts only its cards, and a person only the projects they can see", () => {
    const two = [
      ...events.map((e) => ({ ...e, payload: { ...e.payload, projectId: "proj_a" } })),
      ev(
        "card/created",
        "z",
        { tier: "story", status: "ready", estimate: 13, projectId: "proj_b" },
        "2026-09-21",
      ),
      ev("card/status_changed", "z", { fromStatus: "ready", toStatus: "done" }, "2026-09-25"),
    ].sort((x, y) => x.createdAt.localeCompare(y.createdAt)); // the ledger's order
    const onlyA = burnupFromEvents(events, { now });
    expect(burnupFromEvents(two, { now, project: "proj_a" })).toEqual(onlyA);
    expect(burnupFromEvents(two, { now, canSee: (p) => p !== "proj_b" })).toEqual(onlyA);
    expect(burnupFromEvents(two, { now }).days.at(-1)).toEqual({
      date: "2026-09-25",
      done: 21,
      scope: 22,
    });
  });

  it("a cycle that has not started has no days yet", () => {
    expect(
      burnupFromEvents(events, {
        cycle: { id: "cyc_4", name: "Cycle 4", startsOn: "2026-10-01", endsOn: "2026-10-14" },
        now,
      }).days,
    ).toEqual([]);
  });
});

describe("the burn-up and quick create on a real server (DB-P3-12, DB-P3-14)", () => {
  let repo: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: { port: number; close: () => Promise<void> };
  const base = () => `http://127.0.0.1:${server.port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sekhemet-Action": "1" },
      body: JSON.stringify(body),
    });
  const today = new Date().toISOString().slice(0, 10);
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "sekhemet-map-create-"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture" }));
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "totals.ts"), "export const total = (xs: number[]) => 0;\n");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "e@x");
    git("config", "user.name", "E");
    git("add", "-A");
    git("commit", "-q", "-m", "feat: init");
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    store = new CardStore(db, log);
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 50,
      pressureLevel: () => 1,
    });
  });

  afterAll(async () => {
    await server.close();
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it("GET /api/metrics/burnup: the cycle's done and scope today, the project's, and 404 for no such cycle", async () => {
    const made = await post("/api/cycles", {
      name: "Cycle 1",
      startsOn: today,
      endsOn: inDays(6),
      state: "active",
    });
    const { cycle } = (await made.json()) as { cycle: { id: string } };
    await store.createCard({
      id: "card_a",
      tier: "story",
      title: "A",
      estimate: 3,
      cycleId: cycle.id,
    });
    await store.createCard({ id: "card_b", tier: "story", title: "B", cycleId: cycle.id });
    await store.createCard({ id: "card_c", tier: "story", title: "C", estimate: 5 });
    await store.updateCardStatus("card_a", "done", "accepted", "human", { override: true });

    const r = await fetch(`${base()}/api/metrics/burnup?cycle=${cycle.id}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { scope: string; days: unknown[]; unestimated: number };
    expect(body.scope).toBe("cycle");
    expect(body.days).toEqual([{ date: today, done: 3, scope: 4 }]);
    expect(body.unestimated).toBe(1);

    const p = (await (await fetch(`${base()}/api/metrics/burnup?scope=project`)).json()) as {
      days: { date: string; done: number; scope: number }[];
    };
    expect(p.days.at(-1)).toEqual({ date: today, done: 3, scope: 9 });
    // Another project's cards are not this project's burn-up.
    const proj = await store.ensureProject({ rootPath: join(repo, "atlas"), name: "Atlas" });
    await store.createCard({
      id: "card_z",
      tier: "story",
      title: "Z",
      estimate: 8,
      projectId: proj.id,
    });
    const all = (await (await fetch(`${base()}/api/metrics/burnup?scope=project`)).json()) as {
      days: { date: string; done: number; scope: number }[];
    };
    expect(all.days.at(-1)).toEqual({ date: today, done: 3, scope: 17 });
    const atlas = (await (
      await fetch(`${base()}/api/metrics/burnup?scope=project&project=${proj.id}`)
    ).json()) as { days: { date: string; done: number; scope: number }[] };
    expect(atlas.days.at(-1)).toEqual({ date: today, done: 0, scope: 8 });

    const missing = await fetch(`${base()}/api/metrics/burnup?cycle=cyc_nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "No cycle cyc_nope" });
  });

  it("POST /api/pm/create-card: a create proposal in Seshat's thread, applied through the planner", async () => {
    const refused = await post("/api/pm/create-card", { title: "  " });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "A card needs a title." });

    const r = await post("/api/pm/create-card", {
      title: "Export the monthly totals as CSV",
      description: "One CSV file with a row per month and its total in cents.",
    });
    expect(r.status).toBe(200);
    const { messageId, proposal } = (await r.json()) as {
      messageId: string;
      proposal: { id: string; kind: string; state: string; cards: Record<string, unknown>[] };
    };
    expect(proposal).toMatchObject({
      kind: "create_card",
      state: "open",
      cards: [
        {
          title: "Export the monthly totals as CSV",
          spec: "One CSV file with a row per month and its total in cents.",
        },
      ],
    });
    // Nothing is created until a person applies it.
    expect((await store.listCards()).some((c) => c.title.startsWith("Export the monthly"))).toBe(
      false,
    );

    const thread = (await (await fetch(`${base()}/api/pm/thread`)).json()) as {
      messages: { id: string; text: string; proposals?: { id: string }[] }[];
    };
    const message = thread.messages.find((m) => m.id === messageId);
    expect(message?.proposals?.map((p) => p.id)).toEqual([proposal.id]);
    expect(message?.text).not.toMatch(/CLI|terminal|sekhemet plan/i);

    const applied = await post(`/api/pm/proposals/${proposal.id}/apply`, {});
    expect(applied.status).toBe(200);
    const cards = await store.listCards();
    // The planner makes an epic for it (as `sekhemet plan` does) and the card under it.
    const made = cards.find(
      (c) => c.title === "Export the monthly totals as CSV" && c.tier !== "epic",
    );
    expect(made).toBeDefined();
    // The planner's pipeline, not a bare createCard: the plan is on the ledger
    // and the card carries the planner's criterion ids and points.
    expect((await store.cardEvents(made?.id as string, ["card/created"])).length).toBe(1);
    const plans = db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'plan/created'")
      .get() as { n: number };
    expect(plans.n).toBeGreaterThan(0);
    expect([1, 2, 3, 5, 8]).toContain(made?.estimate);
    expect(cards.find((c) => c.id === made?.parentId)?.tier).toBe("epic");

    // The first thing the person sees of it on the board: its tile, whose
    // approval hold points to the card's Approve, never to the CLI.
    const board = (await (await fetch(`${base()}/api/board`)).json()) as {
      cards: Parameters<typeof tileModel>[0][];
    };
    const tile = tileModel(board.cards.find((c) => c.id === made?.id) as never, {
      now: Date.now(),
    });
    expect(tile.blocker?.text).toContain("approval of its criteria: open the card to approve them");
    expect(tile.blocker?.text).not.toMatch(/CLI|terminal|sekhemet /i);
  });
});
