import { describe, expect, it } from "vitest";
import { MockInferenceAdapter } from "../src/mock_adapter.js";
import { parseArmCTextPatches, parseToolCallsFromText } from "../src/parser.js";
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
