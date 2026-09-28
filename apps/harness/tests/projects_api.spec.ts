import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { CRITERIA_APPROVAL_HOLD, acceptBrief } from "@sekhemet/planner";
import type { ProjectsOverview } from "@sekhemet/ui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Audience } from "../src/pm/audience.js";
import { projectsOverview } from "../src/projects_api.js";
import { startDashboardServer } from "../src/server.js";

/**
 * dashboard DB-N9-9, DB-N9-21, DB-N9-7 (§2.11 Projects; teams item 5): the
 * facts of the Projects page — one entry per project the person can see,
 * with its lead, release, forecast range, target, what waits on the person
 * and what the Agent is doing; the Waiting on you list across projects; the
 * workspace's totals — served as `GET /api/projects/overview` (PM_CONTRACT §3).
 */

function kernel() {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const log = new EventLog(db);
  return { db, log, cards: new CardStore(db, log) };
}

async function workspace(k: ReturnType<typeof kernel>) {
  const repo = mkdtempSync(join(tmpdir(), "projects-api-"));
  const chronicle = await k.cards.ensureProject({ name: "Chronicle", rootPath: repo });
  const shop = await k.cards.ensureProject({ name: "Storefront", rootPath: join(repo, "shop") });
  const secret = await k.cards.ensureProject({ name: "Secret", rootPath: join(repo, "secret") });
  const mk = (
    title: string,
    projectId: string,
    extra: { owner?: string; status?: "backlog" | "ready" } = {},
  ) =>
    k.cards.createCard({
      tier: "task",
      title,
      status: extra.status ?? "ready",
      projectId,
      ...(extra.owner ? { owner: extra.owner } : {}),
    });
  const move = (id: string, to: "in_progress" | "done" | "review" | "parked" | "verify") =>
    k.cards.updateCardStatus(id, to, undefined, "human", { override: true });
  const hasher = await mk("Hasher", chronicle.id);
  await move(hasher.id, "in_progress");
  await move(hasher.id, "done");
  const ledger = await mk("Ledger", chronicle.id, { owner: "p_priya" });
  await move(ledger.id, "in_progress");
  await move(ledger.id, "verify");
  await move(ledger.id, "review");
  const theirs = await mk("Theirs", chronicle.id, { owner: "p_sam" });
  await move(theirs.id, "in_progress");
  await move(theirs.id, "verify");
  await move(theirs.id, "review");
  const search = await mk("Search", chronicle.id);
  await move(search.id, "in_progress");
  await mk("Export", chronicle.id);
  const pay = await mk("Payments", shop.id, { owner: "p_priya" });
  await move(pay.id, "parked");
  await k.cards.runs.requestDecision({
    cardId: search.id,
    kind: "planner",
    question: "Keep the old API?",
    context: "",
    options: ["Keep", "Drop"],
  });
  const hidden = await mk("Hidden work", secret.id, { owner: "p_priya" });
  await move(hidden.id, "in_progress");
  await move(hidden.id, "verify");
  await move(hidden.id, "review");
  // The Agent worked 20 minutes on Search today, and 5 on the hidden project.
  for (const [cardId, secondsUsed] of [
    [search.id, 1200],
    [hidden.id, 300],
  ] as const) {
    const a = await k.cards.runs.startAttempt({ cardId, attemptNumber: 1, modelId: "m" });
    await k.cards.runs.finishAttempt({
      attemptId: a.id,
      status: "failed",
      stopReason: "budget_exhausted",
      tokensUsed: 1,
      secondsUsed,
    });
  }
  return { repo, chronicle, shop, secret, hasher, ledger, search, pay };
}

const models: ProjectsOverview["models"] = {
  roles: [{ role: "worker", model: "coder", state: "resident" }],
  slots: { inUse: 1, capacity: 2 },
  queue: 1,
  memory: { usedBytes: 8, totalBytes: 16 },
};

