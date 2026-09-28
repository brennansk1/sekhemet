import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Audience } from "../src/pm/audience.js";
import { postWeeklyUpdate } from "../src/pm/weekly.js";
import { startDashboardServer } from "../src/server.js";
import { projectSignals, statusFacts } from "../src/status_api.js";

/**
 * dashboard DB-N9-1..4, -8, DEC-37 (§2.8): what only the server knows for
 * Status — who may set health and post the update, the latest update, the
 * forecast range from the project's own throughput, Done this week with who
 * accepted it and the flow — scoped to one project and to what the person
 * can see (PM-N9-8). `GET /api/status` serves it; PM_CONTRACT §3.
 */
const DAY = 86_400_000;

function kernel() {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const log = new EventLog(db);
  return { db, log, cards: new CardStore(db, log) };
}

async function project(k: ReturnType<typeof kernel>) {
  const repo = mkdtempSync(join(tmpdir(), "status-api-"));
  const chronicle = await k.cards.ensureProject({ name: "Chronicle", rootPath: repo });
  const shop = await k.cards.ensureProject({ name: "Storefront", rootPath: join(repo, "shop") });
  const mk = (title: string, status: "backlog" | "ready" | "parked", projectId = chronicle.id) =>
    k.cards.createCard({
      tier: "task",
      title,
      status,
      projectId,
      ...(status === "parked" ? { blockedReason: "Waiting for the design" } : {}),
    });
  const hasher = await mk("Hasher", "ready");
  const ledger = await mk("Ledger", "ready");
  const search = await mk("Search", "ready");
  await mk("Export", "backlog");
  await mk("Parked idea", "parked");
  await k.cards.createCard({
    tier: "epic",
    title: "Ledger epic",
    status: "ready",
    projectId: chronicle.id,
  });
  const other = await mk("Checkout", "ready", shop.id);
  const move = (id: string, to: "in_progress" | "done" | "ready", reason?: string) =>
    k.cards.updateCardStatus(id, to, reason, "human", { override: true });
  // Hasher and Ledger finished; Search sent back once; Storefront's issue finished too.
  for (const c of [hasher, ledger, other]) {
    await move(c.id, "in_progress");
    await move(c.id, "done");
  }
  await move(search.id, "in_progress");
  await move(search.id, "ready", "returned: the tests are too weak");
  await k.log.append({
    actor: "human",
    type: "card/accepted",
    payload: { id: hasher.id, principal: k.log.localPrincipal() },
    principal: k.log.localPrincipal(),
  });
  await k.log.append({
    actor: "human",
    type: "card/accepted",
    payload: { id: other.id, principal: k.log.localPrincipal() },
    principal: k.log.localPrincipal(),
  });
  return { repo, chronicle, shop, hasher, search };
}

