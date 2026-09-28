import { CARD_STOP_REASONS, type CardRecord } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { STRIP_GROUP_AFTER, gateStripModel, stateBadge } from "../src/strip.js";
import { type EvidenceLike, describeCard, gateSummary, statusLine } from "../src/vocabulary.js";

/**
 * NEW-dashboard-1: evidence that stays readable. The gates strip groups by
 * check family past six gates, failing groups first (§2.5.3, DB-N1-1); a
 * card back in Planning reads *Needs a new plan*, never a failure mark on a
 * stage's name (DB-N1-3); no gate is synthesised (DB-N1-4).
 */

// 14 gates in 5 families, as the Chronicle ledger card ran them (domain17 §2).
const configured = [
  { id: "typecheck", rung: "typecheck", layer: "static" },
  { id: "lint", rung: "lint", layer: "static" },
  { id: "unit", rung: "test", layer: "functional" },
  { id: "acceptance", rung: "test", layer: "functional" },
  { id: "regression", rung: "test", layer: "functional" },
  { id: "gitleaks", rung: "security", layer: "security" },
  { id: "osv", rung: "security", layer: "security" },
  { id: "licenses", rung: "security", layer: "security" },
  { id: "semgrep", rung: "security", layer: "security" },
  { id: "trailers", rung: "hygiene", layer: "hygiene" },
  { id: "architecture", rung: "hygiene", layer: "hygiene" },
  { id: "claims", rung: "hygiene", layer: "hygiene" },
  { id: "mutation", rung: "robustness", layer: "robustness" },
];

function evidence(failing: string[]): EvidenceLike {
  return {
    passed: failing.length === 0,
    filesTouched: ["src/ledger.ts"],
    linesAdded: 20,
    linesRemoved: 2,
    rungResults: configured.map((g) => ({
      gate: g.id,
      rung: g.rung,
      passed: !failing.includes(g.id),
      durationMs: 100,
    })),
    failures: failing.map((id) => ({
      gate: id,
      rung: configured.find((g) => g.id === id)?.rung ?? id,
      errorExcerpt: `${id} failed`,
    })),
  };
}

const layers = Object.fromEntries(configured.map((g) => [g.id, g.layer]));

describe("the gates strip (DB-N1-1)", () => {
  it("groups 14 gates in 5 families into 5 segments, failing groups first, with +n passed", () => {
    const gates = gateSummary(evidence(["unit", "gitleaks"]), configured, { maxFiles: 10 });
    expect(gates).toHaveLength(14); // 13 declared, then the derived Size
    const strip = gateStripModel(gates, layers);
    expect(strip.grouped).toBe(true);
    expect(strip.segments.map((s) => [s.label, s.state, s.count, s.overflow])).toEqual([
      ["Tests", "fail", "2/3", "+2 passed"],
      ["Security", "fail", "3/4", "+3 passed"],
      ["Static", "pass", "2/2", ""],
      ["Mutation", "pass", "1/1", ""],
      ["Size and integrity", "pass", "4/4", ""],
    ]);
    // A failing group names the gates that failed, by their own names: four
    // security gates are never all called "Security" (domain17 §2).
    expect(strip.segments[0]?.failing.map((g) => g.label)).toEqual(["Tests"]);
    expect(strip.segments[1]?.failing.map((g) => g.label)).toEqual(["Gitleaks"]);
    expect(strip.segments[4]?.gates.map((g) => g.label)).toEqual([
      "Trailers",
      "Architecture",
      "Claims",
      "Size",
    ]);
  });

  it("keeps one segment per gate, in execution order, up to six gates", () => {
    const six = [...configured.slice(0, 3), ...configured.slice(5, 7)];
    const gates = gateSummary(
      {
        passed: false,
        rungResults: six.map((g) => ({ gate: g.id, rung: g.rung, passed: g.id !== "lint" })),
        failures: [{ gate: "lint", rung: "lint", errorExcerpt: "x" }],
        filesTouched: ["a"],
      },
      six,
    );
    expect(gates).toHaveLength(STRIP_GROUP_AFTER);
    const strip = gateStripModel(gates, layers);
    expect(strip.grouped).toBe(false);
    expect(strip.segments.map((s) => [s.label, s.state])).toEqual([
      ["Types", "pass"],
      ["Lint", "fail"],
      ["Tests", "pass"],
      ["Gitleaks", "pass"],
      ["OSV", "pass"],
      ["Size", "pass"],
    ]);
  });

  it("puts an unavailable group before passing ones, and never counts it as passed", () => {
    const gates = gateSummary(
      {
        ...evidence([]),
        passed: false,
        rungResults: configured.map((g) => ({
          gate: g.id,
          rung: g.rung,
          passed: g.id !== "osv",
          ...(g.id === "osv" ? { unavailable: true } : {}),
        })),
      },
      configured,
    );
    const strip = gateStripModel(gates, layers);
    expect(strip.segments[0]).toMatchObject({
      label: "Security",
      state: "unavailable",
      count: "3/4",
      overflow: "+3 passed",
    });
  });

  it("reads a gate's family from its id when gates.toml gives no layer", () => {
    const gates = gateSummary(evidence([]), configured);
    const strip = gateStripModel(gates, {});
    expect(strip.segments.map((s) => s.label)).toContain("Security");
    expect(strip.segments.every((s) => s.state === "pass")).toBe(true);
  });
});

