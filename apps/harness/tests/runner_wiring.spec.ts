import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { PlaybookRegistry } from "@sekhemet/context";
import { BlobStore, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The browser module, imported as the page runs it.
import { latestReview } from "../../../packages/ui/web/review_parse.js";
import {
  QueuedWorkerQuestions,
  executeCard,
  heldTarget,
  nextAttemptNumber,
  recordReview,
  releaseHeldCards,
  unlessPlaybookCovers,
} from "../src/execute.js";
import { LearningStore } from "../src/learning/store.js";

/** Replies with each scripted turn in order, then `finish_card`; records every request. */
function scripted(turns: Omit<ToolCall, "id">[][]) {
  const seen: InferenceRequest[] = [];
  let i = 0;
  const adapter: LocalInferenceAdapter = {
    modelId: "scripted",
    supportedArms: ["arm_a_flat"],
    generate: async (req) => {
      seen.push(req);
      const calls = turns[i++] ?? [{ name: "finish_card", arguments: {} }];
      return {
        text: "",
        toolCalls: calls.map((c, n) => ({ id: `t${i}-${n}`, ...c })),
        usage: { promptTokens: 10, completionTokens: 2, durationMs: 1 },
      };
    },
  };
  return { adapter, seen };
}

const WRITE_A = [
  {
    name: "write_file",
    arguments: { path: "src/a.ts", content: "export const a = 1;\n" },
  },
  { name: "finish_card", arguments: {} },
];

describe("apps/harness executeCard wiring (wave 2, part 1)", () => {
  let repo: string;
  let db: DatabaseSync;
  let log: EventLog;
  let cardStore: CardStore;
  let boardService: BoardServiceImpl;
  let ctx: Parameters<typeof executeCard>[0];

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "sekhemet-wiring-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    mkdirSync(join(repo, "src"));
    mkdirSync(join(repo, ".sekhemet"));
    writeFileSync(join(repo, "src", "a.ts"), "");
    writeFileSync(
      join(repo, ".sekhemet", "gates.toml"),
      `[project]\nmax_files = 3\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 30\nparser = "generic"\n`,
    );
    writeFileSync(
      join(repo, ".gitignore"),
      ".sekhemet/events.db*\n.sekhemet/worktrees\n.sekhemet/evidence\n.sekhemet/transcripts\n.sekhemet/observations\n",
    );
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    log = new EventLog(db);
    cardStore = new CardStore(db, log);
    boardService = new BoardServiceImpl(cardStore);
    ctx = { repoPath: repo, restrictedMode: false, cardStore, boardService, log: () => {} };
  });

  afterEach(() => {
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  const newCard = (id: string) =>
    cardStore.createCard({
      id,
      tier: "story",
      title: `Write a (${id})`,
      status: "ready",
      scopeFiles: ["src/a.ts"],
      stepBudget: 6,
      spec: "Write src/a.ts exporting a.",
    });

  it("persists actuals through the card store and numbers attempts across runs", async () => {
    const card = await newCard("card_act");
    expect(nextAttemptNumber(repo, card.id)).toBe(1);
    const result = await executeCard(ctx, card, scripted([WRITE_A]).adapter);
    expect(result.passed).toBe(true);
    expect(result.attempt).toBe(1);
    const stored = await cardStore.getCard(card.id);
    expect(stored?.stopReason).toBe("gate_passed");
    expect(stored?.evidenceId).toBe(result.evidence.id);
    expect(stored?.tokensUsed).toBe(12);
    expect(nextAttemptNumber(repo, card.id)).toBe(2);
  });

  it("holds a card on back-pressure and releases it when Review drains", async () => {
    for (const id of ["card_r1", "card_r2", "card_r3"]) {
      await cardStore.createCard({ id, tier: "story", title: id, status: "review" });
    }
    const card = await newCard("card_held");
    const result = await executeCard(ctx, card, scripted([WRITE_A]).adapter);
    expect(result.passed).toBe(true);
    expect(result.held?.wanted).toBe("verify");
    const held = await cardStore.getCard(card.id);
    expect(held?.status).toBe("in_progress");
    expect(heldTarget(held?.blockedReason)).toBe("verify");
    expect((await boardService.listHeld()).map((c) => c.id)).toEqual(["card_held"]);

    // Still full: nothing moves.
    expect(await releaseHeldCards(ctx)).toEqual([]);
    await boardService.transitionCard({
      cardId: "card_r1",
      fromStatus: "review",
      toStatus: "parked",
      actor: "human",
      reason: "parked",
    });
    expect(await releaseHeldCards(ctx)).toEqual(["card_held"]);
    const released = await cardStore.getCard(card.id);
    // Its gates passed, so it continues to Review as it would have.
    expect(released?.status).toBe("review");
    expect(released?.blockedReason ?? null).toBeNull();
  });

  it("hands askTeam the question's dossier entry id, and files a queued answer under it", async () => {
    const card = await newCard("card_ask");
    const asked: { cardId: string; question: string; meta: { questionEntryId?: string } }[] = [];
    const queued = new QueuedWorkerQuestions();
    ctx.askTeam = async (cardId, question, meta) => {
      asked.push({ cardId, question, meta });
      queued.add(cardId, "pmm_q1", meta.questionEntryId);
      return undefined;
    };
    const { adapter } = scripted([
      [{ name: "ask", arguments: { question: "Should zebras be quoted?" } }],
      WRITE_A,
    ]);
    await executeCard(ctx, card, adapter);
    expect(asked).toHaveLength(1);
    const questionId = asked[0]?.meta.questionEntryId;
    expect(questionId).toBeTruthy();

    // Seshat's batch answered it (the thread as PmStore.thread() returns it).
    const filed = await queued.fileAnswers(
      [
        { id: "pmm_q1", seq: 5, role: "user", state: "done", text: "Should zebras..." },
        { id: "pmm_r1", seq: 6, role: "pm", state: "done", text: "Yes, quote them." },
      ],
      cardStore,
    );
    expect(filed).toBe(1);
    expect(queued.size).toBe(0);
    const dossier = await cardStore.getDossier(card.id);
    const thread = dossier.questions.find((t) => t.question.entryId === questionId);
    expect(thread?.answers.map((a) => a.text)).toEqual(["Yes, quote them."]);
    expect(thread?.answers[0]?.actor).toBe("manager");
  });

  it("keeps an unanswered queued question queued", async () => {
    const queued = new QueuedWorkerQuestions();
    queued.add("card_x", "pmm_q", "e1");
    const filed = await queued.fileAnswers(
      [{ id: "pmm_q", seq: 1, role: "user", state: "queued", text: "?" }],
      cardStore,
    );
    expect(filed).toBe(0);
    expect(queued.size).toBe(1);
  });

  it("keeps an error-scoped learned rule out of the prompt until its error stands", async () => {
    const learning = new LearningStore(log);
    const scopedRule = await learning.propose({
      role: "worker",
      text: "When TS9999 appears, rename the zebra field.",
      scope: { errorPattern: "TS9999" },
      source: "seed",
      evidence: [],
    });
    const plainRule = await learning.propose({
      role: "worker",
      text: "Always export constants by name, never default.",
      scope: {},
      source: "seed",
      evidence: [],
    });
    await learning.update(scopedRule?.id ?? "", { status: "active" });
    await learning.update(plainRule?.id ?? "", { status: "active" });
    ctx.learning = learning;
    const card = await newCard("card_rules");
    const { adapter, seen } = scripted([WRITE_A]);
    await executeCard(ctx, card, adapter);
    const first = `${seen[0]?.systemPrompt}\n${seen[0]?.prompt}`;
    expect(first).toContain("Always export constants by name");
    expect(first).not.toContain("rename the zebra field");
  });

  it("does not propose a learned rule the playbook already states (coveringRule)", async () => {
    writeFileSync(
      join(repo, ".sekhemet", "playbook.toml"),
      `[[rule]]\nid = "seed_eopt"\npattern = "src"\ninstruction = "exactOptionalPropertyTypes is on: spread optional fields conditionally."\n`,
    );
    const learning = new LearningStore(log);
    const guarded = unlessPlaybookCovers(learning, new PlaybookRegistry(repo));
    expect(
      await guarded.propose({
        role: "worker",
        text: '"TS2375: undefined not assignable" took 3 attempts to fix.',
        scope: {},
        source: "struggle",
        evidence: [],
      }),
    ).toBeUndefined();
    const fresh = await guarded.propose({
      role: "worker",
      text: '"TS2304: cannot find name" took 3 attempts to fix.',
      scope: {},
      source: "struggle",
      evidence: [],
    });
    expect(fresh?.id).toMatch(/^rule_/);
  });

  it("stops before a turn while the memory watchdog holds turns, resumably", async () => {
    const card = await newCard("card_mem");
    ctx.watchdog = { shouldPauseTurns: () => true, waitUntilBelow: async () => false };
    const { adapter, seen } = scripted([WRITE_A]);
    const result = await executeCard(ctx, card, adapter);
    expect(seen).toHaveLength(0);
    expect(result.stopReason).toBe("memory_pressure");
  });

  it("waits out a watchdog pause between turns and carries on when pressure falls", async () => {
    const card = await newCard("card_wait");
    let paused = false;
    let waited = 0;
    ctx.watchdog = {
      shouldPauseTurns: () => paused,
      waitUntilBelow: async () => {
        waited++;
        paused = false;
        return true;
      },
    };
    ctx.afterTurn = async () => {
      paused = true; // pressure rises during the first turn
    };
    const { adapter } = scripted([
      [{ name: "read_file", arguments: { path: "src/a.ts" } }],
      WRITE_A,
    ]);
    const result = await executeCard(ctx, card, adapter);
    expect(waited).toBeGreaterThan(0);
    expect(result.passed).toBe(true);
  });

  it("runs a --restricted card as a read-only audit on the static gates only", async () => {
    writeFileSync(
      join(repo, ".sekhemet", "gates.toml"),
      `[project]\nmax_files = 3\nmax_diff_lines = 200\n\n[[gate]]\nid = "types"\nrung = "typecheck"\nlayer = "static"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 30\nparser = "generic"\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(1)"]\ntimeout_s = 30\nparser = "generic"\n`,
    );
    execFileSync("git", ["commit", "-qam", "gates"], { cwd: repo });
    const card = await newCard("card_audit");
    const { adapter, seen } = scripted([WRITE_A]);
    const result = await executeCard({ ...ctx, restrictedMode: true }, card, adapter);
    expect(seen[0]?.tools?.map((t) => t.name)).not.toContain("run_cmd");
    expect(result.turns[0]?.observations[0]?.denied).toBe(true);
    // Only the static gate ran (the failing functional one would execute repo code).
    expect(result.passed).toBe(true);
    const ran = result.evidence.rungResults ?? [];
    expect(
      ran.filter((r) => r.layer === "static" || r.layer === "functional").map((r) => r.gate),
    ).toEqual(["types"]);
    // The built-in layers are static analysis too, and run; mutation (which runs tests) does not.
    expect(ran.some((r) => r.gate === "mutation")).toBe(false);
    expect(result.evidence.filesTouched).toEqual([]);
  });

  it("records the attempt, its steps, gate results, evidence and competence, and logs every prompt by hash (K4, K11, K16-K22, K26)", async () => {
    const card = await newCard("card_rec");
    const { adapter, seen } = scripted([
      [{ name: "read_file", arguments: { path: "src/a.ts" } }],
      WRITE_A,
    ]);
    const result = await executeCard(ctx, card, adapter);
    expect(result.passed).toBe(true);

    const [attempt] = cardStore.runs.listAttempts(card.id);
    expect(attempt).toMatchObject({
      attemptNumber: 1,
      status: "passed",
      stopReason: "gate_passed",
    });
    const steps = cardStore.runs.listSteps(attempt?.id ?? "");
    expect(steps.map((s) => s.stepIndex)).toEqual([1, 2]);
    expect(steps[1]?.calls.map((c) => c.name)).toEqual(["write_file", "finish_card"]);
    expect(cardStore.runs.listGateResults(attempt?.id ?? "")[0]).toMatchObject({
      gate: "unit",
      passed: true,
      stepId: steps[1]?.id,
    });
    // The passing step's checkpoint commit is pinned to its step row.
    expect(steps[1]?.gitRef).toMatch(/^[0-9a-f]{7,40}$/);

    // K11/K26: every request's prompt is a stored pack, byte for byte.
    const blobs = new BlobStore(repo);
    for (const [i, step] of steps.entries()) {
      const pack = JSON.parse(blobs.get(step.contextPackId ?? "") ?? "{}");
      expect(pack.systemPrompt).toBe(seen[i]?.systemPrompt);
      expect(pack.prompt).toBe(seen[i]?.prompt);
    }
    expect((await cardStore.getCard(card.id))?.contextPackId).toBe(steps[1]?.contextPackId);

    // K4: the ledger's card/step events carry the typed ids.
    const stepEvents = (await log.getEventsByCard(card.id)).filter((e) => e.type === "card/step");
    expect(stepEvents.map((e) => e.stepId)).toEqual(steps.map((s) => s.id));
    expect(stepEvents.every((e) => e.attemptId === attempt?.id)).toBe(true);

    const [evidence] = cardStore.runs.listEvidence(card.id);
    expect(evidence?.id).toBe(result.evidence.id);
    expect(evidence?.trajectoryRef).toMatch(/transcripts/);
    expect(cardStore.runs.competence("story").attempts).toBe(1);
    // K8: all of it replays byte-identically from the ledger.
    expect((await cardStore.verifyProjections()).identical).toBe(true);
  });

  it("asks a person on the decision queue for an ask-tier command, and runs it on allow (S8, K20)", async () => {
    const card = await newCard("card_ask_tier");
    ctx.approvalTimeoutMs = 10_000;
    let answered = false;
    const dashboard = setInterval(() => {
      const pending = cardStore.runs.listDecisions("pending");
      if (pending[0] && !answered) {
        answered = true;
        void cardStore.runs.answerDecision(pending[0].id, 1, "human");
      }
    }, 50);
    try {
      const { adapter } = scripted([
        [{ name: "run_cmd", arguments: { command: "rm -rf build_output", description: "clean" } }],
        WRITE_A,
      ]);
      const result = await executeCard(ctx, card, adapter);
      const obs = result.turns[0]?.observations[0];
      expect(obs?.denied).not.toBe(true);
      const [decision] = cardStore.runs.listDecisions();
      expect(decision).toMatchObject({
        cardId: card.id,
        kind: "permission",
        status: "answered",
        selectedOptionIndex: 1,
      });
      expect(decision?.question).toContain("rm -rf build_output");
    } finally {
      clearInterval(dashboard);
    }
  });

  it("refuses an ask-tier command nobody answers in time", async () => {
    const card = await newCard("card_ask_none");
    ctx.approvalTimeoutMs = 0;
    const { adapter } = scripted([
      [{ name: "run_cmd", arguments: { command: "curl https://example.com", description: "x" } }],
      WRITE_A,
    ]);
    const result = await executeCard(ctx, card, adapter);
    expect(result.turns[0]?.observations[0]?.denied).toBe(true);
    expect(cardStore.runs.listDecisions()[0]?.status).toBe("timed_out");
  });

  it("files a Worker note in the card's thread as it is written (L11)", async () => {
    const card = await newCard("card_note");
    let notesAfterTurn1 = -1;
    ctx.afterTurn = async (_id, turn) => {
      if (turn.turnIndex === 1)
        notesAfterTurn1 = (await cardStore.getDossier(card.id)).notes.length;
    };
    await executeCard(
      ctx,
      card,
      scripted([[{ name: "note", arguments: { message: "Assumed: a is a number" } }], WRITE_A])
        .adapter,
    );
    expect(notesAfterTurn1).toBe(1);
    const dossier = await cardStore.getDossier(card.id);
    expect(dossier.notes.map((n) => n.text)).toEqual(["Assumed: a is a number"]);
  });

  it("records a review in the dossier, which the Review surface reads as findings", async () => {
    const card = await newCard("card_rev");
    await recordReview(cardStore, card.id, [
      { severity: "consider", note: "name the handler after the route" },
      { severity: "likely_send_back", note: "src/a.ts uses a default export" },
    ]);
    const dossier = await cardStore.getDossier(card.id);
    expect(dossier.reviews[0]?.verdict).toBe("likely_send_back");
    const events = (await log.getEventsByCard(card.id)).filter((e) => e.type === "card/review");
    const review = latestReview(events);
    expect(review?.findings).toEqual([
      { severity: "consider", note: "name the handler after the route" },
      { severity: "likely_send_back", note: "src/a.ts uses a default export" },
    ]);
  });
});
