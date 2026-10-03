import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RetroFacts, retrospectiveDraft } from "../src/pm/retrospective.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";
import { type ReleaseProject, releaseProject } from "./release_fixture.js";

type Action = { kind: string; text: string; why: string; href?: string; title?: string };
type Draft = {
  wentWell: string[];
  slowed: string[];
  actions: Action[];
  text: string;
  basedOn: string;
};
type Retro = {
  due: { sprint?: { id: string; name: string }; from: string; to: string; reason: string } | null;
  draft: Draft | null;
  posted: { id: string; sprint?: string; text: string; by: string; at: string }[];
};

/**
 * The retrospective as a report for people (C2b; planner-pm §2.7 item 4,
 * NEW-planner-pm-11, PM-N11-1..3; FINDINGS_C1 PRC-03; DEC-05, DEC-36), over
 * HTTP against a real server, repository and ledger (DoD §2A): when a sprint
 * completes, or `retro_every_cards` issues are accepted in a Kanban project,
 * Seshat drafts one from the ledger — what went well, what slowed the team,
 * proposed actions — every figure computed by code, with its basis; drafting
 * changes nothing; a person edits and posts it, recorded and listed for
 * Status. No model.
 */
let p: ReleaseProject;
let server: { port: number; close: () => Promise<void> };
let base: string;

const send = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, data: (await r.json()) as Record<string, unknown> };
};
const retro = async () =>
  (await send("GET", `/api/projects/${p.project}/retrospectives`)).data as unknown as Retro;
const count = () =>
  Number((p.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number | bigint }).n);

async function serve() {
  server = await startDashboardServer({
    db: p.db,
    log: p.log,
    boardService: p.board,
    cardStore: p.store,
    repoPath: p.repo,
    port: 0,
    streamIntervalMs: 10_000,
  });
  base = `http://127.0.0.1:${server.port}`;
}

beforeEach(async () => {
  p = await releaseProject();
});
afterEach(async () => {
  await server?.close();
  p.close();
});

