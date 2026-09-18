import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CardRecord } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import {
  BOARD_COLUMN_ORDER,
  EMPTY_SHA256,
  KIND_LABELS,
  columnLabel,
  describeCard,
  formatDuration,
  formatTokens,
  formatWait,
  gateLabel,
  gateSummary,
  outcomeSentence,
  parseTitle,
  statusLine,
  stopReasonLabel,
  vocabularyTables,
} from "../src/vocabulary.js";

const root = join(__dirname, "..", "..", "..");

const hasherEvidence = {
  id: "ev_962e5a7590",
  passed: false,
  stopReason: "oscillation_detected",
  turnsUsed: 8,
  durationMs: 4959,
  filesTouched: ["src/hasher.ts"],
  linesAdded: 11,
  linesRemoved: 0,
  rungResults: [
    { gate: "typecheck", rung: "typecheck", passed: false, durationMs: 658 },
    { gate: "unit", rung: "test", passed: false, durationMs: 900 },
  ],
  failures: [
    { gate: "typecheck", rung: "typecheck", errorExcerpt: "tests/hasher.spec.ts:25:7 TS2353: …" },
    { gate: "typecheck", rung: "typecheck", errorExcerpt: "tests/hasher.spec.ts:58:33 TS2353: …" },
    { gate: "typecheck", rung: "typecheck", errorExcerpt: "tests/hasher.spec.ts:59:28 TS2353: …" },
  ],
  gatesConfigSha256: EMPTY_SHA256,
};

function card(patch: Partial<CardRecord>): CardRecord {
  const now = "2026-09-18T14:00:00.000Z";
  return {
    id: "card_chron_hasher",
    tier: "story",
    title: "Implement canonical JSON and SHA-256 hash chaining (SPIDR: Rule)",
    status: "verify",
    scopeFiles: ["src/hasher.ts"],
    stepBudget: 32,
    stepsUsed: 8,
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

describe("parseTitle", () => {
  it("strips the SPIDR suffix into kind tags", () => {
    expect(parseTitle("Implement canonical JSON and SHA-256 hash chaining (SPIDR: Rule)")).toEqual({
      title: "Implement canonical JSON and SHA-256 hash chaining",
      kinds: ["rules"],
    });
    expect(parseTitle("Define contract types (SPIDR: Interface)").kinds).toEqual(["contract"]);
    expect(parseTitle("x (SPIDR: Data)").kinds).toEqual(["storage"]);
    expect(parseTitle("x (SPIDR: Path)").kinds).toEqual(["flow"]);
    expect(parseTitle("x (SPIDR: Spike)").kinds).toEqual(["research"]);
    expect(parseTitle("x (SPIDR: Visual)").kinds).toEqual(["ui"]);
    expect(parseTitle("x (SPIDR: Integration)").kinds).toEqual(["wiring"]);
  });

  it("keeps at most two kinds, primary first, for combined slices", () => {
    expect(parseTitle("x (SPIDR: Rule & Path)").kinds).toEqual(["rules", "flow"]);
    expect(parseTitle("x (SPIDR: Rule/Interface)").kinds).toEqual(["rules", "contract"]);
    expect(parseTitle("x (SPIDR: Interface & Integration)").kinds).toEqual(["contract", "wiring"]);
    expect(parseTitle("x (SPIDR: Rule, Path, Data)").kinds).toHaveLength(2);
  });

  it("leaves titles without a suffix alone and drops unknown slices", () => {
    expect(parseTitle("Plain title")).toEqual({ title: "Plain title", kinds: [] });
    expect(parseTitle("x (SPIDR: Mystery)")).toEqual({ title: "x", kinds: [] });
  });

  it("understands every suffix used by the fixtures", () => {
    const titles: string[] = [];
    for (const dir of readdirSync(join(root, "fixtures"))) {
      try {
        const cards = JSON.parse(readFileSync(join(root, "fixtures", dir, "cards.json"), "utf8"));
        for (const c of Array.isArray(cards) ? cards : (cards.cards ?? [])) titles.push(c.title);
      } catch {
        // Not every fixture ships cards.json (Chronicle seeds from a script).
      }
    }
    titles.push(
      ...[
        ...readFileSync(join(root, "scripts", "seed_chronicle.mjs"), "utf8").matchAll(
          /title: "([^"]+)"/g,
        ),
      ].map((m) => m[1] as string),
    );
    expect(titles.length).toBeGreaterThan(10);
    for (const t of titles) {
      const parsed = parseTitle(t);
      expect(parsed.title, t).not.toMatch(/SPIDR/);
      expect(parsed.kinds.length, t).toBeGreaterThan(0);
      for (const k of parsed.kinds) expect(KIND_LABELS[k]).toBeDefined();
    }
  });
});

