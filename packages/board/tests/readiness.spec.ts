import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type CardRecord, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardServiceImpl } from "../src/board_service.js";

// dashboard NEW-dashboard-14 (DB-N14-2, DB-N14-3; FINDINGS PRC-12, DESIGN_GAPS
// b19): *Ready to start* names each of the kernel's entry conditions for
// building — met, or not met with its reason in plain words — read from the
// same checks the board enforces, enforcing nothing new: a card is ready by
// it exactly when the board lets it go Backlog → Ready → In progress, and
// reading it appends nothing. Real SQLite files (DoD §2A).

describe("Ready to start (DB-N14-2, DB-N14-3)", () => {
  let dir: string;
  let db: DatabaseSync;
  let log: EventLog;
  let store: CardStore;
  let board: BoardServiceImpl;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-ready-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    log = new EventLog(db);
    store = new CardStore(db, log);
    board = new BoardServiceImpl(store, {
      entryConditions: true,
      zone3Fit: async (card) => ({ tokens: card.title.length > 60 ? 5000 : 100, cap: 3792 }),
    });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const card = async (id: string, title: string, extra: Partial<CardRecord> = {}) =>
    (await store.createCard({
      id,
      tier: "task",
      title,
      status: "backlog",
      ...extra,
    })) as CardRecord;

  /** What the board allows, without moving anything: the same checks, asked. */
  const boardAllows = async (c: CardRecord) =>
    (await board.entryConditionFailure(c, {
      cardId: c.id,
      fromStatus: "backlog",
      toStatus: "ready",
      actor: "human",
    })) === undefined &&
    (await board.entryConditionFailure(c, {
      cardId: c.id,
      fromStatus: "ready",
      toStatus: "in_progress",
      actor: "human",
    })) === undefined;

  it("lists each condition met or not met, with its reason in words", async () => {
    await card("dep", "Import last month's timesheets", { acceptanceCriteria: ["Rows load."] });
    const c = await card("c1", "Pay public holidays at double time", {
      dependsOn: ["dep"],
      criterionIds: ["c1.c1"],
      acceptanceCriteria: ["A holiday hour pays double."],
    } as Partial<CardRecord>);
    expect(await board.readiness(c)).toEqual([
      {
        id: "dependencies",
        met: false,
        reason: "It waits on Import last month's timesheets, which is not done.",
      },
      { id: "criteria", met: true },
      { id: "approval", met: false, reason: "No one has approved its acceptance criteria yet." },
      { id: "suspect", met: true },
      { id: "scope", met: false, reason: "It declares no files it may change." },
      { id: "small", met: true },
    ]);
  });

  it("DB-N14-3: ready exactly when the board would let it start, and reading appends nothing", async () => {
    await card("dep", "A dependency", { acceptanceCriteria: ["x"], scopeFiles: ["a.ts"] });
    const cases = [
      await card("none", "No criteria", { scopeFiles: ["a.ts"] }),
      await card("noscope", "No scope", { acceptanceCriteria: ["x"] }),
      await card("big", "A title far too long to fit in the small context the Coding model has", {
        acceptanceCriteria: ["x"],
        scopeFiles: ["a.ts"],
      }),
      await card("waits", "Waits", {
        acceptanceCriteria: ["x"],
        scopeFiles: ["a.ts"],
        dependsOn: ["dep"],
      }),
      await card("ok", "Ready", { acceptanceCriteria: ["x"], scopeFiles: ["a.ts"] }),
    ];
    const before = log.lastSeq();
    const verdicts: [string, boolean][] = [];
    for (const c of cases) {
      const ready = (await board.readiness(c)).every((r) => r.met);
      expect([c.id, ready]).toEqual([c.id, await boardAllows(c)]);
      verdicts.push([c.id, ready]);
    }
    expect(verdicts).toEqual([
      ["none", false],
      ["noscope", false],
      ["big", false],
      ["waits", false],
      ["ok", true],
    ]);
    expect(log.lastSeq()).toBe(before);
    // And the board itself, asked to move them, agrees.
    await expect(
      board.transitionCard({
        cardId: "ok",
        fromStatus: "backlog",
        toStatus: "ready",
        actor: "human",
      }),
    ).resolves.toBeUndefined();
    await expect(
      board.transitionCard({
        cardId: "none",
        fromStatus: "backlog",
        toStatus: "ready",
        actor: "human",
      }),
    ).rejects.toThrow();
  });
});
