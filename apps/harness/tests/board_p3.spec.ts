import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { boardModel, tileModel } from "@sekhemet/ui";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";

/**
 * dashboard P3 on a real server (DB-P3-4, 9, 16): `/api/board` carries what
 * the tile and the In review header need — the owner's name, when work
 * started, and how the review limit was reached — and a reloaded page (GET
 * /api/board) builds the same board as one that stayed open on the stream.
 * Real SQLite file (DoD §2A).
 */
describe("the board API for the professional board (dashboard P3)", () => {
  let repo: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: { port: number; close: () => Promise<void> };
  const base = () => `http://127.0.0.1:${server.port}`;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "sekhemet-board-p3-"));
    db = new DatabaseSync(join(repo, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    store = new CardStore(db, log);
    await store.createCard({
      id: "card_run",
      tier: "story",
      title: "Stream the ledger verifier",
      assignee: "Jane Doe",
      delegate: { kind: "worker" },
      estimate: 3,
    });
    await store.updateCardStatus("card_run", "ready", "planned", "planner", { override: true });
    await store.updateCardStatus("card_run", "in_progress", "claimed", "worker", {
      override: true,
    });
    // Far enough apart that the second start has a later time than the first.
    await new Promise((r) => setTimeout(r, 15));
    await store.updateCardStatus("card_run", "ready", "retry", "harness", { override: true });
    await store.updateCardStatus("card_run", "in_progress", "claimed", "worker", {
      override: true,
    });
    await store.createCard({ id: "card_rev", tier: "task", title: "Review me", estimate: 2 });
    await store.updateCardStatus("card_rev", "review", "setup", "harness", { override: true });
    await store.createCard({ id: "card_park", tier: "task", title: "Parked one" });
    await store.updateCardStatus("card_park", "parked", "parked: Needs a decision", "human", {
      override: true,
    });
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store, { reviewMinutesPerDay: 60 }),
      cardStore: store,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 50,
    });
  });

  afterAll(async () => {
    await server.close();
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  type Board = {
    cards: {
      id: string;
      status: string;
      display: { ownerName?: string; startedAt?: string; enteredColumnAt?: string };
    }[];
    wipLimits: Record<string, number>;
    reviewLimit?: unknown;
    epics: { id: string; title: string }[];
    estimation?: "off" | "points";
  };

  const firstStart = () =>
    (
      db
        .prepare(
          `SELECT json_extract(payload, '$.updatedAt') AS at, created_at AS created FROM events
            WHERE type = 'card/status_changed' AND card_id = 'card_run'
              AND json_extract(payload, '$.toStatus') = 'in_progress' ORDER BY seq LIMIT 1`,
        )
        .get() as { at: string | null; created: string }
    ).at ??
    (
      db
        .prepare(
          `SELECT created_at AS created FROM events WHERE type = 'card/status_changed'
            AND card_id = 'card_run' AND json_extract(payload, '$.toStatus') = 'in_progress'
            ORDER BY seq LIMIT 1`,
        )
        .get() as { created: string }
    ).created;

  it("names the owner and dates the work item's age from its first start", async () => {
    const board = (await (await fetch(`${base()}/api/board`)).json()) as Board;
    const run = board.cards.find((c) => c.id === "card_run");
    expect(run?.display.ownerName).toBe("Jane Doe");
    expect(run?.display.startedAt).toBe(firstStart());
    // The second start is when it entered the column, not when work began.
    expect(run?.display.enteredColumnAt).not.toBe(run?.display.startedAt);
    const tile = tileModel(run as never, { now: Date.now() });
    expect(tile.owner).toEqual({ initials: "JD", name: "Jane Doe" });
    expect(tile.delegate).toEqual({ text: "Agent", worker: true });
  });

  it("DB-N7-2: carries the project's Preferences → Estimation, off until the team turns on story points", async () => {
    const project = (await store.ensureProject({ rootPath: repo, name: "Board P3" })).id;
    const board = async () =>
      (await (await fetch(`${base()}/api/board?project=${project}`)).json()) as {
        estimation?: string;
        cards: Parameters<typeof tileModel>[0][];
      };
    expect((await board()).estimation).toBe("off");
    const patch = (estimation: unknown) =>
      fetch(`${base()}/api/projects/${project}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-sekhemet-action": "1" },
        body: JSON.stringify({ estimation }),
      });
    expect((await patch("hours")).status).toBe(400);
    const on = await patch("points");
    expect(on.status).toBe(200);
    expect(((await on.json()) as { settings: { estimation: string } }).settings.estimation).toBe(
      "points",
    );
    const b = await board();
    expect(b.estimation).toBe("points");
    // The tile shows its points only now.
    const run = b.cards.find((c) => c.id === "card_run");
    expect(tileModel(run as never, { now: Date.now() }).points).toBeUndefined();
    expect(tileModel(run as never, { now: Date.now(), estimation: "points" }).points).toBe("3 pts");
    expect((await patch("off")).status).toBe(200);
    expect((await board()).estimation).toBe("off");
  });

  it("dates a later first start too, reading only the ledger entries since the last board", async () => {
    const seen: string[] = [];
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("AS cardId") && sql.includes("'in_progress'")) seen.push(sql);
      return prepare(sql);
    });
    try {
      await fetch(`${base()}/api/board`);
      await store.createCard({ id: "card_late", tier: "task", title: "Late" });
      await store.updateCardStatus("card_late", "in_progress", "claimed", "worker", {
        override: true,
      });
      const board = (await (await fetch(`${base()}/api/board`)).json()) as Board;
      expect(board.cards.find((c) => c.id === "card_late")?.display.startedAt).toBeDefined();
      expect(board.cards.find((c) => c.id === "card_run")?.display.startedAt).toBe(firstStart());
      // Each frame's read is bounded by the last one: never the whole ledger again.
      expect(seen.length).toBeGreaterThan(0);
      for (const sql of seen) expect(sql).toMatch(/seq > \?/);
    } finally {
      spy.mockRestore();
    }
  });

  it("says how the In review limit was reached", async () => {
    const board = (await (await fetch(`${base()}/api/board`)).json()) as Board;
    expect(board.reviewLimit).toEqual({
      limit: 4,
      fixed: false,
      minutesPerDay: 60,
      minutesPerCard: 15,
      reviews: 0,
    });
    expect(board.wipLimits.review).toBe(4);
  });

  it("DB-P3-16: a reload shows the same columns, tiles and statuses as the stream", async () => {
    const res = await fetch(`${base()}/api/stream?since=0`);
    const reader = res.body?.getReader();
    let text = "";
    while (reader && !/event: append\ndata: .*\n\n/.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader?.cancel();
    const line = /event: append\ndata: (.*)\n\n/.exec(text)?.[1] ?? "{}";
    const live = (JSON.parse(line) as { board: Board }).board;
    const reloaded = (await (await fetch(`${base()}/api/board`)).json()) as Board;
    const now = Date.now();
    const view = (b: Board) => {
      const m = boardModel({
        cards: b.cards,
        now,
        wipLimits: b.wipLimits,
        reviewLimit: b.reviewLimit as never,
        ...(b.estimation ? { estimation: b.estimation } : {}),
      });
      return {
        columns: m.columns.map((c) => ({
          id: c.id,
          header: [c.label, c.count, c.pointsText, c.limit?.text, c.limit?.derivation],
          tiles: c.cards.map((x) =>
            tileModel(x as never, {
              now,
              epics: b.epics,
              ...(b.estimation ? { estimation: b.estimation } : {}),
            }),
          ),
        })),
        chips: m.chips.map((c) => c.id),
      };
    };
    expect(view(live)).toEqual(view(reloaded));
    expect(view(reloaded).columns.map((c) => c.id)).toEqual([
      "in_progress",
      "in_review",
      "on_hold",
    ]);
    // Estimation is off (DB-N7-2): the header shows no points.
    expect(view(reloaded).columns[1]?.header).toEqual([
      "In review",
      1,
      "",
      "1 / 4",
      "Limit 4, from 60 review minutes a day at ~15 min per card (the starting estimate until you review a card).",
    ]);
  });
});