describe("stopReasonLabel", () => {
  it("names every ExecutionStopReason in plain words", () => {
    const expected: Record<string, [string, string]> = {
      gate_passed: ["Passed", "pass"],
      budget_exhausted: ["Out of steps", "fail"],
      oscillation_detected: ["Looping", "fail"],
      no_progress: ["Stalled", "fail"],
      repair_exhausted: ["Couldn't fix", "fail"],
      error: ["Harness error", "fail"],
      memory_pressure: ["Paused for memory", "parked"],
      quota_suspended: ["Paused for quota", "parked"],
      scope_violation: ["Out of scope", "fail"],
      capability_ceiling: ["Too hard for this model", "fail"],
      human_abort: ["Stopped by you", "neutral"],
    };
    for (const [reason, [short, tone]] of Object.entries(expected)) {
      const label = stopReasonLabel(reason);
      expect(label.short, reason).toBe(short);
      expect(label.tone, reason).toBe(tone);
      expect(label.sentence).toMatch(/\.$/);
      expect(label.sentence).not.toContain("_");
    }
  });

  it("puts numbers in the sentence when it has them", () => {
    expect(stopReasonLabel("gate_passed", { step: 3 }).sentence).toBe(
      "All gates passed on step 3.",
    );
    expect(stopReasonLabel("budget_exhausted", { stepBudget: 32 }).sentence).toBe(
      "Used all 32 budgeted steps without passing.",
    );
    expect(stopReasonLabel("memory_pressure", { memoryPercent: 94 }).sentence).toContain("94%");
  });

  it("falls back to the humanised enum for an unknown reason", () => {
    expect(stopReasonLabel("disk_full").short).toBe("Disk full");
    expect(stopReasonLabel(undefined).short).toBe("Not run");
  });
});

describe("labels and numbers", () => {
  it("renames columns and gates", () => {
    expect(BOARD_COLUMN_ORDER).toContain("planning");
    expect(BOARD_COLUMN_ORDER).toContain("parked");
    expect(columnLabel("in_progress")).toBe("Working");
    expect(columnLabel("verify")).toBe("Checking");
    expect(columnLabel("rejected")).toBe("Closed");
    expect(gateLabel("typecheck")).toBe("Types");
    expect(gateLabel("unit")).toBe("Tests");
    expect(gateLabel("test")).toBe("Tests");
    expect(gateLabel("bounds")).toBe("Size");
    expect(gateLabel("custom_gate")).toBe("Custom gate");
  });

  it("formats waits, durations and tokens with units", () => {
    expect(formatWait(45_000)).toBe("45s");
    expect(formatWait(12 * 60_000)).toBe("12m");
    expect(formatWait(130 * 60_000)).toBe("2h 10m");
    expect(formatWait(120 * 60_000)).toBe("2h");
    expect(formatWait(27 * 3600_000)).toBe("1d 3h");
    expect(formatDuration(445)).toBe("0.4s");
    expect(formatDuration(1158)).toBe("1.2s");
    expect(formatDuration(1_330_000)).toBe("22m 10s");
    expect(formatTokens(180)).toBe("180");
    expect(formatTokens(2100)).toBe("2.1k");
    expect(formatTokens(16800)).toBe("16.8k");
    expect(formatTokens(12000)).toBe("12k");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });

  it("publishes the tables without raw enums in labels", () => {
    const tables = vocabularyTables() as { stopReasons: Record<string, { short: string }> };
    expect(tables.stopReasons.oscillation_detected?.short).toBe("Looping");
    expect(JSON.stringify(tables)).not.toMatch(/"(label|short)":"[a-z]+_[a-z_]+"/);
  });
});

