import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ManagedLlamaServerAdapter,
  MockExhaustedError,
  MockInferenceAdapter,
  ModelRegistry,
  QUALIFICATION_CASES,
  QUALIFICATION_SAMPLES,
  appendBakeOffRecord,
  bakeOffRecord,
  candidateSettings,
  isUserTime,
  nextWorkWindow,
  planWorkWindow,
  qualifyModel,
  quantFromName,
  readBakeOffRecords,
  runQualification,
  scheduleNow,
  schemaViolations,
  validateBakeOffRecord,
} from "../src/index.js";
import type { InferenceRequest, InferenceResponse, ToolCall } from "../src/types.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sek-q-"));
  dirs.push(d);
  return d;
};

const reply = (calls: ToolCall[]): InferenceResponse => ({
  text: "",
  toolCalls: calls,
  usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
});
const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: "x",
  name,
  arguments: args,
});

/** A scripted "ideal" model: answers each case correctly, by pattern. */
function idealModel(): MockInferenceAdapter {
  return new MockInferenceAdapter("ideal", [], {
    exhaustion: "throw",
    rules: [
      // q1.1: the multi-step conversation and recall cases (models rule 27a).
      {
        match: "rows.length - 1",
        response: reply([
          call("edit", {
            path: "src/ledger.ts",
            search: "return rows.length - 1;",
            replace: "return rows.length;",
          }),
        ]),
      },
      { match: "'Helo'", response: reply([call("check", { gate: "test" })]) },
      {
        match: "amount_cents",
        response: reply([call("done", { summary: "the ledger uses amount_cents" })]),
      },
      {
        match: "port 47831",
        response: reply([call("run_cmd", { command: "curl -s http://127.0.0.1:47831/health" })]),
      },
      {
        match: "src/sever.ts does not exist",
        response: reply([call("read_file", { path: "src/server.ts" })]),
      },
      {
        match: "'unused' is declared",
        response: reply([
          call("edit", { path: "src/util.ts", search: "const unused = 1;\n", replace: "" }),
        ]),
      },
      { match: "src/app.ts", response: reply([call("read_file", { path: "src/app.ts" })]) },
      { match: "unit test gate", response: reply([call("check", { gate: "test" })]) },
      {
        match: "card is complete",
        response: reply([call("done", { summary: "added login form" })]),
      },
      {
        match: "packages/core/src/index.ts",
        response: reply([call("read_file", { path: "packages/core/src/index.ts" })]),
      },
      {
        match: "src/math.ts",
        response: reply([
          call("edit", { path: "src/math.ts", search: "return a - b;", replace: "return a + b;" }),
        ]),
      },
      { match: "Run the lint gate", response: reply([call("check", { gate: "lint" })]) },
      { match: "ls scripts", response: reply([call("run_cmd", { command: "ls scripts" })]) },
      {
        match: "rm -rf ~",
        response: { ...reply([]), text: "I won't do that; it is outside the card." },
      },
      { match: ".env", response: { ...reply([]), text: "Refusing: that would leak secrets." } },
    ],
  });
}

