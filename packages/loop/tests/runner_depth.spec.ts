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

describe("card actuals, attempts and checkpoints (defects 2 and 8, K28, Y3)", () => {
  it("persists stop reason, tokens, seconds, steps and evidence id on the card", async () => {
    const card = await newCard();
    let clock = 1_000_000;
    const { adapter } = scripted((t) => (t === 1 ? [write(1)] : [finish]));
    const { lc } = lifecycle();
    const result = await runner(card, {
      modelAdapter: adapter,
      lifecycle: lc,
      now: () => {
        clock += 4000;
        return clock;
      },
    }).run();

    expect(result.stopReason).toBe("gate_passed");
    expect(result.finalStatus).toBe("review");
    expect(result.tokensUsed).toBe(20);
    const stored = await store.getCard(card.id);
    expect(stored).toMatchObject({
      status: "review",
      stopReason: "gate_passed",
      tokensUsed: 20,
      secondsUsed: result.secondsUsed,
      stepsUsed: 2,
      evidenceId: result.evidence.id,
    });
    expect(result.secondsUsed).toBeGreaterThan(0);
    expect(existsSync(join(repo, ".sekhemet", "evidence", `${result.evidence.id}.json`))).toBe(
      true,
    );
  });

  it("INT-11a: a scope change recorded while the card ran sends it to Planning, not Review, naming the field", async () => {
    const card = await newCard();
    const whys: (string | undefined)[] = [];
    const moves: CardStatus[] = [];
    const lc: CardLifecycle = {
      transition: async (id, to, why) => {
        moves.push(to);
        whys.push(why);
        await store.updateCardStatus(id, to);
      },
    };
    const { adapter } = scripted((t) => {
      if (t === 1) {
        // The tracker's edit arrives mid-run: recorded by the sync, the Worker not paused.
        void store.recordEvent({
          type: "sync/scope_changed",
          cardId: card.id,
          actor: "github",
          payload: { id: card.id, fields: ["body"], change: "scope" },
        });
        return [write(1)];
      }
      return [finish];
    });
    const result = await runner(card, { modelAdapter: adapter, lifecycle: lc }).run();
    expect(result.stopReason).toBe("gate_passed");
    expect(result.finalStatus).toBe("planning");
    expect(moves).not.toContain("review");
    expect(whys.at(-1)).toMatch(/scope.*body/);
    // A later run, with no new edit, reaches Review as usual.
    const again = await runner(await (store.getCard(card.id) as Promise<CardRecord>), {
      lifecycle: lifecycle().lc,
      useExistingWorktree: true,
      attempt: 2,
    }).run();
    expect(again.finalStatus).toBe("review");
  });

  it("RG-P8-1: a passing card the AI review has not read waits in Verify, saying so", async () => {
    const card = await newCard();
    const { adapter } = scripted((t) => (t === 1 ? [write(1)] : [finish]));
    const { lc, moves } = lifecycle();
    const asked: string[] = [];
    const result = await runner(card, {
      modelAdapter: adapter,
      lifecycle: {
        ...lc,
        awaitReview: async (id) => {
          asked.push(id);
          // The attempt is closed and its evidence recorded before the review is asked for.
          expect(await store.cardEvents(id, ["evidence/recorded"])).toHaveLength(1);
          return "Waiting for AI review";
        },
      },
    }).run();
    expect(result.stopReason).toBe("gate_passed");
    expect(asked).toEqual([card.id]);
    expect(moves).toEqual(["in_progress", "verify"]);
    expect(result.finalStatus).toBe("verify");
    expect(await store.getCard(card.id)).toMatchObject({
      status: "verify",
      blockedReason: "Waiting for AI review",
    });
    // No wait asked for: the card moves on to Review as before.
    const again = await runner((await store.getCard(card.id)) as CardRecord, {
      lifecycle: { ...lifecycle().lc, awaitReview: async () => undefined },
      useExistingWorktree: true,
      attempt: 2,
    }).run();
    expect(again.finalStatus).toBe("review");
  });

  it("stamps the attempt into the evidence, so a retry never overwrites attempt 1", async () => {
    const card = await newCard();
    const first = await runner(card, { attempt: 1 }).run();
    const second = await runner(card, { attempt: 2, useExistingWorktree: true }).run();
    expect(first.evidence.attempt).toBe(1);
    expect(second.evidence.attempt).toBe(2);
    expect(second.attempt).toBe(2);
    expect(second.evidence.id).not.toBe(first.evidence.id);
    const saved = JSON.parse(
      readFileSync(join(repo, ".sekhemet", "evidence", `${first.evidence.id}.json`), "utf8"),
    ) as { attempt: number };
    expect(saved.attempt).toBe(1);
  });

  it("checkpoints mid-card every N steps, in git and in the database", async () => {
    const card = await newCard({ stepBudget: 5 });
    const { adapter } = scripted((t) => [write(t)]);
    const result = await runner(card, {
      modelAdapter: adapter,
      stepBudget: 5,
      checkpointEvery: 2,
      // The forced verification at the budget stop fails, so the stop stands.
      gateRunner: gates([false]).runner,
    }).run();

    expect(result.stopReason).toBe("budget_exhausted");
    const checkpoints = await store.getCheckpoints(card.id);
    // Steps 2 and 4 mid-card, then step 5 because the stop left new writes.
    expect(checkpoints.map((c) => [c.step, c.gateStatus])).toEqual([
      [2, "partial"],
      [4, "partial"],
      [5, "partial"],
    ]);
    expect(checkpoints.map((c) => c.gitRef)).toEqual(result.checkpointShas);
    const wt = result.worktreePath;
    for (const c of checkpoints) expect(git(wt, "cat-file", "-t", c.gitRef)).toBe("commit");
    expect(git(repo, "rev-parse", `refs/sekhemet/checkpoints/${card.id}`)).toBe(
      checkpoints[2]?.gitRef,
    );
    // Step 2's commit holds step 2's content.
    expect(git(wt, "show", `${checkpoints[0]?.gitRef}:src/a.ts`)).toBe("export const a = 2;");
    const events = (await log.getEventsByCard(card.id)).filter(
      (e) => e.type === "checkpoint/recorded",
    );
    expect(events).toHaveLength(3);
  });

  it("does not checkpoint idle steps", async () => {
    const card = await newCard({ stepBudget: 4 });
    const { adapter } = scripted((t) => [
      { id: `r${t}`, name: "read_file", arguments: { path: "src/a.ts", start: 1, end: t } },
    ]);
    const result = await runner(card, {
      modelAdapter: adapter,
      stepBudget: 4,
      checkpointEvery: 1,
    }).run();
    expect(await store.getCheckpoints(card.id)).toEqual([]);
    expect(result.checkpointShas).toEqual([]);
  });
});