describe("no synthesised gate (DB-N1-4)", () => {
  it("shows no Parse segment or pip when the evidence ran none and none is declared", () => {
    const gates = gateSummary(evidence([]), configured);
    expect(gates.some((g) => g.id === "parse" || g.label === "Parse")).toBe(false);
    const strip = gateStripModel(gates, layers);
    expect(strip.segments.flatMap((s) => s.gates).some((g) => g.label === "Parse")).toBe(false);
    const now = Date.parse("2026-09-18T14:12:00.000Z");
    const d = describeCard(card({ status: "review" }), { now, evidence: evidence([]) });
    expect(d.evidence?.gates.some((g) => g.label === "Parse")).toBe(false);
  });

  it("shows a declared Parse that did not run as Not run, never as passed", () => {
    const gates = gateSummary(evidence([]), [{ id: "parse", rung: "parse" }, ...configured]);
    expect(gates[0]).toMatchObject({ label: "Parse", state: "not_run" });
  });
});

function card(patch: Partial<CardRecord>): CardRecord {
  const now = "2026-09-18T14:00:00.000Z";
  return {
    id: "card_chron_ledger",
    tier: "story",
    title: "Append-only ledger",
    status: "verify",
    scopeFiles: ["src/ledger.ts"],
    stepBudget: 32,
    stepsUsed: 18,
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

describe("one badge for the issue's state (DB-N1-3)", () => {
  const failed: EvidenceLike = {
    passed: false,
    stopReason: "oscillation_detected",
    turnsUsed: 18,
    rungResults: [{ gate: "typecheck", rung: "typecheck", passed: false }],
    failures: [{ gate: "typecheck", rung: "typecheck", errorExcerpt: "TS2375" }],
  };

  it("a card back in Planning after a failed attempt needs a new plan, with no failure mark", () => {
    const line = statusLine(card({ status: "planning" }), { evidence: failed });
    expect(line).toEqual({
      text: "Needs a new plan · Types failed · 1 error",
      tone: "blocked",
      mark: "planning",
    });
    expect(stateBadge("planning", line.tone)).toEqual({
      text: "Needs a new plan",
      tone: "blocked",
      mark: "planning",
    });
  });

  it("never puts a failure mark on a stage's name", () => {
    expect(stateBadge("verify", "fail")).toEqual({ text: "Checks failed", tone: "fail" });
    expect(stateBadge("ready", "fail")).toEqual({ text: "Will retry", tone: "fail" });
    // Negative cases: a stage with nothing wrong keeps its column's name.
    expect(stateBadge("planning", "neutral")).toEqual({ text: "To do", tone: "neutral" });
    expect(stateBadge("review", "pass")).toEqual({ text: "In review", tone: "pass" });
    expect(stateBadge("parked", "parked")).toEqual({ text: "On hold", tone: "parked" });
  });

  it("covers every stop reason without a raw enum", () => {
    for (const reason of CARD_STOP_REASONS) {
      const line = statusLine(card({ status: "planning" }), {
        evidence: { ...failed, stopReason: reason },
      });
      expect(line.text.startsWith("Needs a new plan")).toBe(true);
      expect(line.mark).not.toBe("fail");
    }
  });
});
