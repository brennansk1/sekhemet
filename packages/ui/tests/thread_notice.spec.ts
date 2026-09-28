import { describe, expect, it } from "vitest";
import { threadNotice } from "../src/pm.js";

// planner-pm PM-N9-6, PM-P6-10: a notice shown in the panel while the board is
// in focus is the product's neutral text, kept apart from Seshat's voice.
describe("a product notice in Seshat's panel", () => {
  it("is shown as the product's notice, not as a reply from Seshat", () => {
    expect(threadNotice({ role: "pm", model: "notifier", text: "Review waiting: 2 issues" })).toBe(
      "Notice · Review waiting: 2 issues",
    );
  });

  it("leaves Seshat's own replies and the ledger's standup as Seshat's", () => {
    expect(threadNotice({ role: "pm", model: "qwen3.8-27b", text: "Hi" })).toBeUndefined();
    expect(threadNotice({ role: "pm", model: "ledger", text: "Standup" })).toBeUndefined();
    expect(threadNotice({ role: "user", text: "Hi" })).toBeUndefined();
  });
});