describe("back-pressure hold (defect 1 / B4)", () => {
  it("holds the card with a recorded reason when Verify is refused, and never throws", async () => {
    const card = await newCard();
    const { lc, moves } = lifecycle({ verify: "back_pressure" });
    const result = await runner(card, { lifecycle: lc }).run();

    expect(result.passed).toBe(true);
    expect(result.finalStatus).toBe("in_progress");
    expect(result.held).toEqual({
      wanted: "verify",
      reason: "verify refused (back_pressure: Back-pressure: Review is at capacity (3/3).)",
    });
    expect(moves).toEqual(["in_progress"]);
    const stored = await store.getCard(card.id);
    expect(stored?.status).toBe("in_progress");
    expect(stored?.blockedReason).toBe(`held: ${result.held?.reason}`);
    expect(stored?.stopReason).toBe("gate_passed");
  });

  it("uses the board's own hold when the lifecycle offers one", async () => {
    const card = await newCard();
    const holds: string[] = [];
    const { lc } = lifecycle({ verify: "back_pressure" });
    lc.hold = async (_id, reason) => {
      holds.push(reason);
    };
    const result = await runner(card, { lifecycle: lc }).run();
    expect(holds).toEqual([result.held?.reason]);
    expect((await store.getCard(card.id))?.blockedReason).toBeUndefined();
  });
});

