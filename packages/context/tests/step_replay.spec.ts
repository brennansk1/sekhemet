import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BlobStore, CardStore, EventLog, initSchema, serializeContextPack } from "@sekhemet/kernel";
import type { InferenceRequest, InferenceResponse, ToolCall } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { findContradictions, findPlaceholders } from "../src/prompt_lint.js";
import {
  type ReplayCase,
  type StepReplayModel,
  canonicalStates,
  recordedReplayCases,
  runStepReplay,
} from "../src/step_replay.js";
import type { ToolInterfaceSpec } from "../src/tool_interface.js";
import { workerCopy } from "../src/worker_copy.js";

// PROMPT_STANDARD rule 35.3: recorded prompts, run for one model step each
// under the current templates; code checks the reply. It screens, never admits.

const spec = (name: string, params: string[] = []): ToolInterfaceSpec => ({
  name,
  summary: `The ${name} tool.`,
  parameters: params.map((p) => ({ name: p, type: "string", required: true, description: p })),
});
const TOOLS: ToolInterfaceSpec[] = [
  spec("read_file", ["path"]),
  spec("write_file", ["path", "content"]),
  spec("edit", ["path", "search", "replace"]),
  spec("grep_search", ["query"]),
  spec("check"),
  spec("finish_card"),
];

const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: name,
  name,
  arguments: args,
});

/** A scripted model: the reply for each case by its id, the cases run in order. */
function scripted(
  cases: readonly ReplayCase[],
  replies: Record<string, Partial<InferenceResponse>>,
): StepReplayModel {
  let i = 0;
  return {
    modelId: "scripted",
    generate: async (_req: InferenceRequest) => {
      const id = cases[i++]?.id ?? "";
      return { text: "", toolCalls: [], usage, ...(replies[id] ?? {}) };
    },
  };
}

const states = () => canonicalStates({ tools: TOOLS });
const replay = (replies: Record<string, Partial<InferenceResponse>>) => {
  const cases = states();
  return runStepReplay(cases, scripted(cases, replies));
};

describe("the canonical states", () => {
  it("are rendered under the current templates, each labelled with the tools that are right", () => {
    const states = canonicalStates({ tools: TOOLS });
    expect(states.map((s) => s.id).sort()).toEqual([
      "failing_typecheck",
      "first_step",
      "ready_to_verify",
    ]);
    for (const s of states) {
      expect(s.rendering).toBe("current");
      expect(s.offered).toEqual(TOOLS.map((t) => t.name));
      expect(s.expected?.length).toBeGreaterThan(0);
    }
    // The screen blames the model only for what its prompt did not already hold.
    for (const s of states) {
      const text = `${s.request.systemPrompt ?? ""}\n\n${s.request.prompt}`;
      expect(findPlaceholders(text), s.id).toEqual([]);
      expect(findContradictions(text), s.id).toEqual([]);
    }
    const ready = states.find((s) => s.id === "ready_to_verify");
    expect(ready?.request.prompt).toContain(workerCopy.nextActionReady);
    expect(ready?.expected?.map((e) => e.tool).sort()).toEqual(["check", "finish_card"]);
    const failing = states.find((s) => s.id === "failing_typecheck");
    expect(failing?.request.prompt).toContain("TS2322");
    expect(failing?.expected).toContainEqual({ tool: "edit", path: "src/ledger.ts" });
    expect(failing?.expected).toContainEqual({ tool: "read_file", path: "src/ledger.ts" });
  });
});

