import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cardOneCard } from "../src/card_zero.js";
import { executeCard } from "../src/execute.js";

// design-stage DS-P2-3 through the card run: card one's deliverable is a
// failing test the Worker writes. It is not a staged, protected acceptance
// test — it is in the card's scope, the Worker writes it, and nothing is
// staged or red-first-checked for it. Its gate is card one's verdict: the
// test runs and fails at an assertion. A fake Worker, a real repository, a
// real ledger and the repository's own Vitest; nothing is downloaded.

const REPO = resolve(__dirname, "..", "..", "..");
const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  while (dbs.length) dbs.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function write(root: string, rel: string, text: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sek-card1-run-")));
  const user = mkdtempSync(join(tmpdir(), "sek-card1-user-"));
  dirs.push(root, user);
  vi.stubEnv("SEKHEMET_CONFIG_DIR", user);
  const vitest = join(REPO, "node_modules", ".bin", "vitest");
  write(
    root,
    ".sekhemet/gates.toml",
    [
      "[project]",
      "max_files = 3",
      "max_diff_lines = 200",
      "",
      "[[gate]]",
      'id = "unit"',
      'rung = "test"',
      'layer = "functional"',
      `command = ${JSON.stringify(vitest)}`,
      'args = ["run"]',
      'parser = "vitest"',
      "timeout_s = 120",
      "",
    ].join("\n"),
  );
  write(
    root,
    ".gitignore",
    "node_modules\n.sekhemet/events.db*\n.sekhemet/worktrees\n.sekhemet/evidence\n.sekhemet/transcripts\n.sekhemet/traces.db*\n",
  );
  write(root, "package.json", JSON.stringify({ name: "calc", type: "module" }));
  // The stub card one's test calls: it imports, and its assertion fails.
  write(
    root,
    "src/calc.ts",
    "export function add(a: number, b: number): number {\n  return 0;\n}\n",
  );
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
  const db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
  dbs.push(db);
  initSchema(db);
  const log = new EventLog(db);
  return { root, log, cardStore: new CardStore(db, log) };
}

const RED =
  'import { expect, it } from "vitest";\nimport { add } from "../src/calc.js";\nit("adds two numbers", () => {\n  expect(add(1, 2)).toBe(3);\n});\n';
const GREEN =
  'import { expect, it } from "vitest";\nit("adds two numbers", () => {\n  expect(1 + 2).toBe(3);\n});\n';

/** A Worker that writes card one's test and finishes. */
function worker(test: string): LocalInferenceAdapter {
  return {
    modelId: "m",
    supportedArms: ["arm_a_flat", "arm_b_json"],
    generate: async () => ({
      text: "",
      toolCalls: [
        { id: "1", name: "write_file", arguments: { path: "tests/first.test.ts", content: test } },
        { id: "2", name: "finish_card", arguments: {} },
      ],
      usage: { promptTokens: 5, completionTokens: 1, durationMs: 1 },
    }),
  };
}

async function runCardOne(test: string) {
  const p = project();
  const { reason: _reason, ...fields } = cardOneCard(
    { firstSlice: "adding two numbers" },
    "typescript",
  );
  const card = await p.cardStore.createCard({
    ...fields,
    tier: "task",
    status: "ready",
    stepBudget: 4,
  });
  const result = await executeCard(
    {
      repoPath: p.root,
      restrictedMode: false,
      cardStore: p.cardStore,
      boardService: new BoardServiceImpl(p.cardStore),
      log: () => {},
      headroomCheck: false,
    },
    card,
    worker(test),
  );
  return { ...p, card, result };
}

describe("card one through the card run (DS-P2-3)", () => {
  it("is not a staged acceptance test: the Worker writes it in scope", () => {
    const card = cardOneCard({ firstSlice: "adding two numbers" }, "typescript");
    expect(card.acceptanceTests).toBeUndefined();
    expect(card.scopeFiles).toEqual(["tests/first.test.ts"]);
  });

  it("passes when the Worker's test runs and fails at an assertion, with nothing staged or red-first-checked", async () => {
    const { result, log, card } = await runCardOne(RED);
    const outcomes = result.evidence.rungResults ?? [];
    expect(outcomes.some((o) => o.gate === "card-one" && o.passed)).toBe(true);
    expect(outcomes.some((o) => o.gate === "unit")).toBe(false);
    expect(result.evidence.passed).toBe(true);
    // Nothing staged for it, and no red-first check on it.
    expect(await log.getEventsByTypes(["test/staged"])).toHaveLength(0);
    expect(result.evidence.failToPass).toBeUndefined();
    expect(result.evidence.testStrength).toBeUndefined();
    expect(card.acceptanceTests ?? []).toEqual([]);
  }, 180_000);

  it("fails when the Worker's test passes, naming card one's gate", async () => {
    const { result } = await runCardOne(GREEN);
    expect(result.evidence.passed).toBe(false);
    const outcomes = result.evidence.rungResults ?? [];
    const one = outcomes.find((o) => o.gate === "card-one");
    expect(one?.passed).toBe(false);
    // Judged on the test's own result: it ran, and passed.
    expect(one?.reason).not.toMatch(/missing/);
  }, 180_000);
});