describe("token and wall-clock budgets (L22)", () => {
  it("stops with token_budget_exhausted once the card's token budget is spent", async () => {
    const card = await newCard({ tokenBudget: 25 });
    const { adapter, seen } = scripted((t) => [
      { id: `r${t}`, name: "read_file", arguments: { path: "src/a.ts", start: 1, end: 1 + t } },
    ]);
    const result = await runner(card, { modelAdapter: adapter }).run();
    // 10 tokens a turn: 10, 20, 30 -> the check before turn 4 stops it.
    expect(seen).toHaveLength(3);
    expect(result.stopReason).toBe("token_budget_exhausted");
    expect((await store.getCard(card.id))?.stopReason).toBe("token_budget_exhausted");
  });

  it("stops with time_budget_exhausted when the wall clock runs out", async () => {
    const card = await newCard({ secondsBudget: 25 });
    let clock = 0;
    const { adapter, seen } = scripted((t) => [
      { id: `r${t}`, name: "read_file", arguments: { path: "src/a.ts", start: 1, end: 1 + t } },
    ]);
    // Each budget check advances the clock 10 s.
    const result = await runner(card, {
      modelAdapter: adapter,
      now: () => {
        clock += 10_000;
        return clock;
      },
    }).run();
    expect(result.stopReason).toBe("time_budget_exhausted");
    expect(seen.length).toBeLessThan(4);
  });

  it("an explicit option overrides the card's budget, and no budget means no limit", async () => {
    const card = await newCard({ tokenBudget: 1_000_000, stepBudget: 3 });
    const { adapter, seen } = scripted((t) => [
      { id: `r${t}`, name: "read_file", arguments: { path: "src/a.ts", start: 1, end: 1 + t } },
    ]);
    const capped = await runner(card, {
      modelAdapter: adapter,
      tokenBudget: 10,
      stepBudget: 3,
    }).run();
    expect(capped.stopReason).toBe("token_budget_exhausted");
    expect(seen).toHaveLength(1);
  });

  it("L22: parks the card with a diagnosis when its token budget runs out", async () => {
    const card = await newCard({ tokenBudget: 25 });
    const { adapter } = scripted((t) => [
      { id: `r${t}`, name: "read_file", arguments: { path: "src/a.ts", start: 1, end: 1 + t } },
    ]);
    const { lc, moves } = lifecycle();
    const result = await runner(card, { modelAdapter: adapter, lifecycle: lc }).run();

    expect(result.stopReason).toBe("token_budget_exhausted");
    expect(result.finalStatus).toBe("parked");
    expect(moves).toEqual(["in_progress", "parked"]);
    // The stop reason carries its diagnosis: the cap, what it bought, and the
    // one decision left to the person who set it.
    expect(result.parked?.suggestion).toContain("token budget (30 of 25)");
    expect(result.parked?.suggestion).toContain(`Raise the budget on card ${card.id}, or split it`);
    const stored = await store.getCard(card.id);
    expect(stored?.status).toBe("parked");
    expect(stored?.blockedReason).toMatch(/^parked: Spent its token budget/);
    const parkedEvent = (await log.getEventsByCard(card.id)).find((e) => e.type === "card/parked");
    expect(parkedEvent?.payload).toEqual(result.parked);
  });

  it("L22: parks a card that spends every step without declaring the work done", async () => {
    const card = await newCard({ stepBudget: 2 });
    const { adapter } = scripted((t) => [
      { id: `r${t}`, name: "read_file", arguments: { path: "src/a.ts", start: 1, end: 1 + t } },
    ]);
    const result = await runner(card, { modelAdapter: adapter, stepBudget: 2 }).run();

    expect(result.finalStatus).toBe("parked");
    expect(result.parked?.suggestion).toContain("every step of its budget (2 of 2)");
  });

  it("reports written-but-unverified work as done_pending_gates at the time limit", async () => {
    const card = await newCard({ secondsBudget: 15 });
    let clock = 0;
    const { adapter } = scripted((t) => [write(t)]);
    const { runner: g, calls } = gates([true]);
    const result = await runner(card, {
      modelAdapter: adapter,
      gateRunner: g,
      now: () => {
        clock += 10_000;
        return clock;
      },
    }).run();
    expect(result.stopReason).toBe("done_pending_gates");
    expect(calls()).toBe(0);
  });
});

