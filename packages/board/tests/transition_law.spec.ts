import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { type CardStatus, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardServiceImpl } from "../src/board_service.js";
import type { EvidenceSummary } from "../src/types.js";

// kernel.md rules 26–28, S4: the board's moves are compare-and-sets against
// the stored status, a same-state move appends nothing, only a person with a
// principal may override, and Verify needs the attempt's stop reason.
// Real SQLite files (DoD §2A).

describe("the board under the transition law (S4)", () => {
  let dir: string;
  let db: DatabaseSync;
  let log: EventLog;
  let store: CardStore;
  let evidence: Record<string, EvidenceSummary>;
  let board: BoardServiceImpl;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-law-"));
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

  const count = async () => (await log.getEvents(1, 1_000_000)).length;
  const move = (
    cardId: string,
    fromStatus: CardStatus,
    toStatus: CardStatus,
    extra: { actor?: string; reason?: string; principal?: string } = {},
  ) =>
    board.transitionCard({
      cardId,
      fromStatus,
      toStatus,
      actor: extra.actor ?? "executor",
      ...(extra.reason ? { reason: extra.reason } : {}),
      ...(extra.principal ? { principal: extra.principal } : {}),
    });

  it("K-S4-1: a Backlog card sent {from: done, to: done} is refused with stale_from and stays in Backlog", async () => {
    await store.createCard({ id: "c", tier: "task", title: "C", status: "backlog" });
    const before = await count();
    await expect(move("c", "done", "done", { actor: "human" })).rejects.toMatchObject({
      code: "stale_from",
    });
    // Nor does a believed `from` open an edge the stored status does not have.
    await expect(move("c", "review", "done", { actor: "human" })).rejects.toMatchObject({
      code: "stale_from",
    });
    expect(await count()).toBe(before);
    expect((await store.getCard("c"))?.status).toBe("backlog");
  });

  it("K-S4-2: a move to the stored status appends nothing and changes nothing", async () => {
    await store.createCard({ id: "c", tier: "task", title: "C", acceptanceCriteria: ["x"] });
    const before = await count();
    await move("c", "ready", "ready", { actor: "human", reason: "again" });
    expect(await count()).toBe(before);
    expect((await store.getCard("c"))?.status).toBe("ready");
  });

  it("K-S4-5: refuses an override from any actor but a person with a principal, appending nothing", async () => {
    await store.createCard({ id: "c", tier: "task", title: "C", status: "backlog" });
    const before = await count();
    for (const actor of ["mcp", "harness", "worker", "planner", "executor"]) {
      await expect(
        move("c", "backlog", "rejected", { actor, reason: "override: spam" }),
      ).rejects.toMatchObject({ code: "override_forbidden" });
    }
    // A person, but no principal named.
    await expect(
      move("c", "backlog", "done", { actor: "human", reason: "override: trust me" }),
    ).rejects.toMatchObject({ code: "override_forbidden" });
    expect(await count()).toBe(before);
    // A person with a principal may, and the override names them.
    await move("c", "backlog", "done", {
      actor: "human",
      reason: "override: shipped by hand",
      principal: "p_owner",
    });
    expect((await store.getCard("c"))?.status).toBe("done");
    const [o] = await store.cardEvents("c", ["card/override"]);
    expect(o?.actor).toBe("human");
    expect(o?.payload).toMatchObject({ principal: "p_owner", overrode: "edge", to: "done" });
  });

  it("K-N5-8: moves a card with criteria, staged tests and a scope, and no plan, into In Progress", async () => {
    for (const from of ["ready", "planning"] as const) {
      const id = `np_${from}`;
      await store.createCard({
        id,
        tier: "task",
        title: "No plan",
        status: from,
        acceptanceCriteria: ["returns 1"],
        acceptanceTests: ["one.test.ts"],
        scopeFiles: ["src/one.ts"],
      });
      await move(id, from, "in_progress");
      expect((await store.getCard(id))?.status).toBe("in_progress");
      expect(await store.cardEvents(id, ["card/plan", "card/sketch"])).toEqual([]);
    }
  });

  it("K-S4-6: refuses Verify while the current attempt has no recorded stop reason", async () => {
    await store.createCard({
      id: "c",
      tier: "task",
      title: "C",
      acceptanceCriteria: ["x"],
      scopeFiles: ["src/a.ts"],
    });
    await move("c", "ready", "in_progress");
    // No attempt at all.
    await expect(move("c", "in_progress", "verify")).rejects.toMatchObject({
      code: "entry_condition",
      message: expect.stringMatching(/no attempt with a recorded stop reason/),
    });
    // An attempt still running.
    const a = await store.runs.startAttempt({ cardId: "c", attemptNumber: 1, modelId: "m" });
    await expect(move("c", "in_progress", "verify")).rejects.toMatchObject({
      code: "entry_condition",
    });
    await store.runs.finishAttempt({
      attemptId: a.id,
      status: "failed",
      stopReason: "no_progress",
      tokensUsed: 1,
      secondsUsed: 1,
    });
    await move("c", "in_progress", "verify");
    expect((await store.getCard("c"))?.status).toBe("verify");
  });
});

