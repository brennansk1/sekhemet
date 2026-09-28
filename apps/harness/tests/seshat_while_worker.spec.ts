import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerQueued } from "../src/pm/service.js";
import { PmStore } from "../src/pm/store.js";
import { ledgerQuestion, waitInWords } from "../src/pm/while_worker.js";

// Models rule 20f (MD-N14-27–29): Seshat while the Worker runs. Deterministic
// answers from the ledger and the board with no model; a quick answer only
// when one is named and headroom admits it, labelled, with no tools and never
// acting; the full answer queued with its predicted wait in words. Real
// SQLite; no model is loaded.

const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
const MIN = 60_000;

describe("Seshat while the Worker runs (rule 20f)", () => {
  let repo: string;
  let log: EventLog;
  let cards: CardStore;
  let pm: PmStore;
  const noModel = async (): Promise<never> => {
    throw new Error("a model was asked for");
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "seshat-worker-"));
    const db = new DatabaseSync(join(repo, "ledger.db"));
    initSchema(db);
    log = new EventLog(db);
    cards = new CardStore(db, log);
    pm = new PmStore(log);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("knows the questions the ledger answers", () => {
    expect(ledgerQuestion("status")).toBe("status");
    expect(ledgerQuestion("Where do the cards stop?")).toBe("stops");
    expect(ledgerQuestion("what is waiting on me?")).toBe("waiting");
    expect(ledgerQuestion("How long until you can answer?")).toBe("wait");
    expect(ledgerQuestion("Should we split the ledger card?")).toBeUndefined();
    expect(waitInWords({ waitMs: 4 * MIN, stepMs: MIN, switchMs: 3 * MIN })).toBe(
      "I'll answer in about 4 minutes: the agent is finishing a step, and switching takes about 3.",
    );
  });

  it("MD-N14-27: status, where the cards stop, what waits on the person and the predicted wait come from the ledger, with no model request", async () => {
    const stuck = await cards.createCard({ tier: "task", title: "Ledger", status: "in_progress" });
    await cards.updateCard(stuck.id, { stopReason: "no_progress" });
    const login = await cards.createCard({ tier: "task", title: "Login", status: "in_progress" });
    await cards.updateCardStatus(login.id, "verify");
    await cards.updateCardStatus(login.id, "review");
    for (const q of [
      "status",
      "Where do the cards stop?",
      "What is waiting on me?",
      "How long until you answer?",
    ])
      await pm.appendUserMessage(q);
    const answered = await answerQueued({
      repoPath: repo,
      cardStore: cards,
      pmStore: pm,
      pmModel: "dirk-27b",
      acquire: noModel,
      predictWait: async () => ({
        waitMs: 4 * MIN,
        quickPath: true,
        stepMs: MIN,
        switchMs: 3 * MIN,
      }),
    });
    expect(answered).toBe(true);
    const replies = (await pm.thread()).filter((m) => m.role === "pm");
    expect(replies).toHaveLength(4);
    expect(replies.every((r) => /without loading a model|from the ledger/i.test(r.text))).toBe(
      true,
    );
    expect(replies[1]?.text).toMatch(/Ledger.*no_progress/);
    expect(replies[2]?.text).toMatch(/Login/);
    expect(replies[3]?.text).toMatch(/about 4 minutes/);
    expect(await pm.queued()).toEqual([]);
  });

  it("MD-N14-28: a quick answer is labelled, has no tools, and records no card, plan, proposal or decision", async () => {
    const card = await cards.createCard({ tier: "task", title: "Ledger", status: "ready" });
    await pm.appendUserMessage("Should the ledger card go first?");
    const quick = new MockInferenceAdapter("qwen3-4b", [
      {
        text: `Yes. PROPOSAL: raise \`${card.id}\` to Urgent.`,
        toolCalls: [
          {
            id: "1",
            name: "propose_update_card",
            arguments: { card_id: card.id, priority: 1, reason: "first" },
          },
        ],
        usage,
      },
    ]);
    const answered = await answerQueued({
      repoPath: repo,
      cardStore: cards,
      pmStore: pm,
      pmModel: "dirk-27b",
      acquire: noModel,
      predictWait: async () => ({ waitMs: 9 * MIN, quickPath: true }),
      quick: {
        name: "qwen3-4b",
        admitted: async () => true,
        acquire: async () => ({ role: "quick", adapter: quick, release: () => {} }),
      },
    });
    expect(answered).toBe(false);
    const replies = (await pm.thread()).filter((m) => m.role === "pm");
    const label = replies.find((r) => r.text.startsWith("Quick answer"));
    expect(label?.text).toMatch(/^Quick answer \(qwen3-4b\)/);
    expect(replies.every((r) => (r.proposals ?? []).length === 0)).toBe(true);
    expect(quick.callHistory).toHaveLength(1);
    expect(quick.callHistory[0]?.tools ?? []).toEqual([]);
    expect((await cards.getCard(card.id))?.priority).toBe(card.priority);
    // The full answer stays queued.
    expect(await pm.queued()).toHaveLength(1);
  });

  it("MD-N14-28: a quick answerer that headroom does not admit is never loaded", async () => {
    await pm.appendUserMessage("Should the ledger card go first?");
    let loaded = false;
    await answerQueued({
      repoPath: repo,
      cardStore: cards,
      pmStore: pm,
      pmModel: "dirk-27b",
      acquire: noModel,
      predictWait: async () => ({ waitMs: 9 * MIN, quickPath: true }),
      quick: {
        name: "qwen3-4b",
        admitted: async () => false,
        acquire: async () => {
          loaded = true;
          throw new Error("loaded");
        },
      },
    });
    expect(loaded).toBe(false);
    expect(await pm.queued()).toHaveLength(1);
  });

  it("MD-N14-29: the full answer is queued with its predicted wait in words, said once, then answered when the swap is allowed", async () => {
    await pm.appendUserMessage("Should we split the ledger card?");
    let quickPath = true;
    const model = new MockInferenceAdapter("dirk-27b", [
      { text: "Split it into the parser and the writer.", toolCalls: [], usage },
    ]);
    let acquired = 0;
    const deps = {
      repoPath: repo,
      cardStore: cards,
      pmStore: pm,
      pmModel: "dirk-27b",
      acquire: async () => {
        acquired++;
        return { role: "chat", adapter: model, release: () => {} };
      },
      predictWait: async () => ({ waitMs: 4 * MIN, quickPath, stepMs: MIN, switchMs: 3 * MIN }),
    };
    expect(await answerQueued(deps)).toBe(false);
    expect(await answerQueued(deps)).toBe(false);
    const notes = (await pm.thread()).filter((m) => m.role === "pm");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toMatch(/about 4 minutes/);
    expect((await pm.status()).phase).toBe("waiting_for_step");
    expect((await pm.status()).etaSeconds).toBe(240);
    expect(acquired).toBe(0);
    expect(await pm.queued()).toHaveLength(1);
    quickPath = false;
    expect(await answerQueued(deps)).toBe(true);
    expect(acquired).toBe(1);
    const last = (await pm.thread()).at(-1);
    expect(last?.text).toMatch(/Split it/);
    expect(await pm.queued()).toEqual([]);
  });
});
