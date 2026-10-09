import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type CardStatus, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardServiceImpl, type BoardServiceOptions } from "../src/board_service.js";
import type { EvidenceSummary } from "../src/types.js";

// kernel.md NEW-kernel-5 (the lifecycle's missing conditions: K-N5-1, K-N5-2,
// K-N5-7) and NEW-kernel-6 (K-N6-5: a person-built card meets the same
// conditions). Real SQLite files (DoD §2A).

describe("the lifecycle's entry conditions (NEW-kernel-5, K-N6-5)", () => {
  let dir: string;
  let db: DatabaseSync;
  let log: EventLog;
  let store: CardStore;
  let evidence: Record<string, EvidenceSummary>;
  const board = (extra: Partial<BoardServiceOptions> = {}) =>
    new BoardServiceImpl(store, {
      entryConditions: true,
      evidenceFor: (id) => evidence[id],
      ...extra,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-lifecycle-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    log = new EventLog(db);
    store = new CardStore(db, log);
    evidence = {};
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const count = async () => (await log.getEvents(1, 1_000_000)).length;
  const move = (
    b: BoardServiceImpl,
    cardId: string,
    fromStatus: CardStatus,
    toStatus: CardStatus,
    extra: { actor?: string; reason?: string; principal?: string } = {},
  ) =>
    b.transitionCard({
      cardId,
      fromStatus,
      toStatus,
      actor: extra.actor ?? "executor",
      ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
      ...(extra.principal ? { principal: extra.principal } : {}),
    });

  it("K-N5-1: Planning without a difficulty and no Planner is refused; with one, the move scores the card", async () => {
    await store.createCard({ id: "p", tier: "task", title: "P", acceptanceCriteria: ["x"] });
    const before = await count();
    await expect(move(board(), "p", "ready", "planning")).rejects.toMatchObject({
      code: "entry_condition",
      message: expect.stringMatching(/no Planner/),
    });
    expect(await count()).toBe(before);

    const scored = board({ planner: { scoreDifficulty: () => 6 } });
    await move(scored, "p", "ready", "planning");
    expect(await store.getCard("p")).toMatchObject({ status: "planning", difficulty: 6 });

    // A card already scored needs no Planner.
    await store.createCard({ id: "q", tier: "task", title: "Q", difficulty: 3 });
    await move(board(), "q", "ready", "planning");
    expect((await store.getCard("q"))?.status).toBe("planning");

    // A Planner's score outside 1–10 is refused, nothing moved.
    await store.createCard({ id: "r", tier: "task", title: "R" });
    await expect(
      move(board({ planner: { scoreDifficulty: () => 11 } }), "r", "ready", "planning"),
    ).rejects.toThrow(/1.10/);
    expect((await store.getCard("r"))?.status).toBe("ready");
  });

  it("K-N5-2: Parked needs a parking stop reason, a person's reason or an open decision request", async () => {
    const b = board();
    await store.createCard({ id: "a", tier: "task", title: "A" });
    const before = await count();
    await expect(move(b, "a", "ready", "parked")).rejects.toMatchObject({
      code: "entry_condition",
    });
    await expect(
      move(b, "a", "ready", "parked", { actor: "human", reason: "  " }),
    ).rejects.toMatchObject({ code: "entry_condition" });
    expect(await count()).toBe(before);
    // A person's reason.
    await move(b, "a", "ready", "parked", { actor: "human", reason: "waiting on the API key" });
    expect((await store.getCard("a"))?.status).toBe("parked");

    // A stop reason whose table entry parks.
    await store.createCard({ id: "s", tier: "task", title: "S", scopeFiles: ["s.ts"] });
    await move(b, "s", "ready", "in_progress");
    const att = await store.runs.startAttempt({ cardId: "s", attemptNumber: 1, modelId: "m" });
    await store.runs.finishAttempt({
      attemptId: att.id,
      status: "halted",
      stopReason: "gate_passed",
      tokensUsed: 1,
      secondsUsed: 1,
    });
    await expect(move(b, "s", "in_progress", "parked")).rejects.toMatchObject({
      code: "entry_condition",
    });
    const att2 = await store.runs.startAttempt({ cardId: "s", attemptNumber: 2, modelId: "m" });
    await store.runs.finishAttempt({
      attemptId: att2.id,
      status: "halted",
      stopReason: "capability_ceiling",
      tokensUsed: 1,
      secondsUsed: 1,
    });
    await move(b, "s", "in_progress", "parked");
    expect((await store.getCard("s"))?.status).toBe("parked");

    // An open default_deny decision request on the card parks it from the
    // request; one whose policy lets work proceed on the default does not.
    const decide = (cardId: string, policy: string) =>
      store.runs.requestDecision({
        cardId,
        kind: "planner",
        question: "Which API?",
        context: JSON.stringify({ planner: { policy } }),
        options: ["a", "b"],
      });
    await store.createCard({ id: "sd", tier: "task", title: "SD" });
    await decide("sd", "safe_default");
    await expect(
      move(b, "sd", "ready", "parked", { actor: "planner", reason: "awaiting a decision" }),
    ).rejects.toMatchObject({ code: "entry_condition" });
    await store.createCard({ id: "d", tier: "task", title: "D" });
    await decide("d", "default_deny");
    await move(b, "d", "ready", "parked", { actor: "planner", reason: "awaiting a decision" });
    expect((await store.getCard("d"))?.status).toBe("parked");
  });

  it("K-N5-7, N0: a Coding model window with no room for any issue is said as that, never a negative cap", async () => {
    const b = board({ zone3Fit: () => ({ tokens: 300, cap: 0 }) });
    await store.createCard({
      id: "tiny",
      tier: "task",
      title: "Tiny",
      status: "backlog",
      acceptanceCriteria: ["x"],
    });
    await expect(move(b, "tiny", "backlog", "ready")).rejects.toMatchObject({
      code: "entry_condition",
      message: expect.stringMatching(/Coding model's window leaves no room for any issue/),
    });
  });

  it("K-N5-7: Ready from Backlog or Planning is refused when Zone 3 does not fit; a parent is exempt", async () => {
    const zone3 = { tokens: 5000, cap: 3792 };
    const b = board({ zone3Fit: () => zone3 });
    await store.createCard({
      id: "big",
      tier: "task",
      title: "Big",
      status: "backlog",
      acceptanceCriteria: ["x"],
    });
    const before = await count();
    await expect(move(b, "big", "backlog", "ready")).rejects.toMatchObject({
      code: "entry_condition",
      message: expect.stringMatching(/Zone 3.*5,?000.*3,?792/),
    });
    expect(await count()).toBe(before);
    zone3.tokens = 3000;
    await move(b, "big", "backlog", "ready");
    expect((await store.getCard("big"))?.status).toBe("ready");

    // A parent never runs itself: exempt.
    zone3.tokens = 9000;
    await store.createCard({
      id: "parent",
      tier: "epic",
      title: "Parent",
      status: "backlog",
      acceptanceCriteria: ["x"],
    });
    await store.createCard({ id: "child", tier: "story", title: "Child", parentId: "parent" });
    await move(b, "parent", "backlog", "ready");
    expect((await store.getCard("parent"))?.status).toBe("ready");
  });

  it("K-N6-5: a person-built card meets the same Review condition; a failing blocking gate refuses without override", async () => {
    const b = board();
    await store.createCard({ id: "h", tier: "task", title: "H", scopeFiles: ["h.ts"] });
    await move(b, "h", "ready", "in_progress", { actor: "human", reason: "I will build it" });
    const att = await store.runs.startAttempt({
      cardId: "h",
      attemptNumber: 1,
      modelId: "none",
      builtBy: { kind: "person", id: "p_owner" },
    });
    await store.runs.finishAttempt({
      attemptId: att.id,
      status: "passed",
      stopReason: "done_pending_gates",
      tokensUsed: 0,
      secondsUsed: 1,
    });
    await move(b, "h", "in_progress", "verify", { actor: "human", reason: "built" });
    evidence.h = { passed: false, gatesRun: 2 };
    await expect(
      move(b, "h", "verify", "review", { actor: "human", principal: "p_owner" }),
    ).rejects.toMatchObject({ code: "entry_condition" });
    expect((await store.getCard("h"))?.status).toBe("verify");
    await move(b, "h", "verify", "review", {
      actor: "human",
      principal: "p_owner",
      reason: "override: flaky gate, checked by hand",
    });
    expect((await store.getCard("h"))?.status).toBe("review");
  });
});