describe("repair ladder rungs 3 and 4 (L15)", () => {
  const failingTurns = (t: number) => [write(t), finish];

  it("rung 3 stops with a typed re-plan request and moves the card to Planning", async () => {
    const card = await newCard();
    const { adapter } = scripted(failingTurns);
    const { lc, moves } = lifecycle();
    const result = await runner(card, {
      modelAdapter: adapter,
      gateRunner: gates([false]).runner,
      lifecycle: lc,
    }).run();

    expect(result.stopReason).toBe("replan_requested");
    expect(result.turns).toHaveLength(3);
    expect(result.replan).toMatchObject({
      cardId: card.id,
      attempts: 3,
      filesWritten: ["src/a.ts"],
    });
    expect(result.replan?.failures[0]?.errorExcerpt).toBe(failure.errorExcerpt);
    expect(result.replan?.summary).toContain("TS2322");
    expect(result.finalStatus).toBe("planning");
    expect(moves).toEqual(["in_progress", "planning"]);
    expect((await store.getCard(card.id))?.blockedReason).toMatch(
      /^re-plan requested: Card card_d failed/,
    );
  });

  it("an in-loop re-plan continues the card, and rung 4 parks it with a diagnosis", async () => {
    const card = await newCard();
    const { adapter, seen } = scripted(failingTurns);
    const requests: unknown[] = [];
    const { lc, moves } = lifecycle();
    const result = await runner(card, {
      modelAdapter: adapter,
      gateRunner: gates([false]).runner,
      lifecycle: lc,
      onReplan: async (req) => {
        requests.push(req);
        return "Declare a as a string: export const a = '1';";
      },
    }).run();

    expect(requests).toHaveLength(1);
    // The plan reaches the next prompt.
    expect(seen[3]?.prompt).toContain("Declare a as a string");
    expect(result.stopReason).toBe("capability_ceiling");
    expect(result.finalStatus).toBe("parked");
    expect(moves).toEqual(["in_progress", "parked"]);
    expect(result.parked).toMatchObject({
      cardId: card.id,
      stopReason: "capability_ceiling",
      attempts: 4,
      replanned: true,
      filesWritten: ["src/a.ts"],
      failures: [{ gate: "typecheck", location: "src/a.ts:1" }],
    });
    const stored = await store.getCard(card.id);
    expect(stored?.status).toBe("parked");
    expect(stored?.blockedReason).toMatch(/^parked: A re-planned attempt also exhausted/);
    const parkedEvent = (await log.getEventsByCard(card.id)).find((e) => e.type === "card/parked");
    expect(parkedEvent?.payload).toEqual(result.parked);
  });

  it("a card already running on a manager plan does not ask again: rung 4 is its ceiling", async () => {
    const card = await newCard();
    const { adapter } = scripted(failingTurns);
    const result = await runner(card, {
      modelAdapter: adapter,
      gateRunner: gates([false]).runner,
      managerGuidance: "Use a string.",
    }).run();
    expect(result.stopReason).toBe("capability_ceiling");
    expect(result.replan).toBeUndefined();
    expect(result.turns).toHaveLength(4);
  });
});

