import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type CardLifecycle, CardRunner } from "@sekhemet/loop";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The board package does not depend on sync; the runner needs a real git adapter.
import { NodeGitSyncAdapter } from "../../sync/src/index.js";
import { BoardServiceImpl } from "../src/board_service.js";

/**
 * Defect 1 end to end: the queue path with a real board whose Review column
 * is full. Before the fix, `CardRunner.run` let the back-pressure error escape
 * and a `sekhemet queue` run aborted with no report.
 */
describe("@sekhemet/board back-pressure through the card runner (defect 1)", () => {
  let repo: string;
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;
  let board: BoardServiceImpl;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bp-repo-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 0;\n");
    writeFileSync(join(repo, ".gitignore"), ".sekhemet/\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    dir = mkdtempSync(join(tmpdir(), "bp-db-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    store = new CardStore(db, new EventLog(db));
    board = new BoardServiceImpl(store, { customLimits: { review: 1 } });
  });

  afterEach(() => {
    db.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  /** The harness's lifecycle (apps/harness/src/execute.ts), plus the board's hold. */
  const lifecycle = (): CardLifecycle => ({
    transition: async (id, to) => {
      const current = await store.getCard(id);
      if (!current || current.status === to) return;
      await board.transitionCard({
        cardId: id,
        fromStatus: current.status,
        toStatus: to,
        actor: "executor",
      });
    },
    hold: (id, reason) => board.holdCard(id, reason),
  });

  it("holds a passing card when Review is full, then releases it once Review drains", async () => {
    await store.createCard({ id: "waiting", tier: "task", title: "In review" });
    await store.updateCardStatus("waiting", "review", "test setup", "harness", { override: true });
    const card = await store.createCard({
      id: "c_run",
      tier: "task",
      title: "Runs",
      scopeFiles: ["src/a.ts"],
      stepBudget: 4,
    });
    let turn = 0;
    const result = await new CardRunner({
      card,
      repoRoot: repo,
      worktreePath: join(repo, ".sekhemet", "worktrees", card.id),
      stepBudget: 4,
      scopeFiles: card.scopeFiles,
      syncAdapter: new NodeGitSyncAdapter(repo),
      store,
      lifecycle: lifecycle(),
      gateRunner: {
        runGates: async () => ({ passed: true, failures: [], durationMs: 1, rungResults: [] }),
      },
      modelAdapter: {
        modelId: "scripted",
        supportedArms: ["arm_a_flat"],
        generate: async () => {
          turn++;
          const call =
            turn === 1
              ? {
                  id: "w",
                  name: "write_file",
                  arguments: { path: "src/a.ts", content: "export const a = 1;\n" },
                }
              : { id: "f", name: "finish_card", arguments: {} };
          return {
            text: "",
            toolCalls: [call],
            usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
          };
        },
      },
    }).run();

    expect(result.passed).toBe(true);
    expect(result.finalStatus).toBe("in_progress");
    expect(result.held?.wanted).toBe("verify");
    expect(result.held?.reason).toMatch(
      /^verify refused \(back_pressure: Back-pressure: Review is at capacity \(1\/1\)/,
    );

    const held = await store.getCard(card.id);
    expect(held?.status).toBe("in_progress");
    expect(held?.hold).toMatchObject({
      kind: "backpressure",
      awaiting: "verify",
      reason: result.held?.reason,
    });
    expect(held?.stopReason).toBe("gate_passed");
    expect((await board.listHeld()).map((c) => c.id)).toEqual([card.id]);

    // A person accepts the waiting review; the held card can now proceed.
    await board.transitionCard({
      cardId: "waiting",
      fromStatus: "review",
      toStatus: "done",
      actor: "human",
    });
    expect(await board.releaseHeld(card.id, "verify")).toBe(true);
    expect((await store.getCard(card.id))?.status).toBe("verify");
    expect((await store.getCard(card.id))?.hold).toBeUndefined();
  });
});
