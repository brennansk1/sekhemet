import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardServiceImpl, legalPath } from "../src/board_service.js";
import type { EvidenceSummary } from "../src/types.js";

describe("@sekhemet/board entry conditions, review time, overlap, projects (B1, B3, B6, B8)", () => {
  let dir: string;
  let db: DatabaseSync;
  let log: EventLog;
  let store: CardStore;
  let evidence: Record<string, EvidenceSummary>;
  let board: BoardServiceImpl;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-entry-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    log = new EventLog(db);
    store = new CardStore(db, log);
    evidence = {};
    board = new BoardServiceImpl(store, {
      entryConditions: true,
      evidenceFor: (id) => evidence[id],
    });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const move = (
    cardId: string,
    fromStatus: never,
    toStatus: never,
    actor = "executor",
    reason?: string,
  ) => board.transitionCard({ cardId, fromStatus, toStatus, actor, ...(reason ? { reason } : {}) });

  it("refuses Ready without criteria, and any start while a prerequisite is open", async () => {
    await store.createCard({ id: "a", tier: "story", title: "A", status: "backlog" });
    await expect(move("a", "backlog" as never, "ready" as never)).rejects.toMatchObject({
      code: "entry_condition",
    });
    await store.updateCard("a", { acceptanceCriteria: ["returns 1"] });
    await move("a", "backlog" as never, "ready" as never);

    await store.createCard({
      id: "b",
      tier: "story",
      title: "B",
      scopeFiles: ["src/b.ts"],
      dependsOn: ["a"],
    });
    await expect(move("b", "ready" as never, "in_progress" as never)).rejects.toThrow(/waits on a/);
  });

  it("refuses In Progress without a declared scope, Review without passing evidence, Done without a person", async () => {
    await store.createCard({ id: "c", tier: "story", title: "C" });
    await expect(move("c", "ready" as never, "in_progress" as never)).rejects.toThrow(/scope/);
    await store.updateCard("c", { scopeFiles: ["src/c.ts"] });
    await move("c", "ready" as never, "in_progress" as never);
    await move("c", "in_progress" as never, "verify" as never);
    await expect(move("c", "verify" as never, "review" as never)).rejects.toThrow(/no evidence/);
    evidence.c = { passed: false, gatesRun: 2 };
    await expect(move("c", "verify" as never, "review" as never)).rejects.toThrow(/did not pass/);
    evidence.c = { passed: true, gatesRun: 2 };
    await move("c", "verify" as never, "review" as never);
    await expect(move("c", "review" as never, "done" as never, "executor")).rejects.toThrow(
      /Only a person/,
    );
    await move("c", "review" as never, "done" as never, "human");
  });

  it("lets a person override an entry condition, recorded on the ledger", async () => {
    await store.createCard({ id: "d", tier: "story", title: "D" });
    await move(
      "d",
      "ready" as never,
      "in_progress" as never,
      "human",
      "override: spike, no scope yet",
    );
    expect((await store.getCard("d"))?.status).toBe("in_progress");
    const [o] = await store.cardEvents("d", ["card/override"]);
    expect(o?.actor).toBe("human");
    expect(String((o?.payload as { overrode: string }).overrode)).toContain("entry condition");
  });

  it("refuses even an override past a failing security gate, into Review and into Done (B12)", async () => {
    await store.createCard({ id: "s", tier: "story", title: "S", scopeFiles: ["src/s.ts"] });
    evidence.s = { passed: false, gatesRun: 3, failingSecurityGates: ["secrets"] };

    const forced = "override: shipping this now, I checked it by hand";
    await expect(
      move("s", "verify" as never, "review" as never, "human", forced),
    ).rejects.toMatchObject({ code: "security_gate" });
    await expect(move("s", "review" as never, "done" as never, "human", forced)).rejects.toThrow(
      /secrets/,
    );
    // Refused means refused: the card is where it was, not part-moved.
    expect((await store.getCard("s"))?.status).toBe("ready");

    // Nothing else is tightened: a failing gate in another layer still yields
    // to a person who takes responsibility, and is recorded as their decision.
    evidence.s = { passed: false, gatesRun: 3 };
    await move("s", "verify" as never, "review" as never, "human", forced);
    expect((await store.getCard("s"))?.status).toBe("review");
    const [recorded] = await store.cardEvents("s", ["card/override"]);
    expect(recorded?.actor).toBe("human");

    // And the refusal outlives the failure: once the gate passes, the move goes through.
    evidence.s = { passed: true, gatesRun: 3 };
    await move("s", "review" as never, "done" as never, "human");
    expect((await store.getCard("s"))?.status).toBe("done");
  });

  it("measures review minutes from status changes and derives ReviewWIP (B3)", async () => {
    await store.createCard({ id: "r", tier: "story", title: "R", scopeFiles: ["x"] });
    // Two reviews of 30 and 90 minutes, recorded as the ledger would.
    const at = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString();
    const events = [
      ["ready", "review", 0],
      ["review", "ready", 30],
      ["ready", "review", 100],
      ["review", "done", 190],
    ] as const;
    for (const [from, to, m] of events) {
      await log.append({
        actor: "human",
        type: "card/status_changed",
        cardId: "r",
        payload: { id: "r", fromStatus: from, toStatus: to, updatedAt: at(m) },
      });
    }
    expect((await board.measuredReviewMinutes()).sort()).toEqual([30, 90]);
    // median 60 min; 240 minutes a day -> 4 cards.
    expect(await board.calibrateReviewWip(240)).toBe(4);
    expect((await board.getBoardState()).wipLimits.review).toBe(4);
  });

  it("finds running cards editing the same files, ignoring held ones (B6)", async () => {
    await store.createCard({
      id: "run1",
      tier: "story",
      title: "1",
      scopeFiles: ["src/**/*.ts"],
      status: "in_progress",
    });
    await store.createCard({
      id: "held",
      tier: "story",
      title: "h",
      scopeFiles: ["src/b.ts"],
      status: "in_progress",
      blockedReason: "held: verify refused",
    });
    const next = await store.createCard({
      id: "n",
      tier: "story",
      title: "n",
      scopeFiles: ["src/a/b.ts", "docs/x.md"],
    });
    expect(await board.overlappingRunning(next)).toEqual([
      { cardId: "run1", files: ["src/a/b.ts"] },
    ]);
    const free = await store.createCard({
      id: "f",
      tier: "story",
      title: "f",
      scopeFiles: ["docs/y.md"],
    });
    expect(await board.overlappingRunning(free)).toEqual([]);
  });

  it("scopes the board to a project (B8) and routes rollups by legal paths", async () => {
    const p1 = await store.ensureProject({ rootPath: "/one", name: "one" });
    const p2 = await store.ensureProject({ rootPath: "/two", name: "two" });
    await store.createCard({ id: "x1", tier: "story", title: "x1", projectId: p1.id });
    await store.createCard({ id: "x2", tier: "story", title: "x2", projectId: p2.id });
    const ids = (await board.getBoardState({ projectId: p2.id })).cards.map((c) => c.id);
    expect(ids).toEqual(["x2"]);
    expect(legalPath("in_progress", "done")).toEqual(["verify", "review", "done"]);
    expect(legalPath("done", "done")).toEqual([]);
  });
});
