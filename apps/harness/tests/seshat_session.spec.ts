import type { InferenceRequest, LocalInferenceAdapter } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { type PmSnapshot, answer, seshatThreadId } from "../src/pm/agent.js";
import type { PmMessage } from "../src/pm/types.js";

// models rule 20i, MD-N14-36: Seshat's requests name the repository's thread
// as their live session, so the thread's slot is saved when the Planner's
// weights leave and restored on return.
const snapshot: PmSnapshot = {
  project: "demo",
  cards: [],
  cycles: [],
  recentRuns: [],
  worker: { model: "cyber-tiel", record: "" },
  pmModel: "planner-model",
  preferences: [],
  pmRules: [],
  today: "2026-09-26",
};
const msg: PmMessage = {
  id: "m1",
  seq: 1,
  role: "user",
  text: "Where do the cards stop?",
  createdAt: "2026-09-26T00:00:00Z",
  state: "queued",
};

describe("Seshat's thread is a live session", () => {
  it("names the thread on the request, one id per repository", async () => {
    const seen: InferenceRequest[] = [];
    const model: LocalInferenceAdapter = {
      modelId: "planner-model",
      supportedArms: ["arm_a_flat"],
      contextWindow: { contextTokens: 16384, maxTokens: 1200 },
      generate: async (req) => {
        seen.push(req);
        return {
          text: "ok",
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        };
      },
    };
    const thread = seshatThreadId("/repos/demo");
    await answer(model, snapshot, [], [msg], undefined, undefined, undefined, thread);
    expect(seen[0]?.session).toEqual({ owner: thread, kind: "thread" });
    expect(thread).toMatch(/^seshat-[0-9a-f]{12}$/);
    expect(seshatThreadId("/repos/demo")).toBe(thread);
    expect(seshatThreadId("/repos/other")).not.toBe(thread);
  });
});