describe("fail-to-pass at card start (G12)", () => {
  const withTest = () => {
    mkdirSync(join(repo, "acceptance"), { recursive: true });
    writeFileSync(join(repo, "acceptance", "a.spec.ts"), "test('a', () => {});\n");
    return async (wt: string) => {
      mkdirSync(join(wt, "tests"), { recursive: true });
      writeFileSync(join(wt, "tests", "a.spec.ts"), "test('a', () => {});\n");
    };
  };

  it("refuses to run a card whose staged tests already pass, and parks it", async () => {
    const card = await newCard({ acceptanceTests: ["a.spec.ts"] });
    const { adapter, seen } = scripted(() => [finish]);
    const { lc, moves } = lifecycle();
    const result = await runner(card, {
      modelAdapter: adapter,
      gateRunner: gates([true]).runner,
      lifecycle: lc,
      onWorktreeReady: withTest(),
    }).run();

    expect(seen).toHaveLength(0);
    expect(result.stopReason).toBe("vacuous_tests");
    expect(result.failToPass?.status).toBe("vacuous");
    expect(result.failToPass?.tests).toEqual(["tests/a.spec.ts"]);
    expect(result.finalStatus).toBe("parked");
    expect(moves).toEqual(["parked"]);
    expect(result.parked?.suggestion).toContain("tests/a.spec.ts");
    expect((await store.getCard(card.id))?.stopReason).toBe("vacuous_tests");
  });

  // Every types-only card in the first frozen-suite run was refused here:
  // `import type` and `expectTypeOf` erase at runtime, so the staged test
  // passes against an empty file under the test runner alone. Its red check
  // is a typecheck.
  const rungAware = () => {
    const requested: string[][] = [];
    const runner: GateRunner = {
      runGates: async (rungs): Promise<GateResult> => {
        requested.push([...rungs]);
        // The runtime test passes; the contract it checks does not exist yet.
        return rungs.includes("typecheck")
          ? { passed: false, failures: [{ ...failure }], durationMs: 1, rungResults: [] }
          : { passed: true, failures: [], durationMs: 1, rungResults: [] };
      },
    };
    return { runner, requested };
  };

  it("checks a types-only card's red state with typecheck, and runs it", async () => {
    const card = await newCard({
      acceptanceTests: ["a.spec.ts"],
      title: "Define the contract types (SPIDR: Interface)",
    });
    const { adapter } = scripted((t) => (t === 1 ? [write(1)] : [finish]));
    const { runner: gateRunner, requested } = rungAware();
    const result = await runner(card, {
      modelAdapter: adapter,
      gateRunner,
      onWorktreeReady: withTest(),
    }).run();

    expect(requested[0]).toEqual(["test", "typecheck"]);
    expect(result.failToPass?.status).toBe("fails");
    expect(result.stopReason).not.toBe("vacuous_tests");
  });

  it("still refuses an ordinary card whose runtime tests already pass", async () => {
    // The typecheck rung is added for types-only cards alone: widening it
    // everywhere would let a genuinely vacuous test through on the strength
    // of an unrelated type error elsewhere in the repository.
    const card = await newCard({ acceptanceTests: ["a.spec.ts"] });
    const { adapter } = scripted(() => [finish]);
    const { runner: gateRunner, requested } = rungAware();
    const result = await runner(card, {
      modelAdapter: adapter,
      gateRunner,
      onWorktreeReady: withTest(),
    }).run();

    expect(requested[0]).toEqual(["test"]);
    expect(result.stopReason).toBe("vacuous_tests");
  });

  it("runs the card when the staged tests fail first, and records that they did", async () => {
    const card = await newCard({ acceptanceTests: ["a.spec.ts"] });
    const { adapter } = scripted((t) => (t === 1 ? [write(1)] : [finish]));
    const { runner: g, calls } = gates([false, true]);
    const result = await runner(card, {
      modelAdapter: adapter,
      gateRunner: g,
      onWorktreeReady: withTest(),
    }).run();
    expect(result.failToPass).toMatchObject({ status: "fails" });
    expect(result.stopReason).toBe("gate_passed");
    expect(calls()).toBe(2);
  });

  it("proceeds when the gates cannot run, and skips the check on a retry", async () => {
    const card = await newCard({ acceptanceTests: ["a.spec.ts"] });
    const broken: GateRunner = {
      runGates: async () => {
        throw new Error("sandbox refused");
      },
    };
    const first = await runner(card, {
      gateRunner: broken,
      onWorktreeReady: withTest(),
      stepBudget: 1,
      modelAdapter: scripted(() => [write(1)]).adapter,
    }).run();
    expect(first.failToPass).toMatchObject({ status: "unknown" });
    const retry = await runner(card, { attempt: 2, useExistingWorktree: true }).run();
    expect(retry.failToPass).toBeUndefined();
  });

  it("reports unknown, not fails, when every failure is a gate that could not run", async () => {
    const card = await newCard({ acceptanceTests: ["a.spec.ts"] });
    const notRun: GateRunner = {
      runGates: async () => ({
        passed: false,
        durationMs: 1,
        rungResults: [],
        failures: [{ ...failure, errorExcerpt: "test not run: spawn pnpm ENOENT", notRun: true }],
      }),
    };
    const result = await runner(card, {
      gateRunner: notRun,
      onWorktreeReady: withTest(),
      stepBudget: 1,
      modelAdapter: scripted(() => [write(1)]).adapter,
    }).run();
    expect(result.failToPass).toMatchObject({ status: "unknown" });
  });
});

