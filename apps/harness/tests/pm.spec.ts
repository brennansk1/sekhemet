import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toProposals } from "../src/pm/agent.js";
import { ProposalError, applyProposal } from "../src/pm/apply.js";
import { answerQueued, runnerLease, workerRecord } from "../src/pm/service.js";
import { PmStore } from "../src/pm/store.js";

const usage = { promptTokens: 10, completionTokens: 10, durationMs: 1 };
const held = (adapter: MockInferenceAdapter) => ({ role: "chat", adapter, release: () => {} });

describe("project manager", () => {
  let repo: string;
  let db: DatabaseSync;
  let log: EventLog;
  let cards: CardStore;
  let board: BoardServiceImpl;
  let pm: PmStore;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pm-"));
    db = new DatabaseSync(":memory:");
    initSchema(db);
    log = new EventLog(db);
    cards = new CardStore(db, log);
    board = new BoardServiceImpl(cards);
    pm = new PmStore(log);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("keeps the conversation in the ledger and marks a message answered once replied to", async () => {
    const msg = await pm.appendUserMessage("How is the ledger card doing?", {
      cardId: "card_x",
    });
    expect((await pm.queued()).map((m) => m.id)).toEqual([msg.id]);

    await pm.appendReply({ replyTo: [msg.id], text: "It passed in 5 turns." });
    const thread = await pm.thread();
    expect(thread.map((m) => [m.role, m.state])).toEqual([
      ["user", "done"],
      ["pm", "done"],
    ]);
    expect(await pm.queued()).toEqual([]);
    expect((await log.verifyHashChain()).valid).toBe(true);
  });

  it("answers queued messages with the PM model and turns tool calls into proposals", async () => {
    const ledger = await cards.createCard({ tier: "task", title: "Ledger", status: "ready" });
    await pm.appendUserMessage("Make the ledger urgent and estimate it.");
    const model = new MockInferenceAdapter("dirk-27b", [
      {
        text: `Raising Ledger (\`${ledger.id}\`) to Urgent: the API waits on it.`,
        toolCalls: [
          {
            id: "1",
            name: "propose_update_card",
            arguments: { card_id: ledger.id, priority: 1, estimate: 3, reason: "api waits on it" },
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
      acquire: async () => held(model),
    });
    expect(answered).toBe(true);

    const reply = (await pm.thread()).at(-1);
    expect(reply?.role).toBe("pm");
    expect(reply?.cites).toEqual([{ cardId: ledger.id }]);
    // PM-N9-1: the priority is a suggestion on the issue; the estimate a proposal.
    const [suggested, proposal] = reply?.proposals ?? [];
    expect(suggested).toMatchObject({
      kind: "update_card",
      cardId: ledger.id,
      patch: { priority: 1 },
      before: { priority: 0 },
      state: "open",
      why: "Api waits on it",
    });
    expect(suggested?.suggestionId).toMatch(/^sug_/);
    expect(proposal).toMatchObject({
      kind: "update_card",
      cardId: ledger.id,
      patch: { estimate: 3 },
      before: { estimate: null },
      state: "open",
    });
    expect((await pm.status()).phase).toBe("idle");

    // Nothing changed until the human applies it.
    expect((await cards.getCard(ledger.id))?.priority).toBe(0);
    await applyProposal(suggested as never, { cardStore: cards, boardService: board, pmStore: pm });
    const applied = await applyProposal(proposal as never, {
      cardStore: cards,
      boardService: board,
      pmStore: pm,
    });
    expect(applied.cards[0]).toMatchObject({ priority: 1, estimate: 3 });
    expect(await cards.suggestions.open(ledger.id)).toEqual([]);
    expect((await pm.proposal(proposal?.id ?? ""))?.state).toBe("applied");

    // The ledger credits the human who approved it, not the PM.
    const updates = (await log.getEventsByCard(ledger.id)).filter((e) => e.type === "card/updated");
    expect(updates.at(-1)?.actor).toBe("human");
  });

  it("refuses a proposal whose card changed since the PM wrote it", async () => {
    const card = await cards.createCard({ tier: "task", title: "Api", status: "ready" });
    const [draft] = toProposals(
      [
        {
          id: "1",
          name: "propose_update_card",
          arguments: { card_id: card.id, priority: 2, reason: "it blocks the release" },
        },
      ],
      [card],
    );
    const reply = await pm.appendReply({ replyTo: [], text: "x", proposals: draft ? [draft] : [] });
    await cards.updateCard(card.id, { priority: 4 }, "human");

    await expect(
      applyProposal(reply.proposals?.[0] as never, {
        cardStore: cards,
        boardService: board,
        pmStore: pm,
      }),
    ).rejects.toBeInstanceOf(ProposalError);
    expect((await pm.proposal(reply.proposals?.[0]?.id ?? ""))?.state).toBe("stale");
  });

  it("PM-P1-7: splits a card into ordered parts and rejects the original", async () => {
    const card = await cards.createCard({ tier: "task", title: "Ledger", status: "ready" });
    const [draft] = toProposals(
      [
        {
          id: "1",
          name: "propose_split_card",
          arguments: {
            card_id: card.id,
            parts: [
              { title: "Append", spec: "append-only insert", estimate: 3 },
              { title: "Idempotency", spec: "dedupe by key", estimate: 2 },
            ],
            reason: "the Worker looped on it",
          },
        },
      ],
      [card],
    );
    expect(draft?.summary).toContain("5 pts");
    const reply = await pm.appendReply({ replyTo: [], text: "x", proposals: draft ? [draft] : [] });
    const { cards: parts } = await applyProposal(reply.proposals?.[0] as never, {
      cardStore: cards,
      boardService: board,
      pmStore: pm,
      repoPath: repo,
    });
    expect(parts.map((p) => p.title)).toEqual(["Append", "Idempotency"]);
    expect(parts[1]?.dependsOn).toContain(parts[0]?.id);
    expect((await cards.getCard(card.id))?.status).toBe("rejected");
  });

  it("PM-P1-7: a split carries none of the original's test files or records to its parts", async () => {
    const card = await cards.createCard({
      tier: "task",
      title: "Ledger",
      status: "ready",
      acceptanceTests: ["a.spec.ts", "b.spec.ts"],
    });
    const staged = (path: string, sha: string, author: string) =>
      cards.recordEvent({
        type: "test/staged",
        cardId: card.id,
        actor: "planner",
        payload: { cardId: card.id, path, sha256: sha, author },
      });
    await staged("tests/a.spec.ts", "a".repeat(64), "planner");
    await staged("tests/b.spec.ts", "b".repeat(64), "repository");
    const [draft] = toProposals(
      [
        {
          id: "1",
          name: "propose_split_card",
          arguments: {
            card_id: card.id,
            parts: [
              { title: "Append", spec: "append-only insert", estimate: 3 },
              { title: "Idempotency", spec: "dedupe by key", estimate: 2 },
            ],
            reason: "too big",
          },
        },
      ],
      [card],
    );
    const reply = await pm.appendReply({ replyTo: [], text: "x", proposals: draft ? [draft] : [] });
    const { cards: parts } = await applyProposal(reply.proposals?.[0] as never, {
      cardStore: cards,
      boardService: board,
      pmStore: pm,
      repoPath: repo,
    });
    for (const part of parts) {
      expect(part.acceptanceTests ?? []).not.toContain("a.spec.ts");
      const records = (await cards.cardEvents(part.id, ["test/staged"])).map(
        (e) => (e.payload as { path: string }).path,
      );
      expect(records).not.toContain("tests/a.spec.ts");
      expect(records).not.toContain("tests/b.spec.ts");
    }
  });

  it("drops invalid tool calls instead of producing broken proposals", async () => {
    const card = await cards.createCard({ tier: "task", title: "Api", status: "ready" });
    const drafts = toProposals(
      [
        { id: "1", name: "propose_update_card", arguments: { card_id: "nope", priority: 1 } },
        { id: "2", name: "propose_update_card", arguments: { card_id: card.id, priority: 9 } },
        { id: "3", name: "propose_split_card", arguments: { card_id: card.id, parts: [] } },
        { id: "4", name: "propose_move_card", arguments: { card_id: card.id, to: "done" } },
      ],
      [card],
    );
    expect(drafts).toEqual([]);
  });

  it("turns a model failure into an error reply rather than a silent hang", async () => {
    await pm.appendUserMessage("Plan next cycle");
    await answerQueued({
      repoPath: repo,
      cardStore: cards,
      pmStore: pm,
      pmModel: "dirk-27b",
      acquire: async () => {
        throw new Error("model not installed");
      },
    });
    const reply = (await pm.thread()).at(-1);
    expect(reply?.state).toBe("error");
    // PM-01: a worded cause, never the exception's text (it goes to the log).
    expect(reply?.cause).toBe("no_model");
    expect(reply?.text).toMatch(/No model is answering for Seshat/);
    expect(reply?.text).not.toContain("model not installed");
    expect(await pm.queued()).toEqual([]);
  });

  it("WL-N5-2: summarises the Worker's record from attempt/finished records", async () => {
    for (const id of ["a", "b", "c", "d"]) {
      await cards.createCard({ id, tier: "task", title: id });
    }
    const run = async (
      cardId: string,
      stopReason: "gate_passed" | "oscillation_detected",
      steps: number,
      builtBy?: { kind: "person"; id: string },
    ) => {
      const a = await cards.runs.startAttempt({
        cardId,
        attemptNumber: cards.runs.nextAttemptNumber(cardId),
        modelId: "cyber-tiel",
        ...(builtBy ? { builtBy } : {}),
      });
      await cards.runs.finishAttempt({
        attemptId: a.id,
        status: stopReason === "gate_passed" ? "passed" : "failed",
        stopReason,
        tokensUsed: 1,
        secondsUsed: 1,
        steps,
      });
    };
    await run("a", "gate_passed", 2);
    await run("b", "gate_passed", 4);
    await run("c", "oscillation_detected", 10);
    await run("c", "gate_passed", 3); // a retry is not a first attempt
    await run("d", "gate_passed", 1, { kind: "person", id: "p_1" }); // nor is a person's
    const record = workerRecord(cards.runs.readAttemptOutcomes());
    expect(record?.model).toBe("cyber-tiel");
    expect(record?.record).toContain("2/3 first attempts passed");
    expect(record?.record).toContain("median of 4 steps");
    expect(record?.record).toContain("oscillation_detected ×1");
    expect(workerRecord([])).toBeUndefined();
  });

  it("M1: Seshat holds the model for the whole answer and releases it after, even on a failure", async () => {
    await pm.appendUserMessage("Plan next cycle");
    const events: string[] = [];
    const model = new MockInferenceAdapter("dirk-27b", [
      { text: "Split the ledger card first.", toolCalls: [], usage },
    ]);
    const acquire = (adapter: MockInferenceAdapter) => async () => {
      events.push("hold");
      return { role: "chat", adapter, release: () => events.push("release") };
    };
    await answerQueued({
      repoPath: repo,
      cardStore: cards,
      pmStore: pm,
      pmModel: "dirk-27b",
      acquire: acquire(model),
    });
    expect((await pm.thread()).at(-1)?.text).toContain("Split the ledger");
    expect(events).toEqual(["hold", "release"]);

    await pm.appendUserMessage("And after that?");
    const broken = new MockInferenceAdapter("dirk-27b", []);
    broken.generate = async () => {
      throw new Error("the server went away");
    };
    await answerQueued({
      repoPath: repo,
      cardStore: cards,
      pmStore: pm,
      pmModel: "dirk-27b",
      acquire: acquire(broken),
    });
    expect((await pm.thread()).at(-1)?.state).toBe("error");
    expect(events).toEqual(["hold", "release", "hold", "release"]);
  });

  it("has no runner lease when no queue is running", () => {
    expect(runnerLease(repo)).toBeUndefined();
  });

  it("answers a status question from the ledger without loading any model", async () => {
    await cards.createCard({
      tier: "task",
      title: "Ledger (SPIDR: Rule)",
      status: "ready",
      priority: 1,
    });
    await pm.appendUserMessage("status?");
    let loaded = false;
    await answerQueued({
      repoPath: repo,
      cardStore: cards,
      pmStore: pm,
      pmModel: "dirk-27b",
      acquire: async () => {
        loaded = true;
        throw new Error("must not load");
      },
    });
    expect(loaded).toBe(false);
    const reply = (await pm.thread()).at(-1);
    expect(reply?.text).toContain("Next up: Ledger");
    expect(reply?.text).toContain("without loading a model");
  });

  it("folds older messages into a rolling summary and honours /compact", async () => {
    for (let i = 0; i < 3; i++) {
      const m = await pm.appendUserMessage(`question ${i}`);
      await pm.appendReply({ replyTo: [m.id], text: `answer ${i}` });
    }
    await pm.appendUserMessage("/compact");
    const model = new MockInferenceAdapter("dirk-27b", [
      { text: "Human asked three questions; all answered.", toolCalls: [], usage },
    ]);
    await answerQueued({
      repoPath: repo,
      cardStore: cards,
      pmStore: pm,
      pmModel: "dirk-27b",
      acquire: async () => held(model),
    });
    expect((await pm.summary())?.text).toBe("Human asked three questions; all answered.");
    expect((await pm.thread()).at(-1)?.text).toMatch(/^Compacted\./);
  });
});