describe("runStepReplay", () => {
  const good: Record<string, Partial<InferenceResponse>> = {
    first_step: { toolCalls: [call("read_file", { path: "tests/ledger.spec.ts" })] },
    failing_typecheck: {
      toolCalls: [call("edit", { path: "src/ledger.ts", search: "a", replace: "b" })],
    },
    ready_to_verify: { toolCalls: [call("finish_card")] },
  };

  it("passes every check when each state gets a right, offered, literal call, and never admits", async () => {
    const report = await replay(good);
    expect(report.admits).toBe(false);
    expect(report.passed).toBe(true);
    expect(report.cases.every((c) => c.passed)).toBe(true);
    expect(report.byCheck).toEqual({
      parses: { pass: 3, fail: 0 },
      offeredOnly: { pass: 3, fail: 0 },
      noPlaceholder: { pass: 3, fail: 0 },
      rightTool: { pass: 3, fail: 0 },
    });
    expect(report.byState.ready_to_verify).toBe(true);
  });

  it("fails each check on its own failure, naming the case and the check", async () => {
    const report = await replay({
      first_step: { text: "I will read the file now." },
      failing_typecheck: { toolCalls: [call("delete_everything", { path: "src" })] },
      ready_to_verify: { toolCalls: [call("read_file", { path: "<path to file>" })] },
    });
    expect(report.passed).toBe(false);
    const byId = Object.fromEntries(report.cases.map((c) => [c.id, c]));
    expect(byId.first_step?.checks.parses).toBe(false);
    expect(byId.failing_typecheck?.checks).toMatchObject({ parses: true, offeredOnly: false });
    expect(byId.failing_typecheck?.checks.rightTool).toBe(false);
    expect(byId.ready_to_verify?.checks).toMatchObject({ noPlaceholder: false, rightTool: false });
    expect(byId.ready_to_verify?.problems.join(" ")).toMatch(/<path to file>/);
    expect(report.byState).toEqual({
      first_step: false,
      failing_typecheck: false,
      ready_to_verify: false,
    });
  });

  it("chooses the wrong tool in a canonical state: finishing on a failing typecheck", async () => {
    const report = await replay({
      ...good,
      failing_typecheck: { toolCalls: [call("finish_card")] },
    });
    const failing = report.cases.find((c) => c.id === "failing_typecheck");
    expect(failing?.checks).toEqual({
      parses: true,
      offeredOnly: true,
      noPlaceholder: true,
      rightTool: false,
    });
    expect(report.byCheck.rightTool).toEqual({ pass: 2, fail: 1 });
  });

  it("parses a call written in the reply's text, as the text arm sends it", async () => {
    const report = await replay({
      ...good,
      ready_to_verify: { text: '<tool_call>{"name": "check", "arguments": {}}</tool_call>' },
    });
    expect(report.cases.find((c) => c.id === "ready_to_verify")?.checks).toMatchObject({
      parses: true,
      rightTool: true,
    });
  });
});