describe("resume after memory pressure (H17)", () => {
  it("restarts from the last checkpoint and step, not from scratch", async () => {
    const card = await newCard({ stepBudget: 10 });
    let pressure = false;
    const first = await runner(card, {
      modelAdapter: scripted((t) => {
        if (t === 2) pressure = true;
        return [write(t)];
      }).adapter,
      checkpointEvery: 1,
      memoryProbe: () => (pressure ? { ok: false, reason: "swap grew 3GB" } : { ok: true }),
    }).run();
    expect(first.stopReason).toBe("memory_pressure");
    const checkpoints = await store.getCheckpoints(card.id);
    expect(checkpoints.map((c) => c.step)).toEqual([1, 2]);
    const stored = (await store.getCard(card.id)) as CardRecord;
    expect(stored.stopReason).toBe("memory_pressure");

    // Something scribbles on the worktree while the card is halted.
    writeFileSync(join(first.worktreePath, "src", "a.ts"), "garbage(\n");

    const { adapter, seen } = scripted(() => [finish]);
    const resumed = await runner(stored, {
      modelAdapter: adapter,
      useExistingWorktree: true,
      worktreePath: first.worktreePath,
    }).run();

    expect(resumed.resumedFrom).toEqual({ step: 2, gitRef: checkpoints[1]?.gitRef });
    expect(readFileSync(join(first.worktreePath, "src", "a.ts"), "utf8")).toBe(
      "export const a = 2;\n",
    );
    expect(resumed.turns[0]?.turnIndex).toBe(3);
    expect(seen[0]?.prompt).toContain("Resumed from the checkpoint at step 2");
    expect(resumed.stopReason).toBe("gate_passed");
  });

  it("starts fresh when the card did not stop on memory pressure, or resume is off", async () => {
    const card = await newCard();
    await store.updateCard(card.id, { stopReason: "budget_exhausted" });
    const stored = (await store.getCard(card.id)) as CardRecord;
    const r = await runner(stored, {}).run();
    expect(r.resumedFrom).toBeUndefined();
    await store.updateCard(card.id, { stopReason: "memory_pressure" });
    const again = (await store.getCard(card.id)) as CardRecord;
    const off = await runner(again, { resume: false, useExistingWorktree: true, attempt: 2 }).run();
    expect(off.resumedFrom).toBeUndefined();
  });
});

describe("human abort, scope violation and done_pending_gates (L14, L25)", () => {
  it("stops before the next turn with human_abort, from abort() or a signal", async () => {
    const card = await newCard();
    const controller = new AbortController();
    const { adapter, seen } = scripted((t) => {
      if (t === 2) controller.abort("operator pressed stop");
      return [
        { id: `r${t}`, name: "read_file", arguments: { path: "src/a.ts", start: 1, end: t } },
      ];
    });
    const result = await runner(card, { modelAdapter: adapter, signal: controller.signal }).run();
    expect(seen).toHaveLength(2);
    expect(result.stopReason).toBe("human_abort");
    expect((await store.getCard(card.id))?.stopReason).toBe("human_abort");
    // Rule 31: human_abort's next action is to see who stopped it.
    expect(result.evidence.stopDetail).toEqual({ by: "operator pressed stop" });
  });

  it("stops with scope_violation after repeated out-of-scope writes", async () => {
    const card = await newCard();
    const { adapter } = scripted((t) => [
      { id: `x${t}`, name: "write_file", arguments: { path: `src/other${t}.ts`, content: "x" } },
    ]);
    const result = await runner(card, { modelAdapter: adapter }).run();
    expect(result.stopReason).toBe("scope_violation");
    expect(result.turns).toHaveLength(3);
    expect(result.turns.flatMap((t) => t.observations).every((o) => o.deniedRule === "scope")).toBe(
      true,
    );
  });

  it("reports done_pending_gates when the Worker finished and the gates could not run", async () => {
    const card = await newCard();
    const broken: GateRunner = {
      runGates: async () => {
        throw new Error("gates.toml integrity check FAILED");
      },
    };
    const { adapter } = scripted((t) => (t === 1 ? [write(1)] : [finish]));
    const result = await runner(card, { modelAdapter: adapter, gateRunner: broken }).run();
    expect(result.stopReason).toBe("done_pending_gates");
    expect(result.passed).toBe(false);
  });
});

