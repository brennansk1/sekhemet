import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter, type ToolCall } from "@sekhemet/models";
import { DecisionStore } from "@sekhemet/planner";
import { afterEach, describe, expect, it } from "vitest";
import { type PmSnapshot, answer } from "../src/pm/agent.js";
import type { Audience } from "../src/pm/audience.js";
import { namedDecisions } from "../src/pm/decisions.js";
import { answerQueued } from "../src/pm/service.js";
import { PmStore } from "../src/pm/store.js";
import { postSuggestions } from "../src/pm/suggest.js";
import { BANNED_PHRASES, voiceGuard } from "../src/pm/voice.js";
import { HEALTH_WORDS, draftWeeklyUpdate } from "../src/pm/weekly.js";

// planner-pm PM-N9-4, -5, -7, -8: how Seshat speaks, names a decision's
// person, drafts the weekly update, and keeps to what the asker can see.
// Real SQLite on disk.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };

function setup() {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-pm-voice-"));
  dirs.push(repoPath);
  mkdirSync(join(repoPath, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(repoPath, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  return { repoPath, db, log, cardStore: new CardStore(db, log), pmStore: new PmStore(log) };
}

type S = ReturnType<typeof setup>;

async function converse(
  s: S,
  turns: { ask: string; say: string; calls?: ToolCall[] }[],
  audience?: Audience,
  as?: string,
) {
  const model = new MockInferenceAdapter(
    "pm",
    turns.map((t) => ({ text: t.say, toolCalls: t.calls ?? [], usage })),
  );
  for (const t of turns) {
    const send = () => s.pmStore.appendUserMessage(t.ask);
    if (as) await EventLog.actingFor(as, send);
    else await send();
    await answerQueued({
      repoPath: s.repoPath,
      cardStore: s.cardStore,
      pmStore: s.pmStore,
      pmModel: "pm",
      acquire: async () => ({ role: "chat", adapter: model, release: () => {} }),
      ...(audience ? { audience } : {}),
    });
  }
  return (await s.pmStore.thread()).filter((m) => m.role === "pm");
}

describe("PM-N9-4: the scripted conversation keeps Seshat's voice", () => {
  it("no banned phrase, no exclamation mark, and every proposal carries its reason", async () => {
    const s = setup();
    const card = await s.cardStore.createCard({
      id: "card_http",
      tier: "task",
      title: "Http",
      status: "ready",
    });
    const replies = await converse(s, [
      { ask: "standup please?", say: "Great question! Two cards are done!" },
      {
        ask: "what about http",
        say: "I'd be happy to help! You should split it. I've assigned it to Bob and I've decided the order.",
        calls: [
          {
            id: "1",
            name: "propose_update_card",
            arguments: { card_id: card.id, estimate: 5, reason: "it touches five files" },
          },
          // No reason: never offered as a proposal.
          { id: "2", name: "propose_move_card", arguments: { card_id: card.id, to: "backlog" } },
        ],
      },
      { ask: "did you approve it?", say: "I approved it yesterday!!" },
    ]);
    expect(replies).toHaveLength(3);
    for (const r of replies) {
      for (const phrase of BANNED_PHRASES) {
        expect(r.text.toLowerCase()).not.toContain(phrase.toLowerCase());
      }
      expect(r.text).not.toContain("!");
      for (const p of r.proposals ?? []) {
        expect(p.why).toBeTruthy();
        expect(p.summary).toContain(`Why: ${p.why}`);
      }
    }
    expect(replies[1]?.proposals?.map((p) => p.kind)).toEqual(["update_card"]);
    expect(replies[1]?.text).toMatch(/gave no reason/);
  });

  it("keeps code as written", () => {
    expect(voiceGuard("Done! Use `a !== b` there.")).toBe("Done. Use `a !== b` there.");
  });
});

describe("PM-N9-5: a decision names its person, the default and its deadline", () => {
  it("names the card's owner, else the lead; the default and the deadline where one applies", async () => {
    const s = setup();
    await s.cardStore.createCard({
      id: "card_api",
      tier: "task",
      title: "Api",
      status: "ready",
      owner: "p_priya",
    });
    await s.cardStore.createCard({ id: "card_ui", tier: "task", title: "Ui", status: "ready" });
    const ledger = { store: s.cardStore, log: s.log };
    const request = (id: string, cardId: string, policy: "safe_default" | "default_deny") =>
      new DecisionStore(ledger).request(
        {
          id,
          cardId,
          question: "Keep the old API?",
          options: [
            { label: "Keep it", consequence: "", effortDelta: "none", riskNote: "" },
            { label: "Drop it", consequence: "", effortDelta: "+1 card", riskNote: "" },
          ],
          previewSketches: [],
          recommendation: { optionIndex: 0, rationale: "" },
          policy,
          defaultIfNoAnswer:
            policy === "safe_default"
              ? { optionIndex: 0, deadline: "2026-10-02T17:00:00.000Z" }
              : { deadline: "2026-10-02T17:00:00.000Z" },
          category: "scope_boundary",
          createdAt: "2026-09-26T09:00:00.000Z",
        },
        { park: false },
      );
    await request("q_api", "card_api", "safe_default");
    await request("q_ui", "card_ui", "default_deny");
    const audience: Audience = {
      setup: "team",
      nameOf: (p) => ({ p_priya: "Priya", p_lee: "Lee" })[p],
      levelOf: () => "member",
      canSee: () => true,
      leadOf: () => "p_lee",
    };
    const lines = await namedDecisions({ cardStore: s.cardStore, log: s.log }, audience);
    expect(lines).toContain(
      "Needs a decision from Priya: Keep the old API? (card_api) Default if no answer by 2026-10-02 17:00 UTC: Keep it.",
    );
    expect(lines).toContain(
      "Needs a decision from Lee: Keep the old API? (card_ui) No default: the work waits for the answer.",
    );
  });
});

describe("PM-N9-7: the weekly update is a five-part draft with no health word", () => {
  it("drafts status, done, next, risks and asks; posts nothing", async () => {
    const s = setup();
    await s.cardStore.createCard({
      id: "card_done",
      tier: "task",
      title: "Hasher",
      status: "backlog",
    });
    await s.cardStore.createCard({
      id: "card_next",
      tier: "task",
      title: "Ledger",
      status: "ready",
    });
    const before = (await s.log.getLastEvent())?.seq ?? 0;
    const draft = await draftWeeklyUpdate({
      repoPath: s.repoPath,
      cardStore: s.cardStore,
      pmStore: s.pmStore,
    });
    expect(Object.keys(draft.parts)).toEqual(["status", "done", "next", "risks", "asks"]);
    expect(draft.text).toMatch(/^Status\b/);
    for (const word of HEALTH_WORDS) expect(draft.text.toLowerCase()).not.toContain(word);
    expect(draft.parts.next).toContain("Ledger");
    // A draft is not a post: nothing was written.
    expect((await s.log.getLastEvent())?.seq ?? 0).toBe(before);
  });

  it("DEC-31, dashboard DB-P5-2: the draft names issues by title, in plain words, with no id or stop-reason code", async () => {
    const s = setup();
    const stuck = await s.cardStore.createCard({
      tier: "task",
      title: "Export",
      status: "ready",
    });
    await s.cardStore.updateCard(stuck.id, { stopReason: "budget_exhausted" });
    await s.cardStore.createCard({ tier: "task", title: "Ledger", status: "ready" });
    const draft = await draftWeeklyUpdate({
      repoPath: s.repoPath,
      cardStore: s.cardStore,
      pmStore: s.pmStore,
    });
    expect(draft.parts.status).toBe(
      "0 issues done in the last 7 days, 0 in progress, 0 waiting for review, 2 ready.",
    );
    expect(draft.parts.risks).toBe("- Export: Used every budgeted step without passing.");
    expect(draft.parts.next).toBe("- Export\n- Ledger");
    expect(draft.text).not.toMatch(/card_|\bcards?\b|budget_exhausted|in flight/);
  });

  it("DEC-31: a parked issue is On hold, and the ids in its reason become titles", async () => {
    const s = setup();
    const ledger = await s.cardStore.createCard({ tier: "task", title: "Ledger", status: "ready" });
    await s.cardStore.createCard({
      tier: "task",
      title: "Export",
      status: "parked",
      blockedReason: `Waiting for ${ledger.id} and card_gone to land`,
    });
    const draft = await draftWeeklyUpdate({
      repoPath: s.repoPath,
      cardStore: s.cardStore,
      pmStore: s.pmStore,
    });
    expect(draft.parts.risks).toBe("- Export is on hold: Waiting for Ledger and an issue to land");
    expect(draft.text).not.toMatch(/card_|\bparked\b|\bledger\b/);
  });
});

describe("PM-N9-8: Seshat uses only what the asker can see", () => {
  it("a Viewer's question that would need a hidden project's issue gets nothing from it", async () => {
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
      title: "Salary export to the bank",
      status: "ready",
      projectId: hidden.id,
    });
    await s.cardStore.updateCardStatus("card_salary", "verify", "test setup", "harness", {
      override: true,
    });
    await s.cardStore.updateCardStatus("card_salary", "review", "gates passed");
    const audience: Audience = {
      setup: "team",
      nameOf: () => undefined,
      levelOf: () => "viewer",
      canSee: (_p, project) => project !== hidden.id,
      leadOf: () => undefined,
    };
    const prompts: string[] = [];
    const model = new MockInferenceAdapter("pm", [
      { text: "Cart totals (`card_cart`) is ready.", toolCalls: [], usage },
    ]);
    const wrapped = {
      ...model,
      modelId: model.modelId,
      supportedArms: model.supportedArms,
      generate: async (req: Parameters<typeof model.generate>[0]) => {
        prompts.push(`${req.systemPrompt ?? ""}\n${req.prompt}`);
        return model.generate(req);
      },
    };
    await EventLog.actingFor("p_vic", () =>
      s.pmStore.appendUserMessage("What is waiting for review about the salary export?"),
    );
    await EventLog.actingFor("p_vic", () => s.pmStore.appendUserMessage("status"));
    await answerQueued({
      repoPath: s.repoPath,
      cardStore: s.cardStore,
      pmStore: s.pmStore,
      pmModel: "pm",
      acquire: async () => ({ role: "chat", adapter: wrapped, release: () => {} }),
      audience,
    });
    const replies = (await s.pmStore.thread()).filter((m) => m.role === "pm");
    expect(replies.length).toBeGreaterThan(0);
    for (const text of [...replies.map((r) => r.text), ...prompts]) {
      expect(text).not.toContain("card_salary");
      expect(text).not.toContain("Salary export");
    }
    // The ledger standup counts only the visible issue: nothing in Review.
    const standup = replies.find((r) => /Needs you|Done|In flight|Nothing/i.test(r.text));
    expect(standup?.text ?? "").not.toMatch(/review/i);
  });
});

describe("PM-N9-4: every model string a person reads is guarded, not only the assembled summary", () => {
  it("guards a suggestion's own why, posted on the issue as 'Suggested: … Why: …'", async () => {
    const s = setup();
    const card = await s.cardStore.createCard({
      id: "card_http",
      tier: "task",
      title: "Http",
      status: "ready",
    });
    const { drafts } = await postSuggestions(
      [
        {
          id: "1",
          kind: "update_card",
          cardId: card.id,
          patch: { priority: 1 },
          summary: "x",
          why: "You should ship it now!",
        },
      ],
      {
        cardStore: s.cardStore,
        cards: [card],
        audience: {
          setup: "solo",
          nameOf: () => undefined,
          levelOf: () => "admin",
          canSee: () => true,
          leadOf: () => undefined,
        },
      },
    );
    const suggestionId = drafts[0]?.suggestionId as string;
    const stored = await s.cardStore.suggestions.get(suggestionId);
    expect(stored?.why).not.toMatch(/!/);
    expect(stored?.why?.toLowerCase()).not.toContain("you should");
  });

  it("guards a decision's question and its default option's label", async () => {
    const s = setup();
    await s.cardStore.createCard({ id: "card_api", tier: "task", title: "Api", status: "ready" });
    await new DecisionStore({ store: s.cardStore, log: s.log }).request(
      {
        id: "q_api",
        cardId: "card_api",
        question: "Great question! Should we drop the old API?",
        options: [
          { label: "Keep it!", consequence: "", effortDelta: "none", riskNote: "" },
          { label: "Drop it", consequence: "", effortDelta: "+1 card", riskNote: "" },
        ],
        previewSketches: [],
        recommendation: { optionIndex: 0, rationale: "" },
        policy: "safe_default",
        defaultIfNoAnswer: { optionIndex: 0, deadline: "2026-10-02T17:00:00.000Z" },
        category: "scope_boundary",
        createdAt: "2026-09-26T09:00:00.000Z",
      },
      { park: false },
    );
    const audience: Audience = {
      setup: "solo",
      nameOf: () => undefined,
      levelOf: () => "admin",
      canSee: () => true,
      leadOf: () => undefined,
    };
    const [line] = await namedDecisions({ cardStore: s.cardStore, log: s.log }, audience);
    expect(line).not.toContain("!");
    expect(line?.toLowerCase()).not.toContain("great question");
  });

  it("guards a parked card's reason in the weekly draft's risks", async () => {
    const s = setup();
    await s.cardStore.createCard({
      id: "card_parked",
      tier: "task",
      title: "Parked",
      status: "parked",
      blockedReason: "You should wait, I've decided it's not ready!",
    });
    const draft = await draftWeeklyUpdate({
      repoPath: s.repoPath,
      cardStore: s.cardStore,
      pmStore: s.pmStore,
    });
    expect(draft.parts.risks).not.toContain("!");
    expect(draft.parts.risks.toLowerCase()).not.toContain("you should");
    expect(draft.parts.risks.toLowerCase()).not.toContain("i've decided");
  });

  it("PM-P13-6: with no story map (a Team snapshot scoped away from it), the claim guard does not strip", async () => {
    const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
    const model = {
      modelId: "stand-in",
      supportedArms: ["arm_a_flat"] as const,
      generate: async () => ({
        text: "The walking skeleton is complete and the release is ready to ship.",
        toolCalls: [],
        usage,
      }),
    };
    const snapshot: PmSnapshot = {
      project: "Fixture",
      cards: [],
      cycles: [],
      recentRuns: [],
      pmModel: "stand-in",
      today: "2026-09-26",
      // No storyMap: a Team snapshot scoped to what the asker can see leaves
      // it out (PM-N9-8) rather than judge a claim against a partial graph.
    };
    const reply = await answer(model, snapshot, [], []);
    expect(reply.text).toContain("is complete and the release is ready to ship");
  });
});
