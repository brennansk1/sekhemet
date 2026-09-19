import { describe, expect, it } from "vitest";
import { calibratedStepBudget } from "../src/budget.js";

describe("planner-set dynamic step budgets (L21)", () => {
  it("keeps the prior until three passes are measured", () => {
    const d = calibratedStepBudget(40, { attempts: 5, passed: 2, stepsP80: 10 });
    expect(d).toMatchObject({ budget: 40, changed: false });
  });

  it("moves toward 1.25 x the p80 of passing attempts, at most 15% per calibration", () => {
    expect(calibratedStepBudget(40, { attempts: 6, passed: 4, stepsP80: 10 }).budget).toBe(34);
    expect(calibratedStepBudget(34, { attempts: 6, passed: 4, stepsP80: 10 }).budget).toBe(28);
    expect(calibratedStepBudget(13, { attempts: 6, passed: 4, stepsP80: 10 }).budget).toBe(13);
    expect(calibratedStepBudget(20, { attempts: 6, passed: 4, stepsP80: 30 }).budget).toBe(23);
    expect(calibratedStepBudget(4, { attempts: 6, passed: 4, stepsP80: 1 }).budget).toBe(4);
  });
});
