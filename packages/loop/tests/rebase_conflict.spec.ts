import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GateRunner } from "@sekhemet/gates";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardRunner } from "../src/card_runner.js";

// review-git NEW-review-git-1 (RG-N1-1..3): a rebase conflict before Verify
// goes back to the Worker as typed failures, parks when it is outside the
// card's scope, and becomes one decision request when the budget ends.
// Real git repositories and worktrees, a real SQLite file (DEFINITION_OF_DONE §2A).

type Script = (n: number, req: InferenceRequest) => Omit<ToolCall, "id">[];
function adapterOf(script: Script) {
  const seen: InferenceRequest[] = [];
  let n = 0;
  const adapter: LocalInferenceAdapter = {
    modelId: "m",
    supportedArms: ["arm_a_flat", "arm_b_json"],
    generate: async (req) => {
      seen.push(req);
      n++;
      return {
        text: "",
        toolCalls: script(n, req).map((c, i) => ({ id: `${n}-${i}`, ...c })),
        usage: { promptTokens: 5, completionTokens: 1, durationMs: 1 },
      };
    },
  };
  return { adapter, seen };
}
const passing: GateRunner = {
  runGates: async () => ({ passed: true, failures: [], durationMs: 1, rungResults: [] }),
};
const promptText = (req: InferenceRequest | undefined) => JSON.stringify(req ?? {});

describe("NEW-review-git-1: a rebase conflict before Verify", () => {
  let repo: string;
  let db: DatabaseSync;
  let store: CardStore;
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "rg-n1-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 0;\n");
    writeFileSync(join(repo, "src", "b.ts"), "export const b = 0;\n");
    writeFileSync(join(repo, ".gitignore"), ".sekhemet/\nevents.db*\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    db = new DatabaseSync(join(repo, "events.db"));
    initSchema(db);
    store = new CardStore(db, new EventLog(db));
  });
  afterEach(() => {
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  /** Another accepted card moves main under the running card. */
  const mainMoves = (file: string, content: string) => {
    writeFileSync(join(repo, file), content);
    git("commit", "-qam", "feat(card_other): other\n\nCard: card_other");
  };

  const runner = async (id: string, stepBudget: number, script: Script) => {
    const card = await store.createCard({
      id,
      tier: "story",
      title: `Card ${id}`,
      scopeFiles: ["src/a.ts"],
      stepBudget,
    });
    const { adapter, seen } = adapterOf(script);
    const run = new CardRunner({
      card,
      repoRoot: repo,
      worktreePath: join(repo, ".sekhemet", "worktrees", id),
      stepBudget,
      modelAdapter: adapter,
      gateRunner: passing,
      syncAdapter: new NodeGitSyncAdapter(repo),
      scopeFiles: ["src/a.ts"],
      store,
    }).run();
    return { result: await run, seen };
  };

  it("RG-N1-1: a conflict inside scope returns to the Worker with one typed failure per file naming its hunks, and the resolved card sits on main", async () => {
    const { result, seen } = await runner("card_n1", 5, (n) => {
      if (n === 1) {
        mainMoves("src/a.ts", "export const a = 99;\n");
        return [
          { name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 2;\n" } },
          { name: "finish_card", arguments: {} },
        ];
      }
      return [
        {
          name: "write_file",
          arguments: { path: "src/a.ts", content: "export const a = 99 + 2;\n" },
        },
        { name: "finish_card", arguments: {} },
      ];
    });
    // The Worker's next step saw the conflict as a typed failure with its hunk.
    const second = promptText(seen[1]);
    expect(second).toContain("rebase");
    expect(second).toContain("src/a.ts");
    expect(second).toContain("<<<<<<<");
    expect(second).toContain("export const a = 99;");
    expect(seen).toHaveLength(2);
    // Resolved within the budget: passed, on top of main, with the resolution.
    expect(result.stopReason).toBe("gate_passed");
    expect(result.passed).toBe(true);
    const wt = result.worktreePath;
    const onWt = (...a: string[]) => execFileSync("git", a, { cwd: wt, encoding: "utf8" }).trim();
    expect(onWt("merge-base", "HEAD", "main")).toBe(git("rev-parse", "main"));
    expect(readFileSync(join(wt, "src", "a.ts"), "utf8")).toBe("export const a = 99 + 2;\n");
    // The conflict is on the ledger with its files, returned to the Worker.
    const events = await store.cardEvents("card_n1", ["card/rebase_conflict"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      id: "card_n1",
      files: ["src/a.ts"],
      outOfScope: [],
      returnedToWorker: true,
    });
    // The pre-conflict branch is kept under refs/sekhemet, never lost.
    const kept = (events[0]?.payload as { preservedRef: string }).preservedRef;
    expect(kept).toMatch(/^refs\/sekhemet\/rebase\/card_n1\//);
    expect(git("show", `${kept}:src/a.ts`)).toBe("export const a = 2;");
  });

  it("RG-N1-2: a conflict touching a file outside the card's scope parks the card with the files named", async () => {
    const { result, seen } = await runner("card_n2", 5, (n) => {
      if (n === 1) {
        mainMoves("src/b.ts", "export const b = 7;\n");
        // A command's side effect outside the declared scope.
        writeFileSync(
          join(repo, ".sekhemet", "worktrees", "card_n2", "src", "b.ts"),
          "export const b = 8;\n",
        );
      }
      return [
        { name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 2;\n" } },
        { name: "finish_card", arguments: {} },
      ];
    });
    expect(seen).toHaveLength(1);
    expect(result.stopReason).toBe("rebase_conflict");
    expect(result.finalStatus).toBe("parked");
    expect(result.parked?.suggestion ?? "").toContain("src/b.ts");
    expect((await store.getCard("card_n2"))?.blockedReason).toMatch(/^parked: .*src\/b\.ts/);
    const [event] = await store.cardEvents("card_n2", ["card/rebase_conflict"]);
    expect(event?.payload).toMatchObject({ outOfScope: ["src/b.ts"], returnedToWorker: false });
  });

  it("RG-N1-3: an unresolved conflict at the end of the budget posts one decision request naming both cards", async () => {
    const { result, seen } = await runner("card_n3", 3, (n) => {
      if (n === 1) {
        mainMoves("src/a.ts", "export const a = 99;\n");
        return [
          { name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 2;\n" } },
          { name: "finish_card", arguments: {} },
        ];
      }
      return [{ name: "read_file", arguments: { path: "src/a.ts" } }];
    });
    expect(seen).toHaveLength(3);
    expect(result.stopReason).toBe("rebase_conflict");
    expect(result.passed).toBe(false);
    const decisions = store.runs.listDecisions("pending");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.cardId).toBe("card_n3");
    expect(decisions[0]?.kind).toBe("rebase_conflict");
    expect(decisions[0]?.question).toContain("card_n3");
    expect(decisions[0]?.question).toContain("card_other");
    expect(decisions[0]?.context).toContain("src/a.ts");
    expect(result.finalStatus).toBe("parked");
  });
});