describe("acceptance and principals under the law (spine: the human is the rate limiter)", () => {
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;
  let evidence: Record<string, EvidenceSummary>;
  const open = (options: ConstructorParameters<typeof EventLog>[1] = {}) => {
    store = new CardStore(db, new EventLog(db, options));
    return new BoardServiceImpl(store, {
      entryConditions: true,
      evidenceFor: (id) => evidence[id],
    });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-accept-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    evidence = {};
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Drive a card from Ready to Review by the board's own rules. */
  const toReview = async (board: BoardServiceImpl, id: string, from: CardStatus = "ready") => {
    const mv = (f: CardStatus, t: CardStatus) =>
      board.transitionCard({ cardId: id, fromStatus: f, toStatus: t, actor: "executor" });
    await mv(from, "in_progress");
    const n = store.runs.listAttempts(id).length + 1;
    const a = await store.runs.startAttempt({ cardId: id, attemptNumber: n, modelId: "m" });
    await store.runs.finishAttempt({
      attemptId: a.id,
      status: "passed",
      stopReason: "gate_passed",
      tokensUsed: 1,
      secondsUsed: 1,
    });
    await mv("in_progress", "verify");
    evidence[id] = { passed: true, gatesRun: 1 };
    await mv("verify", "review");
  };
  const card = (id: string) =>
    store.createCard({
      id,
      tier: "task",
      title: id,
      acceptanceCriteria: ["x"],
      scopeFiles: [`src/${id}.ts`],
    });

  it("a person's acceptance does not carry over: after Done → Ready → … → Review the executor cannot accept", async () => {
    const board = open();
    await card("c");
    await toReview(board, "c");
    await board.transitionCard({
      cardId: "c",
      fromStatus: "review",
      toStatus: "done",
      actor: "human",
      principal: "p_owner",
    });
    expect((await store.getCard("c"))?.accepter).toBe("p_owner");
    await board.transitionCard({
      cardId: "c",
      fromStatus: "done",
      toStatus: "ready",
      actor: "human",
      principal: "p_owner",
      reason: "reopened",
    });
    expect((await store.getCard("c"))?.accepter).toBeUndefined();
    await toReview(board, "c");
    await expect(
      board.transitionCard({
        cardId: "c",
        fromStatus: "review",
        toStatus: "done",
        actor: "executor",
      }),
    ).rejects.toMatchObject({ code: "entry_condition", message: /Only a person accepts/ });
    expect((await store.getCard("c"))?.status).toBe("review");
  });

  it("K-N3-4: a merged pull request moves an accepted card to Done by its merge, not by the accepter field", async () => {
    const board = open();
    await card("m");
    await toReview(board, "m");
    await board.acceptWithPullRequest("m", { pr: 7, url: "u/7", headSha: "sha7" }, "p_owner");
    await board.closePullRequest("m", { pr: 7, merged: true }, "sync");
    expect((await store.getCard("m"))?.status).toBe("done");
    expect((await store.getCard("m"))?.accepter).toBe("p_owner");
  });

  it("K-S4-8: two concurrent board moves of one Ready card — one succeeds, the other is stale_from", async () => {
    const board = open();
    await card("r");
    const results = await Promise.allSettled([
      board.transitionCard({
        cardId: "r",
        fromStatus: "ready",
        toStatus: "in_progress",
        actor: "executor",
      }),
      board.transitionCard({
        cardId: "r",
        fromStatus: "ready",
        toStatus: "backlog",
        actor: "human",
        principal: "p_owner",
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason,
    ).toMatchObject({
      code: "stale_from",
    });
    expect(await store.cardEvents("r", ["card/status_changed"])).toHaveLength(1);
    expect((await store.verifyProjections()).identical).toBe(true);
  });

  it("K-N2-2: a solo install records the named principal on the move, and as the accepter", async () => {
    const board = open();
    await card("s");
    await toReview(board, "s");
    await board.transitionCard({
      cardId: "s",
      fromStatus: "review",
      toStatus: "done",
      actor: "human",
      principal: "p_bob",
    });
    const moves = await store.cardEvents("s", ["card/status_changed"]);
    expect(moves.at(-1)?.principal).toBe("p_bob");
    expect((await store.getCard("s"))?.accepter).toBe("p_bob");
  });

  it("K-N2-1, K-N2-2: a team setup records the named principal on a person's move", async () => {
    const board = open({ setup: "team" });
    await card("t");
    await board.transitionCard({
      cardId: "t",
      fromStatus: "ready",
      toStatus: "backlog",
      actor: "human",
      principal: "p_alice",
      reason: "not yet",
    });
    const [moved] = await store.cardEvents("t", ["card/status_changed"]);
    expect(moved?.principal).toBe("p_alice");
  });

  it("K-S4-5: an override refused by a WIP limit or back-pressure records no card/override", async () => {
    store = new CardStore(db, new EventLog(db));
    const board = new BoardServiceImpl(store, {
      entryConditions: true,
      evidenceFor: (id) => evidence[id],
      customLimits: { in_progress: 1 },
    });
    await card("busy");
    await board.transitionCard({
      cardId: "busy",
      fromStatus: "ready",
      toStatus: "in_progress",
      actor: "executor",
    });
    await store.createCard({ id: "o", tier: "task", title: "o", status: "backlog" });
    await expect(
      board.transitionCard({
        cardId: "o",
        fromStatus: "backlog",
        toStatus: "in_progress",
        actor: "human",
        principal: "p_owner",
        reason: "override: rush it",
      }),
    ).rejects.toMatchObject({ code: "wip_limit" });
    expect(await store.cardEvents("o", ["card/override"])).toEqual([]);
  });
});

describe("one path for every writer (K-S4-3)", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(ts|tsx|mts)$/.test(name) && !/\.d\.ts$/.test(name) ? [path] : [];
    });
  const productionSources = (): string[] =>
    ["packages", "apps"].flatMap((top) =>
      readdirSync(join(root, top)).flatMap((pkg) => {
        const src = join(root, top, pkg, "src");
        try {
          return statSync(src).isDirectory() ? sources(src) : [];
        } catch {
          return [];
        }
      }),
    );

  it("finds no status write outside packages/kernel and packages/board", () => {
    const files = productionSources();
    // The search is not vacuous: it reads the harness and the planner.
    expect(files.some((f) => f.includes(join("apps", "harness", "src")))).toBe(true);
    expect(files.some((f) => f.includes(join("packages", "planner", "src")))).toBe(true);
    const writers = files
      .map((f) => relative(root, f))
      .filter(
        (f) =>
          !f.startsWith(join("packages", "kernel")) && !f.startsWith(join("packages", "board")),
      )
      .filter((f) => /\bupdateCardStatus\s*\(/.test(readFileSync(join(root, f), "utf8")));
    expect(writers).toEqual([]);
  });
});