describe("gates and outcomes", () => {
  it("lists gates in execution order with no synthetic Parse, then the derived Size", () => {
    const gates = gateSummary(hasherEvidence, [], { maxFiles: 3, maxDiffLines: 200 });
    expect(gates.map((g) => [g.label, g.state])).toEqual([
      ["Types", "fail"],
      ["Tests", "fail"],
      ["Size", "pass"],
    ]);
    expect(gates[0]?.failures).toBe(3);
    expect(gates[0]?.firstError).toContain("TS2353");
    expect(gates.some((g) => g.id === "parse")).toBe(false);
  });

  it("shows a declared gate that did not run as Not run", () => {
    const gates = gateSummary(hasherEvidence, [
      { id: "typecheck", rung: "typecheck" },
      { id: "lint", rung: "lint" },
      { id: "unit", rung: "test" },
    ]);
    expect(gates.map((g) => `${g.label}:${g.state}`)).toEqual([
      "Types:fail",
      "Lint:not_run",
      "Tests:fail",
      "Size:pass",
    ]);
  });

  it("fails Size when the diff exceeds the contract", () => {
    const big = { ...hasherEvidence, filesTouched: ["a", "b", "c", "d"] };
    expect(gateSummary(big, [], { maxFiles: 3 }).at(-1)?.state).toBe("fail");
  });

  it("writes the outcome sentence", () => {
    expect(outcomeSentence(hasherEvidence)).toBe("Failed Types and Tests · Looping on step 8");
    expect(
      outcomeSentence({
        passed: true,
        turnsUsed: 1,
        durationMs: 1158,
        filesTouched: ["src/types.ts"],
        linesAdded: 18,
        linesRemoved: 0,
        rungResults: [],
      }),
    ).toBe("Passed on step 1 · 1.2s · 1 file, +18 −0");
  });
});

describe("statusLine and describeCard", () => {
  const now = Date.parse("2026-09-18T14:12:00.000Z");

  it("hasher in Checking: title, kind and the failing gate", () => {
    const d = describeCard(card({}), { now, evidence: hasherEvidence });
    expect(d.title).toBe("Implement canonical JSON and SHA-256 hash chaining");
    expect(d.kinds).toEqual(["rules"]);
    expect(d.shortId).toBe("hasher");
    expect(d.statusLine).toBe("Types failed · 3 errors");
    expect(d.tone).toBe("fail");
    expect(d.stopLabel).toBe("Looping");
    expect(d.needsYou).toBe(true);
    expect(d.budgetText).toBe("8 of 32 steps");
    expect(d.evidence?.gates.map((g) => g.label)).toEqual(["Types", "Tests", "Size"]);
  });

  it("covers every column in words", () => {
    const at = "2026-09-18T14:00:00.000Z";
    const line = (patch: Partial<CardRecord>, ctx = {}) =>
      statusLine(card(patch), { now, enteredColumnAt: at, ...ctx });
    expect(line({ status: "ready", stepsUsed: 0 }).text).toBe("Ready · 32-step budget");
    expect(
      line({ status: "backlog" }, { waitsOn: [{ id: "a", title: "Tamper detection" }] }),
    ).toEqual({ text: "Waits on Tamper detection", tone: "blocked", mark: "blocked" });
    expect(line({ status: "planning" }).text).toBe("Planner is writing the plan");
    expect(line({ status: "in_progress", stepsUsed: 5 })).toMatchObject({
      text: "Step 5 of 32",
      tone: "running",
    });
    expect(line({ status: "verify" }).text).toBe("Running gates…");
    expect(line({ status: "review" }).text).toBe("Waiting 12m");
    expect(line({ status: "done" }).text).toBe("Accepted · 12m ago");
    expect(line({ status: "rejected" }).text).toBe("Closed");
    expect(line({ status: "parked" }, { statusReason: "parked: Needs a decision" })).toMatchObject({
      text: "Needs a decision",
      tone: "parked",
    });
    expect(
      line(
        { status: "parked" },
        { evidence: { ...hasherEvidence, stopReason: "memory_pressure", turnsUsed: 11 } },
      ).text,
    ).toBe("Paused for memory at step 11");
    expect(line({ status: "ready" }, { statusReason: "returned: fix it" }).text).toBe(
      "Sent back with your note",
    );
    expect(line({ status: "ready" }, { evidence: hasherEvidence }).text).toBe(
      "Types failed · 3 errors · will retry",
    );
  });

  it("never lets an internal enum or tier through", () => {
    const d = describeCard(card({ status: "in_progress", tier: "story" }), { now });
    expect(JSON.stringify(d)).not.toMatch(/in_progress|story|SPIDR/);
  });
});