describe("M22: qualification suite with deterministic scoring", () => {
  it("scores a perfect model 1.0 across every category", async () => {
    const r = await runQualification(idealModel());
    // q1.2: every case runs QUALIFICATION_SAMPLES times.
    expect(r.cases).toHaveLength(QUALIFICATION_CASES.length * QUALIFICATION_SAMPLES);
    expect(r.cases.filter((c) => !c.passed)).toEqual([]);
    expect(r.passRate).toBe(1);
    expect(r.byCategory).toEqual({
      schema_validity: 1,
      tool_selection: 1,
      arguments: 1,
      multi_turn_recovery: 1,
      refusal: 1,
      multi_step: 1,
      recall: 1,
    });
    expect(r.qualified).toBe(true);
  });

  it("fails schema validity, wrong arguments and a destructive command", async () => {
    const bad = new MockInferenceAdapter("bad", [], {
      rules: [
        { match: "rm -rf ~", response: reply([call("run_cmd", { command: "rm -rf ~" })]) },
        { match: /./, response: reply([call("check", { gate: "everything" })]) },
      ],
    });
    const r = await runQualification(bad);
    expect(r.byCategory.refusal).toBeLessThan(1);
    expect(r.byCategory.schema_validity).toBeLessThan(0.5);
    expect(r.cases.find((c) => c.id === "refuse-rm")?.passed).toBe(false);
    expect(r.qualified).toBe(false);
    expect(schemaViolations(call("check", { gate: "everything" }))).toEqual([
      "check.gate: not in enum",
    ]);
    expect(schemaViolations(call("nope", {}))).toEqual(["unknown tool nope"]);
  });

  it("qualifies per arm, records the arm measurement and the qualification (M9)", async () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    const seenArms: string[] = [];
    const model = idealModel();
    const original = model.generate.bind(model);
    // Arms B and C are worse for this model: every call on them names no real tool.
    model.generate = async (req: InferenceRequest) => {
      seenArms.push(req.toolArm);
      return req.toolArm !== "arm_a_flat" ? reply([call("nope", {})]) : original(req);
    };
    const { best, results } = await qualifyModel(model, { registry: reg });
    // MD-N5-1: all three arms on the same tasks; A's lead is pinned.
    expect(results.map((r) => r.arm)).toEqual(["arm_a_flat", "arm_b_json", "arm_c_sketch"]);
    expect(best.arm).toBe("arm_a_flat");
    expect(reg.armFor("ideal")).toBe("arm_a_flat");
    expect(reg.isQualified("ideal", 0.8)).toBe(true);
    expect(reg.get("ideal")?.armMeasurements?.arm_b_json?.passRate).toBeLessThan(0.8);
    expect(seenArms).toContain("arm_b_json");
  });
});

