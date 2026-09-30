import { describe, expect, it } from "vitest";
import { modelUseView } from "../src/pm.js";

// Insights' model use (measurement rule 4a, dashboard §2.10 item 7): every
// role's tokens over the period, in DEC-31's words for the models.

const row = (role: string, requests: number, promptTokens: number, completionTokens: number) => ({
  role,
  requests,
  promptTokens,
  cachedPromptTokens: Math.round(promptTokens / 2),
  completionTokens,
  thinkingTokens: Math.round(completionTokens / 4),
  answerTokens: completionTokens - Math.round(completionTokens / 4),
  purposes: {},
});

describe("modelUseView", () => {
  it("names every model in the product's words, with its tokens and share", () => {
    const rows = [
      row("worker", 40, 120_000, 9_000),
      row("seshat", 6, 48_000, 2_400),
      row("planner", 2, 20_000, 3_000),
      row("reviewer", 3, 9_000, 600),
      row("researcher", 1, 3_000, 0),
    ];
    const v = modelUseView(
      {
        rows,
        total: {
          requests: 52,
          promptTokens: 200_000,
          cachedPromptTokens: 100_000,
          completionTokens: 15_000,
          thinkingTokens: 3_750,
          answerTokens: 11_250,
        },
      },
      30,
    );
    expect(v.lines.map((l) => l.label)).toEqual([
      "Coding model",
      "Seshat",
      "Planning model",
      "Review model",
      "Research model",
    ]);
    expect(v.lines[1]).toEqual({
      role: "seshat",
      label: "Seshat",
      requests: "6 requests",
      tokensIn: "48k",
      reused: "24k",
      tokensOut: "2.4k",
      thinking: "600",
      share: "23%",
    });
    expect(v.lines[4]?.requests).toBe("1 request");
    expect(v.caption).toBe(
      "Every model's tokens in the last 30 days: 200k in, of which 100k were reused from the cache, and 15k out, over 52 requests. The Coding model's are its steps on issues; the others' are Seshat's answers and the other models' work.",
    );
    expect(v.empty).toBeUndefined();
  });

  it("says when no model ran, and when the server does not count them", () => {
    const none = modelUseView(
      {
        rows: [],
        total: {
          requests: 0,
          promptTokens: 0,
          cachedPromptTokens: 0,
          completionTokens: 0,
          thinkingTokens: 0,
          answerTokens: 0,
        },
      },
      7,
    );
    expect(none).toEqual({ lines: [], caption: "", empty: "No model ran in the last 7 days." });
    expect(modelUseView(undefined, 7).empty).toBe(
      "This server doesn't count the models' tokens yet. Update Sekhemet and restart it.",
    );
  });
});
