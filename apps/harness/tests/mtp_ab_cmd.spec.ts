import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BlobStore, CardStore, EventLog, initSchema, serializeContextPack } from "@sekhemet/kernel";
import type { ToolDefinition } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { recordedStepRequests } from "../src/calibrate_cmd.js";

/**
 * MD-M11-1: the A/B replays the Worker's recorded steps exactly as they were
 * sent (kernel rule 17; B2.2 review A3, A4, A5).
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const MODEL = "cyber-tiel-coder-35b-a3b-mtp-iq3xxs";

/** A definition as a session sends it: note with the attempt's gate enum. */
const note: ToolDefinition = {
  name: "note",
  description: "Record a short note for the human reviewer.",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "Note text" },
      gate: { type: "string", description: "A gate you believe is wrong.", enum: ["lint", "test"] },
    },
    required: ["message"],
  },
};

interface Step {
  prompt: string;
  modelId?: string;
  /** Omitted: a pack recorded before packs held the whole request. */
  whole?: boolean;
  thinking?: string;
  toolArm?: string;
}

async function ledgerWithSteps(steps: Step[], attemptArm: "A" | "B" = "A"): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "sek-ab-repo-"));
  dirs.push(repo);
  mkdirSync(join(repo, ".sekhemet"));
  const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  const store = new CardStore(db, new EventLog(db));
  const card = await store.createCard({
    id: "card_ab",
    title: "A",
    tier: "story",
    status: "ready",
  });
  const attempt = await store.runs.startAttempt({
    cardId: card.id,
    attemptNumber: 1,
    modelId: MODEL,
    toolArm: attemptArm,
  });
  const blobs = new BlobStore(repo);
  const schemas = blobs.put(JSON.stringify([note]));
  for (const [i, s] of steps.entries()) {
    const whole = s.whole !== false;
    const packId = blobs.put(
      serializeContextPack({
        cardId: card.id,
        attemptId: attempt.id,
        step: i,
        modelId: s.modelId ?? MODEL,
        systemPrompt: "system",
        prompt: s.prompt,
        tools: ["note"],
        reasoning: "off",
        ...(whole
          ? {
              toolSchemas: schemas,
              thinking: s.thinking ?? "off",
              ...(s.toolArm ? { toolArm: s.toolArm } : {}),
              reasoningBudgetTokens: 0,
              maxTokens: 2048,
              temperature: 0.6,
            }
          : {}),
      }),
    );
    await store.runs.recordStep({
      attemptId: attempt.id,
      cardId: card.id,
      stepIndex: i,
      calls: [],
      contextPackId: packId,
      promptTokens: 100,
      completionTokens: 10,
      durationMs: 1000,
    });
  }
  db.close();
  return repo;
}

describe("recordedStepRequests", () => {
  it("A5: rebuilds each step's request exactly as sent: stored definitions, caps and sampling", async () => {
    const repo = await ledgerWithSteps([{ prompt: "first" }, { prompt: "second" }]);
    const r = recordedStepRequests([repo], { modelId: MODEL });
    expect(r.requests.map((q) => q.prompt)).toEqual(["first", "second"]);
    expect(r.requests[0]).toMatchObject({
      systemPrompt: "system",
      toolArm: "arm_a_flat",
      reasoning: "off",
      reasoningBudgetTokens: 0,
      maxTokens: 2048,
      temperature: 0.6,
    });
    // The definition the session sent, gate enum included, not the base catalog's.
    expect(r.requests[0]?.tools).toEqual([note]);
    expect(r.thinking).toBe("off");
    expect(r.skipped).toEqual({});
  });

  it("A5: skips and counts steps recorded before packs held the whole request, and other models' steps", async () => {
    const repo = await ledgerWithSteps([
      { prompt: "a" },
      { prompt: "legacy", whole: false },
      { prompt: "other model", modelId: "someone-else" },
      { prompt: "b" },
      { prompt: "c" },
    ]);
    const r = recordedStepRequests([repo], { modelId: MODEL, maxSteps: 2 });
    expect(r.requests.map((q) => q.prompt)).toEqual(["a", "b"]);
    expect(r.skipped).toEqual({ "no exact request recorded (an older pack)": 1 });
  });

  it("A3: replays a B-arm attempt in arm B", async () => {
    const fromPack = await ledgerWithSteps([{ prompt: "b", toolArm: "arm_b_json" }]);
    expect(recordedStepRequests([fromPack], { modelId: MODEL }).requests[0]?.toolArm).toBe(
      "arm_b_json",
    );
    // A pack without the arm falls back to the attempt row's letter.
    const fromRow = await ledgerWithSteps([{ prompt: "b" }], "B");
    expect(recordedStepRequests([fromRow], { modelId: MODEL }).requests[0]?.toolArm).toBe(
      "arm_b_json",
    );
  });

  it("A4: files the steps under the policy they ran under; a mix needs a choice", async () => {
    const one = await ledgerWithSteps([{ prompt: "a", thinking: "surgical" }]);
    expect(recordedStepRequests([one], { modelId: MODEL }).thinking).toBe("surgical");
    const mixed = await ledgerWithSteps([
      { prompt: "a", thinking: "off" },
      { prompt: "b", thinking: "surgical" },
      { prompt: "c", thinking: "surgical" },
    ]);
    expect(() => recordedStepRequests([mixed], { modelId: MODEL })).toThrow(
      /more than one thinking policy \(off 1, surgical 2\).*--thinking/,
    );
    const chosen = recordedStepRequests([mixed], { modelId: MODEL, thinking: "surgical" });
    expect(chosen.requests.map((q) => q.prompt)).toEqual(["b", "c"]);
    expect(chosen.thinking).toBe("surgical");
    expect(chosen.skipped).toEqual({ "ran under thinking off": 1 });
  });
});
