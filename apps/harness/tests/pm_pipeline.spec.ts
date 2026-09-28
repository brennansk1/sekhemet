import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { PLANNED_WITHOUT_MODEL } from "@sekhemet/planner";
import { afterEach, describe, expect, it } from "vitest";
import { toProposals } from "../src/pm/agent.js";
import { applyProposal } from "../src/pm/apply.js";
import { PipelineRefusal, criteriaForParts } from "../src/pm/pipeline.js";
import { answerQueued } from "../src/pm/service.js";
import { PmStore } from "../src/pm/store.js";

// planner-pm PM-P1-1 and PM-P1-7: every card Seshat produces goes through the
// one planning pipeline, and a split gives each part only its own tests and
// rejects the parent "Split into N cards". A real repository and an on-disk
// ledger (DEFINITION_OF_DONE §2A); no model is loaded.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function setup() {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-pm-pipe-"));
  dirs.push(repoPath);
  const w = (rel: string, text: string) => {
    mkdirSync(dirname(join(repoPath, rel)), { recursive: true });
    writeFileSync(join(repoPath, rel), text);
  };
  w("src/invoice.ts", "export function total(cents: number): number { return cents; }\n");
  w("package.json", JSON.stringify({ name: "fixture", devDependencies: { vitest: "^3" } }));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repoPath, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  git("add", "-A");
  git("commit", "-q", "-m", "feat: init");
  mkdirSync(join(repoPath, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(repoPath, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const cardStore = new CardStore(db, log);
  const boardService = new BoardServiceImpl(cardStore, { entryConditions: true });
  const pmStore = new PmStore(log);
  return { repoPath, db, log, cardStore, boardService, pmStore };
}

async function applyOne(
  s: ReturnType<typeof setup>,
  draft: ReturnType<typeof toProposals>[number] | undefined,
) {
  const reply = await s.pmStore.appendReply({
    replyTo: [],
    text: "x",
    proposals: draft ? [draft] : [],
  });
  return applyProposal(reply.proposals?.[0] as never, {
    cardStore: s.cardStore,
    boardService: s.boardService,
    pmStore: s.pmStore,
    repoPath: s.repoPath,
    actor: "human",
  });
}

describe("PM-P1-1: Seshat's cards come only through the planning pipeline", () => {
  it("propose_create_card: INVEST, the criterion lint, scope and a staged test", async () => {
    const s = setup();
    const [draft] = toProposals(
      [
        {
          id: "1",
          name: "propose_create_card",
          arguments: {
            title: "Refund a paid invoice",
            spec: "Refund part of a paid invoice.",
            acceptance_criteria: [
              "Given a paid invoice of 1000 cents, refunding 400 leaves 600",
              "refunds work",
            ],
            scope_files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
            reason: "the API needs refunds before billing ships",
          },
        },
      ],
      [],
    );
    const { cards } = await applyOne(s, draft);
    // The planner may add its own cards (a characterization of existing code): find Seshat's.
    const card = cards.find((c) => c.title === "Refund a paid invoice");
    expect(card).toBeDefined();
    // Persisted by the planner: criterion ids, a stored kind, points.
    expect(card?.criterionIds?.length).toBe(card?.acceptanceCriteria?.length);
    expect(card?.kind).toBe("implement");
    expect([1, 2, 3, 5, 8]).toContain(card?.estimate);
    // Scope validation: never more than the 3-file bound.
    expect(card?.scopeFiles.length).toBeLessThanOrEqual(3);
    // The lint refuses "refunds work", so the card waits in Planning, naming it.
    expect(card?.status).toBe("planning");
    expect(card?.blockedReason).toMatch(/refused by the lint/);
    // PM-N7-5: applying is not approving. The proposal showed titles, not the
    // criteria the planner wrote, so the card keeps its approval hold.
    expect(card?.blockedReason).toMatch(/approval of its criteria/);
    expect(s.cardStore.stagedTests.criteriaApproval(card?.id as string).approved).toBe(false);
    // A failing acceptance test was staged for the criterion with values.
    const staged = await s.cardStore.cardEvents(card?.id as string, ["test/staged"]);
    expect(staged.length).toBeGreaterThan(0);
    // The plan itself is on the ledger, as for `sekhemet plan`.
    expect((await s.log.getEventsByTypes(["plan/created"])).length).toBe(1);
  });

  it("/plan runs the one planner, without loading a model", async () => {
    const s = setup();
    let loads = 0;
    await s.pmStore.appendUserMessage(
      "/plan Let users refund a paid invoice. Given a paid invoice of 1000 cents, refunding 400 leaves 600.",
    );
    await answerQueued({
      repoPath: s.repoPath,
      cardStore: s.cardStore,
      pmStore: s.pmStore,
      pmModel: "pm",
      acquire: async () => {
        loads++;
        throw new Error("no model in this test");
      },
    });
    expect(loads).toBe(0);
    const reply = (await s.pmStore.thread()).filter((m) => m.role === "pm").at(-1);
    expect(reply?.text).toContain(PLANNED_WITHOUT_MODEL);
    const planned = (await s.cardStore.listCards()).filter((c) => c.tier !== "epic");
    expect(planned.length).toBeGreaterThan(0);
    for (const c of planned) expect(c.criterionIds?.length).toBe(c.acceptanceCriteria?.length);
  });

  it("start_project is a proposal; applied, it plans through the same pipeline", async () => {
    const s = setup();
    const [draft] = toProposals(
      [
        {
          id: "1",
          name: "start_project",
          arguments: {
            brief:
              "Let users refund a paid invoice. Given a paid invoice of 1000 cents, refunding 400 leaves 600.",
            reason: "you asked to start the refunds project",
          },
        },
      ],
      [],
    );
    expect(draft).toMatchObject({ kind: "start_project" });
    expect(await s.cardStore.listCards()).toEqual([]);
    const { cards } = await applyOne(s, draft);
    const planned = cards.filter((c) => c.tier !== "epic");
    expect(planned.length).toBeGreaterThan(0);
    for (const c of planned) expect(c.criterionIds?.length).toBe(c.acceptanceCriteria?.length);
  });
});

describe("PM-P1-7: a split gives each part only its own tests; the parent is rejected", () => {
  it("assigns each criterion to its part and moves the parent to Rejected", async () => {
    const s = setup();
    const parent = await s.cardStore.createCard({
      id: "card_ledger",
      tier: "task",
      title: "Ledger",
      status: "ready",
      spec: "An append-only ledger of events, deduplicated by key.",
      scopeFiles: ["src/ledger.ts"],
      acceptanceCriteria: [
        "Given an empty log, appending an event leaves 1 event",
        "Given a key seen before, dedupe returns the first result",
      ],
      acceptanceTests: ["tests/ledger.spec.ts"],
    });
    await s.cardStore.recordEvent({
      type: "test/staged",
      cardId: parent.id,
      actor: "planner",
      payload: {
        cardId: parent.id,
        path: "tests/ledger.spec.ts",
        sha256: "a".repeat(64),
        author: "planner",
      },
    });
    const [draft] = toProposals(
      [
        {
          id: "1",
          name: "propose_split_card",
          arguments: {
            card_id: parent.id,
            parts: [
              { title: "Append an event to the log", spec: "append-only insert", estimate: 3 },
              {
                title: "Dedupe by key",
                spec: "a key seen before returns the first result",
                estimate: 2,
              },
            ],
            reason: "the Worker looped on it",
          },
        },
      ],
      [parent],
    );
    const { cards: parts } = await applyOne(s, draft);
    expect(parts).toHaveLength(2);
    const append = parts.find((p) => /Append/.test(p.title));
    const dedupe = parts.find((p) => /Dedupe/.test(p.title));
    expect(append?.acceptanceCriteria).toEqual([
      "Given an empty log, appending an event leaves 1 event",
    ]);
    expect(dedupe?.acceptanceCriteria).toEqual([
      "Given a key seen before, dedupe returns the first result",
    ]);
    for (const part of parts) {
      // Never the parent's test file, nor its test records.
      expect(part.acceptanceTests ?? []).not.toContain("tests/ledger.spec.ts");
      const records = (await s.cardStore.cardEvents(part.id, ["test/staged"])).map(
        (e) => (e.payload as { path: string }).path,
      );
      expect(records).not.toContain("tests/ledger.spec.ts");
      expect(part.splitDepth).toBe(1);
    }
    const after = await s.cardStore.getCard(parent.id);
    expect(after?.status).toBe("rejected");
    const moved = (await s.cardStore.cardEvents(parent.id, ["card/status_changed"])).at(-1);
    expect((moved?.payload as { reason?: string }).reason).toMatch(/^Split into 2 issues/);
    for (const p of parts) expect((moved?.payload as { reason?: string }).reason).toContain(p.id);
  });

  it("PM-P1-7: refuses a split that would drop a criterion sharing no word with any part", () => {
    const parent = {
      acceptanceCriteria: [
        "Given an empty log, appending an event leaves 1 event",
        "Given a currency mismatch, the transfer is refused",
      ],
    };
    const parts = [
      { title: "Append an event to the log", spec: "append-only insert" },
      { title: "Dedupe by key", spec: "a key seen before returns the first result" },
    ];
    expect(() => criteriaForParts(parent, parts)).toThrow(PipelineRefusal);
    try {
      criteriaForParts(parent, parts);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineRefusal);
      expect((err as Error).message).toContain("currency mismatch");
    }
  });

  it("PM-P1-7: never creates a part or moves the parent when a criterion is orphaned", async () => {
    const s = setup();
    const parent = await s.cardStore.createCard({
      id: "card_wallet",
      tier: "task",
      title: "Wallet",
      status: "ready",
      spec: "A wallet that appends events and rejects mismatched transfers.",
      acceptanceCriteria: [
        "Given an empty log, appending an event leaves 1 event",
        "Given a currency mismatch, the transfer is refused",
      ],
    });
    const [draft] = toProposals(
      [
        {
          id: "1",
          name: "propose_split_card",
          arguments: {
            card_id: parent.id,
            parts: [
              { title: "Append an event to the log", spec: "append-only insert", estimate: 3 },
              {
                title: "Dedupe by key",
                spec: "a key seen before returns the first result",
                estimate: 2,
              },
            ],
            reason: "too big",
          },
        },
      ],
      [parent],
    );
    await expect(applyOne(s, draft)).rejects.toThrow(/currency mismatch/);
    expect(await s.cardStore.listCards({ tier: "task" })).toHaveLength(1);
    expect((await s.cardStore.getCard(parent.id))?.status).toBe("ready");
  });
});
