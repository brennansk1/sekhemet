import { afterEach, describe, expect, it, vi } from "vitest";

// DS-P2-4: `sekhemet` in an empty directory asks what to build and takes the
// sentence. `openHome` passes these prompts to the first run; the terminal is
// a scripted readline here.
const answers: string[] = [];
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async () => answers.shift() ?? "",
    close: () => undefined,
  }),
}));

afterEach(() => {
  answers.length = 0;
});

describe("the first run's terminal prompts", () => {
  it("take the person's sentence raw, and read Enter or yes as yes", async () => {
    const { firstRunPrompts } = await import("../src/index.js");
    const p = firstRunPrompts();
    answers.push("  a recipe website where people save favourites ");
    expect(await p.askText("What would you like to build? ")).toBe(
      "  a recipe website where people save favourites ",
    );
    answers.push("", "yes", "n");
    expect(await p.ask("Download? ")).toBe(true);
    expect(await p.ask("Download? ")).toBe(true);
    expect(await p.ask("Download? ")).toBe(false);
  }, 60_000);
});
