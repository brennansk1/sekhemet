import { describe, expect, it } from "vitest";
import { MockInferenceAdapter } from "../src/mock_adapter.js";
import {
  looksLikeToolCallAttempt,
  parseArmCTextPatches,
  parseToolCallsFromText,
} from "../src/parser.js";
import type { ToolArm } from "../src/types.js";

describe("@sekhemet/models", () => {
  it("MockInferenceAdapter returns configured responses and tracks calls", async () => {
    const mock = new MockInferenceAdapter("mock-llama-3-8b", [
      {
        text: "I will edit the file.",
        toolCalls: [
          {
            id: "call_1",
            name: "write_file",
            arguments: { path: "foo.ts", content: "console.log(1);" },
          },
        ],
        usage: { promptTokens: 120, completionTokens: 35, durationMs: 45 },
      },
    ]);

    expect(mock.modelId).toBe("mock-llama-3-8b");
    const res = await mock.generate({
      prompt: "Add a log statement to foo.ts",
      toolArm: "arm_a_flat",
    });

    expect(res.text).toBe("I will edit the file.");
    expect(res.toolCalls.length).toBe(1);
    expect(res.toolCalls[0]?.name).toBe("write_file");
    expect(res.usage.promptTokens).toBe(120);
    expect(mock.callHistory.length).toBe(1);
  });

  it("parses JSON tool calls from markdown code blocks in raw model output", () => {
    const rawOutput = `
Here is the tool call:
\`\`\`json
{
  "name": "replace_lines",
  "arguments": {
    "file": "test.ts",
    "start": 10,
    "end": 15,
    "replacement": "return true;"
  }
}
\`\`\`
`;
    const calls = parseToolCallsFromText(rawOutput, "arm_a_flat");
    expect(calls.length).toBe(1);
    expect(calls[0]?.name).toBe("replace_lines");
    expect(calls[0]?.arguments.file).toBe("test.ts");
    expect(calls[0]?.arguments.start).toBe(10);
  });

  it("parses multiple tool calls from json array block", () => {
    const rawOutput = `
\`\`\`json
[
  { "name": "read_file", "arguments": { "path": "a.ts" } },
  { "name": "read_file", "arguments": { "path": "b.ts" } }
]
\`\`\`
`;
    const calls = parseToolCallsFromText(rawOutput, "arm_b_json");
    expect(calls.length).toBe(2);
    expect(calls[0]?.name).toBe("read_file");
    expect(calls[1]?.arguments.path).toBe("b.ts");
  });

  it("parses Arm C search/replace text delimiter patches", () => {
    const patchText = `
I will update the function:
<<<<<<< SEARCH
function add(a: number, b: number): number {
  return a - b;
}
=======
function add(a: number, b: number): number {
  return a + b;
}
>>>>>>>
`;
    const patches = parseArmCTextPatches(patchText);
    expect(patches.length).toBe(1);
    expect(patches[0]?.search.trim()).toBe(
      "function add(a: number, b: number): number {\n  return a - b;\n}",
    );
    expect(patches[0]?.replace.trim()).toBe(
      "function add(a: number, b: number): number {\n  return a + b;\n}",
    );
  });
});

describe("looksLikeToolCallAttempt (worker-loop WL-M2-5)", () => {
  const known = ["read_file", "edit", "finish_card"];
  it("is true for a call the parser could not read", () => {
    expect(looksLikeToolCallAttempt('read_file(path="a.ts"', known)).toBe(true);
    expect(looksLikeToolCallAttempt('```json\n{"name": "edit", "arguments": {\n```', known)).toBe(
      true,
    );
    expect(looksLikeToolCallAttempt('<tool_call>{"name": "read_file"', known)).toBe(true);
    expect(looksLikeToolCallAttempt("<<<<<<< SEARCH\nold\n=======", known)).toBe(true);
    expect(looksLikeToolCallAttempt("finish_card()", known)).toBe(true);
    expect(looksLikeToolCallAttempt("edit({path: 'a.ts'", known)).toBe(true);
    // Cyber-Tiel's native Qwen3-Coder XML, with and without the wrapper.
    expect(
      looksLikeToolCallAttempt(
        "<tool_call>\n<function=read_file>\n<parameter=path>\nsrc/a.ts\n</parameter>\n",
        known,
      ),
    ).toBe(true);
    expect(
      looksLikeToolCallAttempt("<function=read_file>\n<parameter=path>\nsrc/a.ts", known),
    ).toBe(true);
  });
  it("is false for prose, an empty reply, or a call inside reasoning only", () => {
    expect(looksLikeToolCallAttempt("I think I should read the file first.", known)).toBe(false);
    expect(looksLikeToolCallAttempt("", known)).toBe(false);
    expect(looksLikeToolCallAttempt('<think>read_file(path="a")</think>Done.', known)).toBe(false);
    // A tool's name in prose is not a call.
    expect(looksLikeToolCallAttempt("I will use read_file next.", known)).toBe(false);
    const more = [...known, "check", "note"];
    expect(looksLikeToolCallAttempt("Let me check (again) before editing.", more)).toBe(false);
    expect(looksLikeToolCallAttempt("I'll add a note (for later).", more)).toBe(false);
    // Code in a fence is code, not a call.
    expect(
      looksLikeToolCallAttempt("Here is the fix:\n```ts\nexport function check(x) {}\n```", more),
    ).toBe(false);
    // JSX is not a tool-call tag.
    expect(looksLikeToolCallAttempt("It renders <Tool /> and <Function name='x' />.", more)).toBe(
      false,
    );
  });
});
