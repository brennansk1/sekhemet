import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DeterministicGateRunner } from "@sekhemet/gates";
import {
  CardStore,
  EventLog,
  LifecycleHookEngine,
  STOP_REASONS,
  initSchema,
} from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardRunner } from "../src/card_runner.js";

const GATE = `[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "const fs=require('fs');for (const f of fs.existsSync('tests')?fs.readdirSync('tests'):[]) if (f.endsWith('.test.js')) require(require('path').resolve('tests', f));"]\ntimeout_s = 30\nparser = "generic"\n`;

describe("the runner reads the stop-reason table and records the step evidence (B2.1)", () => {
  let repo: string;
  let db: DatabaseSync;
  let store: CardStore;
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "b21-runner-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    mkdirSync(join(repo, "src"));
    mkdirSync(join(repo, ".sekhemet"));
    writeFileSync(join(repo, "src", "a.js"), "module.exports = { a: 0 };\n");
    writeFileSync(join(repo, ".gitignore"), ".sekhemet/*\n!.sekhemet/gates.toml\n");
    db = new DatabaseSync(join(repo, "events.db"));
    initSchema(db);
    store = new CardStore(db, new EventLog(db));
  });
  afterEach(() => {
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  const run = async (
    id: string,
    project: string,
    calls: (n: number) => Omit<ToolCall, "id">[],
    extra: { hooks?: LifecycleHookEngine; promptTokenBudget?: number } = {},
  ) => {
    writeFileSync(join(repo, ".sekhemet", "gates.toml"), `[project]\n${project}\n\n${GATE}`);
    git("add", "-A");
    git("commit", "-qm", "seed");
    const card = await store.createCard({
      id,
      tier: "story",
      title: id,
      scopeFiles: ["src/a.js"],
      stepBudget: 2,
    });
    let n = 0;
    const adapter: LocalInferenceAdapter = {
      modelId: "m",
      supportedArms: ["arm_a_flat"],
      contextWindow: { contextTokens: 16_384, maxTokens: 4_096 },
      generate: async (_req: InferenceRequest) => {
        n++;
        return {
          text: "",
          toolCalls: calls(n).map((c, i) => ({ id: `${n}-${i}`, ...c })),
          usage: { promptTokens: 10, completionTokens: 3, durationMs: 1 },
          finishReason: "tool_calls",
        };
      },
    };
    return new CardRunner({
      card,
      repoRoot: repo,
      worktreePath: join(repo, ".sekhemet", "worktrees", id),
      stepBudget: 2,
      modelAdapter: adapter,
      gateRunner: new DeterministicGateRunner(new ProcessSandbox(), { repoRoot: repo }),
      syncAdapter: new NodeGitSyncAdapter(repo),
      scopeFiles: ["src/a.js"],
      store,
      verifyFailToPass: false,
      ...extra,
    }).run();
  };
  const readA: Omit<ToolCall, "id"> = { name: "read_file", arguments: { path: "src/a.js" } };
  const list: Omit<ToolCall, "id"> = { name: "list_dir", arguments: { path: "." } };

  it("WL-T3-13, WL-T3-1, WL-M2-5, WL-M3-4: each sample has its own step budget; the evidence gives the steps of each and every step's phase, tokens and format errors", async () => {
    const result = await run("card_k", "pass_at_k = 3", (n) => (n % 2 === 1 ? [readA] : [list]));
    expect(result.stopReason).toBe("budget_exhausted");
    const ev = result.evidence;
    expect(ev.sampleSteps).toEqual([2, 2, 2]);
    expect(ev.steps?.map((s) => s.sample)).toEqual([1, 1, 2, 2, 3, 3]);
    for (const s of ev.steps ?? []) {
      expect(s.phase).toBe("find");
      expect(s.promptTokens).toBe(10);
      expect(s.formatErrors).toBe(0);
      expect(s.proseOnly).toBe(0);
      expect(s.finishReason).toBe("tool_calls");
    }
    expect(ev.settings.toolSet).toBe("fixed");
    // WL-M3-5: the attempt's W, 16,384 − 4,096 − 2,048 − 256.
    expect(ev.settings.promptBudgetTokens).toBe(9_984);
    // WL-M3-4: the step rows carry the same facts.
    const attempt = store.runs?.listAttempts("card_k").at(-1);
    const rows = attempt ? (store.runs?.listSteps(attempt.id) ?? []) : [];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({
      phase: "find",
      finishReason: "tool_calls",
      formatErrors: 0,
      proseOnly: 0,
    });
    // Rule 31a: the step budget ran out, and the evidence says so.
    expect(ev.stopDetail).toEqual({ budget: "steps", used: 2, of: 2 });
  }, 60_000);

  it("WL-M2-5: a reply with no tool call is counted as prose-only, apart from format errors, in the evidence and the step rows", async () => {
    const result = await run("card_p", "", (n) => (n === 1 ? [] : [list]));
    const steps = result.evidence.steps ?? [];
    expect(steps.map((s) => [s.formatErrors, s.proseOnly])).toEqual([
      [0, 1],
      [0, 0],
    ]);
    const attempt = store.runs?.listAttempts("card_p").at(-1);
    const rows = attempt ? (store.runs?.listSteps(attempt.id) ?? []) : [];
    expect(rows.map((r) => [r.formatErrors, r.proseOnly])).toEqual([
      [0, 1],
      [0, 0],
    ]);
  }, 60_000);

  it("WL-T3-12: a context stop parks with the zone, its tokens and cap, and does not offer more steps", async () => {
    const result = await run("card_c", "", () => [readA], { promptTokenBudget: 50 });
    expect(result.stopReason).toBe("budget_exhausted");
    expect(result.evidence.stopDetail?.budget).toBe("context");
    expect(result.finalStatus).toBe("parked");
    const text = result.parked?.suggestion ?? "";
    expect(text).toMatch(/95%/);
    expect(text).toContain(String(result.evidence.stopDetail?.zone));
    expect(text).toContain(String(result.evidence.stopDetail?.cap));
    expect(text).not.toMatch(/raise/i);
  }, 60_000);

  it("WL-T3-4: a hook veto parks the card with the hook named, and the attempt is halted", async () => {
    const hooks = new LifecycleHookEngine();
    hooks.register("pre-step", () => ({ block: true, reason: "change freeze" }));
    const result = await run("card_h", "", () => [readA], { hooks });
    expect(result.stopReason).toBe("hook_veto");
    expect(STOP_REASONS.hook_veto.parks).toBe("yes");
    expect(result.finalStatus).toBe("parked");
    expect(result.parked?.suggestion).toMatch(/pre-step hook 1/);
    expect(result.parked?.suggestion).toMatch(/change freeze/);
    expect(result.evidence.stopDetail).toEqual({
      hook: "pre-step hook 1",
      reason: "change freeze",
    });
    const attempt = store.runs?.listAttempts("card_h").at(-1);
    expect(attempt?.status).toBe("halted");
  }, 60_000);
});
