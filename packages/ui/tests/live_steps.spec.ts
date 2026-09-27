import { describe, expect, it } from "vitest";
import {
  LIVE_STEP_COPY,
  LIVE_TEXT_LIMIT,
  UI_LIB_MODULES,
  liveRow,
  onStepEvent,
  onTokensFrame,
  tokensFrame,
} from "../src/index.js";

/**
 * dashboard NEW-dashboard-3 (§2.6 Steps): the server streams `event: tokens
 * { cardId, text }` — the tail of the step being decoded — and the Steps tab
 * of a running card shows it in the current step row, replaced by the step's
 * summary when its `card/step` event arrives (DB-N3-1). With the tab closed,
 * no token text is kept (DB-N3-2).
 */
const open = { cardId: "card_a", tab: "steps", running: true };

describe("DB-N3-1: the model's output, live, in the running step's row", () => {
  it("reads only a well-formed frame", () => {
    expect(tokensFrame({ cardId: "card_a", text: "let x" })).toEqual({
      cardId: "card_a",
      text: "let x",
    });
    expect(tokensFrame({ cardId: "card_a" })).toBeNull();
    expect(tokensFrame({ text: "x" })).toBeNull();
    expect(tokensFrame("nope")).toBeNull();
    expect(tokensFrame(null)).toBeNull();
  });

  it("shows each frame's text for the open, running card: the text grows as the step decodes", () => {
    const a = onTokensFrame(null, { cardId: "card_a", text: "export const" }, open);
    expect(a).toEqual({ cardId: "card_a", text: "export const" });
    const b = onTokensFrame(a, { cardId: "card_a", text: "export const answer = 42;" }, open);
    expect(b).toEqual({ cardId: "card_a", text: "export const answer = 42;" });
  });

  it("ignores another card's frames and keeps its own text", () => {
    const a = onTokensFrame(null, { cardId: "card_a", text: "mine" }, open);
    expect(onTokensFrame(a, { cardId: "card_b", text: "theirs" }, open)).toBe(a);
  });

  it("replaces the text with the step's summary when that card's `card/step` arrives", () => {
    const a = onTokensFrame(null, { cardId: "card_a", text: "write_file(...)" }, open);
    const done = onStepEvent(a, { type: "card/step", cardId: "card_a" });
    expect(done).toEqual({ cardId: "card_a", text: "", finished: "write_file(...)" });
    expect(liveRow(done, { step: 4, stepBudget: 12 }).text).toBe("");
    // Another card's step, or another event, changes nothing.
    expect(onStepEvent(a, { type: "card/step", cardId: "card_b" })).toBe(a);
    expect(onStepEvent(a, { type: "gate/result", cardId: "card_a" })).toBe(a);
  });

  it("does not bring the finished step's text back from a late frame, and starts the next step clean", () => {
    const a = onTokensFrame(null, { cardId: "card_a", text: "step one" }, open);
    const done = onStepEvent(a, { type: "card/step", cardId: "card_a" });
    // The finished generation's file, re-read: the same text.
    expect(onTokensFrame(done, { cardId: "card_a", text: "step one" }, open)).toBe(done);
    // The next generation restarts the file.
    expect(onTokensFrame(done, { cardId: "card_a", text: "step two" }, open)).toEqual({
      cardId: "card_a",
      text: "step two",
    });
  });

  it("shows the next step's first words even when they begin as the last step did", () => {
    const call = '<tool_call>{"name":"write_file","arguments":{"path":"src/a.ts"}}';
    const a = onTokensFrame(null, { cardId: "card_a", text: call }, open);
    const done = onStepEvent(a, { type: "card/step", cardId: "card_a" });
    // The file restarted: the new step's opening is a prefix of the old text.
    expect(onTokensFrame(done, { cardId: "card_a", text: '<tool_call>{"name":"' }, open)).toEqual({
      cardId: "card_a",
      text: '<tool_call>{"name":"',
    });
  });

  it("keeps at most the last LIVE_TEXT_LIMIT characters", () => {
    const long = "x".repeat(LIVE_TEXT_LIMIT + 50);
    const a = onTokensFrame(null, { cardId: "card_a", text: long }, open);
    expect(a?.text.length).toBe(LIVE_TEXT_LIMIT);
    expect(LIVE_TEXT_LIMIT).toBe(2000);
  });

  it("words the row: the step it belongs to, and a wait before the first words", () => {
    expect(liveRow(null, { step: 3, stepBudget: 12 })).toEqual({
      heading: "Step 3 of 12 · the model is writing",
      text: "",
      waiting: "Waiting for the model's first words. New steps appear here as they finish.",
      label: "The model's output for step 3, so far",
    });
    expect(
      liveRow({ cardId: "card_a", text: "const a = 1;" }, { step: 3, stepBudget: 12 }),
    ).toEqual({
      heading: "Step 3 of 12 · the model is writing",
      text: "const a = 1;",
      waiting: "",
      label: "The model's output for step 3, so far",
    });
    expect(liveRow(null, { step: 1 }).heading).toBe("Step 1 · the model is writing");
    expect(LIVE_STEP_COPY.heading(2, 5)).toBe("Step 2 of 5 · the model is writing");
  });
});

describe("DB-N3-2: nothing is kept while the Steps tab is closed", () => {
  it("keeps no text for another tab, a card that is not running, or no open card", () => {
    const a = onTokensFrame(null, { cardId: "card_a", text: "kept" }, open);
    expect(onTokensFrame(a, { cardId: "card_a", text: "more" }, { ...open, tab: "activity" })).toBe(
      null,
    );
    expect(onTokensFrame(a, { cardId: "card_a", text: "more" }, { ...open, running: false })).toBe(
      null,
    );
    expect(
      onTokensFrame(
        a,
        { cardId: "card_a", text: "more" },
        { cardId: null, tab: null, running: false },
      ),
    ).toBe(null);
  });

  it("is one of the compiled modules the page loads", () => {
    expect(UI_LIB_MODULES).toContain("live.js");
  });
});