describe("recorded context packs", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  async function ledger(toolNames: string[] = ["read_file"]): Promise<string> {
    const repo = mkdtempSync(join(tmpdir(), "step-replay-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".sekhemet"));
    const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    const store = new CardStore(db, new EventLog(db));
    const card = await store.createCard({
      id: "card_r",
      title: "R",
      tier: "story",
      status: "ready",
    });
    const attempt = await store.runs.startAttempt({
      cardId: card.id,
      attemptNumber: 1,
      modelId: "worker",
      toolArm: "A",
    });
    const blobs = new BlobStore(repo);
    const schemas = blobs.put(
      JSON.stringify(
        toolNames.map((name) => ({ name, description: "A tool.", parameters: { type: "object" } })),
      ),
    );
    const packs = [{ prompt: "a whole pack", toolSchemas: schemas }, { prompt: "an older pack" }];
    for (const [i, p] of packs.entries()) {
      const id = blobs.put(
        serializeContextPack({
          cardId: card.id,
          attemptId: attempt.id,
          step: i,
          modelId: "worker",
          systemPrompt: "system",
          prompt: p.prompt,
          tools: ["read_file"],
          ...(p.toolSchemas ? { toolSchemas: p.toolSchemas, maxTokens: 2048 } : {}),
        }),
      );
      await store.runs.recordStep({
        attemptId: attempt.id,
        cardId: card.id,
        stepIndex: i,
        calls: [],
        contextPackId: id,
        promptTokens: 1,
        completionTokens: 1,
        durationMs: 1,
      });
    }
    db.close();
    return repo;
  }

  it("replays a pack as stored and says so, and counts a pack it cannot replay", async () => {
    const repo = await ledger();
    const r = recordedReplayCases([repo], { modelId: "worker" });
    expect(r.cases).toHaveLength(1);
    const c = r.cases[0] as ReplayCase;
    expect(c.rendering).toBe("as-stored");
    expect(c.note).toMatch(/as sent/);
    expect(c.request).toMatchObject({
      systemPrompt: "system",
      prompt: "a whole pack",
      maxTokens: 2048,
    });
    expect(c.offered).toEqual(["read_file"]);
    expect(c.expected).toBeUndefined();
    expect(r.skipped).toEqual({ "no tool definitions recorded (an older pack)": 1 });

    const report = await runStepReplay(r.cases, scripted(r.cases, {}));
    // With no label, rightTool is not judged; the reply has no call, so parses fails.
    expect(report.cases[0]?.checks).toEqual({
      parses: false,
      offeredOnly: true,
      noPlaceholder: true,
    });
    expect(report.asStored).toBe(1);
  });

  it("offers a progressive pack's whole class catalog, which tool_search reaches", async () => {
    const repo = await ledger(["tool_search", "read_file"]);
    const r = recordedReplayCases([repo], {
      modelId: "worker",
      progressiveCatalog: ["read_file", "git_history", "tool_search"],
    });
    expect(r.cases[0]?.offered.sort()).toEqual(["git_history", "read_file", "tool_search"]);
  });
});

describe("the arms review's fixes (item 10)", () => {
  const good: Record<string, Partial<InferenceResponse>> = {
    first_step: { toolCalls: [call("read_file", { path: "tests/ledger.spec.ts" })] },
    failing_typecheck: {
      toolCalls: [call("edit", { path: "src/ledger.ts", search: "a", replace: "b" })],
    },
    ready_to_verify: { toolCalls: [call("finish_card")] },
  };

  it("does not count editing the empty scope file as right on the first step", () => {
    const first = states().find((s) => s.id === "first_step");
    expect(first?.expected).not.toContainEqual({ tool: "edit", path: "src/ledger.ts" });
    expect(first?.expected).toContainEqual({ tool: "write_file", path: "src/ledger.ts" });
  });

  it("counts a model error apart from the checks, and fails the screen", async () => {
    const cases = states();
    let i = 0;
    const model: StepReplayModel = {
      modelId: "flaky",
      generate: async () => {
        const id = cases[i++]?.id ?? "";
        if (id === "failing_typecheck") throw new Error("connection reset");
        return { text: "", toolCalls: [], usage, ...(good[id] ?? {}) };
      },
    };
    const report = await runStepReplay(cases, model);
    expect(report.modelErrors).toBe(1);
    expect(report.byCheck.parses).toEqual({ pass: 2, fail: 0 });
    expect(report.cases.find((c) => c.id === "failing_typecheck")).toMatchObject({
      passed: false,
      error: "connection reset",
    });
    expect(report.passed).toBe(false);
  });

  it("gives the current templates a verdict apart from the packs replayed as stored", async () => {
    const cases: ReplayCase[] = [
      ...states(),
      {
        id: "pack",
        rendering: "as-stored",
        request: { prompt: "p", toolArm: "arm_a_flat" },
        offered: ["read_file"],
      },
    ];
    const report = await runStepReplay(cases, scripted(cases, good));
    expect(report.current).toEqual({ cases: 3, passed: true });
    expect(report.asStoredVerdict).toEqual({ cases: 1, passed: false });
  });

  it("reports an unknown tool written in the text as not offered, not as unparsed", async () => {
    const report = await replay({
      ...good,
      ready_to_verify: { text: 'delete_everything(path="src")' },
    });
    expect(report.cases.find((c) => c.id === "ready_to_verify")?.checks).toMatchObject({
      parses: true,
      offeredOnly: false,
    });
  });
});
