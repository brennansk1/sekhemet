import { describe, expect, it } from "vitest";
import {
  CARD_STOP_REASONS,
  DEFAULT_STEP_BUDGET,
  STOP_REASONS,
  STOP_REASON_CLASSES,
  defaultSecondsBudget,
} from "../src/index.js";

describe("the stop-reason table (worker-loop rule 31)", () => {
  it("WL-T3-2: every stored reason has a class, parks, resumable, mayVerify and a next action", () => {
    for (const reason of CARD_STOP_REASONS) {
      const row = STOP_REASONS[reason];
      expect(row, reason).toBeDefined();
      expect(STOP_REASON_CLASSES, reason).toContain(row.class);
      expect(["yes", "no", "unless_gates_ran"], reason).toContain(row.parks);
      expect(typeof row.resumable, reason).toBe("boolean");
      expect(typeof row.mayVerify, reason).toBe("boolean");
      expect(row.nextAction.trim().length, reason).toBeGreaterThan(0);
      expect(row.goesTo.trim().length, reason).toBeGreaterThan(0);
    }
  });

  it("WL-T3-9: gate_passed alone is success; machine failures are environment", () => {
    const success = CARD_STOP_REASONS.filter((r) => STOP_REASONS[r].class === "success");
    expect(success).toEqual(["gate_passed"]);
    for (const r of [
      "memory_pressure",
      "quota_suspended",
      "error",
      "crashed",
      "rebase_conflict",
      "integration_failed",
    ] as const) {
      expect(STOP_REASONS[r].class, r).toBe("environment");
    }
    // Seven failure classes plus success, each used.
    const used = new Set(CARD_STOP_REASONS.map((r) => STOP_REASONS[r].class));
    expect([...used].sort()).toEqual([...STOP_REASON_CLASSES].sort());
    expect(STOP_REASON_CLASSES).toHaveLength(8);
  });

  it("WL-T3-10: holds the five v1 reasons with rule 31's values; CARD_STOP_REASONS is the table's keys", () => {
    expect([...CARD_STOP_REASONS].sort()).toEqual(Object.keys(STOP_REASONS).sort());
    expect(CARD_STOP_REASONS).toHaveLength(25);
    const want = {
      gate_suspected: ["capability_ceiling", "yes", false],
      tests_not_red_for_reason: ["no_progress", "yes", false],
      hook_veto: ["human_abort", "yes", true],
      git_metadata_tampered: ["scope_violation", "yes", false],
      crashed: ["environment", "no", true],
    } as const;
    for (const [reason, [cls, parks, resumable]] of Object.entries(want)) {
      const row = STOP_REASONS[reason as keyof typeof want];
      expect([row.class, row.parks, row.resumable], reason).toEqual([cls, parks, resumable]);
    }
  });

  it("base_not_green: a green-first card's tests failing on the base parks before any step and never measures the model (gates rule 6b)", () => {
    const row = STOP_REASONS.base_not_green;
    expect(row).toBeDefined();
    expect(row.measuresModel).toBe(false);
    expect([row.class, row.parks, row.resumable, row.mayVerify]).toEqual([
      "no_progress",
      "yes",
      false,
      false,
    ]);
    expect(row.goesTo).toMatch(/before any step/i);
    expect(row.nextAction).toMatch(/characterize, refactor or upgrade/);
    expect(row.nextAction).toMatch(/fail on the base/);
  });

  it("rule 31: human_abort's next action says who stopped it, then resume or reject", () => {
    expect(STOP_REASONS.human_abort.nextAction).toMatch(/who stopped it/i);
    expect(STOP_REASONS.human_abort.nextAction).toMatch(/resume or reject/i);
  });

  it("matches rule 31 for the eighteen the runner kept in hand-kept sets", () => {
    const resumable = CARD_STOP_REASONS.filter((r) => STOP_REASONS[r].resumable).sort();
    expect(resumable).toEqual(
      [
        "crashed",
        "error",
        "hook_veto",
        "human_abort",
        "memory_pressure",
        // WL-N10-2: a person's pause resumes from its checkpoint when handed back.
        "paused",
        "quota_suspended",
      ].sort(),
    );
    const budget = CARD_STOP_REASONS.filter((r) => STOP_REASONS[r].parks === "unless_gates_ran");
    expect(budget.sort()).toEqual(
      ["budget_exhausted", "time_budget_exhausted", "token_budget_exhausted"].sort(),
    );
    const noVerify = CARD_STOP_REASONS.filter(
      (r) => !STOP_REASONS[r].mayVerify && STOP_REASONS[r].class !== "success",
    );
    for (const r of [
      "human_abort",
      "memory_pressure",
      "quota_suspended",
      "time_budget_exhausted",
      "replan_requested",
      "scope_violation",
    ]) {
      expect(noVerify, r).toContain(r);
    }
  });
});

describe("one default budget (WL-T3-11)", () => {
  it("is 40 steps and 70 s per step", () => {
    expect(DEFAULT_STEP_BUDGET).toBe(40);
    expect(defaultSecondsBudget()).toBe(2800);
    expect(defaultSecondsBudget(10)).toBe(700);
  });

  it("never counts a stop the harness or the integration caused against the Worker (rule 31, DEC-42)", () => {
    for (const r of ["error", "rebase_conflict", "integration_failed"] as const) {
      expect(STOP_REASONS[r].measuresModel).toBe(false);
    }
    // Environment stops of every kind stay out of the competence model.
    for (const [reason, row] of Object.entries(STOP_REASONS)) {
      if (row.class === "environment") expect([reason, row.measuresModel]).toEqual([reason, false]);
    }
  });
});
