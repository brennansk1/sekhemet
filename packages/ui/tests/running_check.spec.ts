import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeCard, statusLine } from "../src/vocabulary.js";

/**
 * Dashboard DB-N2-10 (B4.11; trace PMFE:466 restored): a card being
 * verified names the check that is running in its In progress badge —
 * *Running Tests…* — by the check's name as the Checks tab names it (a
 * rung's word, or the gate's own for a family rung); before any check has
 * started it says *Running checks…* (DEC-31: "checks", never "gates").
 */

const verifying = { status: "verify" as const, stepsUsed: 4, stepBudget: 20 };

describe("DB-N2-10: the In progress badge names the running check", () => {
  it("names a check by its rung's word, or its own name on a family rung", () => {
    expect(statusLine(verifying, { runningGate: { gate: "unit", rung: "test" } }).text).toBe(
      "Running Tests…",
    );
    expect(statusLine(verifying, { runningGate: { gate: "tsc", rung: "typecheck" } }).text).toBe(
      "Running Types…",
    );
    expect(
      statusLine(verifying, { runningGate: { gate: "licenses", rung: "security" } }).text,
    ).toBe("Running Licenses…");
    expect(statusLine(verifying, { runningGate: { gate: "unit", rung: "test" } })).toMatchObject({
      tone: "running",
      mark: "running",
    });
  });

  it("says Running checks… when none has started, and names the check over an earlier attempt's evidence", () => {
    expect(statusLine(verifying, {}).text).toBe("Running checks…");
    const failed = { passed: false, rungResults: [], failures: [] } as never;
    expect(
      statusLine(verifying, { evidence: failed, runningGate: { gate: "lint", rung: "lint" } }).text,
    ).toBe("Running Lint…");
  });

  it("names it only while the issue is in verification", () => {
    const running = { gate: "unit", rung: "test" };
    expect(
      statusLine({ ...verifying, status: "review" }, { runningGate: running }).text,
    ).not.toMatch(/^Running/);
    const card = {
      id: "c1",
      title: "Login",
      status: "verify",
      stepsUsed: 4,
      stepBudget: 20,
      tier: "task",
    } as never;
    expect(describeCard(card, { runningGate: running }).statusLine).toBe("Running Tests…");
  });
});

describe("DB-N2-10 on the page", () => {
  it("reads the board again when a card's running check starts, changes or ends", () => {
    const app = readFileSync(join(import.meta.dirname, "..", "web", "app.js"), "utf8");
    expect(app).toMatch(/addEventListener\("gate", \(\) => \{\n\s*void refreshBoard\(\)/);
  });
});
