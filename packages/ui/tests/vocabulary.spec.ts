import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CARD_STOP_REASONS, type CardRecord, STOP_REASONS } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import {
  BOARD_COLUMN_ORDER,
  EMPTY_SHA256,
  GATE_STATE_LABELS,
  ISSUE_TYPE_LABELS,
  actorLabel,
  callPhrase,
  checkFixHint,
  columnLabel,
  describeCard,
  eventSentence,
  formatDuration,
  formatTokens,
  formatWait,
  gateLabel,
  gateSummary,
  humanize,
  isEmptyGateContract,
  issueTypeOf,
  loopRange,
  outcomeSentence,
  parseTitle,
  statusLine,
  stopReasonLabel,
  summarizeRun,
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
      kinds: ["rule"],
    });
    // DB-N2-4: the kernel's stored kinds, never a second enumeration; UI and
    // Wiring are refinements of an `implement` card (NAMING).
    expect(parseTitle("Define contract types (SPIDR: Interface)").kinds).toEqual(["interface"]);
    expect(parseTitle("x (SPIDR: Data)").kinds).toEqual(["data"]);
    expect(parseTitle("x (SPIDR: Path)").kinds).toEqual(["implement"]);
    expect(parseTitle("x (SPIDR: Spike)").kinds).toEqual(["spike"]);
    expect(parseTitle("x (SPIDR: Visual)").kinds).toEqual(["implement"]);
    expect(parseTitle("x (SPIDR: Integration)").kinds).toEqual(["implement"]);
  });

  it("keeps at most two kinds, primary first, for combined slices", () => {
    expect(parseTitle("x (SPIDR: Rule & Path)").kinds).toEqual(["rule", "implement"]);
    expect(parseTitle("x (SPIDR: Rule/Interface)").kinds).toEqual(["rule", "interface"]);
    expect(parseTitle("x (SPIDR: Interface & Integration)").kinds).toEqual([
      "interface",
      "implement",
    ]);
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
      // Each older title reads as a standard issue type (DEC-31).
      expect(ISSUE_TYPE_LABELS[issueTypeOf({ title: t })], t).toBeDefined();
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

  it("labels every stop reason the kernel defines, including wave 1's", () => {
    const wave1: Record<string, [string, string]> = {
      done_pending_gates: ["Done, checks not run", "blocked"],
      token_budget_exhausted: ["Out of tokens", "fail"],
      time_budget_exhausted: ["Out of time", "fail"],
      replan_requested: ["Needs a new plan", "blocked"],
      vacuous_tests: ["Tests already pass", "parked"],
    };
    for (const [reason, [short, tone]] of Object.entries(wave1)) {
      expect(stopReasonLabel(reason).short, reason).toBe(short);
      expect(stopReasonLabel(reason).tone, reason).toBe(tone);
    }
    // No kernel stop reason falls through to the humanised fallback.
    for (const reason of CARD_STOP_REASONS) {
      expect(stopReasonLabel(reason).short, reason).not.toBe(humanize(reason));
      expect(stopReasonLabel(reason).sentence, reason).not.toContain("_");
    }
    const tables = vocabularyTables(STOP_REASONS) as { stopReasons: Record<string, unknown> };
    expect(Object.keys(tables.stopReasons).sort()).toEqual([...CARD_STOP_REASONS].sort());
  });

  it("WL-T3-9: reads each reason's class and next action from the kernel's stop-reason table", () => {
    const tables = vocabularyTables(STOP_REASONS) as {
      stopClasses: Record<string, string>;
      stopReasons: Record<string, { class: string; nextAction: string }>;
    };
    for (const reason of CARD_STOP_REASONS) {
      expect(tables.stopClasses[reason], reason).toBe(STOP_REASONS[reason].class);
      expect(tables.stopReasons[reason]?.nextAction, reason).toBe(STOP_REASONS[reason].nextAction);
    }
    expect(tables.stopClasses.memory_pressure).toBe("environment");
    expect(tables.stopClasses.gate_passed).toBe("success");
  });

  it("puts numbers in the sentence when it has them", () => {
    expect(stopReasonLabel("gate_passed", { step: 3 }).sentence).toBe(
      "All checks passed on step 3.",
    );
    expect(stopReasonLabel("budget_exhausted", { stepBudget: 32 }).sentence).toBe(
      "Used all 32 budgeted steps without passing.",
    );
    expect(stopReasonLabel("memory_pressure", { memoryPercent: 94 }).sentence).toContain("94%");
  });

  it("falls back to the humanised enum for an unknown reason", () => {
    expect(stopReasonLabel("disk_full").short).toBe("Disk full");
    expect(stopReasonLabel(undefined).short).toBe("Not run");
    // The sentence reaches Status's Needs you: worded, never the code, and *issue* (DEC-31).
    expect(stopReasonLabel("disk_full").sentence).toBe("It stopped before its checks passed.");
    expect(stopReasonLabel(undefined).sentence).toBe("This issue has not run yet.");
    const sentences = [
      "scope_violation",
      "token_budget_exhausted",
      "time_budget_exhausted",
      "replan_requested",
      "hook_veto",
      "error",
    ].map((r) => stopReasonLabel(r).sentence);
    expect(sentences.filter((t) => /\bcard\b|\bledger\b/i.test(t))).toEqual([]);
  });
});

