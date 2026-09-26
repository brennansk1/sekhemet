import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Goal, GoalStore, type PlannerLedger } from "../src/index.js";

// planner-pm PM-N4-3: a person marking a `human` criterion met is a goal
// event, carrying the principal, that the next evaluation reads. Real SQLite.

const goal = (): Goal => ({
  id: "goal_1",
  workspaceId: "ws",
  projectIds: [],
  statement: "Users can sign in, and the test suite passes.",
  criteria: [
    { id: "crit_1", text: "Users can sign in", kind: "human", status: "unmet" },
    { id: "crit_2", text: "the test suite passes", kind: "gate", status: "unmet" },
  ],
  budget: { tokens: 1000, hours: 1 },
  strategy: "epic_1",
  state: "active",
  assumptions: [],
  strategiesTried: 0,
  createdAt: new Date(0).toISOString(),
});

describe("human criterion marks (PM-N4-3)", () => {
  let dir: string;
  let db: DatabaseSync;
  let ledger: PlannerLedger;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sekhemet-goal-marks-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    ledger = { log, store: new CardStore(db, log) };
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records a person's mark as goal/criterion_marked and reads the latest per criterion", async () => {
    const goals = new GoalStore(ledger);
    await goals.create(goal());
    expect(await goals.humanMarks("goal_1")).toEqual({});
    await goals.markHuman("goal_1", "crit_1", true, "p_owner");
    const [event] = await ledger.log.getEventsByTypes(["goal/criterion_marked"]);
    expect(event?.payload).toEqual({ goalId: "goal_1", criterionId: "crit_1", met: true });
    expect(event?.principal).toBe("p_owner");
    expect(event?.actor).toBe("human");
    expect(await goals.humanMarks("goal_1")).toEqual({ crit_1: true });
    await goals.markHuman("goal_1", "crit_1", false, "p_owner");
    expect(await goals.humanMarks("goal_1")).toEqual({ crit_1: false });

    // Only a human criterion of a goal that exists, by a named person.
    await expect(goals.markHuman("goal_1", "crit_2", true, "p_owner")).rejects.toThrow(/human/);
    await expect(goals.markHuman("goal_9", "crit_1", true, "p_owner")).rejects.toThrow(/goal_9/);
    await expect(goals.markHuman("goal_1", "crit_1", true, "")).rejects.toThrow(/principal/);
  });
});
