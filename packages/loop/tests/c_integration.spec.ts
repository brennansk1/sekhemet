import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ExemplarStore, cardClassOf as contextCardClass } from "@sekhemet/context";
import type { GateRunner } from "@sekhemet/gates";
import { type CardRecord, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardRunner } from "../src/card_runner.js";
import { CardExecutionSessionImpl } from "../src/session.js";

type Script = (n: number, req: InferenceRequest) => Omit<ToolCall, "id">[];
function adapterOf(script: Script, extra: Partial<LocalInferenceAdapter> = {}) {
  const seen: InferenceRequest[] = [];
  let n = 0;
  const adapter: LocalInferenceAdapter = {
    modelId: "m",
    supportedArms: ["arm_a_flat", "arm_b_json"],
    ...extra,
    generate: async (req) => {
      seen.push(req);
      n++;
      req.onToken?.("tok ");
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

describe("loop callers of Builder C's APIs (C1, C2, C4, C9, C13, C14, C16, C19, C20, C22, M2, M9)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "c-int-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "export function alpha(): number {\n  return 1;\n}\n");
    writeFileSync(
      join(root, "src", "b.ts"),
      'import { alpha } from "./a.js";\nexport const beta = alpha() + 1;\n',
    );
    writeFileSync(
      join(root, "AGENTS.md"),
      "# Rules\n\n- Always use named exports in this project.\n",
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const card: CardRecord = {
    id: "card_c",
    tier: "task",
    title: "Change alpha",
    status: "in_progress",
    scopeFiles: ["src/a.ts"],
    stepBudget: 6,
    stepsUsed: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  it("builds the prompt with conventions, exemplars, the ranked map, a prefix guard, the measured arm and streamed tokens", async () => {
    const store = new ExemplarStore(join(root, "ex"));
    store.record({
      cardId: "card_old",
      cardClass: contextCardClass(card),
      title: "An earlier alpha change that passed",
      trajectory: ["read_file src/a.ts", "edit src/a.ts", "check: pass"],
      steps: 3,
      tokens: 100,
      date: "2026-01-01T00:00:00Z",
    });
    const tokens: string[] = [];
    const { adapter, seen } = adapterOf(
      () => [{ name: "read_file", arguments: { path: "src/a.ts" } }],
      {
        preferredToolArm: "arm_b_json",
      },
    );
    const session = new CardExecutionSessionImpl({
      cardId: card.id,
      card,
      stepBudget: 6,
      worktreePath: root,
      modelAdapter: adapter,
      gateRunner: passing,
      scopeFiles: ["src/a.ts"],
      exemplarStore: store,
      onToken: (t) => tokens.push(t),
    });
    const turn = await session.executeTurn();
    const all = `${seen[0]?.systemPrompt}\n${seen[0]?.prompt}`;
    expect(all).toContain("Always use named exports in this project.");
    expect(all).toContain("An earlier alpha change that passed");
    expect(all).toContain("alpha");
    expect(seen[0]?.toolArm).toBe("arm_b_json");
    expect(tokens).toEqual(["tok "]);
    const report = session.getLastContextReport();
    expect(report?.pack.cardId).toBe("card_c");
    expect(report?.metrics.step).toBeGreaterThanOrEqual(1);
    expect(turn.stopReason).toBeUndefined();
  });

  it("loads tools on demand through tool_search when progressive loading is on (C19)", async () => {
    const { adapter, seen } = adapterOf((n) =>
      n === 1
        ? [{ name: "tool_search", arguments: { query: "go_to_definition" } }]
        : [{ name: "read_file", arguments: { path: "src/a.ts" } }],
    );
    const session = new CardExecutionSessionImpl({
      cardId: card.id,
      card,
      stepBudget: 6,
      worktreePath: root,
      modelAdapter: adapter,
      gateRunner: passing,
      scopeFiles: ["src/a.ts"],
      progressiveTools: true,
    });
    const first = await session.executeTurn();
    await session.executeTurn();
    const before = (seen[0]?.tools ?? []).map((t) => t.name);
    const after = (seen[1]?.tools ?? []).map((t) => t.name);
    expect(before).toContain("tool_search");
    expect(before).not.toContain("go_to_definition");
    expect(after).toContain("go_to_definition");
    expect(first.observations[0]?.summary).toContain("go_to_definition");
  });

  it("answers a side question in a child context and returns only the answer (C16)", async () => {
    const child: LocalInferenceAdapter = {
      modelId: "child",
      supportedArms: ["arm_a_flat"],
      generate: async () => ({
        text: "ANSWER: alpha is defined in src/a.ts line 1",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      }),
    };
    const { adapter } = adapterOf(() => [
      { name: "subtask", arguments: { question: "Where is alpha defined?" } },
    ]);
    const session = new CardExecutionSessionImpl({
      cardId: card.id,
      card,
      stepBudget: 6,
      worktreePath: root,
      modelAdapter: adapter,
      subtaskAdapter: child,
      gateRunner: passing,
      scopeFiles: ["src/a.ts"],
    });
    const turn = await session.executeTurn();
    expect(turn.observations[0]).toMatchObject({ tool: "subtask", ok: true });
    expect(turn.observations[0]?.content).toBe("alpha is defined in src/a.ts line 1");
  });
});

describe("the runner's sync and evidence callers (Y1, Y6, E3)", () => {
  let repo: string;
  let db: DatabaseSync;
  let store: CardStore;
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "c-int-run-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 0;\n");
    writeFileSync(join(repo, ".gitignore"), ".sekhemet/\n");
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

  const run = async (id: string, content: string, onFirstTurn?: () => void) => {
    const card = await store.createCard({
      id,
      tier: "story",
      title: `Card ${id}`,
      scopeFiles: ["src/a.ts"],
      stepBudget: 4,
    });
    const { adapter } = adapterOf((n) => {
      if (n === 1) onFirstTurn?.();
      return [
        { name: "write_file", arguments: { path: "src/a.ts", content } },
        { name: "finish_card", arguments: {} },
      ];
    });
    return new CardRunner({
      card,
      repoRoot: repo,
      worktreePath: join(repo, ".sekhemet", "worktrees", id),
      stepBudget: 4,
      modelAdapter: adapter,
      gateRunner: passing,
      syncAdapter: new NodeGitSyncAdapter(repo),
      scopeFiles: ["src/a.ts"],
      store,
    }).run();
  };

  it("records the full settings and the commit in the evidence (E3)", async () => {
    const r = await run("card_e3", "export const a = 1;\n");
    expect(r.evidence.settings).toMatchObject({ modelId: "m", toolArm: "arm_a_flat" });
    expect(r.evidence.settings.harnessCommit).toMatch(/^[0-9a-f]{12}$|^unknown$/);
    expect((r.evidence.settings as unknown as { quant: string }).quant).toBeDefined();
  });

  it("rebases a passing card onto main before Verify, and stops on a conflict (Y6)", async () => {
    // main moves under the card while it works, touching the same line.
    const r = await run("card_y6", "export const a = 2;\n", () => {
      writeFileSync(join(repo, "src", "a.ts"), "export const a = 99;\n");
      git("commit", "-qam", "main moved");
    });
    expect(r.stopReason).toBe("rebase_conflict");
    expect(r.passed).toBe(false);
    const stored = await store.getCard("card_y6");
    expect(stored?.blockedReason).toMatch(/^rebase conflict: .*src\/a\.ts/);

    // A non-conflicting move of main: rebased, re-verified, passes.
    writeFileSync(join(repo, "src", "b.ts"), "export const b = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "unrelated");
    const ok = await run("card_y6b", "export const a = 3;\n", () => {
      writeFileSync(join(repo, "src", "c.ts"), "export const c = 1;\n");
      git("add", "-A");
      git("commit", "-qm", "main moved elsewhere");
    });
    expect(ok.stopReason).toBe("gate_passed");
    // The card now sits on top of the latest main.
    expect(existsSync(join(ok.worktreePath, "src", "c.ts"))).toBe(true);
  });
});
