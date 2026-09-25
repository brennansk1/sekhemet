import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeCard } from "../src/execute.js";

// What `executeCard` hands the runner for the card's evidence: the card's own
// configuration layer (surface SUR-40) and the hooks files that failed to load
// (extensibility EXT-10). A real repository, ledger and gate process.

const adapter: LocalInferenceAdapter = {
  modelId: "m",
  supportedArms: ["arm_a_flat", "arm_b_json"],
  generate: async () => ({
    text: "",
    toolCalls: [
      {
        id: "1",
        name: "write_file",
        arguments: { path: "src/a.ts", content: "export const a = 1;\n" },
      },
      { id: "2", name: "finish_card", arguments: {} },
    ],
    usage: { promptTokens: 5, completionTokens: 1, durationMs: 1 },
  }),
};

describe("the card's evidence names its configuration layer and failed hooks", () => {
  let repo: string;
  let user: string;
  let db: DatabaseSync;
  let cardStore: CardStore;
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo });
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ev-fields-"));
    user = mkdtempSync(join(tmpdir(), "ev-fields-user-"));
    vi.stubEnv("SEKHEMET_CONFIG_DIR", user);
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
      ".sekhemet/events.db*\n.sekhemet/worktrees\n.sekhemet/evidence\n.sekhemet/transcripts\n.sekhemet/traces.db*\n",
    );
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    cardStore = new CardStore(db, new EventLog(db));
  });
  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
    for (const d of [repo, user]) rmSync(d, { recursive: true, force: true });
  });

  const run = async (configOverrides?: Record<string, Record<string, number>>) => {
    const card = await cardStore.createCard({
      id: "card_ev",
      tier: "story",
      title: "Write a",
      scopeFiles: ["src/a.ts"],
      stepBudget: 6,
      spec: "Write src/a.ts exporting the constant a.",
      ...(configOverrides ? { configOverrides } : {}),
    });
    return executeCard(
      {
        repoPath: repo,
        restrictedMode: false,
        cardStore,
        boardService: new BoardServiceImpl(cardStore),
        log: () => {},
        headroomCheck: false,
      },
      card,
      adapter,
    );
  };

  it("SUR-40: lists the card's configOverrides, one line each", async () => {
    const r = await run({ loop: { default_step_budget: 5 } });
    expect(r.evidence.configOverrides).toEqual(["loop.default_step_budget = 5"]);
  });

  it("EXT-10: names a hooks file that failed to load", async () => {
    writeFileSync(join(user, "hooks.toml"), "[[hook]\nnot toml");
    const r = await run();
    expect(r.evidence.extensions?.hookErrors?.[0]).toContain(join(user, "hooks.toml"));
    expect(r.evidence.configOverrides).toBeUndefined();
  });
});
