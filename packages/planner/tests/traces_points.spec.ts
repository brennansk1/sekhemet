import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CARD_ESTIMATES, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
  type PlannerLedger,
  SpidrFeaturePlanner,
  estimatePoints,
  formatPlanReport,
  persistPlan,
} from "../src/index.js";

/**
 * Traces and points at persist (planner-pm §2.15.2, PM-P13-2; §2.6.2,
 * PM-N1-1/2): every card records the requirement ids and versions it traces
 * to, and a card that traces to none is refused and offered as a proposed
 * change; every card carries points derived from difficulty and history, and
 * an 8 is proposed for a split in the same plan.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function diskLedger(): PlannerLedger {
  const dir = mkdtempSync(join(tmpdir(), "sek-traces-"));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  return { log, store: new CardStore(db, log) };
}

const SPEC =
  "Implement user authentication with JWT session cookies, password hashing, and rate limiting.";

async function plan(l: PlannerLedger, spec = SPEC) {
  await l.store.createCard({ id: "epic_t", tier: "epic", title: spec, status: "in_progress" });
  return new SpidrFeaturePlanner().decomposeSpec({
    parentId: "epic_t",
    parentTier: "epic",
    spec,
  });
}

describe("PM-P13-2: a card records the requirements it traces to", () => {
  it("with no brief, derives requirements from the spec and links every card at version 1", async () => {
    const l = diskLedger();
    const p = await plan(l);
    const result = await persistPlan(l, p, { epicId: "epic_t" });
    const requirements = await l.store.requirements.list();
    expect(requirements.length).toBeGreaterThanOrEqual(3);
    expect(requirements.every((r) => r.mustHave)).toBe(true);
    expect(requirements.map((r) => r.title?.toLowerCase()).join(" | ")).toContain(
      "password hashing",
    );
    expect(result.created.length).toBeGreaterThan(0);
    for (const c of result.created) {
      const links = l.store.requirements.linksFrom("card", c.id);
      expect(links.length, c.id).toBeGreaterThan(0);
      for (const link of links) expect(link.version).toBe(1);
    }
  });

  it("reuses a requirement the project already has instead of deriving a duplicate", async () => {
    const l = diskLedger();
    await l.store.requirements.create(
      { title: "Password hashing for user authentication" },
      l.store.localPrincipal(),
    );
    const p = await plan(l);
    await persistPlan(l, p, { epicId: "epic_t" });
    const titles = (await l.store.requirements.list()).map((r) => r.title?.toLowerCase());
    expect(titles.filter((t) => t?.includes("password hashing")).length).toBe(1);
  });

  it("refuses a card that traces to no requirement and offers it as a proposed change", async () => {
    const l = diskLedger();
    await l.store.requirements.create(
      { title: "Rate limiting of login attempts" },
      l.store.localPrincipal(),
    );
    const p = await plan(l);
    // A brief's accepted requirements are the only ones: nothing is derived.
    const result = await persistPlan(l, p, { epicId: "epic_t", deriveRequirements: false });
    const orphan = p.stories.find((s) => /password hashing/i.test(s.card.title));
    expect(orphan).toBeDefined();
    expect(await l.store.getCard(orphan?.card.id as string)).toBeNull();
    expect(result.proposedChanges.map((c) => c.title)).toContain(orphan?.card.title);
    expect(formatPlanReport(result)).toMatch(/Proposed change/);
    const limiter = p.stories.find((s) => /rate limiting/i.test(s.card.title));
    expect(l.store.requirements.linksFrom("card", limiter?.card.id as string).length).toBe(1);
  });
});

describe("PM-N1-1: points from difficulty and the project's history", () => {
  it("writes an estimate in 1, 2, 3, 5, 8 on every planned card", async () => {
    const l = diskLedger();
    const result = await persistPlan(l, await plan(l), { epicId: "epic_t" });
    for (const c of result.created) {
      const card = await l.store.getCard(c.id);
      expect(CARD_ESTIMATES).toContain(card?.estimate);
    }
  });

  it("follows the project's finished cards of the same difficulty once there are enough", () => {
    expect(estimatePoints(5, []).points).toBe(3);
    expect(estimatePoints(5, []).basis).toBe("prior");
    const history = [5, 5.5, 6].map((difficulty) => ({ difficulty, estimate: 5 }));
    const measured = estimatePoints(5, history);
    expect(measured.points).toBe(5);
    expect(measured.basis).toBe("history");
    expect(estimatePoints(9, []).points).toBe(8);
    expect(estimatePoints(1, []).points).toBe(1);
  });
});

describe("PM-N1-2: an estimate of 8 proposes a split in the same plan", () => {
  it("lists the card as a proposed split and says so in the report", async () => {
    const l = diskLedger();
    // Three finished cards of every band, each estimated 8 by a person.
    for (const [i, d] of [2, 2, 2, 5, 5, 5, 8, 8, 8].entries()) {
      await l.store.createCard({
        id: `done_${i}`,
        tier: "story",
        title: `done ${i}`,
        status: "in_progress",
        difficulty: d,
        estimate: 8,
      });
      await l.store.updateCardStatus(`done_${i}`, "done", "fixture: finished", "human", {
        override: true,
      });
    }
    const result = await persistPlan(l, await plan(l), { epicId: "epic_t" });
    const eights = [];
    for (const c of result.created) {
      if ((await l.store.getCard(c.id))?.estimate === 8) eights.push(c.id);
    }
    expect(eights.length).toBeGreaterThan(0);
    expect(result.proposedSplits.map((s) => s.id).sort()).toEqual(eights.sort());
    expect(formatPlanReport(result)).toMatch(/Proposed split/);
  });
});

describe("PM-P1-20 (persist): a mechanism becomes an epic of its own", () => {
  it("creates the epic in Backlog, with no single card for the mechanism", async () => {
    const l = diskLedger();
    const p = await plan(l, "Build a repo map of the source tree.");
    const result = await persistPlan(l, p, { epicId: "epic_t" });
    expect(result.epics.map((e) => e.mechanism)).toEqual(["repo map"]);
    const epic = await l.store.getCard(result.epics[0]?.id as string);
    expect(epic?.tier).toBe("epic");
    expect(epic?.status).toBe("backlog");
    expect(formatPlanReport(result)).toMatch(/Re-split as an epic/);
    for (const c of result.created) expect(c.title).not.toMatch(/repo map/i);
  });
});
