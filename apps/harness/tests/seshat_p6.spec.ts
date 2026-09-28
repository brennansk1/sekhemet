import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PROMPT_RULE_CAP, lintPrompt } from "@sekhemet/context";
import { type CardRecord, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter } from "@sekhemet/models";
import { ASSUMPTION_EVENTS, GoalStore, appendPlannerEvent } from "@sekhemet/planner";
import { afterEach, describe, expect, it } from "vitest";
import { LearningStore, PROFILE_IN_FORCE, decayedStrength } from "../src/learning/store.js";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import {
  PM_TOOLS,
  type PmSnapshot,
  boardDigest,
  fitSeshatPrompt,
  pmSystemPrompt,
  seshatSections,
} from "../src/pm/agent.js";
import type { Audience } from "../src/pm/audience.js";
import { splitSuggestedSummary, startProjectSummary } from "../src/pm/pm_copy.js";
import { answerQueued } from "../src/pm/service.js";
import { SESHAT_SKILL, SESHAT_SKILL_VERSION, skillRules } from "../src/pm/seshat_skill.js";
import { PmStore } from "../src/pm/store.js";
import type { PmMessage } from "../src/pm/types.js";

// planner-pm P6 (group S1): what Seshat knows and the skill it answers
// under. Scripted model replies only; nothing loads a model.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-seshat-p6-"));
  dirs.push(repoPath);
  mkdirSync(join(repoPath, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(repoPath, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  return { repoPath, db, log, cardStore: new CardStore(db, log), pmStore: new PmStore(log) };
}
type S = ReturnType<typeof setup>;

/** A Planner that records each request and answers with the scripted text. */
function planner(say: (req: InferenceRequest) => string = () => "Noted.") {
  const seen: InferenceRequest[] = [];
  const model: LocalInferenceAdapter = {
    modelId: "planner-model",
    supportedArms: ["arm_a_flat"],
    contextWindow: { contextTokens: 16_384, maxTokens: 1200 },
    generate: async (req) => {
      seen.push(req);
      return {
        text: say(req),
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      };
    },
  };
  return { model, seen };
}

async function ask(
  s: S,
  text: string,
  opts: { model?: LocalInferenceAdapter; audience?: Audience; as?: string; cardId?: string } = {},
) {
  const send = () =>
    s.pmStore.appendUserMessage(text, opts.cardId ? { cardId: opts.cardId } : undefined);
  if (opts.as) await EventLog.actingFor(opts.as, send);
  else await send();
  await answerQueued({
    repoPath: s.repoPath,
    cardStore: s.cardStore,
    pmStore: s.pmStore,
    pmModel: "planner-model",
    acquire: async () => {
      if (!opts.model) throw new Error("no model may load for this question");
      return { role: "chat", adapter: opts.model, release: () => {} };
    },
    ...(opts.audience ? { audience: opts.audience } : {}),
  });
  const replies = (await s.pmStore.thread()).filter((m) => m.role === "pm");
  return replies.at(-1) as PmMessage;
}

describe("PM-P6-5: the skill file carries §2.8.17's five sample exchanges as few-shots", () => {
  it("renders each exchange into Seshat's standing prompt, under the rule cap, in registered tags", () => {
    expect(SESHAT_SKILL.exchanges.map((x) => x.id)).toEqual([
      "standup",
      "why_failed",
      "split",
      "plan_sprint",
      "at_risk",
    ]);
    const system = pmSystemPrompt({ project: "chronicle", pmModel: "planner-model" } as PmSnapshot);
    for (const x of SESHAT_SKILL.exchanges)
      expect(system).toContain(`Person: ${x.person}\nYou: ${x.seshat}`);
    // The language table as example pairs, the Do first (PROMPT_STANDARD rule 31).
    for (const p of SESHAT_SKILL.language) {
      expect(system).toContain(
        `<prefer>${p.prefer}</prefer>\n<instead_of>${p.insteadOf}</instead_of>`,
      );
    }
    const report = lintPrompt(system);
    expect(report.ruleCountMethod).toBe("rule_sections");
    expect(report.counts.imperativeRules).toBeLessThanOrEqual(PROMPT_RULE_CAP);
    const { rules, toolRules } = skillRules("conversation");
    expect(report.counts.imperativeRules).toBe(rules.length + toolRules.length);
    expect(report.placeholders).toEqual([]);
    expect(report.contradictions).toEqual([]);
    expect(report.counts.capitalWords).toBe(0);
    // DEC-31 in the model-facing text: issues, checks, sprints, the Agent.
    expect(system).not.toMatch(/\bcards?\b|\bgates?\b|\bcycles?\b(?! time)|\bWorker\b|\bhuman\b/);
  });
});

describe("PM-P6-4: every pm/reply records the skill file's version", () => {
  it("the version names the skill, its revision and a hash of its content", () => {
    const hash = createHash("sha256").update(JSON.stringify(SESHAT_SKILL)).digest("hex");
    expect(SESHAT_SKILL_VERSION).toBe(
      `${SESHAT_SKILL.name}/${SESHAT_SKILL.revision}+${hash.slice(0, 12)}`,
    );
  });

  it("stamps a model's reply and a ledger reply alike", async () => {
    const s = setup();
    await s.cardStore.createCard({ tier: "task", title: "Ledger", status: "ready" });
    const { model } = planner(() => "The ledger issue is ready.");
    const modelReply = await ask(s, "How is the ledger issue doing?", { model });
    const ledgerReply = await ask(s, "status");
    const replies = await s.log.getEventsByTypes(["pm/reply"]);
    expect(replies.length).toBe(2);
    for (const e of replies) {
      expect((e.payload as { skillVersion?: string }).skillVersion).toBe(SESHAT_SKILL_VERSION);
    }
    expect(modelReply.skillVersion).toBe(SESHAT_SKILL_VERSION);
    expect(ledgerReply.skillVersion).toBe(SESHAT_SKILL_VERSION);
  });
});

const cardOf = (id: string, status: string, extra: Partial<CardRecord> = {}): CardRecord =>
  ({
    id,
    title: `Issue ${id}`,
    status,
    tier: "task",
    stepBudget: 40,
    scopeFiles: [],
    ...extra,
  }) as unknown as CardRecord;

describe("PM-P6-11: two prompts for one project share every byte up to the board digest", () => {
  it("differs only from <board> on, whatever the board, the runs and the forecast hold", () => {
    const base: PmSnapshot = {
      project: "chronicle",
      cards: [],
      cycles: [],
      recentRuns: [],
      pmModel: "planner-model",
      preferences: ["Prefers short answers"],
      pmRules: ["Split an issue that touches more than three files."],
      today: "2026-09-28",
    };
    const quiet: PmSnapshot = { ...base, cards: [cardOf("card_a", "ready")] };
    const busy: PmSnapshot = {
      ...base,
      today: "2026-09-29",
      cards: Array.from({ length: 300 }, (_, i) =>
        cardOf(`card_${i}`, i % 2 ? "in_progress" : "review", {
          stopReason: "gate_failed",
        } as never),
      ),
      recentRuns: ["- `card_1` attempt 2: failed (gate_failed) in 9 steps, 80s"],
      worker: { model: "cyber-tiel", record: "12 of 20 first attempts passed" },
      forecast: "40 issues left: 50% likely within 6 day(s), 85% within 9.",
      decisions: ["Needs a decision from you: keep the old API?"],
      team: "Seshat is loaded.",
      goals: [
        {
          id: "goal_1",
          statement: "Chronicle is usable",
          state: "active",
          met: 1,
          total: 3,
          assumptions: [],
        },
      ],
      findings: [
        { cardId: "card_1", entryId: "ev_r1", verdict: "unmet", text: "Criterion 1 is left out." },
      ],
    };
    const request = (s: PmSnapshot) => {
      const q: PmMessage = {
        id: "m1",
        seq: 1,
        role: "user",
        text: "Anything at risk?",
        createdAt: "",
        state: "queued",
      };
      const system = pmSystemPrompt(s);
      const fitted = fitSeshatPrompt(
        { contextWindow: { contextTokens: 8192, maxTokens: 1200 } },
        system,
        PM_TOOLS,
        seshatSections(s, [], [q]),
      );
      return `${system}\n\n${fitted.prompt}`;
    };
    const a = request(quiet);
    const b = request(busy);
    const at = a.indexOf("<board>");
    expect(at).toBeGreaterThan(0);
    expect(b.indexOf("<board>")).toBe(at);
    expect(b.slice(0, at)).toBe(a.slice(0, at));
    // The stable head holds the skill, the approved rules and the profile.
    expect(a.slice(0, at)).toContain(
      "<playbook>\n- Split an issue that touches more than three files.",
    );
    expect(a.slice(0, at)).toContain("<preferences>\n- Prefers short answers");
    expect(a).not.toBe(b);
  });
});

describe("PM-P6-1: the goal and the assumptions, answered from the ledger and cited", () => {
  it("answers 'what's our goal?' and 'what did you assume?' with no model, citing each id", async () => {
    const s = setup();
    const card = await s.cardStore.createCard({ tier: "task", title: "Ledger", status: "ready" });
    await new GoalStore({ store: s.cardStore, log: s.log }).create({
      id: "goal_http",
      workspaceId: "w",
      projectIds: [],
      statement: "Chronicle is usable over HTTP",
      criteria: [
        { id: "crit_1", text: "Reads work", kind: "human", status: "met" },
        { id: "crit_2", text: "Writes work", kind: "human", status: "unmet" },
      ],
      budget: { tokens: 1, hours: 1 },
      strategy: "epic_1",
      state: "active",
      assumptions: ["one user at a time"],
      strategiesTried: 0,
      createdAt: "2026-09-28T00:00:00.000Z",
    });
    await appendPlannerEvent(
      { store: s.cardStore, log: s.log },
      ASSUMPTION_EVENTS.logged,
      {
        id: "asm_utc",
        cardId: card.id,
        category: "data_format",
        statement: "Timestamps are stored in UTC",
        basis: "the project's other tables do",
        excerpt: "store the time",
        createdAt: new Date().toISOString(),
      },
      { cardId: card.id },
    );
    const goal = await ask(s, "What's our goal?");
    expect(goal.text).toContain("goal_http");
    expect(goal.text).toContain("Chronicle is usable over HTTP");
    expect(goal.text).toContain("1 of 2 criteria met");
    expect(goal.cites).toEqual([{ goalId: "goal_http", label: "Goal goal_http" }]);
    const assumed = await ask(s, "What did you assume?");
    expect(assumed.text).toContain("asm_utc");
    expect(assumed.text).toContain("Timestamps are stored in UTC");
    expect(assumed.text).toContain("one user at a time");
    expect(assumed.cites).toEqual(
      expect.arrayContaining([
        { assumptionId: "asm_utc", cardId: card.id, label: "Assumption asm_utc" },
        { goalId: "goal_http", label: "Goal goal_http" },
      ]),
    );
    // Neither question loaded a model: `ask` throws on any acquire.
    expect((await s.pmStore.thread()).filter((m) => m.state === "error")).toEqual([]);
  });

  it("puts the goals and assumptions in a model's prompt too, an unverified one old enough on the risk register", async () => {
    const s = setup();
    const card = await s.cardStore.createCard({ tier: "task", title: "Ledger", status: "ready" });
    await appendPlannerEvent(
      { store: s.cardStore, log: s.log },
      ASSUMPTION_EVENTS.logged,
      {
        id: "asm_old",
        cardId: card.id,
        category: "data_format",
        statement: "Amounts are integers of cents",
        basis: "billing convention",
        excerpt: "amount",
        createdAt: new Date(Date.now() - 30 * 3_600_000).toISOString(),
      },
      { cardId: card.id },
    );
    const { model, seen } = planner();
    await ask(s, "Should we split the ledger issue?", { model });
    const prompt = seen[0]?.prompt ?? "";
    expect(prompt).toContain("<assumptions>");
    expect(prompt).toMatch(
      /Assumption `asm_old` on `[^`]+`: Amounts are integers of cents .*unverified for 30h, on the risk register/,
    );
  });
});

describe("PM-P6-2: the Reviewer's findings are in Seshat's snapshot and cited", () => {
  it("renders the latest AI review of an issue and cites the finding a reply names", async () => {
    const s = setup();
    const card = await s.cardStore.createCard({ tier: "task", title: "Ledger", status: "ready" });
    const old = await s.cardStore.recordDossierEntry({
      cardId: card.id,
      kind: "review",
      actor: "reviewer",
      verdict: "unmet",
      modelId: "review-model",
      text: "Criterion 1 is unmet at src/ledger.ts:3: the old review.",
    });
    await s.cardStore.recordDossierEntry({
      cardId: card.id,
      kind: "review",
      actor: "reviewer",
      verdict: "coverage",
      text: "Read 1 of 1 file.",
    });
    const finding = await s.cardStore.recordDossierEntry({
      cardId: card.id,
      kind: "review",
      actor: "reviewer",
      verdict: "unclear",
      modelId: "review-model",
      text: "Criterion 2 is unclear at src/ledger.ts:12: the empty ledger is left out.",
    });
    await s.cardStore.recordDossierEntry({
      cardId: card.id,
      kind: "review",
      actor: "reviewer",
      verdict: "coverage",
      text: "Read 1 of 1 file.",
    });
    const { model, seen } = planner(
      () =>
        `Ledger (\`${card.id}\`) has one open finding, ${finding.entryId}: the empty ledger is left out.`,
    );
    const reply = await ask(s, "What did the AI review say about the ledger?", { model });
    const prompt = seen[0]?.prompt ?? "";
    expect(prompt).toContain("<review_findings>");
    expect(prompt).toContain(
      `\`${card.id}\` finding \`${finding.entryId}\`, unclear: Criterion 2 is unclear`,
    );
    expect(prompt).toContain("(Review model review-model)");
    // Only the latest review: the earlier one was superseded.
    expect(prompt).not.toContain(old.entryId);
    expect(reply.cites).toEqual(
      expect.arrayContaining([
        { cardId: card.id },
        { findingId: finding.entryId, cardId: card.id, label: `AI review of ${card.id}` },
      ]),
    );
  });
});

async function failedRun(s: S, cardId: string) {
  const bundle = {
    id: "ev_7f3a",
    cardId,
    attempt: 2,
    passed: false,
    stopReason: "oscillation_detected",
    turnsUsed: 8,
    failures: [
      {
        gate: "typecheck",
        rung: "typecheck",
        location: { file: "tests/hasher.spec.ts", line: 25 },
        errorExcerpt: "TS2353: Object literal may only specify known properties",
      },
    ],
  };
  const body = JSON.stringify(bundle);
  mkdirSync(join(s.repoPath, ".sekhemet", "evidence"), { recursive: true });
  writeFileSync(join(s.repoPath, ".sekhemet", "evidence", "ev_7f3a.json"), body);
  await recordLedgerRun(s.cardStore, {
    cardId,
    modelId: "cyber-tiel",
    passed: false,
    stopReason: "oscillation_detected",
    evidenceId: "ev_7f3a",
    path: ".sekhemet/evidence/ev_7f3a.json",
    body,
  });
}

describe("PM-P6-6: asked why an issue failed, the reply names the evidence's facts and cites its id", () => {
  it("adds the stop reason, step, failing check and file:line when the model leaves them out", async () => {
    const s = setup();
    const card = await s.cardStore.createCard({ tier: "task", title: "Ledger", status: "ready" });
    await failedRun(s, card.id);
    const { model, seen } = planner(
      () => "It looped; I'd send it back with a note about the test's input shape.",
    );
    const reply = await ask(s, "Why did the ledger issue fail?", { model });
    expect(seen[0]?.prompt).toContain("<failure_evidence>");
    expect(reply.text).toContain("stopped on Looping at step 8");
    expect(reply.text).toContain("the first failing check was Types, at tests/hasher.spec.ts:25");
    expect(reply.text).toContain("Evidence `ev_7f3a`, attempt 2");
    expect(reply.cites).toEqual(
      expect.arrayContaining([
        { evidenceId: "ev_7f3a", cardId: card.id, label: "Evidence ev_7f3a" },
      ]),
    );
  });

  it("leaves a reply that already cites the evidence as the model wrote it", async () => {
    const s = setup();
    const card = await s.cardStore.createCard({ tier: "task", title: "Ledger", status: "ready" });
    await failedRun(s, card.id);
    const said =
      "Ledger stopped on Looping at step 8; Types failed at tests/hasher.spec.ts:25. Based on: evidence ev_7f3a.";
    const { model } = planner(() => said);
    const reply = await ask(s, "why did it fail?", { model, cardId: card.id });
    expect(reply.text).toBe(said);
    expect(reply.cites).toEqual(
      expect.arrayContaining([expect.objectContaining({ evidenceId: "ev_7f3a" })]),
    );
  });

  it("names no evidence when the bundle's file differs from the ledger's hash", async () => {
    const s = setup();
    const card = await s.cardStore.createCard({ tier: "task", title: "Ledger", status: "ready" });
    await failedRun(s, card.id);
    writeFileSync(join(s.repoPath, ".sekhemet", "evidence", "ev_7f3a.json"), "{}");
    const { model, seen } = planner(() => "There is no sound evidence for that attempt.");
    const reply = await ask(s, "Why did the ledger issue fail?", { model });
    expect(seen[0]?.prompt).not.toContain("<failure_evidence>");
    expect(reply.text).not.toContain("ev_7f3a");
  });
});

describe("PM-N9-8: what Seshat knows beyond the board is scoped to what the asker can see", () => {
  it("a Viewer's prompt holds no goal, assumption or finding of a hidden project", async () => {
    const s = setup();
    const open = await s.cardStore.ensureProject({
      name: "Storefront",
      rootPath: join(s.repoPath, "shop"),
    });
    const hidden = await s.cardStore.ensureProject({
      name: "Payroll",
      rootPath: join(s.repoPath, "pay"),
    });
    await s.cardStore.createCard({
      id: "card_cart",
      tier: "task",
      title: "Cart totals",
      status: "ready",
      projectId: open.id,
    });
    await s.cardStore.createCard({
      id: "card_salary",
      tier: "task",
      title: "Salary export",
      status: "ready",
      projectId: hidden.id,
    });
    await s.cardStore.recordDossierEntry({
      cardId: "card_salary",
      kind: "review",
      actor: "reviewer",
      verdict: "unmet",
      text: "Salary rounding is left out.",
    });
    await appendPlannerEvent(
      { store: s.cardStore, log: s.log },
      ASSUMPTION_EVENTS.logged,
      {
        id: "asm_pay",
        cardId: "card_salary",
        category: "data_format",
        statement: "Salaries are monthly",
        basis: "x",
        excerpt: "x",
        createdAt: new Date().toISOString(),
      },
      { cardId: "card_salary" },
    );
    await new GoalStore({ store: s.cardStore, log: s.log }).create({
      id: "goal_pay",
      workspaceId: "w",
      projectIds: [hidden.id],
      statement: "Payroll runs monthly",
      criteria: [],
      budget: { tokens: 1, hours: 1 },
      strategy: "e",
      state: "active",
      assumptions: [],
      strategiesTried: 0,
      createdAt: "2026-09-28T00:00:00.000Z",
    });
    const audience: Audience = {
      setup: "team",
      nameOf: () => undefined,
      levelOf: () => "viewer",
      canSee: (_p, project) => project !== hidden.id,
      leadOf: () => undefined,
    };
    const { model, seen } = planner(() => "Cart totals is ready.");
    await ask(s, "Anything at risk in the cart?", { model, audience, as: "p_vic" });
    const goal = await ask(s, "What's our goal?", { audience, as: "p_vic" });
    for (const text of [seen[0]?.prompt ?? "", goal.text]) {
      expect(text).not.toMatch(/Salary|salar|asm_pay|goal_pay|Payroll/);
    }
  });
});

describe("PM-P6-15: a profile statement without new evidence decays and stops being used below 0.2", () => {
  const week = 7 * 24 * 3_600_000;

  it("lowers the strength by the scope's weekly rate, drops it below 0.2, and new evidence raises it again", async () => {
    const s = setup();
    const learning = new LearningStore(s.log);
    const t0 = Date.parse("2026-09-01T00:00:00.000Z");
    const first = await learning.observe(
      {
        statement: "Prefers short answers",
        category: "communication",
        source: "edits",
        evidence: "edited a reply",
        key: "short",
      },
      t0,
    );
    expect(first.strength).toBe(0.3);
    // The default scope: this project, 0.1 lost per week without evidence.
    const after = (await learning.profile(t0 + 2 * week))[0];
    expect(after?.strength).toBeCloseTo(0.3 * 0.9 ** 2, 3);
    expect(after?.recordedStrength).toBe(0.3);
    expect((await learning.profileInForce(t0 + 2 * week)).map((p) => p.id)).toEqual(["pref_short"]);
    // Four weeks: 0.3 × 0.9⁴ ≈ 0.197, below the threshold.
    expect(decayedStrength(first, t0 + 4 * week)).toBeLessThan(PROFILE_IN_FORCE);
    expect(await learning.profileInForce(t0 + 4 * week)).toEqual([]);
    // Nothing is written for time passing: the ledger holds one statement event.
    expect((await s.log.getEventsByTypes(["learn/profile"])).length).toBe(1);
    // New evidence reinforces from the decayed strength, and the statement is used again.
    const again = await learning.observe(
      {
        statement: "Prefers short answers",
        category: "communication",
        source: "edits",
        evidence: "edited again",
        key: "short",
      },
      t0 + 4 * week,
    );
    expect(again.strength).toBeCloseTo(0.197 + (1 - 0.197) * 0.3, 2);
    expect((await learning.profileInForce(t0 + 4 * week)).map((p) => p.id)).toEqual(["pref_short"]);
  });

  it("uses the rate the statement's scope records, and a person's edit never writes a decayed strength", async () => {
    const s = setup();
    const learning = new LearningStore(s.log);
    const t0 = Date.parse("2026-09-01T00:00:00.000Z");
    await learning.observe(
      {
        statement: "Reviews in the morning",
        category: "priorities",
        source: "edits",
        evidence: "reviewed at 8",
        key: "morning",
        scope: { reach: "all", decayPerWeek: 0.5 },
      },
      t0,
    );
    expect((await learning.profile(t0 + week))[0]?.strength).toBeCloseTo(0.15, 3);
    await learning.updateProfile("pref_morning", { statement: "Reviews before noon" });
    const recorded = (await s.log.getEventsByTypes(["learn/profile"])).at(-1)?.payload as {
      strength: number;
      recordedStrength?: number;
    };
    expect(recorded.strength).toBe(0.3);
    expect(recorded.recordedStrength).toBeUndefined();
  });

  it("keeps a faded statement out of Seshat's prompt", async () => {
    const s = setup();
    await s.cardStore.createCard({ tier: "task", title: "Ledger", status: "ready" });
    const learning = new LearningStore(s.log);
    await learning.observe(
      {
        statement: "Prefers tables over prose",
        category: "communication",
        source: "edits",
        evidence: "x",
        key: "tables",
      },
      Date.now() - 10 * week,
    );
    await learning.observe({
      statement: "Prefers short answers",
      category: "communication",
      source: "edits",
      evidence: "y",
      key: "short",
    });
    const { model, seen } = planner();
    await ask(s, "How is the ledger issue doing?", { model });
    const prompt = seen[0]?.prompt ?? "";
    expect(prompt).toContain("Prefers short answers");
    expect(prompt).not.toContain("Prefers tables over prose");
  });
});

describe("DEC-31's words in what Seshat writes and reads (PM-N9)", () => {
  it("says issues, not cards, in its proposal summaries", () => {
    expect(splitSuggestedSummary("Ledger", 2, "", "")).toBe(
      "Suggested: split Ledger into 2 issues",
    );
    expect(
      startProjectSummary(
        {
          buildSpec: "A calculator",
          creates: { epics: 1, issues: 3 },
          stack: { name: "TypeScript" },
        } as never,
        "",
      ),
    ).toMatch(/1 epic and 3 issues in TypeScript/);
  });

  it("reads the board by its column names and stop reasons in words", () => {
    const digest = boardDigest({
      project: "p",
      cards: [
        {
          id: "CHR-7",
          title: "Ledger",
          status: "in_progress",
          tier: "story",
          stopReason: "oscillation_detected",
        } as CardRecord,
      ],
      cycles: [],
      recentRuns: [],
      pmModel: "m",
      today: "2026-09-28",
    });
    expect(digest).toContain("In progress (1):");
    expect(digest).not.toContain("in_progress");
    expect(digest).not.toContain("oscillation_detected");
  });
});

describe("PROMPT_STANDARD rule 31 for Seshat", () => {
  it("puts the brief last among the data, before the message and the ask", () => {
    const s = {
      project: "billing",
      cards: [],
      cycles: [],
      recentRuns: ["CHR-2 Canonical form: passed in 6 steps"],
      forecast: "50% by 6 October",
      pmModel: "m",
      today: "2026-09-28",
      brief: "A billing service that charges monthly.",
    } as PmSnapshot;
    const q: PmMessage = {
      id: "m1",
      seq: 1,
      role: "user",
      text: "Where are we?",
      createdAt: "",
      state: "queued",
    };
    const fitted = fitSeshatPrompt(
      { contextWindow: { contextTokens: 8192, maxTokens: 1200 } },
      pmSystemPrompt(s),
      PM_TOOLS,
      seshatSections(s, [], [q]),
    );
    const ids = fitted.allocation.sections.map((x) => x.id);
    expect(ids.slice(-3)).toEqual(["brief", "newest", "instruction"]);
  });

  it("asks a non-developer one question at a time", () => {
    const system = pmSystemPrompt({ project: "p", pmModel: "m" } as PmSnapshot);
    expect(system).toMatch(/one question at a time/i);
    expect(lintPrompt(system).counts.imperativeRules).toBeLessThanOrEqual(PROMPT_RULE_CAP);
  });
});
