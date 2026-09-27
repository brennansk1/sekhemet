import { afterEach, describe, expect, it } from "vitest";
import {
  type CacheStepKind,
  type CacheStepRecord,
  type ChatTurn,
  HttpInferenceAdapter,
  ModelTelemetry,
  type TokenUsage,
} from "../src/index.js";
import { fakeServer } from "./support/fake_server.js";

/**
 * Live-test F5 (M18, context rule 7): the `[cache]` alerts of a live
 * qualification run (~43-46% against the 85% floor) came from the suite's
 * canned tool-result cases. Each is its own conversation, preceded by a
 * different case, so the server can reuse only the system prompt and tools
 * they share; it is not "the previous step's prompt plus one observation".
 * A tool-result step is a request that extends the adapter's previous
 * request with new turns ending in a tool result; only those are held to
 * the floor, which stays at 85%.
 */
/** The telemetry, keeping each step's kind. */
class KindsTelemetry extends ModelTelemetry {
  public kinds: CacheStepKind[] = [];
  public override record(
    modelId: string,
    kind: CacheStepKind,
    usage: TokenUsage,
    onAlert?: (record: CacheStepRecord) => void,
  ): CacheStepRecord | undefined {
    this.kinds.push(kind);
    return super.record(modelId, kind, usage, onAlert);
  }
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

async function adapterAt45Percent() {
  const srv = await fakeServer(() => ({
    json: {
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 2000, completion_tokens: 5 },
      timings: { cache_n: 900, prompt_n: 1100, prompt_ms: 100, predicted_n: 5, predicted_ms: 50 },
    },
  }));
  closers.push(srv.close);
  const alerts: CacheStepRecord[] = [];
  const telemetry = new KindsTelemetry();
  const adapter = new HttpInferenceAdapter({
    modelId: "m",
    baseUrl: srv.url,
    apiFormat: "openai",
    maxRetries: 0,
    telemetry,
    onCacheAlert: (r) => alerts.push(r),
  });
  const kinds = () => telemetry.kinds;
  return { adapter, alerts, kinds };
}

const call = (id: string, path: string) => ({
  role: "assistant" as const,
  content: "",
  toolCalls: [{ id, name: "read_file", arguments: { path } }],
});
const result = (id: string, text: string): ChatTurn => ({
  role: "tool",
  toolCallId: id,
  content: text,
});

describe("F5: a tool-result step is one that extends the previous request (M18)", () => {
  it("does not hold independent canned conversations to the floor (a qualification suite)", async () => {
    const { adapter, alerts, kinds } = await adapterAt45Percent();
    const system = "You call tools.";
    const caseA: ChatTurn[] = [
      { role: "user", content: "Read src/server.ts." },
      call("c1", "src/sever.ts"),
      result("c1", "Error: ENOENT"),
    ];
    const caseB: ChatTurn[] = [
      { role: "user", content: "Make the lint gate pass." },
      call("c1", "src/a.ts"),
      result("c1", "lint: 2 problems"),
    ];
    for (const messages of [caseA, caseA, caseB]) {
      await adapter.generate({ systemPrompt: system, prompt: "", messages, toolArm: "arm_a_flat" });
    }
    expect(kinds()).toEqual(["first", "other", "other"]);
    expect(alerts).toEqual([]);
  });

  it("still alerts under 85% on a real continuation: the previous request plus a call and its result", async () => {
    const { adapter, alerts, kinds } = await adapterAt45Percent();
    const system = "You call tools.";
    const first: ChatTurn[] = [{ role: "user", content: "Fix the ledger." }];
    const second: ChatTurn[] = [...first, call("c1", "src/ledger.ts"), result("c1", "code")];
    const third: ChatTurn[] = [...second, call("c2", "src/b.ts"), result("c2", "more code")];
    for (const messages of [first, second, third]) {
      await adapter.generate({ systemPrompt: system, prompt: "", messages, toolArm: "arm_a_flat" });
    }
    expect(kinds()).toEqual(["first", "tool_result", "tool_result"]);
    expect(alerts.map((a) => a.cacheHitRate)).toEqual([0.45, 0.45]);
  });

  it("holds a continuation whose system prompt changed to the floor: that is the defect it catches", async () => {
    const { adapter, alerts, kinds } = await adapterAt45Percent();
    const first: ChatTurn[] = [{ role: "user", content: "Fix the ledger." }];
    const second: ChatTurn[] = [...first, call("c1", "src/ledger.ts"), result("c1", "code")];
    await adapter.generate({
      systemPrompt: "A",
      prompt: "",
      messages: first,
      toolArm: "arm_a_flat",
    });
    await adapter.generate({
      systemPrompt: "B",
      prompt: "",
      messages: second,
      toolArm: "arm_a_flat",
    });
    expect(kinds()).toEqual(["first", "tool_result"]);
    expect(alerts).toHaveLength(1);
  });
});
