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
      acquire: async () => model,
    });
    expect(answered).toBe(true);

    const reply = (await pm.thread()).at(-1);
    expect(reply?.role).toBe("pm");
    expect(reply?.cites).toEqual([{ cardId: ledger.id }]);
    const proposal = reply?.proposals?.[0];
    expect(proposal).toMatchObject({
      kind: "update_card",
      cardId: ledger.id,
      patch: { priority: 1, estimate: 3 },
      before: { priority: 0, estimate: null },
      state: "open",
    });
    expect((await pm.status()).phase).toBe("idle");

    // Nothing changed until the human applies it.
    expect((await cards.getCard(ledger.id))?.priority).toBe(0);
    const applied = await applyProposal(proposal as never, {
      cardStore: cards,
      boardService: board,
      pmStore: pm,
    });
    expect(applied.cards[0]).toMatchObject({ priority: 1, estimate: 3 });
    expect((await pm.proposal(proposal?.id ?? ""))?.state).toBe("applied");

    // The ledger credits the human who approved it, not the PM.
    const updates = (await log.getEventsByCard(ledger.id)).filter((e) => e.type === "card/updated");
    expect(updates.at(-1)?.actor).toBe("human");
  });

  it("refuses a proposal whose card changed since the PM wrote it", async () => {
    const card = await cards.createCard({ tier: "task", title: "Api", status: "ready" });
    const [draft] = toProposals(
      [{ id: "1", name: "propose_update_card", arguments: { card_id: card.id, priority: 2 } }],
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

  it("splits a card into ordered parts and parks the original", async () => {
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
    });
    expect(parts.map((p) => p.title)).toEqual(["Append", "Idempotency"]);
    expect(parts[1]?.dependsOn).toEqual([parts[0]?.id]);
    expect((await cards.getCard(card.id))?.status).toBe("parked");
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
    expect(reply?.text).toContain("model not installed");
    expect(await pm.queued()).toEqual([]);
  });

  it("summarises the Worker's record from run reports", () => {
    const record = workerRecord([
      {
        startedAt: "2026-09-18T10:00:00Z",
        model: "cyber-tiel",
        entries: [
          {
            cardId: "a",
            attempt: 1,
            passed: true,
            accepted: true,
            stopReason: "gate_passed",
            turns: 2,
            durationMs: 1,
            promptTokens: 1,
            completionTokens: 1,
          },
          {
            cardId: "b",
            attempt: 1,
            passed: true,
            accepted: true,
            stopReason: "gate_passed",
            turns: 4,
            durationMs: 1,
            promptTokens: 1,
            completionTokens: 1,
          },
          {
            cardId: "c",
            attempt: 1,
            passed: false,
            accepted: false,
            stopReason: "oscillation_detected",
            turns: 10,
            durationMs: 1,
            promptTokens: 1,
            completionTokens: 1,
          },
        ],
        passAt1: 2 / 3,
        passAfterEscalation: 2 / 3,
        modelSwaps: 0,
        totalDurationMs: 1,
      },
    ]);
    expect(record?.record).toContain("2/3 first attempts passed");
    expect(record?.record).toContain("oscillation_detected ×1");
  });

  it("has no runner lease when no queue is running", () => {
    expect(runnerLease(repo)).toBeUndefined();
  });
});