describe("projectsOverview (DB-N9-9)", () => {
  it("Team: each project the person can see, its lead, release, target, waits and the Agent; totals over those only", async () => {
    const k = kernel();
    const w = await workspace(k);
    const audience: Audience = {
      setup: "team",
      nameOf: (x) => ({ p_priya: "Priya", p_sam: "Sam" })[x],
      levelOf: () => "member",
      canSee: (_p, project) => project !== w.secret.id,
      leadOf: (project) => (project === w.chronicle.id ? "p_sam" : undefined),
    };
    const now = new Date();
    const o = await projectsOverview({
      cardStore: k.cards,
      log: k.log,
      me: "p_priya",
      audience,
      now,
      repoPath: w.repo,
      models,
    });
    expect(o.setup).toBe("team");
    expect(o.models).toEqual(models);
    expect(o.projects.map((p) => p.name)).toEqual(["Chronicle", "Storefront"]);
    const [chronicle, shop] = o.projects;
    expect(chronicle).toMatchObject({
      id: w.chronicle.id,
      state: "active",
      lead: "Sam",
      // Health is recorded by B4.11 (teams NEW-teams-11): none is set yet.
      health: null,
      // No brief accepted: no release on the story map.
      release: null,
      // A sprint's end is not a project's target (DEC-37): no release target is recorded yet.
      target: null,
      // Priya's review; the unowned decision waits on the lead (Sam), not on her.
      waitingOnYou: 1,
      agent: { working: ["Search"], queued: 1 },
    });
    expect(chronicle?.forecast).toMatchObject({ remaining: 4, finished: 1, minimum: 5 });
    expect(shop).toMatchObject({ lead: null, waitingOnYou: 1, agent: { working: [], queued: 0 } });
    // Team, the project began today: no update is missing yet (TEAM-29).
    expect(shop?.updateMissing).toBe(false);
    expect(o.waiting.map((x) => ({ project: x.project, title: x.title, kind: x.kind }))).toEqual([
      { project: "Chronicle", title: "Ledger", kind: "review" },
      { project: "Storefront", title: "Payments", kind: "parked" },
    ]);
    for (const x of o.waiting) expect(Date.parse(x.since)).not.toBeNaN();
    // Hasher finished this month; the hidden project's time is not counted.
    expect(o.shippedThisMonth).toBe(1);
    expect(o.agentSecondsToday).toBe(1200);
    // DB-N9-7: no per-person figure anywhere in the facts.
    expect(JSON.stringify(o)).not.toMatch(/Hidden work|Secret/);
    rmSync(w.repo, { recursive: true, force: true });
  });

  it("Solo: every project, the person leads, and the decision waits on them", async () => {
    const k = kernel();
    const w = await workspace(k);
    // A plan waits for the person's approval of its criteria (Status's *Needs you*).
    await k.cards.createCard({
      tier: "story",
      title: "Plan me",
      status: "planning",
      projectId: w.chronicle.id,
      blockedReason: `${CRITERIA_APPROVAL_HOLD}: sekhemet approve it`,
    });
    // A person accepted Chronicle's brief: its first release is on the story map.
    await acceptBrief(
      { store: k.cards, log: k.log },
      {
        projectId: w.chronicle.id,
        baseline: "Notes live in a text file",
        slices: [
          {
            title: "Release 1",
            appetite: { cards: 4 },
            requirements: [{ title: "Save a note" }, { title: "List notes" }],
          },
        ],
      },
      k.log.localPrincipal(),
    );
    const o = await projectsOverview({
      cardStore: k.cards,
      log: k.log,
      me: k.log.localPrincipal(),
      repoPath: w.repo,
      models,
    });
    expect(o.setup).toBe("solo");
    expect(o.projects[0]?.release).toEqual({ name: "Release 1", done: 0, total: 2 });
    expect(o.projects[1]?.release).toBeNull();
    expect(o.projects.map((p) => p.name)).toEqual(["Chronicle", "Storefront", "Secret"]);
    expect(o.projects[0]).toMatchObject({ lead: "you", target: null, updateMissing: false });
    expect(o.waiting.map((x) => `${x.kind}:${x.title}`).sort()).toEqual([
      "decision:Search",
      "parked:Payments",
      "plan:Plan me",
      "review:Hidden work",
      "review:Ledger",
      "review:Theirs",
    ]);
    expect(o.waiting.find((x) => x.kind === "decision")?.question).toBe("Keep the old API?");
    expect(o.agentSecondsToday).toBe(1500);
    rmSync(w.repo, { recursive: true, force: true });
  });

  it("no projects: an empty list, so the page shows only Start your first project (DB-N9-21)", async () => {
    const k = kernel();
    const o = await projectsOverview({ cardStore: k.cards, log: k.log, me: "p", models });
    expect(o.projects).toEqual([]);
    expect(o.waiting).toEqual([]);
    expect(o.shippedThisMonth).toBe(0);
  });
});

describe("GET /api/projects/overview", () => {
  const k = kernel();
  let server: { port: number; close: () => Promise<void> };
  let w: Awaited<ReturnType<typeof workspace>>;

  beforeAll(async () => {
    w = await workspace(k);
    server = await startDashboardServer({
      db: k.db,
      log: k.log,
      boardService: new BoardServiceImpl(k.cards),
      cardStore: k.cards,
      repoPath: w.repo,
      port: 0,
      streamIntervalMs: 50,
      pressureLevel: () => 1,
    });
  });

  afterAll(async () => {
    await server.close();
    rmSync(w.repo, { recursive: true, force: true });
  });

  it("serves the overview with the models on this server", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/projects/overview`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { overview: ProjectsOverview };
    expect(body.overview.setup).toBe("solo");
    expect(body.overview.projects.map((p) => p.name)).toEqual([
      "Chronicle",
      "Storefront",
      "Secret",
    ]);
    expect(body.overview.models.roles.map((r) => r.role)).toEqual([
      "worker",
      "manager",
      "reviewer",
      "researcher",
    ]);
    expect(body.overview.models.slots.capacity).toBeGreaterThanOrEqual(1);
    // Search is the one issue being built: one slot in use.
    expect(body.overview.models.slots.inUse).toBe(1);
    expect(typeof body.overview.models.queue).toBe("number");
    expect(body.overview.models.memory?.totalBytes).toBeGreaterThan(0);
  });
});