describe("Status facts (DB-N9-1..4, DB-N9-8)", () => {
  it("Solo: the project, who may post, the update once posted, the forecast range and the flow", async () => {
    const k = kernel();
    const p = await project(k);
    const me = k.log.localPrincipal();
    // Six days on: seven days of history, two issues finished on the first.
    const now = new Date(Date.now() + 6 * DAY);
    const facts = await statusFacts({
      cardStore: k.cards,
      log: k.log,
      me,
      project: p.chronicle.id,
      now,
      random: () => 0,
    });
    expect(facts).toMatchObject({
      setup: "solo",
      project: { id: p.chronicle.id, name: "Chronicle" },
      isLead: true,
      canSetHealth: true,
      // Health is recorded by B4.11 (teams NEW-teams-11): nothing offers to set it yet.
      healthWritable: false,
      health: null,
      update: null,
      updateMissing: false,
      canPostUpdate: true,
    });
    // Open: Search, Export (not the parked, the finished or the epic); the other project's not at all.
    expect(facts.forecast).toEqual({
      remaining: 2,
      p50Days: 1,
      p85Days: 1,
      historyDays: 7,
      finished: 2,
      minimum: 5,
    });
    expect(facts.acceptedThisWeek).toEqual([
      { title: "Hasher", by: "you", at: expect.any(String) },
    ]);
    expect(facts.flow).toMatchObject({
      days: 30,
      finished: 2,
      sentBack: 1,
      firstTime: { passed: 0, total: 0 },
    });
    expect(facts.flow.cycleHours).toHaveLength(2);

    await postWeeklyUpdate(k.log, {
      project: p.chronicle.id,
      text: "Status\nA good week.",
      principal: me,
    });
    const after = await statusFacts({
      cardStore: k.cards,
      log: k.log,
      me,
      project: p.chronicle.id,
      now,
    });
    expect(after.update).toEqual({
      text: "Status\nA good week.",
      by: "you",
      at: expect.any(String),
    });
    rmSync(p.repo, { recursive: true, force: true });
  });

  it("says there is not enough history below five days, and never gives one date", async () => {
    const k = kernel();
    const p = await project(k);
    const facts = await statusFacts({
      cardStore: k.cards,
      log: k.log,
      me: k.log.localPrincipal(),
      project: p.chronicle.id,
    });
    expect(facts.forecast).toEqual({ remaining: 2, historyDays: 1, finished: 2, minimum: 5 });
    rmSync(p.repo, { recursive: true, force: true });
  });

  it("Team: only the lead may post, and the lead alone is told the update is missing after 7 days", async () => {
    const k = kernel();
    const p = await project(k);
    const team = (lead: string): Audience => ({
      setup: "team",
      nameOf: (x) => ({ p_priya: "Priya", p_sam: "Sam" })[x],
      levelOf: (x) => (x === "p_priya" ? "member" : "member"),
      canSee: () => true,
      leadOf: () => lead,
    });
    const later = new Date(Date.now() + 8 * DAY);
    const lead = await statusFacts({
      cardStore: k.cards,
      log: k.log,
      me: "p_priya",
      project: p.chronicle.id,
      audience: team("p_priya"),
      now: later,
    });
    expect(lead).toMatchObject({
      setup: "team",
      isLead: true,
      canSetHealth: true,
      canPostUpdate: true,
      updateMissing: true,
      health: null,
    });
    // Eight days on, Hasher's accept is no longer this week's.
    expect(lead.acceptedThisWeek).toEqual([]);
    const member = await statusFacts({
      cardStore: k.cards,
      log: k.log,
      me: "p_sam",
      project: p.chronicle.id,
      audience: team("p_priya"),
      now: later,
    });
    expect(member).toMatchObject({
      isLead: false,
      canSetHealth: false,
      canPostUpdate: false,
      canUnpark: true,
      updateMissing: false,
    });
    // Unpark needs a Member (team/access.ts: review): a Stakeholder is not offered it.
    const stakeholder = await statusFacts({
      cardStore: k.cards,
      log: k.log,
      me: "p_sam",
      project: p.chronicle.id,
      audience: { ...team("p_priya"), levelOf: () => "stakeholder" },
      now: later,
    });
    expect(stakeholder.canUnpark).toBe(false);
    await postWeeklyUpdate(k.log, {
      project: p.chronicle.id,
      text: "Posted",
      principal: "p_priya",
    });
    const posted = await statusFacts({
      cardStore: k.cards,
      log: k.log,
      me: "p_priya",
      project: p.chronicle.id,
      audience: team("p_priya"),
      now: new Date(Date.now() + DAY),
    });
    // Posted a day ago: not missing; a week after it, missing again.
    expect(posted.updateMissing).toBe(false);
    expect(posted.update).toMatchObject({ text: "Posted", by: "you" });
    const week = await statusFacts({
      cardStore: k.cards,
      log: k.log,
      me: "p_priya",
      project: p.chronicle.id,
      audience: team("p_priya"),
      now: later,
    });
    expect(week.updateMissing).toBe(true);
    // A person who cannot see the project is told nothing about it (PM-N9-8).
    const hidden = await statusFacts({
      cardStore: k.cards,
      log: k.log,
      me: "p_sam",
      project: p.chronicle.id,
      audience: { ...team("p_priya"), canSee: () => false },
      now: later,
    });
    expect(hidden.project).toBeNull();
    expect(hidden.update).toBeNull();
    expect(hidden.acceptedThisWeek).toEqual([]);
    expect(hidden.forecast.remaining).toBe(0);
    rmSync(p.repo, { recursive: true, force: true });
  });
});

describe("Status's flow and forecast count each finished issue once", () => {
  it("an issue reverted and accepted again is one issue finished, not two", async () => {
    const k = kernel();
    const repo = mkdtempSync(join(tmpdir(), "status-api-"));
    const pr = await k.cards.ensureProject({ name: "Chronicle", rootPath: repo });
    const c = await k.cards.createCard({
      tier: "task",
      title: "Hasher",
      status: "ready",
      projectId: pr.id,
    });
    const move = (to: "in_progress" | "done") =>
      k.cards.updateCardStatus(c.id, to, undefined, "human", { override: true });
    await move("in_progress");
    await move("done");
    await move("in_progress");
    await move("done");
    const facts = await statusFacts({
      cardStore: k.cards,
      log: k.log,
      me: k.log.localPrincipal(),
      project: pr.id,
      now: new Date(Date.now() + 6 * DAY),
      random: () => 0,
    });
    expect(facts.flow.finished).toBe(1);
    expect(facts.forecast.finished).toBe(1);
    rmSync(repo, { recursive: true, force: true });
  });
});

