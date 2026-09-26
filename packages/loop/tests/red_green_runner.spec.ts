import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GateFailure, GateResult, GateRunner } from "@sekhemet/gates";
import {
  type CardRecord,
  type CardStatus,
  CardStore,
  EventLog,
  initSchema,
} from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CardLifecycle, type CardRunOptions, CardRunner } from "../src/card_runner.js";

let repo: string;
let dbDir: string;
let db: DatabaseSync;
let store: CardStore;
let log: EventLog;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "runner-depth-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "T");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 0;\n");
  writeFileSync(join(repo, ".gitignore"), ".sekhemet/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");
  // A real on-disk WAL database, as production uses.
  dbDir = mkdtempSync(join(tmpdir(), "runner-db-"));
  db = new DatabaseSync(join(dbDir, "events.db"));
  initSchema(db);
  log = new EventLog(db);
  store = new CardStore(db, log);
});

afterEach(() => {
  db.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

const usage = { promptTokens: 7, completionTokens: 3, durationMs: 1 };

/** An adapter that answers turn N with `script(N)` and counts its calls. */
function scripted(script: (turn: number) => ToolCall[]) {
  const seen: InferenceRequest[] = [];
  const adapter: LocalInferenceAdapter = {
    modelId: "scripted",
    supportedArms: ["arm_a_flat"],
    generate: async (req) => {
      seen.push(req);
      return { text: "", toolCalls: script(seen.length), usage };
    },
  };
  return { adapter, seen };
}

const write = (n: number): ToolCall => ({
  id: `w${n}`,
  name: "write_file",
  arguments: { path: "src/a.ts", content: `export const a = ${n};\n` },
});
const finish: ToolCall = { id: "f", name: "finish_card", arguments: {} };
const failure: GateFailure = {
  rung: "typecheck",
  gate: "typecheck",
  exitCode: 2,
  errorExcerpt: "src/a.ts:1:14 TS2322: Type 'number' is not assignable to type 'string'.",
  suggestedFixFiles: ["src/a.ts"],
  expected: "the gate to pass",
  actual: "it failed",
  minimalRepro: "pnpm test",
  suggestedAction: "Fix the failure shown.",
  location: { file: "src/a.ts", line: 1 },
};

/** Gates that answer each call from `verdicts` (the last one repeats). */
function gates(verdicts: boolean[]) {
  let calls = 0;
  const runner: GateRunner = {
    runGates: async (): Promise<GateResult> => {
      const passed = verdicts[Math.min(calls, verdicts.length - 1)] ?? false;
      calls++;
      return passed
        ? { passed: true, failures: [], durationMs: 1, rungResults: [] }
        : { passed: false, failures: [{ ...failure }], durationMs: 1, rungResults: [] };
    },
  };
  return { runner, calls: () => calls };
}

/** A lifecycle backed by the real card store; `refuse` makes a column refuse entry. */
function lifecycle(refuse?: Partial<Record<CardStatus, string>>) {
  const moves: CardStatus[] = [];
  const lc: CardLifecycle = {
    transition: async (id, to) => {
      const code = refuse?.[to];
      if (code) {
        throw Object.assign(new Error("Back-pressure: Review is at capacity (3/3)."), { code });
      }
      moves.push(to);
      await store.updateCardStatus(id, to);
    },
  };
  return { lc, moves };
}

async function newCard(
  over: Partial<Parameters<CardStore["createCard"]>[0]> = {},
): Promise<CardRecord> {
  return store.createCard({
    id: "card_d",
    tier: "task",
    title: "Depth card",
    scopeFiles: ["src/a.ts"],
    stepBudget: 10,
    spec: "Set a.",
    ...over,
  });
}

function runner(card: CardRecord, over: Partial<CardRunOptions>): CardRunner {
  return new CardRunner({
    card,
    repoRoot: repo,
    worktreePath: join(repo, ".sekhemet", "worktrees", card.id),
    stepBudget: card.stepBudget,
    modelAdapter: scripted(() => [finish]).adapter,
    gateRunner: gates([true]).runner,
    syncAdapter: new NodeGitSyncAdapter(repo),
    scopeFiles: card.scopeFiles,
    store,
    ...over,
  });
}

// GT-N8-2: the red-first check applies the red/green rule of the card's
// `change` (rule 6b), one table in code, never `kind` or `split`.

describe("red-first by the card's change (GT-N8-2)", () => {
  const withTest = () => async (wt: string) => {
    mkdirSync(join(wt, "tests"), { recursive: true });
    writeFileSync(join(wt, "tests", "a.spec.ts"), "test('a', () => {});\n");
  };

  it("runs a characterize card whose tests pass on the base: green is its proof, not vacuous", async () => {
    const card = await newCard({ acceptanceTests: ["a.spec.ts"], change: "characterize" });
    const { adapter, seen } = scripted((t) => (t === 1 ? [write(1)] : [finish]));
    const result = await runner(card, {
      modelAdapter: adapter,
      gateRunner: gates([true]).runner,
      onWorktreeReady: withTest(),
    }).run();
    expect(result.failToPass?.status).toBe("green");
    expect(result.stopReason).not.toBe("vacuous_tests");
    expect(seen.length).toBeGreaterThan(0);
  });

  it("refuses a characterize card whose tests fail on the base, naming them, before any step", async () => {
    const card = await newCard({ acceptanceTests: ["a.spec.ts"], change: "characterize" });
    const { adapter, seen } = scripted(() => [finish]);
    const { lc, moves } = lifecycle();
    const result = await runner(card, {
      modelAdapter: adapter,
      gateRunner: gates([false]).runner,
      lifecycle: lc,
      onWorktreeReady: withTest(),
    }).run();
    expect(seen).toHaveLength(0);
    expect(result.failToPass?.status).toBe("refused");
    expect(result.stopReason).toBe("base_not_green");
    expect(result.parked?.suggestion).toContain("tests/a.spec.ts");
    expect(moves).toEqual(["parked"]);
  });

  it("chooses the rule by change, not kind: a contract card that characterizes runs green", async () => {
    const card = await newCard({
      acceptanceTests: ["a.spec.ts"],
      title: "Define the contract types (SPIDR: Interface)",
      change: "refactor",
    });
    const { adapter } = scripted((t) => (t === 1 ? [write(1)] : [finish]));
    const result = await runner(card, {
      modelAdapter: adapter,
      gateRunner: gates([true]).runner,
      onWorktreeReady: withTest(),
    }).run();
    expect(result.failToPass?.status).toBe("green");
    expect(result.stopReason).not.toBe("vacuous_tests");
  });

  it("still refuses a feature card whose tests already pass", async () => {
    const card = await newCard({ acceptanceTests: ["a.spec.ts"], change: "feature" });
    const result = await runner(card, {
      gateRunner: gates([true]).runner,
      onWorktreeReady: withTest(),
    }).run();
    expect(result.stopReason).toBe("vacuous_tests");
  });

  it("checks a build-repair card's red state with its build command, and runs it when the build fails", async () => {
    const card = await newCard({ change: "fix" });
    const { adapter, seen } = scripted((t) => (t === 1 ? [write(1)] : [finish]));
    const result = await runner(card, {
      modelAdapter: adapter,
      buildRepair: {
        command: "sh",
        args: ["-c", "echo 'error: cannot find module x' >&2; exit 2"],
      },
    }).run();
    expect(result.failToPass?.status).toBe("fails");
    expect(result.failToPass?.detail).toContain("cannot find module x");
    expect(seen.length).toBeGreaterThan(0);
  });

  it("refuses a build-repair card whose build already succeeds on the base", async () => {
    const card = await newCard({ change: "fix" });
    const { adapter, seen } = scripted(() => [finish]);
    const result = await runner(card, {
      modelAdapter: adapter,
      buildRepair: { command: "sh", args: ["-c", "exit 0"] },
    }).run();
    expect(seen).toHaveLength(0);
    expect(result.failToPass?.status).toBe("refused");
    expect(result.stopReason).toBe("tests_not_red_for_reason");
  });
});