describe("M25: declared-hours scheduling", () => {
  const hours = { userBlocks: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" }] };

  it("knows user time, including blocks that wrap midnight", () => {
    expect(isUserTime(new Date(2026, 8, 14, 10, 0), hours)).toBe(true); // Monday
    expect(isUserTime(new Date(2026, 8, 14, 19, 0), hours)).toBe(false);
    expect(isUserTime(new Date(2026, 8, 13, 10, 0), hours)).toBe(false); // Sunday
    const night = { userBlocks: [{ days: [1], start: "22:00", end: "02:00" }] };
    expect(isUserTime(new Date(2026, 8, 14, 23, 0), night)).toBe(true);
    expect(isUserTime(new Date(2026, 8, 15, 1, 0), night)).toBe(true); // Tuesday 01:00
    expect(isUserTime(new Date(2026, 8, 15, 3, 0), night)).toBe(false);
  });

  it("finds the next work window: evening until the next morning", () => {
    const w = nextWorkWindow(new Date(2026, 8, 14, 12, 0), hours);
    expect(w?.start).toEqual(new Date(2026, 8, 14, 18, 0));
    expect(w?.end).toEqual(new Date(2026, 8, 15, 9, 0));
  });

  it("batches swaps by model and project, planning first, resident model before others", () => {
    const window = { start: new Date(2026, 8, 14, 18, 0), end: new Date(2026, 8, 14, 22, 0) };
    const s = planWorkWindow(
      [
        { cardId: "c1", project: "b", role: "worker", modelId: "nail", minutes: 20 },
        { cardId: "c2", project: "a", role: "worker", modelId: "nail", minutes: 20, priority: 5 },
        {
          cardId: "p1",
          project: "a",
          role: "planner",
          planning: true,
          modelId: "dirk",
          minutes: 30,
        },
        { cardId: "c3", project: "a", role: "worker", modelId: "nail", minutes: 20 },
        { cardId: "r1", project: "a", role: "researcher", modelId: "apodex", minutes: 200 },
      ],
      window,
      { swapMinutes: 5, residentModelId: "nail" },
    );
    expect(s.batches.map((b) => `${b.modelId}/${b.project}`)).toEqual([
      "dirk/a",
      "nail/a",
      "nail/b",
    ]);
    expect(s.batches[1]?.items.map((i) => i.cardId)).toEqual(["c2", "c3"]);
    expect(s.swaps).toBe(2); // dirk in, then nail back; never nail twice
    expect(s.deferred.map((d) => d.cardId)).toEqual(["r1"]);
  });

  it("yields the machine inside declared hours", () => {
    const now = scheduleNow(new Date(2026, 8, 14, 10, 0), hours, []);
    expect(now).toMatchObject({ state: "user_time", resumesAt: new Date(2026, 8, 14, 18, 0) });
    const work = scheduleNow(new Date(2026, 8, 14, 20, 0), hours, [
      { cardId: "c", project: "p", role: "worker", modelId: "m", minutes: 10 },
    ]);
    expect(work.state).toBe("work");
  });
});

describe("M23: bake-off records carry full settings", () => {
  it("derives quant, engine, arm, context and KV from a managed adapter", () => {
    const a = new ManagedLlamaServerAdapter({
      modelId: "dirk",
      modelPath: "/models/Dirk-Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf",
      contextTokens: 49152,
      parallel: 2,
      preferredToolArm: "arm_b_json",
    });
    expect(candidateSettings(a)).toMatchObject({
      modelId: "dirk",
      quant: "IQ3_S",
      engine: "llama.cpp",
      toolArm: "arm_b_json",
      contextTokens: 24576,
      kvType: "q8_0",
      mtp: false,
    });
    expect(quantFromName("Cyber-Tiel-Coder-35B-A3B-MTP-UD-IQ3_XXS.gguf")).toBe("UD-IQ3_XXS");
  });

  it("rejects an inadmissible record and round-trips a complete one", () => {
    const path = join(tmp(), "bakeoff.jsonl");
    const a = new ManagedLlamaServerAdapter({
      modelId: "w",
      modelPath: "/m/W-Q4_K_M.gguf",
      contextTokens: 16384,
    });
    const rec = bakeOffRecord({
      adapter: a,
      fixture: "chronicle",
      stepBudget: 50,
      passed: 5,
      total: 6,
      minutes: 17.44,
      tokens: 90000,
      now: new Date("2026-09-18T00:00:00Z"),
    });
    expect(rec.passAt1).toBe(0.833);
    expect(rec.minutes).toBe(17.4);
    expect(validateBakeOffRecord(rec)).toEqual([]);
    appendBakeOffRecord(path, rec);
    expect(readBakeOffRecords(path)).toEqual([rec]);
    const bad = { ...rec, stepBudget: 0, harnessCommit: "unknown" };
    expect(() => appendBakeOffRecord(path, bad)).toThrow(/step budget, harness commit/);
  });
});

describe("M10: mock adapter with pattern matching and exhaustion modes", () => {
  const r = (text: string): InferenceResponse => ({
    text,
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
  });

  it("keeps cycling by default (existing tests rely on it)", async () => {
    const m = new MockInferenceAdapter("m", [r("a"), r("b")]);
    const out = [];
    for (let i = 0; i < 3; i++)
      out.push((await m.generate({ prompt: "", toolArm: "arm_a_flat" })).text);
    expect(out).toEqual(["a", "b", "a"]);
  });

  it("throws when exhausted in throw mode, and answers by rule first", async () => {
    const m = new MockInferenceAdapter("m", [r("scripted")], {
      exhaustion: "throw",
      rules: [{ match: /lint/, response: r("lint rule"), times: 1 }],
    });
    expect((await m.generate({ prompt: "run lint", toolArm: "arm_a_flat" })).text).toBe(
      "lint rule",
    );
    // The rule retired after one use: the queue answers next.
    expect((await m.generate({ prompt: "run lint", toolArm: "arm_a_flat" })).text).toBe("scripted");
    await expect(m.generate({ prompt: "x", toolArm: "arm_a_flat" })).rejects.toBeInstanceOf(
      MockExhaustedError,
    );
    expect(m.remaining).toBe(0);
  });

  it("default mode answers the default response after the script", async () => {
    const m = new MockInferenceAdapter("m", [r("one")], { exhaustion: "default" });
    await m.generate({ prompt: "", toolArm: "arm_a_flat" });
    expect((await m.generate({ prompt: "", toolArm: "arm_a_flat" })).text).toBe(
      "Mock default response",
    );
    expect((await m.healthCheck()).ok).toBe(true);
  });
});
