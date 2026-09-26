import { FALLBACK_CHARS_PER_TOKEN, estimatePromptTokens } from "@sekhemet/context";
import type { CardRecord } from "@sekhemet/kernel";
import {
  type InferenceRequest,
  type LocalInferenceAdapter,
  PROMPT_CHARS_PER_TOKEN,
  countPromptTokens,
} from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { type PmSnapshot, answer, pmSystemPrompt } from "../src/pm/agent.js";
import type { PmMessage } from "../src/pm/types.js";

// CX-N3-7: Seshat's prompt is fitted to the Planner's configured context by
// the allocator's priorities. Nothing here loads a model.

function fakePlanner(contextTokens: number) {
  const seen: InferenceRequest[] = [];
  const model: LocalInferenceAdapter = {
    modelId: "planner-model",
    supportedArms: ["arm_a_flat"],
    contextWindow: { contextTokens, maxTokens: 1200 },
    generate: async (req) => {
      seen.push(req);
      return {
        text: "Here is the answer.",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      };
    },
  };
  return { model, seen };
}

const card = (i: number): CardRecord =>
  ({
    id: `card_${i}`,
    title: `A card with a fairly long title describing work item number ${i} in detail`,
    status: i % 3 === 0 ? "backlog" : "ready",
    stepBudget: 20,
    scopeFiles: [],
  }) as unknown as CardRecord;

const snapshot = (cards: number): PmSnapshot => ({
  project: "demo",
  cards: Array.from({ length: cards }, (_, i) => card(i)),
  cycles: [],
  recentRuns: Array.from({ length: 12 }, (_, i) => `card_${i}: passed in 3 steps (38s)`),
  worker: { model: "cyber-tiel", record: "8 of 10 first attempts passed" },
  pmModel: "planner-model",
  preferences: ["Short replies"],
  pmRules: ["Split any card that touches more than three files."],
  dossier: { cardId: "card_1", lines: ["Q: which parser? A: the existing one"] },
  today: "2026-09-25",
});

const msg = (seq: number, role: "user" | "pm", text: string): PmMessage => ({
  id: `m${seq}`,
  seq,
  role,
  text,
  createdAt: "2026-09-25T00:00:00Z",
  state: "done",
});

describe("CX-N3-7: Seshat's prompt fits the Planner's context", () => {
  it("uses the one estimator's ratio when the adapter counts a prompt (CX-N3-3)", () => {
    expect(PROMPT_CHARS_PER_TOKEN).toBe(FALLBACK_CHARS_PER_TOKEN);
  });

  it("cuts by priority, never the system text or the newest message, and records each section", async () => {
    const { model, seen } = fakePlanner(4096);
    const history = Array.from({ length: 30 }, (_, i) =>
      msg(i + 1, i % 2 ? "pm" : "user", `message ${i} ${"words ".repeat(90)}`),
    );
    const newest = msg(99, "user", `Should we split card_7? ${"Please be thorough. ".repeat(20)}`);
    const snap = snapshot(400);
    const result = await answer(model, snap, history, [newest]);
    const req = seen[0] as InferenceRequest;
    expect(req.systemPrompt).toBe(pmSystemPrompt(snap));
    expect(req.prompt).toContain(newest.text);
    // What the adapter counts fits the window less the answer cap.
    const counted = countPromptTokens(
      [{ content: req.systemPrompt ?? "" }, { content: req.prompt }],
      req.tools,
    );
    expect(counted).toBeLessThanOrEqual(4096 - 1200);
    // The board was cut, and it says so; the PM's rules and the dossier are there.
    expect(req.prompt).not.toContain("card_399");
    expect(req.prompt).toContain("Split any card that touches more than three files.");
    const ids = result.promptSections?.map((s) => s.id) ?? [];
    expect(ids).toEqual(expect.arrayContaining(["newest", "board"]));
    const newestTokens = result.promptSections?.find((s) => s.id === "newest")?.tokens;
    expect(newestTokens).toBe(estimatePromptTokens(`NEW MESSAGE\nHuman: ${newest.text}`));
    expect(result.promptBudget).toMatchObject({ role: "seshat", windowTokens: 4096 });
  });

  it("with room to spare, sends the whole board", async () => {
    const { model, seen } = fakePlanner(32_768);
    await answer(model, snapshot(40), [], [msg(1, "user", "Status of card_39?")]);
    expect(seen[0]?.prompt).toContain("card_39");
    expect(seen[0]?.prompt).not.toContain("cut to fit");
  });
});

describe("CX-N3-7 in the product: the PM service fills the snapshot and records the fit", () => {
  it("puts the PM's rules and the card's dossier in Seshat's prompt, and records the per-section tokens", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { DatabaseSync } = await import("node:sqlite");
    const { CardStore, EventLog, initSchema } = await import("@sekhemet/kernel");
    const { LearningStore } = await import("../src/learning/store.js");
    const { PmStore } = await import("../src/pm/store.js");
    const { answerQueued } = await import("../src/pm/service.js");
    const repoPath = mkdtempSync(join(tmpdir(), "sek-pm-fit-"));
    try {
      const db = new DatabaseSync(join(repoPath, "events.db"));
      initSchema(db);
      const log = new EventLog(db);
      const cardStore = new CardStore(db, log);
      const pmStore = new PmStore(log);
      await cardStore.createCard({ id: "card_x", tier: "story", title: "Ledger", scopeFiles: [] });
      await cardStore.recordDossierEntry({
        cardId: "card_x",
        kind: "note",
        actor: "manager",
        text: "The ledger keeps its hash chain.",
      });
      const learning = new LearningStore(log);
      const rule = await learning.propose({
        role: "manager",
        text: "Split any card that touches more than three files.",
        scope: { kind: "rule" },
        source: "person",
        evidence: [{ cardId: "card_x", kind: "send_back" } as never],
      });
      expect(rule).toBeDefined();
      if (rule) await learning.update(rule.id, { status: "active" });
      await pmStore.appendUserMessage("Should we split it?", { cardId: "card_x" });
      const { model, seen } = fakePlanner(8192);
      expect(
        await answerQueued({
          repoPath,
          cardStore,
          pmStore,
          pmModel: "planner-model",
          acquire: async () => ({ role: "chat", adapter: model, release: () => {} }),
        }),
      ).toBe(true);
      const prompt = seen[0]?.prompt ?? "";
      expect(prompt).toContain("Split any card that touches more than three files.");
      // CX-N4-5: the rules a Worker prompt reads never include it.
      const workerRules = await learning.activeFor("worker", {
        title: "Ledger",
        kind: "rule",
        scopeFiles: [],
      });
      expect(JSON.stringify(workerRules)).not.toContain("Split any card");
      expect(prompt).toContain("DOSSIER OF `card_x`");
      expect(prompt).toContain("The ledger keeps its hash chain.");
      const fitted = (await log.getEventsByTypes(["pm/prompt_fitted"])).at(-1)?.payload as
        | { role: string; windowTokens: number; sections: { id: string; tokens: number }[] }
        | undefined;
      expect(fitted).toMatchObject({ role: "seshat", windowTokens: 8192 });
      expect(fitted?.sections.map((s) => s.id)).toEqual(
        expect.arrayContaining(["newest", "dossier"]),
      );
      db.close();
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