describe("PM-N11-1..3: a completed sprint's retrospective", () => {
  it("is drafted from the ledger when the sprint completes, changes nothing, and is posted by a person", async () => {
    await serve();
    const created = await send("POST", "/api/cycles", {
      name: "Sprint 1",
      startsOn: "2026-09-21",
      endsOn: "2026-10-02",
      projectId: p.project,
    });
    const sprint = (created.data.cycle as { id: string }).id;
    await p.review("c1", "Record a day's hours");
    await p.review("c2", "Flag hours past 40 as overtime");
    await p.store.createCard({
      id: "c3",
      tier: "story",
      title: "Export the week to payroll",
      status: "ready",
      projectId: p.project,
    });
    for (const id of ["c1", "c2", "c3"]) {
      expect((await send("PATCH", `/api/cards/${id}`, { cycleId: sprint })).status).toBe(200);
    }
    expect((await send("POST", `/api/cycles/${sprint}/start`, {})).status).toBe(200);
    // Scope added after the start.
    await p.store.createCard({
      id: "c4",
      tier: "story",
      title: "Show the weekly total",
      status: "ready",
      projectId: p.project,
    });
    expect((await send("PATCH", "/api/cards/c4", { cycleId: sprint })).status).toBe(200);

    await p.accept("c1");
    // Changes requested once, with a reason, then accepted.
    const back = await send("POST", "/api/cards/c2/return", {
      reason: "Name the overtime rule in tests/overtime.spec.ts",
    });
    expect(back.status).toBe(200);
    await p.store.updateCardStatus("c2", "review", "verified", "harness", { override: true });
    await p.accept("c2");
    // On hold, waiting on another team.
    expect(
      (await send("POST", "/api/cards/c3/park", { reason: "Waiting for payroll's file format" }))
        .status,
    ).toBe(200);

    expect((await retro()).due).toBeNull();
    const done = await send("POST", `/api/cycles/${sprint}/complete`, { carryTo: "backlog" });
    expect(done.status).toBe(200);

    // Seshat says the draft is ready, in the chat.
    const replies = await p.log.getEventsByTypes(["pm/reply"]);
    expect(String((replies.at(-1)?.payload as { text?: string }).text)).toBe(
      "I drafted the retrospective for Sprint 1 from the Activity log. Edit it and post it on Status; nothing changes until a person applies an action.",
    );

    const before = count();
    const r = await retro();
    expect(count()).toBe(before);
    expect(r.due?.sprint).toEqual({ id: sprint, name: "Sprint 1" });
    expect(r.due?.reason).toBe("Sprint 1 completed");
    const d = r.draft as Draft;
    expect(d.wentWell[0]).toBe(
      "2 issues accepted: Record a day's hours; Flag hours past 40 as overtime.",
    );
    expect(d.slowed).toContain(
      "Changes were requested once: “Name the overtime rule in tests/overtime.spec.ts” (Flag hours past 40 as overtime).",
    );
    expect(d.slowed.some((l) => l.startsWith("On hold: Export the week to payroll ("))).toBe(true);
    expect(d.slowed).toContain("Scope added during the sprint: Show the weekly total.");
    expect(d.actions).toEqual([
      {
        kind: "playbook",
        text: "Make the note you gave when requesting changes a Playbook rule, so the Agent is told it before its first try.",
        why: "Changes were requested once this sprint for a reason the Agent could have been told up front.",
        href: "#/playbook",
      },
      {
        kind: "issue",
        text: "Create an issue to remove what holds “Export the week to payroll”.",
        why: "It was on hold: Waiting for payroll's file format.",
        title: "Remove the blocker on “Export the week to payroll”",
      },
    ]);
    expect(d.basedOn).toMatch(/^Based on: Activity log #\d+–#\d+ · 2 issues accepted\.$/);
    expect(d.text.split("\n")[0]).toBe("Retrospective: Sprint 1");
    expect(d.text).toContain("What went well\n- 2 issues accepted");
    expect(d.text).toContain("What slowed the team\n- ");
    expect(d.text).toContain("Proposed actions\n- Make the note");
    expect(d.text.trim().split("\n").at(-1)).toBe(d.basedOn);

    // PM-N11-3: a person edits and posts it.
    const text = `${d.text}\n\nWe agreed: pair on the payroll export.`;
    const posted = await send("POST", `/api/projects/${p.project}/retrospectives`, {
      sprint,
      from: r.due?.from,
      to: r.due?.to,
      text,
    });
    expect(posted.status).toBe(200);
    const [ev] = await p.log.getEventsByTypes(["retrospective/posted"]);
    expect(ev?.payload).toMatchObject({
      project: p.project,
      sprint,
      from: r.due?.from,
      to: r.due?.to,
    });
    expect((ev?.private as { text: string }).text).toBe(text);
    expect(ev?.actor).toBe("human");
    expect(ev?.principal).toBe(p.log.localPrincipal());
    const after = await retro();
    expect(after.due).toBeNull();
    expect(after.draft).toBeNull();
    expect(after.posted.map((x) => [x.sprint, x.text])).toEqual([[sprint, text]]);
    // An empty retrospective is refused, and records nothing.
    const n = count();
    expect(
      (await send("POST", `/api/projects/${p.project}/retrospectives`, { text: "  " })).status,
    ).toBe(400);
    expect(count()).toBe(n);
  });
});

describe("PM-N11-1: a Kanban project's retrospective every retro_every_cards accepted issues", () => {
  it("is due once that many issues are accepted since the last one", async () => {
    mkdirSync(join(p.repo, ".sekhemet"), { recursive: true });
    writeFileSync(
      join(p.repo, ".sekhemet", "config.toml"),
      '[process]\nprofile = "kanban"\nretro_every_cards = 2\n',
    );
    await serve();
    await p.review("c1", "Record a day's hours");
    await p.accept("c1");
    expect((await retro()).due).toBeNull();
    await p.review("c2", "Fix the CSV header");
    await p.accept("c2");
    const r = await retro();
    expect(r.due?.reason).toBe("2 issues accepted since the last retrospective");
    expect(r.due?.sprint).toBeUndefined();
    expect(r.draft?.text.split("\n")[0]).toBe("Retrospective: the last 2 accepted issues");
    expect(
      (
        await send("POST", `/api/projects/${p.project}/retrospectives`, {
          from: r.due?.from,
          to: r.due?.to,
          text: r.draft?.text,
        })
      ).status,
    ).toBe(200);
    expect((await retro()).due).toBeNull();
  });
});

describe("PM-N11-2: proposed actions are proposals; a slow review proposes more review capacity", () => {
  const facts = (over: Partial<RetroFacts> = {}): RetroFacts => ({
    project: "proj_a",
    title: "Sprint 2",
    sprintWords: "this sprint",
    from: "2026-09-21T00:00:00.000Z",
    to: "2026-10-02T00:00:00.000Z",
    accepted: [{ id: "c1", title: "A" }],
    firstTime: { passed: 1, total: 1 },
    cycle: { hours: [3], serviceLevelHours: 4 },
    reviewWait: { hours: [30, 50], longest: { title: "A", hours: 50 } },
    changesRequested: [],
    onHold: [],
    scopeAdded: [],
    reviewMinutesPerDay: 60,
    basedOn: "Based on: Activity log #1–#9 · 1 issue accepted.",
    ...over,
  });

  it("proposes raising review capacity, naming the minutes, applied on Configuration", () => {
    const d = retrospectiveDraft(facts());
    expect(d.actions).toEqual([
      {
        kind: "review_capacity",
        text: "Raise review capacity from 60 to 90 minutes a day.",
        why: "Issues waited 40h for review at the median, longer than a working day.",
        href: "#/configuration/review",
      },
    ]);
    expect(d.slowed).toContain("Review wait: 40h at the median; the longest was A (50h).");
    expect(d.wentWell).toContain("1 of 1 issue passed its checks on the Agent's first try.");
    expect(d.wentWell).toContain(
      "1 of 1 issue finished within the service level of 4h (85% of this project's issues finish within it).",
    );
  });

  it("proposes nothing when nothing slowed the team, and says so", () => {
    const d = retrospectiveDraft(facts({ reviewWait: { hours: [1] } }));
    expect(d.actions).toEqual([]);
    expect(d.text).toContain(
      "Proposed actions\n- None: nothing slowed the team enough to change how it works.",
    );
  });
});
