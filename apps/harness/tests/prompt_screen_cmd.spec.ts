import type { InferenceRequest, LocalInferenceAdapter } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { runPromptScreen } from "../src/prompt_screen_cmd.js";

/**
 * PROMPT_STANDARD rule 35.3: `sekhemet prompt-screen` runs the step-replay
 * screen on the Worker's canonical states (and recorded packs, with --from)
 * and reports; it never admits a change.
 */
const model = (answer: (req: InferenceRequest) => { name: string; args: object }) =>
  ({
    modelId: "fake-worker",
    async generate(req: InferenceRequest) {
      const c = answer(req);
      return {
        text: "",
        toolCalls: [{ id: "1", name: c.name, arguments: c.args }],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      };
    },
  }) as unknown as LocalInferenceAdapter;

describe("sekhemet prompt-screen", () => {
  it("reports each canonical state and never admits", async () => {
    const lines: string[] = [];
    const report = await runPromptScreen({
      model: model((req) =>
        /ready to verify|has been written/i.test(req.prompt)
          ? { name: "finish_card", args: { summary: "done" } }
          : { name: "read_file", args: { path: "src/ledger.ts" } },
      ),
      repos: [],
      say: (l) => lines.push(l),
    });
    expect(report.admits).toBe(false);
    expect(Object.keys(report.byState).sort()).toEqual([
      "failing_typecheck",
      "first_step",
      "ready_to_verify",
    ]);
    expect(lines.join("\n")).toMatch(/screens only; it never admits/);
  });

  it("fails a state when the model calls a tool it was not offered", async () => {
    const report = await runPromptScreen({
      model: model(() => ({ name: "delete_everything", args: {} })),
      repos: [],
      say: () => {},
    });
    expect(report.passed).toBe(false);
    expect(report.byCheck.offeredOnly.fail).toBeGreaterThan(0);
  });
});
