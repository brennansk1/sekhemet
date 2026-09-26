import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { AttemptOutcome } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { capabilityReport, capabilitySummary, wilson } from "../src/pm/capability.js";

describe("worker capability from evidence", () => {
  const repos: string[] = [];
  afterEach(() => {
    for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  it("computes a Wilson interval that is wide for small samples", () => {
    expect(wilson(2, 4)).toEqual({ low: 0.15, high: 0.85 });
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
  });

  it("WL-N5-2: groups first attempts from attempt/finished records by kind and finds the 80% size horizon", async () => {
    const repo = mkdtempSync(join(tmpdir(), "cap-"));
    repos.push(repo);
    mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
    // An evidence file is not an outcome source any more: this one would add a pass.
    writeFileSync(
      join(repo, ".sekhemet", "evidence", "ev_99.json"),
      JSON.stringify({ cardId: "a", attempt: 1, passed: true, linesAdded: 1 }),
    );
    const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    const store = new CardStore(db, new EventLog(db));
    const kinds: Record<string, string> = {
      a: "Interface",
      b: "Rule",
      c: "Rule",
      d: "Data",
      e: "Rule & Path",
      f: "Rule",
    };
    for (const [id, kind] of Object.entries(kinds)) {
      await store.createCard({ id, tier: "story", title: `T (SPIDR: ${kind})` });
    }
    const run = async (cardId: string, passed: boolean, linesAdded: number) => {
      const a = await store.runs.startAttempt({
        cardId,
        attemptNumber: store.runs.nextAttemptNumber(cardId),
        modelId: "m",
      });
      await store.runs.finishAttempt({
        attemptId: a.id,
        status: passed ? "passed" : "failed",
        stopReason: passed ? "gate_passed" : "budget_exhausted",
        tokensUsed: 1,
        secondsUsed: 1,
        linesAdded,
      });
    };
    await run("a", true, 20);
    await run("b", true, 40);
    await run("c", true, 45);
    await run("d", true, 30);
    await run("e", false, 150);
    await run("f", false, 180);
    await run("e", true, 150); // retries do not count toward first-attempt rates
    // A person's attempt says nothing about the Worker (MD-N6-2).
    await store.createCard({ id: "g", tier: "story", title: "T (SPIDR: Rule)" });
    const byPerson = await store.runs.startAttempt({
      cardId: "g",
      attemptNumber: 1,
      modelId: "m",
      builtBy: { kind: "person", id: "p_1" },
    });
    await store.runs.finishAttempt({
      attemptId: byPerson.id,
      status: "passed",
      stopReason: "gate_passed",
      tokensUsed: 0,
      secondsUsed: 1,
    });
    const cards = await store.listCards();
    db.close();

    const r = capabilityReport(repo, cards);
    expect(r.sampleSize).toBe(6);
    expect(r.types.find((t) => t.type === "Rule")).toMatchObject({ attempts: 4, passes: 2 });
    expect(r.horizon80Lines).toBe(50);
    expect(r.note).toMatch(/range/);
    expect(capabilitySummary(r)).toContain("Rules 2/4 (95% CI 15-85%)");
  });

  it("reports no attempts for a repository with no ledger", () => {
    const repo = mkdtempSync(join(tmpdir(), "cap-"));
    repos.push(repo);
    expect(capabilityReport(repo, []).sampleSize).toBe(0);
  });
});

describe("WL-N5-2: the readers of outcomes read the attempt record only", () => {
  it("the capability report, the Worker record and tune read no evidence file or queue report", () => {
    const src = join(__dirname, "..", "src");
    for (const file of ["pm/capability.ts", "pm/service.ts", "tune.ts"]) {
      const text = readFileSync(join(src, file), "utf8");
      expect(text, file).not.toMatch(/"evidence"|queue_report|QueueReport|"runs"\)/);
    }
  });
});

describe("B4.0a review M1/M2: the capability report on existing ledgers", () => {
  const o = (cardId: string, n: number, extra: Partial<AttemptOutcome> = {}) =>
    ({
      seq: 0,
      attemptId: `${cardId}-${n}`,
      cardId,
      attemptNumber: n,
      rung: 0,
      toolArm: "full",
      role: "worker",
      modelId: "m",
      status: "passed",
      passed: true,
      stopReason: "gate_passed",
      tokensUsed: 0,
      secondsUsed: 0,
      ruleIds: [],
      withheldRuleIds: [],
      exemplarIds: [],
      builtBy: { kind: "worker" },
      completedAt: "2026-09-25T00:00:00Z",
      ...extra,
    }) as AttemptOutcome;

  it("leaves a record without linesAdded out of the size curve, and counts it in the rates", () => {
    const r = capabilityReport("/nonexistent", [], [o("old", 1), o("new", 1, { linesAdded: 120 })]);
    expect(r.sizeCurve.reduce((n, b) => n + b.attempts, 0)).toBe(1);
    expect(r.sizeCurve[0]?.maxLines).toBe(200);
    expect(r.sampleSize).toBe(2);
  });

  it("counts a resume after a halt as the card's first attempt, and never the halt", () => {
    const r = capabilityReport(
      "/nonexistent",
      [],
      [
        o("a", 1, { passed: false, status: "failed", stopReason: "memory_pressure" }),
        o("a", 2, { linesAdded: 10 }),
      ],
    );
    expect(r.sampleSize).toBe(1);
    expect(r.types[0]?.passes).toBe(1);
  });
});
