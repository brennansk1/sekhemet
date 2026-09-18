import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpInferenceAdapter } from "../src/http_adapter.js";
import {
  APODEX_SYSTEM_PROMPT,
  apodexContextTokens,
  createApodexResearcher,
} from "../src/llama_server.js";
import type { ChatTurn, ToolDefinition } from "../src/types.js";

const GB = 1024 ** 3;
const bodies: unknown[] = [];

function stubFetch(reply: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(init?.body ? JSON.parse(init.body) : undefined);
      return new Response(JSON.stringify(reply), { status: 200 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  bodies.length = 0;
});

const search: ToolDefinition = {
  name: "web_search",
  description: "Search the web.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

const conversation: ChatTurn[] = [
  { role: "user", content: "Which node:sqlite method returns all rows?" },
  {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "call_a", name: "web_search", arguments: { query: "node:sqlite StatementSync all" } },
      { id: "call_b", name: "web_search", arguments: { query: "DatabaseSync prepare" } },
    ],
  },
  { role: "tool", toolCallId: "call_a", content: "StatementSync.all() returns an array of rows." },
  { role: "tool", toolCallId: "call_b", content: "db.prepare(sql) returns a StatementSync." },
];

describe("native multi-turn messages", () => {
  it("OpenAI/llama-server: sends assistant tool_calls and tool turns as-is after the system prompt", async () => {
    stubFetch({ choices: [{ message: { content: "Use stmt.all()." } }] });
    const adapter = new HttpInferenceAdapter({
      modelId: "apodex-1.1-mini",
      baseUrl: "http://127.0.0.1:8101",
      apiFormat: "openai",
      maxRetries: 0,
    });
    const res = await adapter.generate({
      systemPrompt: "SYS",
      prompt: "ignored when messages are set",
      messages: conversation,
      tools: [search],
      toolArm: "arm_b_json",
    });
    expect(res.text).toBe("Use stmt.all().");
    const body = bodies[0] as Record<string, unknown>;
    expect(body.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "Which node:sqlite method returns all rows?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_a",
            type: "function",
            function: {
              name: "web_search",
              arguments: '{"query":"node:sqlite StatementSync all"}',
            },
          },
          {
            id: "call_b",
            type: "function",
            function: { name: "web_search", arguments: '{"query":"DatabaseSync prepare"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_a",
        content: "StatementSync.all() returns an array of rows.",
      },
      { role: "tool", tool_call_id: "call_b", content: "db.prepare(sql) returns a StatementSync." },
    ]);
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Search the web.",
          parameters: search.parameters,
        },
      },
    ]);
  });

  it("without messages the request is unchanged, and parallel_tool_calls needs tools", async () => {
    stubFetch({ choices: [{ message: { content: "ok" } }] });
    const adapter = new HttpInferenceAdapter({ modelId: "m", apiFormat: "openai", maxRetries: 0 });
    await adapter.generate({ systemPrompt: "S", prompt: "P", toolArm: "arm_a_flat" });
    const body = bodies[0] as Record<string, unknown>;
    expect(body.messages).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "P" },
    ]);
    expect(body.parallel_tool_calls).toBeUndefined();
  });

  it("Ollama: tool turns keep role tool, named by the call they answer; arguments stay objects", async () => {
    stubFetch({ message: { content: "done" }, prompt_eval_count: 1, eval_count: 1 });
    const adapter = new HttpInferenceAdapter({
      modelId: "r",
      apiFormat: "ollama",
      maxRetries: 0,
      memoryAware: false,
    });
    await adapter.generate({ prompt: "", messages: conversation, toolArm: "arm_b_json" });
    const chat = bodies.find((b) => (b as { messages?: unknown } | undefined)?.messages) as {
      messages: unknown[];
    };
    expect(chat.messages).toEqual([
      { role: "user", content: "Which node:sqlite method returns all rows?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            function: { name: "web_search", arguments: { query: "node:sqlite StatementSync all" } },
          },
          { function: { name: "web_search", arguments: { query: "DatabaseSync prepare" } } },
        ],
      },
      {
        role: "tool",
        tool_name: "web_search",
        content: "StatementSync.all() returns an array of rows.",
      },
      {
        role: "tool",
        tool_name: "web_search",
        content: "db.prepare(sql) returns a StatementSync.",
      },
    ]);
  });
});

describe("Apodex researcher profile", () => {
  it("uses the vendor sampling, native tools, and a context sized to the host", async () => {
    expect(apodexContextTokens(24 * GB)).toBe(16384);
    expect(apodexContextTokens(32 * GB)).toBe(32768);
    const small = createApodexResearcher("/a.gguf", undefined, 24 * GB);
    const large = createApodexResearcher("/a.gguf", undefined, 128 * GB);
    expect(small.contextWindow).toEqual({ contextTokens: 16384, maxTokens: 1500 });
    expect(large.contextWindow).toEqual({ contextTokens: 32768, maxTokens: 1500 });
    expect(large.launchArgs()[large.launchArgs().indexOf("-c") + 1]).toBe("32768");
    expect(small.nativeTools).toBe(true);
    expect(small.samplingFor({})).toEqual({ temperature: 1.0, topP: 0.95, topK: 20, minP: 0 });
  });

  it("APODEX_SYSTEM_PROMPT is the vendor text with the time filled in", () => {
    const text = APODEX_SYSTEM_PROMPT("2026-09-18");
    expect(text).toBe(
      "You are Apodex, an AI assistant developed by Apodex AI.\n\nApodex is the flagship agent of Apodex AI. Rather than a conventional conversational LLM, it is a general-purpose solver designed for mission-critical tasks.\n\nCurrent time: 2026-09-18. In this environment you have access to a set of tools you can use to answer the user's question.\n\nYou only have access to the tools provided. You can use multiple tools per message, and will receive the results of those tools in the user's next response. You use tools step-by-step to accomplish a given task.\n\n# General Objective\n\nYou accomplish a given task iteratively, breaking it down into clear steps and working through them methodically.",
    );
  });
});
