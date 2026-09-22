import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type InferenceResponse, MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { executeCard } from "../src/execute.js";

/**
 * MVP path step 8: the same card runs twice identically.
 *
 * Byte-identical prompts are what make the prefix cache and every measurement
 * real: if two runs of one card from the same starting state send the model
 * different bytes, a cached prefix misses and two runs are not comparable.
 * Sampling is the model's business, so the Worker here is scripted to answer
 * identically; everything that remains different is the harness's doing.
 */

const repos: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
});

function seed(): { repo: string; db: DatabaseSync; cardStore: CardStore; board: BoardServiceImpl } {
  const repo = mkdtempSync(join(tmpdir(), "sekhemet-twice-"));
  repos.push(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, ".sekhemet"));
  writeFileSync(join(repo, "src", "a.ts"), "");
  writeFileSync(join(repo, "src", "b.ts"), "export const b = 2;\n");
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
  const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  const cardStore = new CardStore(db, new EventLog(db));
  return { repo, db, cardStore, board: new BoardServiceImpl(cardStore) };
}

const usage = { promptTokens: 100, completionTokens: 10, durationMs: 5 };
const script = (): InferenceResponse[] => [
  {
    text: "",
    toolCalls: [{ id: "1", name: "read_file", arguments: { path: "src/b.ts" } }],
    usage,
  },
  {
    text: "",
    toolCalls: [
      {
        id: "2",
        name: "write_file",
        arguments: {
          path: "src/a.ts",
          content: 'import { b } from "./b.js";\nexport const a = b;\n',
        },
      },
      { id: "3", name: "finish_card", arguments: {} },
    ],
    usage,
  },
];

async function runOnce(): Promise<{ passed: boolean; prompts: string[]; root: string }> {
  const { repo, db, cardStore, board } = seed();
  const card = await cardStore.createCard({
    id: "card_twice",
    tier: "story",
    title: "Write a",
    scopeFiles: ["src/a.ts"],
    stepBudget: 6,
    spec: "Write src/a.ts exporting a, equal to b from src/b.ts",
  });
  const model = new MockInferenceAdapter("scripted", script(), { exhaustion: "throw" });
  const ctx = {
    repoPath: repo,
    restrictedMode: false,
    cardStore,
    boardService: board,
    log: () => {},
  };
  const result = await executeCard(ctx, card, model, "1. Export a, equal to b.");
  db.close();
  return {
    passed: result.passed,
    prompts: model.callHistory.map((r) => JSON.stringify(r)),
    root: repo,
  };
}

describe("MVP step 8: the same card runs twice identically", () => {
  it("sends the model byte-identical requests on every turn of two runs", async () => {
    const first = await runOnce();
    const second = await runOnce();
    expect(first.passed).toBe(true);
    expect(second.passed).toBe(true);
    expect(first.prompts.length).toBeGreaterThanOrEqual(2);
    expect(second.prompts.length).toBe(first.prompts.length);
    // The two runs live in different directories; a request that carries its
    // own path would differ by exactly that, so name it if it happens.
    for (const [i, p] of first.prompts.entries()) {
      expect(p.includes(first.root), `turn ${i + 1} carries the repository path`).toBe(false);
      expect(second.prompts[i], `turn ${i + 1} differs between runs`).toBe(p);
    }
  });
});
