import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { type CardRecord, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { startDashboardServer } from "../src/server.js";
import { acquireSlotLease } from "../src/slot_lease.js";
import { FairScheduler, fairOrder, queueStanding } from "../src/team/fair_queue.js";

/**
 * runtime RUN-34 (fair share per person, interactive PM replies first, aging
 * past `max_wait_s`) and teams TEAM-30 (the per-person cap on concurrent
 * Agent issues, with place and estimate), on a real ledger and server.
 */

describe("the fair scheduler (RUN-34)", () => {
  it("shares model time per person in tokens", () => {
    let now = 1_000;
    const s = new FairScheduler({ maxWaitS: 600, now: () => now });
    s.enqueue({ id: "a1", person: "p_a", kind: "worker_step" });
    s.enqueue({ id: "a2", person: "p_a", kind: "worker_step" });
    s.enqueue({ id: "a3", person: "p_a", kind: "worker_step" });
    now += 1;
    s.enqueue({ id: "b1", person: "p_b", kind: "worker_step" });
    expect(s.next()?.id).toBe("a1");
    s.charge("p_a", { input: 1_000, output: 500 });
    expect(s.next()?.id).toBe("b1");
    s.charge("p_b", { input: 100, output: 10 });
    expect(s.next()?.id).toBe("a2");
    expect(s.next()?.id).toBe("a3");
    expect(s.next()).toBeUndefined();
  });

  it("costs output tokens above input tokens", () => {
    const s = new FairScheduler({ maxWaitS: 600, now: () => 0 });
    s.charge("p_a", { input: 1_000, output: 0 });
    s.charge("p_b", { input: 0, output: 600 });
    s.enqueue({ id: "a1", person: "p_a", kind: "worker_step" });
    s.enqueue({ id: "b1", person: "p_b", kind: "worker_step" });
    // 600 output tokens cost more than 1,000 input tokens: p_a goes first.
    expect(s.next()?.id).toBe("a1");
  });

  it("runs interactive PM replies ahead of Worker steps", () => {
    let now = 0;
    const s = new FairScheduler({ maxWaitS: 600, now: () => now });
    s.enqueue({ id: "w1", person: "p_a", kind: "worker_step" });
    now += 5_000;
    s.enqueue({ id: "pm1", person: "p_a", kind: "pm_reply" });
    expect(s.next()?.id).toBe("pm1");
    expect(s.next()?.id).toBe("w1");
  });

  it("promotes a request that waited longer than max_wait_s ahead of both", () => {
    let now = 0;
    const s = new FairScheduler({ maxWaitS: 60, now: () => now });
    s.charge("p_a", { input: 1_000_000, output: 0 });
    s.enqueue({ id: "w1", person: "p_a", kind: "worker_step" });
    now += 61_000;
    s.enqueue({ id: "pm1", person: "p_b", kind: "pm_reply" });
    s.enqueue({ id: "w2", person: "p_b", kind: "worker_step" });
    expect(s.next()?.id).toBe("w1");
    expect(s.next()?.id).toBe("pm1");
  });

  it("gives a person returning from idle no banked credit", () => {
    const s = new FairScheduler({ maxWaitS: 600, now: () => 0 });
    s.enqueue({ id: "a1", person: "p_a", kind: "worker_step" });
    s.next();
    s.charge("p_a", { input: 10_000, output: 0 });
    s.enqueue({ id: "a2", person: "p_a", kind: "worker_step" });
    // p_b arrives after p_a used 10,000 tokens: lifted to p_a's count, not 0.
    s.enqueue({ id: "b1", person: "p_b", kind: "worker_step" });
    s.enqueue({ id: "b2", person: "p_b", kind: "worker_step" });
    expect(s.next()?.id).toBe("a2");
    s.charge("p_a", { input: 1_000, output: 0 });
    expect(s.next()?.id).toBe("b1");
  });
});

describe("the shared queue on the ledger (RUN-34, TEAM-30)", () => {
  let repo: string;
  let db: DatabaseSync;
  let log: EventLog;
  let store: CardStore;
  let server: { port: number; close: () => Promise<void> } | undefined;

  const card = async (id: string, by: string, status: "ready" | "in_progress" = "ready") => {
    await store.createCard({ id, tier: "task", title: id, status });
    await store.delegateCard(id, { kind: "worker" }, by);
    return (await store.getCard(id)) as CardRecord;
  };
  const step = (cardId: string, input: number, output: number) =>
    log.appendNow({
      actor: "executor",
      type: "card/step",
      cardId,
      payload: {
        id: cardId,
        turn: 1,
        calls: [],
        usage: { promptTokens: input, completionTokens: output },
      },
    });
  const drain = async (it: AsyncIterable<CardRecord>, after?: (c: CardRecord) => void) => {
    const out: string[] = [];
    for await (const c of it) {
      out.push(c.id);
      after?.(c);
    }
    return out;
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "sek-fair-queue-"));
    writeFileSync(join(repo, "noop.mjs"), "");
    process.env.SEKHEMET_CLI = join(repo, "noop.mjs");
    db = new DatabaseSync(join(repo, "events.db"));
    initSchema(db);
    log = new EventLog(db);
    store = new CardStore(db, log);
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    Reflect.deleteProperty(process.env, "SEKHEMET_CLI");
    Reflect.deleteProperty(process.env, "SEKHEMET_USER_CONFIG");
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it("orders Ready cards by each person's tokens as the queue runs", async () => {
    const cards = [await card("a1", "p_a"), await card("a2", "p_a"), await card("b1", "p_b")];
    const sinceSeq = (await log.getLastEvent())?.seq ?? 0;
    const order = await drain(
      fairOrder(cards, { db, cardStore: store, cap: 1, maxWaitS: 600, sinceSeq }),
      // Each card the queue runs spends tokens for its person.
      (c) => step(c.id, 5_000, 1_000),
    );
    expect(order).toEqual(["a1", "b1", "a2"]);
  });

  it("runs other people's issues first while a person is at the cap (TEAM-30)", async () => {
    await card("x", "p_a", "in_progress");
    const cards = [await card("a1", "p_a"), await card("b1", "p_b"), await card("b2", "p_b")];
    const order = await drain(
      fairOrder(cards, { db, cardStore: store, cap: 1, maxWaitS: 600, sinceSeq: 0 }),
    );
    expect(order).toEqual(["b1", "b2", "a1"]);
    // Raised to two, p_a is under the cap and keeps their turn.
    const raised = await drain(
      fairOrder(cards, { db, cardStore: store, cap: 2, maxWaitS: 600, sinceSeq: 0 }),
    );
    expect(raised[0]).toBe("a1");
  });

  it("says where each queued issue stands and about how long it waits (TEAM-30)", async () => {
    await card("x", "p_a", "in_progress");
    // Two finished attempts of 6 minutes: the estimate's basis.
    for (const n of [1, 2]) {
      const a = await store.runs.startAttempt({ cardId: "x", attemptNumber: n, modelId: "m" });
      await store.runs.finishAttempt({
        attemptId: a.id,
        status: "passed",
        stopReason: "gate_passed",
        tokensUsed: 10,
        secondsUsed: 360,
      });
    }
    const cards = [await card("a1", "p_a"), await card("b1", "p_b")];
    const standing = await queueStanding(cards, {
      db,
      cardStore: store,
      cap: 1,
      maxWaitS: 600,
      sinceSeq: 0,
    });
    expect(standing).toEqual([
      {
        cardId: "b1",
        person: "p_b",
        place: 1,
        estimateSeconds: 360,
        message: "Next in queue, about 6 minutes",
      },
      {
        cardId: "a1",
        person: "p_a",
        place: 2,
        estimateSeconds: 720,
        message: "2nd in queue, about 12 minutes",
      },
    ]);
  });

  it("reads the per-person cap and the aging bound from the user config only", () => {
    const userConfig = join(repo, "user.toml");
    writeFileSync(
      userConfig,
      "[queue]\nagent_issues_per_person = 2\n[scheduler]\nmax_wait_s = 90\n",
    );
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    writeFileSync(
      join(repo, ".sekhemet", "config.toml"),
      "[queue]\nagent_issues_per_person = 9\n[scheduler]\nmax_wait_s = 1\n",
    );
    const cfg = resolveConfig({ repoPath: repo, userConfigPath: userConfig }).config;
    expect(cfg.queue.agentIssuesPerPerson).toBe(2);
    expect(cfg.scheduler.maxWaitS).toBe(90);
    const defaults = resolveConfig({
      repoPath: repo,
      userConfigPath: join(repo, "none.toml"),
    }).config;
    expect(defaults.queue.agentIssuesPerPerson).toBe(1);
    expect(defaults.scheduler.fairShare).toBe(true);
  });

  it("queues a person's next issue at the cap instead of starting it, with place and estimate (TEAM-30)", async () => {
    process.env.SEKHEMET_USER_CONFIG = join(repo, "none.toml");
    await card("card_x", "p_a", "in_progress");
    await card("card_b", "p_b");
    await store.createCard({ id: "card_a", tier: "task", title: "a", status: "ready" });
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 10_000,
      setup: "team",
      requester: () => "p_a",
    });
    log.appendNow({
      actor: "system",
      type: "member/joined",
      principal: "p_a",
      payload: { principal: "p_a", level: "admin", via: "invite", pending: false },
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/cards/card_a/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sekhemet-Action": "1" },
      body: "{}",
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ queued: true, cardId: "card_a", place: 2 });
    expect(String(body.message)).toMatch(/^2nd in queue, about \d+ minutes?$/);
    expect(body.started).toBeUndefined();
    const capped = (await log.getEventsByTypes(["queue/capped"])).at(-1);
    expect(capped?.payload).toEqual({ id: "card_a", cap: 1, running: 1 });
    expect(capped?.principal).toBe("p_a");
    // The queued issue is now p_a's, so the queue counts it toward p_a.
    expect(store.delegatorOf("card_a")).toBe("p_a");
    const standing = (await (
      await fetch(`http://127.0.0.1:${server.port}/api/queue/standing`)
    ).json()) as { entries: { cardId: string; place: number }[] };
    expect(standing.entries.map((e) => [e.cardId, e.place])).toEqual([
      ["card_b", 1],
      ["card_a", 2],
    ]);
  });

  it("says why each waiting card waits: all slots busy, or its files overlap a running card's (RUN-35)", async () => {
    process.env.SEKHEMET_USER_CONFIG = join(repo, "none.toml");
    const make = (id: string, scopeFiles: string[], status: "ready" | "in_progress" = "ready") =>
      store.createCard({ id, tier: "task", title: id, status, scopeFiles });
    await make("card_x", ["src/a.ts"], "in_progress");
    await make("card_y", ["src/c.ts"], "in_progress");
    await make("card_a", ["src/a.ts"]);
    await make("card_b", ["src/b.ts"]);
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 10_000,
      setup: "team",
      requester: () => "p_a",
      parallelSlots: () => 2,
    });
    const standing = async () =>
      new Map(
        (
          (await (await fetch(`http://127.0.0.1:${server?.port}/api/queue/standing`)).json()) as {
            entries: { cardId: string; waits?: string }[];
          }
        ).entries.map((e) => [e.cardId, e.waits]),
      );
    const x = acquireSlotLease(repo, { capacity: 2, cardId: "card_x", scopeFiles: ["src/a.ts"] });
    if (!x.granted) throw new Error(x.message);
    try {
      let now = await standing();
      expect(now.get("card_a")).toBe("waits for card_x (slot 0), which is editing src/a.ts");
      // One of two slots is free, and card_b's files are its own.
      expect(now.get("card_b")).toBeUndefined();
      const y = acquireSlotLease(repo, { capacity: 2, cardId: "card_y", scopeFiles: ["src/c.ts"] });
      if (!y.granted) throw new Error(y.message);
      try {
        now = await standing();
        expect(now.get("card_b")).toBe(
          "waits for a free slot: all 2 slots are running (card_x, card_y)",
        );
      } finally {
        y.release();
      }
    } finally {
      x.release();
    }
  });
});