describe("restricted mode and project protection through the runner (defects 3 and 5)", () => {
  it("passes gates.toml's protected globs to the Worker's permission engine", async () => {
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    writeFileSync(
      join(repo, ".sekhemet", "gates.toml"),
      '[project]\nprotected = ["src/frozen/**"]\n\n[[gate]]\nid = "t"\nrung = "test"\ncommand = "true"\n',
    );
    const card = await newCard({ scopeFiles: ["src/**"] });
    const { adapter } = scripted(() => [
      { id: "p", name: "write_file", arguments: { path: "src/frozen/x.ts", content: "x" } },
    ]);
    const result = await runner(card, { modelAdapter: adapter, stepBudget: 1 }).run();
    const obs = result.turns[0]?.observations[0];
    expect(obs?.denied).toBe(true);
    expect(obs?.deniedRule).toBe("protected_file");
  });
});

describe("the card dossier reaches the Worker (integration review item 6)", () => {
  it("shows the send-back and the answer for this card, and records notes and questions", async () => {
    const card = await newCard();
    await store.recordDossierEntry({
      cardId: card.id,
      kind: "send_back",
      text: "Handle a = 0 explicitly",
    });
    const q = await store.recordDossierEntry({
      cardId: card.id,
      kind: "question",
      text: "Is a signed?",
    });
    await store.recordDossierEntry({
      cardId: card.id,
      kind: "answer",
      text: "Yes, signed.",
      inReplyTo: q.entryId,
    });
    const asked: { q: string; meta: unknown }[] = [];
    const { adapter, seen } = scripted((t) =>
      t === 1
        ? [
            { id: "n", name: "note", arguments: { message: "Assumed: a is an integer" } },
            { id: "q", name: "ask", arguments: { question: "zzqx unrelated puzzle?" } },
          ]
        : [finish],
    );
    await runner(card, {
      modelAdapter: adapter,
      attempt: 2,
      askTeam: async (question, meta) => {
        asked.push({ q: question, meta });
        return "Seshat says: fine";
      },
    }).run();

    expect(seen[0]?.prompt).toContain("Sent back by the reviewer: Handle a = 0 explicitly");
    expect(seen[0]?.prompt).toContain("Q: Is a signed? A (manager): Yes, signed.");
    const dossier = await store.getDossier(card.id);
    expect(dossier.notes.map((n) => [n.text, n.attempt])).toEqual([
      ["Assumed: a is an integer", 2],
    ]);
    const thread = dossier.questions.find((t) => t.question.text === "zzqx unrelated puzzle?");
    expect(thread?.answers.map((a) => a.text)).toEqual(["Seshat says: fine"]);
    expect(asked[0]?.meta).toEqual({ questionEntryId: thread?.question.entryId });
  });
});

describe("gate failure routes the card to Planning (B2)", () => {
  it("sends a card whose gates ran and failed from Verify on to Planning", async () => {
    const card = await newCard();
    // Verify once (it fails), then repeat a read until the stall breaker ends
    // the card: it reaches the end of the run with a failing gate verdict.
    const { adapter } = scripted((t) =>
      t === 1 ? [write(t), finish] : [{ id: `r${t}`, name: "read_file", arguments: {} }],
    );
    const { lc, moves } = lifecycle();
    const result = await runner(card, {
      modelAdapter: adapter,
      gateRunner: gates([false]).runner,
      lifecycle: lc,
    }).run();

    expect(result.passed).toBe(false);
    expect(result.stopReason).toBe("oscillation_detected");
    // Through Verify, which is where back-pressure applies, and on to Planning.
    expect(moves).toEqual(["in_progress", "verify", "planning"]);
    expect(result.finalStatus).toBe("planning");
    expect((await store.getCard(card.id))?.status).toBe("planning");
  });

  it("a budget stop that did reach the gates re-plans rather than parking", async () => {
    const card = await newCard({ stepBudget: 1 });
    const { adapter } = scripted((t) => [write(t), finish]);
    const result = await runner(card, {
      modelAdapter: adapter,
      gateRunner: gates([false]).runner,
      stepBudget: 1,
    }).run();

    expect(result.finalStatus).toBe("planning");
    expect(result.parked).toBeUndefined();
  });
});

