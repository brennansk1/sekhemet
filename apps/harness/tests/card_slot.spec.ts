import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeCard } from "../src/execute.js";

// RUN-35, models rule 20i (MD-N14-36): each card runs on the server slot its
// slot lease names, so parallel cards on one server keep their own KV slot
// and their own saved slot file, never slot 0's shared one.
describe("a card's slot lease is its server slot", () => {
  let repo: string;
  let db: DatabaseSync;
  let cardStore: CardStore;
  let boardService: BoardServiceImpl;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "sekhemet-slot-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    mkdirSync(join(repo, "src"));
    mkdirSync(join(repo, ".sekhemet"));
    writeFileSync(join(repo, "src", "a.ts"), "");
    writeFileSync(join(repo, "src", "b.ts"), "");
    writeFileSync(
      join(repo, ".sekhemet", "gates.toml"),
      `[project]\nmax_files = 3\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 30\nparser = "generic"\n`,
    );
    writeFileSync(
      join(repo, ".gitignore"),
      ".sekhemet/events.db*\n.sekhemet/worktrees\n.sekhemet/evidence\n.sekhemet/transcripts\n",
    );
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    cardStore = new CardStore(db, log);
    boardService = new BoardServiceImpl(cardStore);
  });

  afterEach(() => {
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it("two concurrent cards send their own slot ids and sessions on every request", async () => {
    const seen: InferenceRequest[] = [];
    const model: LocalInferenceAdapter = {
      modelId: "worker",
      supportedArms: ["arm_a_flat"],
      contextWindow: { contextTokens: 32768, maxTokens: 2048 },
      generate: async (req) => {
        seen.push(req);
        const file = req.session?.owner === "card_a" ? "src/a.ts" : "src/b.ts";
        await new Promise((r) => setTimeout(r, 5));
        return {
          text: "",
          toolCalls: [
            {
              id: "1",
              name: "write_file",
              arguments: { path: file, content: "export const x = 1;\n" },
            },
            { id: "2", name: "finish_card", arguments: {} },
          ],
          usage: { promptTokens: 100, completionTokens: 10, durationMs: 5 },
        };
      },
    };
    const ctx = {
      repoPath: repo,
      restrictedMode: false,
      cardStore,
      boardService,
      log: () => {},
      headroomCheck: false,
    };
    const card = (id: string, file: string) =>
      cardStore.createCard({
        id,
        tier: "story",
        title: `Write ${file}`,
        scopeFiles: [file],
        stepBudget: 4,
        spec: `Write ${file}`,
      });
    const a = await card("card_a", "src/a.ts");
    const b = await card("card_b", "src/b.ts");
    const [ra, rb] = await Promise.all([
      executeCard(ctx, a, model, undefined, { serverSlot: 0 }),
      executeCard(ctx, b, model, undefined, { serverSlot: 1 }),
    ]);
    // Whether the fake's cards pass is not what this checks: which slot each request named is.
    expect(ra.turns.length).toBeGreaterThan(0);
    expect(rb.turns.length).toBeGreaterThan(0);
    const byCard = (id: string) => seen.filter((r) => r.session?.owner === id);
    expect(byCard("card_a").length).toBeGreaterThan(0);
    expect(byCard("card_b").length).toBeGreaterThan(0);
    expect(new Set(byCard("card_a").map((r) => r.slot))).toEqual(new Set([0]));
    expect(new Set(byCard("card_b").map((r) => r.slot))).toEqual(new Set([1]));
  }, 60_000);
});
