import { describe, expect, it } from "vitest";
import { seshatModelState } from "../src/seshat.js";

/**
 * Wave 2 A6 (dashboard §2.5 item 1, DB-N6-14; models.md's role gate): the
 * rail's *Model* row says the Planning model's real state, as Configuration
 * › Models and Machine say it — never *Ready* because the thread route
 * answered. It names no model (Configuration does).
 */
describe("A6: Seshat's Model row follows the Planning model's state", () => {
  it("not verified and swapped out: says both, never Ready", () => {
    expect(
      seshatModelState({ model: "nail-mtp", state: "swapped_out", qualified: false }, true),
    ).toBe("Swapped out · not verified on this machine yet");
  });

  it("verified: the roster's state word", () => {
    expect(seshatModelState({ model: "m", state: "resident", qualified: true }, true)).toBe(
      "Resident",
    );
    expect(seshatModelState({ model: "m", state: "swapped_out", qualified: true }, true)).toBe(
      "Swapped out",
    );
  });

  it("no Planning model, no Seshat route, or not read yet", () => {
    expect(seshatModelState({ state: "not_configured", qualified: false }, true)).toBe(
      "Not configured",
    );
    expect(seshatModelState(undefined, false)).toBe("Not set up");
    expect(seshatModelState(undefined, true)).toBe("Checking…");
  });
});