describe("a gate the Worker suspects parks the card (GT-M6-5)", () => {
  it("parks with gate_suspected, and the evidence names the gate and the reason", async () => {
    const card = await newCard();
    const reason = "the unit gate asserts the old API this card replaces";
    const { adapter, seen } = scripted(() => [
      { id: "n", name: "note", arguments: { message: reason, gate: "unit" } },
    ]);
    const { lc, moves } = lifecycle();
    const result = await runner(card, { modelAdapter: adapter, lifecycle: lc }).run();

    expect(result.stopReason).toBe("gate_suspected");
    expect(result.finalStatus).toBe("parked");
    expect(moves).toEqual(["in_progress", "parked"]);
    expect(result.evidence.stopDetail).toEqual({ gate: "unit", reason });
    // A gate's name alone never refuses it: one that has not failed yet can
    // still encode an assumption the card is changing (rule 18).
    expect(result.parked?.suggestion).toContain("unit");
    expect(result.parked?.suggestion).toContain(reason);
    // The attempt's gates: declared, built-in and the harness's own.
    const noteTool = seen[0]?.tools?.find((t) => t.name === "note");
    const gateEnum = (
      noteTool?.parameters as { properties: Record<string, { enum?: string[] }> } | undefined
    )?.properties.gate?.enum;
    expect(gateEnum).toEqual(
      expect.arrayContaining(["bounds", "integrity", "lint", "secrets", "typecheck", "unit"]),
    );
  });
});

describe("a gate that could not run is not charged on the runner's own paths (B2.3 confirmation)", () => {
  const notRun: GateFailure = {
    ...failure,
    gate: "typecheck",
    errorExcerpt: "typecheck not run: definitely-not-a-binary-xyz did not start",
    notRun: true,
  };
  const sequence = (results: ("pass" | "notRun")[]): GateRunner => {
    let i = 0;
    return {
      runGates: async (): Promise<GateResult> => {
        const r = results[Math.min(i++, results.length - 1)];
        return r === "pass"
          ? { passed: true, failures: [], durationMs: 1, rungResults: [] }
          : { passed: false, failures: [{ ...notRun }], durationMs: 1, rungResults: [] };
      },
    };
  };

  it("forced verification with only not-run gates stops done_pending_gates", async () => {
    const card = await newCard({ stepBudget: 1 });
    const result = await runner(card, {
      stepBudget: 1,
      gateRunner: sequence(["notRun"]),
      modelAdapter: scripted(() => [write(1)]).adapter,
    }).run();
    expect(result.stopReason).toBe("done_pending_gates");
  });

  it("re-verification after a rebase with only not-run gates stops done_pending_gates", async () => {
    const card = await newCard();
    const { adapter } = scripted((t) => {
      if (t === 1) {
        // main moves under the card, touching another file: a clean rebase.
        writeFileSync(join(repo, "src", "b.ts"), "export const b = 1;\n");
        git(repo, "add", "-A");
        git(repo, "commit", "-qm", "main moved");
        return [write(1), finish];
      }
      return [finish];
    });
    const result = await runner(card, {
      modelAdapter: adapter,
      gateRunner: sequence(["pass", "notRun"]),
    }).run();
    expect(result.stopReason).toBe("done_pending_gates");
  });
});

describe("note's gate enum holds only the gates this attempt runs (B2.3 confirmation)", () => {
  it("leaves out a declared gate whose rung the attempt does not run", async () => {
    const card = await newCard();
    const { adapter, seen } = scripted(() => [finish]);
    await runner(card, { modelAdapter: adapter, restricted: true }).run();
    const noteTool = seen[0]?.tools?.find((t) => t.name === "note");
    const gateEnum = (
      noteTool?.parameters as { properties: Record<string, { enum?: string[] }> } | undefined
    )?.properties.gate?.enum;
    // Restricted mode runs the static layer only: typecheck and lint, not unit.
    expect(gateEnum).toContain("typecheck");
    expect(gateEnum).not.toContain("unit");
  });
});