describe("projectSignals: Status's risks are the page's project's only (PM-N9-8, DB-N9-1)", () => {
  const HOUR = 3_600_000;
  async function twoProjects() {
    const k = kernel();
    const repo = mkdtempSync(join(tmpdir(), "status-signals-"));
    const a = await k.cards.ensureProject({ name: "Chronicle", rootPath: repo });
    const b = await k.cards.ensureProject({ name: "Storefront", rootPath: join(repo, "b") });
    await k.cards.createCard({ tier: "task", title: "Search", status: "ready", projectId: a.id });
    // Project B: four issues in review and one blocked for 30 hours.
    for (const t of ["One", "Two", "Three", "Four"]) {
      const c = await k.cards.createCard({
        tier: "task",
        title: t,
        status: "ready",
        projectId: b.id,
      });
      for (const to of ["in_progress", "verify", "review"] as const)
        await k.cards.updateCardStatus(c.id, to, undefined, "human", { override: true });
    }
    const blocked = await k.cards.createCard({
      tier: "task",
      title: "Payments",
      status: "parked",
      projectId: b.id,
      blockedReason: "Waiting for the provider",
    });
    return { k, repo, a, b, blocked, later: new Date(Date.now() + 30 * HOUR) };
  }
  const fired = (s: { id: string; triggered: boolean }[]) =>
    s.filter((x) => x.triggered).map((x) => x.id);

  it("Team: Sam cannot see project B, so B's review queue and blocked issue reach neither A's page nor the workspace's", async () => {
    const w = await twoProjects();
    const sam = (project: string | undefined) => project !== w.b.id;
    const onA = await projectSignals({
      cardStore: w.k.cards,
      log: w.k.log,
      canSee: sam,
      project: w.a.id,
      reviewWip: 4,
      now: w.later,
    });
    expect(fired(onA)).toEqual([]);
    expect(onA.find((x) => x.id === "review_backlog")?.value).toBe(0);
    // Asking for B by name reads as no project; the workspace's leaves B out.
    for (const project of [w.b.id, undefined]) {
      const s = await projectSignals({
        cardStore: w.k.cards,
        log: w.k.log,
        canSee: sam,
        project,
        reviewWip: 4,
        now: w.later,
      });
      expect(fired(s)).toEqual([]);
      expect(JSON.stringify(s)).not.toContain(w.blocked.id);
    }
    // Priya sees B: its risks are on B's page, with B's own issues as targets.
    const onB = await projectSignals({
      cardStore: w.k.cards,
      log: w.k.log,
      canSee: () => true,
      project: w.b.id,
      reviewWip: 4,
      now: w.later,
    });
    expect(fired(onB).sort()).toEqual(["blocked_time", "review_backlog"]);
    expect(onB.find((x) => x.id === "blocked_time")?.response?.targets).toEqual([w.blocked.id]);
    rmSync(w.repo, { recursive: true, force: true });
  });

  it("GET /api/signals?project= serves one project's signals with the board's own In review limit", async () => {
    const w = await twoProjects();
    const server = await startDashboardServer({
      db: w.k.db,
      log: w.k.log,
      boardService: new BoardServiceImpl(w.k.cards),
      cardStore: w.k.cards,
      repoPath: w.repo,
      port: 0,
      streamIntervalMs: 50,
      pressureLevel: () => 1,
    });
    try {
      const get = async (q: string) =>
        (
          (await (await fetch(`http://127.0.0.1:${server.port}/api/signals${q}`)).json()) as {
            signals: { id: string; value: number; threshold?: number; triggered: boolean }[];
          }
        ).signals;
      const a = await get(`?project=${w.a.id}`);
      expect(a.find((x) => x.id === "review_backlog")).toMatchObject({
        value: 0,
        triggered: false,
      });
      const b = await get(`?project=${w.b.id}`);
      // 60 review minutes a day at the 15-minute prior: an In review limit of 4, not a fixed 3.
      expect(b.find((x) => x.id === "review_backlog")).toMatchObject({
        value: 4,
        threshold: 4,
        triggered: true,
      });
    } finally {
      await server.close();
      rmSync(w.repo, { recursive: true, force: true });
    }
  });
});

describe("GET /api/status and POST /api/cards/:id/unpark", () => {
  const k = kernel();
  let server: { port: number; close: () => Promise<void> };
  let base: string;
  let p: Awaited<ReturnType<typeof project>>;

  beforeAll(async () => {
    p = await project(k);
    server = await startDashboardServer({
      db: k.db,
      log: k.log,
      boardService: new BoardServiceImpl(k.cards),
      cardStore: k.cards,
      repoPath: p.repo,
      port: 0,
      streamIntervalMs: 50,
      pressureLevel: () => 1,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
    rmSync(p.repo, { recursive: true, force: true });
  });

  it("serves one project's facts", async () => {
    const res = await fetch(`${base}/api/status?project=${p.chronicle.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { facts: { project: { name: string }; setup: string } };
    expect(body.facts.project.name).toBe("Chronicle");
    expect(body.facts.setup).toBe("solo");
  });

  it("unparks a parked issue from Status's Needs you, and only from the dashboard", async () => {
    const parked = (await k.cards.listCards()).find((c) => c.title === "Parked idea");
    if (!parked) throw new Error("fixture");
    const url = `${base}/api/cards/${parked.id}/unpark`;
    expect((await fetch(url, { method: "POST" })).status).toBe(403);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sekhemet-Action": "1" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "ready" });
    expect((await k.cards.getCard(parked.id))?.status).toBe("ready");
    // Not parked any more: refused, with the reason.
    const again = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sekhemet-Action": "1" },
      body: "{}",
    });
    expect(again.status).toBe(409);
  });
});
