import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { ProjectsOverview } from "@sekhemet/ui";
import { afterEach, describe, expect, it } from "vitest";
import { liveRunCardIds } from "../src/live_runs.js";
import { projectsOverview } from "../src/projects_api.js";
import { leasePath, newLease } from "../src/runner_lease.js";
import { startDashboardServer } from "../src/server.js";

/**
 * Wave 2 A1 (dashboard §2.1.6, §2.2.3): the server's one fact behind every
 * "the Agent is working" — a card has a live run when a runner or slot lease
 * names it, or its attempt is running on the ledger. A card stored In
 * progress with neither (a person's move, a seed, an import) has none.
 */
const repos: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function board() {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const log = new EventLog(db);
  const cards = new CardStore(db, log);
  const repo = mkdtempSync(join(tmpdir(), "live-runs-"));
  repos.push(repo);
  const project = await cards.ensureProject({ name: "Timesheets", rootPath: repo });
  const card = await cards.createCard({
    tier: "task",
    title: "Work out the pay period of a date",
    status: "ready",
    projectId: project.id,
  });
  await cards.updateCardStatus(card.id, "in_progress", "setup", "harness", { override: true });
  return { db, log, cards, repo, card };
}

/** A live runner lease for the workspace (this process holds it), naming no card. */
function holdLease(repo: string, extra: Record<string, unknown> = { kind: "queue" }) {
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  writeFileSync(leasePath(repo), JSON.stringify({ ...newLease(), ...extra }));
}

const models: ProjectsOverview["models"] = {
  roles: [],
  slots: { inUse: 0, capacity: 1 },
  queue: 0,
  memory: null,
};

describe("liveRunCardIds (A1)", () => {
  it("a card stored In progress with no lease and no running attempt has no run", async () => {
    const b = await board();
    const all = await b.cards.listCards();
    expect(liveRunCardIds({ repoPath: b.repo, runs: b.cards.runs, cards: all }).size).toBe(0);
  });

  // Review finding 6: a killed runner (memory guard, OOM, sleep) leaves its
  // attempt "running" until the next supervisor sweep; no process is behind it.
  it("a running attempt with no live runner or slot lease is not a run", async () => {
    const b = await board();
    await b.cards.runs.startAttempt({ cardId: b.card.id, attemptNumber: 1, modelId: "m" });
    const all = await b.cards.listCards();
    expect(liveRunCardIds({ repoPath: b.repo, runs: b.cards.runs, cards: all }).size).toBe(0);
    // A lease whose holder is gone is no lease.
    holdLease(b.repo, { kind: "queue", pid: 999_999_999 });
    expect(liveRunCardIds({ repoPath: b.repo, runs: b.cards.runs, cards: all }).size).toBe(0);
  });

  it("a running attempt under a live runner lease is a run; a finished one is not", async () => {
    const b = await board();
    holdLease(b.repo);
    const a = await b.cards.runs.startAttempt({
      cardId: b.card.id,
      attemptNumber: 1,
      modelId: "m",
    });
    let all = await b.cards.listCards();
    expect([...liveRunCardIds({ repoPath: b.repo, runs: b.cards.runs, cards: all })]).toEqual([
      b.card.id,
    ]);
    await b.cards.runs.finishAttempt({
      attemptId: a.id,
      status: "failed",
      stopReason: "budget_exhausted",
      tokensUsed: 1,
      secondsUsed: 1,
    });
    all = await b.cards.listCards();
    expect(liveRunCardIds({ repoPath: b.repo, runs: b.cards.runs, cards: all }).size).toBe(0);
  });

  it("a live runner lease naming the card is a run, before its attempt begins", async () => {
    const b = await board();
    mkdirSync(join(b.repo, ".sekhemet"), { recursive: true });
    writeFileSync(
      leasePath(b.repo),
      JSON.stringify({ ...newLease(), kind: "run", cardId: b.card.id }),
    );
    const all = await b.cards.listCards();
    expect([...liveRunCardIds({ repoPath: b.repo, runs: b.cards.runs, cards: all })]).toEqual([
      b.card.id,
    ]);
  });
});

describe("the Projects overview and the board read it (A1, A2)", () => {
  it("Projects: a stored In progress card is not running; with a run it is the Agent's work", async () => {
    const b = await board();
    holdLease(b.repo);
    const read = async () =>
      (
        await projectsOverview({
          cardStore: b.cards,
          log: b.log,
          me: "p_me",
          repoPath: b.repo,
          models,
        })
      ).projects[0]?.agent;
    expect(await read()).toEqual({
      working: [],
      notRunning: ["Work out the pay period of a date"],
      queued: 0,
    });
    await b.cards.runs.startAttempt({ cardId: b.card.id, attemptNumber: 1, modelId: "m" });
    expect(await read()).toEqual({
      working: ["Work out the pay period of a date"],
      notRunning: [],
      queued: 0,
    });
  });

  it("the board marks each card's live run, and Projects' slots count runs, not stored states", async () => {
    const b = await board();
    holdLease(b.repo);
    const server = await startDashboardServer({
      db: b.db,
      log: b.log,
      boardService: new BoardServiceImpl(b.cards),
      cardStore: b.cards,
      repoPath: b.repo,
      port: 0,
      streamIntervalMs: 50,
      pressureLevel: () => 1,
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const card = async () =>
        (
          (await (await fetch(`${base}/api/board`)).json()) as {
            cards: { id: string; liveRun?: boolean }[];
          }
        ).cards.find((c) => c.id === b.card.id);
      const slots = async () =>
        (
          (await (await fetch(`${base}/api/projects/overview`)).json()) as {
            overview: ProjectsOverview;
          }
        ).overview.models.slots.inUse;
      expect((await card())?.liveRun).toBe(false);
      expect(await slots()).toBe(0);
      await b.cards.runs.startAttempt({ cardId: b.card.id, attemptNumber: 1, modelId: "m" });
      expect((await card())?.liveRun).toBe(true);
      expect(await slots()).toBe(1);
    } finally {
      await server.close();
    }
  });
});