describe("labels and numbers", () => {
  it("renames columns and gates", () => {
    expect(BOARD_COLUMN_ORDER).toContain("planning");
    expect(BOARD_COLUMN_ORDER).toContain("parked");
    expect(columnLabel("in_progress")).toBe("In progress");
    expect(columnLabel("verify")).toBe("Verify");
    expect(columnLabel("rejected")).toBe("Rejected");
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
    const tables = vocabularyTables(STOP_REASONS) as {
      stopReasons: Record<string, { short: string }>;
    };
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

  it("shows a gate that could not run as unavailable, not failed", () => {
    const ev = {
      passed: false,
      rungResults: [
        { gate: "unit", rung: "test", passed: true },
        { gate: "gitleaks", rung: "security", passed: false, unavailable: true },
      ],
      failures: [{ gate: "gitleaks", rung: "security", errorExcerpt: "gitleaks not run: missing" }],
    };
    const gates = gateSummary(ev);
    expect(gates.map((g) => g.state)).toEqual(["pass", "unavailable"]);
    expect(GATE_STATE_LABELS.unavailable).toBe("Unavailable");
    expect(outcomeSentence(ev)).not.toMatch(/Failed Gitleaks|Failed Secrets/);
    expect(outcomeSentence(ev)).toMatch(/unavailable/);
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
    expect(d.kinds).toEqual(["rule"]);
    expect(d.type).toBe("story");
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
    expect(line({ status: "planning" }).text).toBe("Being planned");
    // Suite run 5: a card that failed and went back to Planning showed
    // "Planner is writing the plan" — work in progress, when nothing was
    // working on it. A failed attempt is shown as one, its state first and
    // with no failure mark on the stage (DB-N1-3).
    expect(line({ status: "planning" }, { evidence: hasherEvidence })).toEqual({
      text: "Needs a new plan · Types failed · 3 errors",
      tone: "blocked",
      mark: "planning",
    });
    // DB-N7-3: no step count on the board; the issue carries it (`budgetText`).
    expect(line({ status: "in_progress", stepsUsed: 5 })).toMatchObject({
      text: "Working",
      tone: "running",
    });
    expect(line({ status: "in_progress", stepsUsed: 0 }).text).toBe("Starting");
    expect(line({ status: "verify" }).text).toBe("Running checks…");
    expect(line({ status: "review" }).text).toBe("Waiting 12m");
    expect(line({ status: "done" }).text).toBe("Accepted · 12m ago");
    expect(line({ status: "rejected" }).text).toBe("Rejected");
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
    // `type` is the issue type's id; a person reads its label (ISSUE_TYPE_LABELS).
    const { type, ...shown } = d;
    expect(type).toBe("story");
    expect(JSON.stringify(shown)).not.toMatch(/in_progress|story|SPIDR/);
  });
});

describe("Phase 3 and 4 language", () => {
  it("says what a running card is doing from its last step", () => {
    const now = Date.parse("2026-09-18T14:12:00.000Z");
    const line = statusLine(card({ status: "in_progress", stepsUsed: 0 }), {
      now,
      lastStep: {
        turn: 5,
        calls: [
          { name: "read_file", target: "a.ts" },
          { name: "write_file", target: "src/hasher.ts" },
        ],
      },
    });
    expect(line).toEqual({
      text: "Editing src/hasher.ts",
      tone: "running",
      mark: "running",
    });
    expect(callPhrase({ name: "run_cmd", target: "pnpm test" })).toBe("running pnpm test");
    expect(callPhrase({ name: "finish_card" })).toBe("asking for verification");
    const d = describeCard(card({ status: "in_progress", stepsUsed: 0 }), {
      now,
      lastStep: { turn: 5, calls: [] },
    });
    expect(d.budgetText).toBe("5 of 32 steps");
  });

  it("names the merge sha on a Done card", () => {
    const now = Date.parse("2026-09-18T16:00:00.000Z");
    expect(
      statusLine(card({ status: "done" }), {
        now,
        enteredColumnAt: "2026-09-18T14:00:00.000Z",
        acceptedSha: "ba1338e43b",
      }).text,
    ).toBe("Accepted · ba1338e · 2h ago");
  });

  it("writes ledger events as sentences with the actor named", () => {
    const title = () => "Implement canonical JSON";
    const moved = eventSentence(
      {
        type: "card/status_changed",
        actor: "executor",
        cardId: "c",
        payload: { fromStatus: "in_progress", toStatus: "verify" },
      },
      title,
    );
    expect(moved).toMatchObject({
      actor: "Agent",
      verb: "moved",
      title: "Implement canonical JSON",
      rest: "from In progress to Verify",
    });
    const back = eventSentence(
      {
        type: "card/status_changed",
        actor: "human",
        cardId: "c",
        payload: { fromStatus: "review", toStatus: "ready", reason: "returned: Sort the keys" },
      },
      title,
    );
    expect(back).toMatchObject({ actor: "You", verb: "sent back", quote: "Sort the keys" });
    const parked = eventSentence(
      {
        type: "card/status_changed",
        actor: "human",
        cardId: "c",
        payload: { toStatus: "parked", reason: "parked: Not now" },
      },
      title,
    );
    expect(parked).toMatchObject({ verb: "parked", quote: "Not now", tone: "parked" });
    expect(
      eventSentence(
        { type: "card/accepted", actor: "human", cardId: "c", payload: { sha: "ba1338e43b" } },
        title,
      ),
    ).toMatchObject({
      actor: "You",
      verb: "merged",
      rest: "to main as ba1338e",
    });
    expect(
      eventSentence(
        {
          type: "card/updated",
          actor: "planner",
          cardId: "c",
          payload: { patch: { stepsUsed: 8 } },
        },
        title,
      ),
    ).toMatchObject({ actor: "Agent", verb: "finished step 8 on" });
    expect(
      eventSentence({
        type: "card/created",
        actor: "planner",
        cardId: "c",
        payload: { title: "Hasher (SPIDR: Rule)" },
      }),
    ).toMatchObject({ actor: "Planning model", verb: "created", title: "Hasher" });
    const step = eventSentence(
      {
        type: "card/step",
        actor: "executor",
        cardId: "c",
        payload: {
          turn: 4,
          calls: [{ name: "note", target: "stuck" }],
          gate: { passed: false, failed: ["typecheck"] },
        },
      },
      title,
    );
    expect(step.rest).toBe('· noting "stuck" · Types failed');
    expect(step.tone).toBe("fail");
    expect(
      eventSentence(
        { type: "card/repair_plan", actor: "planner", cardId: "c", payload: { plan: "1. Do x" } },
        title,
      ).quote,
    ).toBe("1. Do x");
    expect(humanize("dependsOn")).toBe("Depends on");
  });

  it("summarises a run: first try, retries, failed time, stops, and a timeline that fills 100%", () => {
    const run = {
      startedAt: "2026-09-18T14:16:10.135Z",
      model: "m",
      managerModel: "p",
      totalDurationMs: 1_330_356,
      entries: [
        {
          cardId: "a",
          attempt: 1,
          passed: true,
          stopReason: "gate_passed",
          turns: 2,
          durationMs: 150_846,
          promptTokens: 3437,
          completionTokens: 124,
        },
        {
          cardId: "b",
          attempt: 1,
          passed: false,
          stopReason: "no_progress",
          turns: 8,
          durationMs: 281_463,
          promptTokens: 23882,
          completionTokens: 7651,
        },
        {
          cardId: "c",
          attempt: 1,
          passed: false,
          stopReason: "memory_pressure",
          turns: 11,
          durationMs: 524_000,
          promptTokens: 40500,
          completionTokens: 14800,
        },
        {
          cardId: "b",
          attempt: 2,
          passed: true,
          stopReason: "gate_passed",
          turns: 3,
          durationMs: 90_000,
          promptTokens: 5000,
          completionTokens: 300,
        },
      ],
    };
    const s = summarizeRun(run);
    expect(s).toMatchObject({
      cards: 3,
      firstTry: 1,
      retried: 1,
      passedAfterRetry: 1,
      failedMs: 805_463,
    });
    expect(s.stops.map((x) => [x.label, x.count])).toEqual([
      ["Passed", 2],
      ["Stalled", 1],
      ["Paused for memory", 1],
    ]);
    expect(s.segments.map((x) => x.tone)).toEqual(["pass", "fail", "parked", "pass"]);
    const total = s.segments.reduce((n, x) => n + x.share, 0) + s.overheadShare;
    expect(total).toBeCloseTo(1, 10);
  });

  it("finds where loop detection fired", () => {
    const steps = [
      { turn: 1, calls: [{ name: "write_file", target: "src/h.ts" }] },
      { turn: 2, calls: [{ name: "note", target: "stuck" }] },
      { turn: 3, calls: [{ name: "note", target: "stuck" }] },
      { turn: 4, calls: [{ name: "note", target: "stuck" }], stopReason: "oscillation_detected" },
    ];
    expect(loopRange(steps)).toEqual({ from: 2, to: 4, lastChange: 1, repeated: 'noting "stuck"' });
    expect(loopRange([{ turn: 1, calls: [], stopReason: "gate_passed" }])).toBe(null);
  });

  it("offers a fix for every failing health check it knows", () => {
    expect(checkFixHint("Skills registry", "warn")).toBe(
      "Create .sekhemet/skills/ to load skills.",
    );
    expect(checkFixHint("Local inference socket", "fail")).toMatch(/Start Ollama/);
    expect(checkFixHint("Skills registry", "pass")).toBeUndefined();
  });
});

describe("ledger sentences for Seshat, research, reproducibility and compute", () => {
  const ev = (type: string, actor: string, payload: Record<string, unknown>) => ({
    type,
    actor,
    payload,
  });
  it("reads Seshat's chat as what was said, not ids", () => {
    const asked = eventSentence(
      ev("pm/message", "human", { text: "What is blocking the ledger?" }),
    );
    expect(asked).toMatchObject({
      actor: "You",
      verb: "asked Seshat",
      quote: "What is blocking the ledger?",
    });
    expect(eventSentence(ev("pm/message", "human", { text: "/status" })).verb).toBe("ran");
    // B4.11: a message's text is in its private part, when the reader was given it.
    expect(
      eventSentence({ ...ev("pm/message", "human", {}), private: { text: "Is the ledger done?" } }),
    ).toMatchObject({ verb: "asked Seshat", quote: "Is the ledger done?" });
    const reply = eventSentence(
      ev("pm/reply", "planner", {
        text: "\nThe hasher is next.\nThen the verifier.",
        model: "ledger",
      }),
    );
    expect(reply).toMatchObject({
      actor: "Seshat",
      verb: "answered from the ledger",
      quote: "The hasher is next.",
    });
  });
  it("says what the Research model, the reproducibility record and the breakers did", () => {
    expect(
      eventSentence(
        ev("research/asked", "researcher", {
          question: "WAL?",
          grounded: true,
          confidence: 0.6,
          sources: ["a", "b"],
        }),
      ),
    ).toMatchObject({
      actor: "Research model",
      verb: "researched",
      rest: "· grounded, confidence 0.60 · 2 source(s)",
      tone: "pass",
    });
    // The question is private (it can carry a card's spec and a gate's
    // output): quoted from the event's private part, its first line only.
    expect(
      eventSentence({
        ...ev("research/asked", "researcher", { grounded: false, sources: [] }),
        private: { question: "Why does the WAL test fail?\nSpec: the card's whole spec" },
      }).quote,
    ).toBe("Why does the WAL test fail?");
    expect(
      eventSentence(ev("research/asked", "researcher", { grounded: false })).quote,
    ).toBeUndefined();
    expect(
      eventSentence(
        ev("card/repro", "harness", { model: { id: "apodex-1.1-mini", quant: "IQ3_M" } }),
      ).rest,
    ).toBe("(apodex-1.1-mini IQ3_M)");
    expect(
      eventSentence(
        ev("compute/breaker_tripped", "harness", { breaker: "energy", reason: "budget spent" }),
      ),
    ).toMatchObject({ tone: "fail", quote: "budget spent" });
    expect(actorLabel("researcher")).toBe("Research model");
  });
});

describe("isolationLabel (SEC-21)", () => {
  it("marks a card that ran unconfined as a warning", async () => {
    const { isolationLabel } = await import("../src/vocabulary.js");
    expect(isolationLabel("none")).toMatchObject({ short: "Unconfined", tone: "parked" });
    expect(isolationLabel("none").sentence).toMatch(/SEKHEMET_ALLOW_UNCONFINED/);
  });

  it("names the mechanism a card ran under", async () => {
    const { isolationLabel } = await import("../src/vocabulary.js");
    expect(isolationLabel("seatbelt").short).toBe("Seatbelt");
    expect(isolationLabel("bubblewrap").short).toBe("bubblewrap");
  });

  it("is what the card's Run facts show", () => {
    const facts = readFileSync(join(import.meta.dirname, "..", "web", "facts.js"), "utf8");
    expect(facts).toMatch(/isolationLabel\(evidence\.settings\?\.isolation\)/);
  });
});

describe("the empty gate contract (gates GT-T1-10)", () => {
  it("recognises a run on the defaults as 'no gates.toml', and older bundles' empty-string hash", () => {
    expect(isEmptyGateContract("no gates.toml")).toBe(true);
    expect(isEmptyGateContract(EMPTY_SHA256)).toBe(true);
    expect(isEmptyGateContract("4f1a".padEnd(64, "0"))).toBe(false);
    expect(isEmptyGateContract(undefined)).toBe(false);
  });
});

describe("PM-P1-10: the board's kind tag comes from the card's stored kind", () => {
  it("tags a planner card with no title suffix by its stored kind, and keeps the title whole", () => {
    const d = describeCard(card({ title: "Store the order", kind: "data" }), {
      now: new Date("2026-09-26T12:00:00Z"),
    });
    expect(d.kinds).toEqual(["data"]);
    expect(d.title).toBe("Store the order");
  });

  it("prefers the stored kind over an older card's title suffix", () => {
    const d = describeCard(card({ title: "Check totals (SPIDR: Data)", kind: "rule" }), {
      now: new Date("2026-09-26T12:00:00Z"),
    });
    expect(d.kinds).toEqual(["rule"]);
    expect(d.title).toBe("Check totals");
  });
});
