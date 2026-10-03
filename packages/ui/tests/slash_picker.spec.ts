import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS, composerPlaceholder, slashMatches } from "../src/seshat.js";

// FINDINGS PM-08 and PM-09 (C2b): the composer's promise "/ for commands"
// is kept — typing / lists Seshat's commands, as the server answers them —
// and its placeholder fits the composer it sits in.

describe("PM-08: typing / lists Seshat's commands", () => {
  it("lists every command with what it does, in the order /help gives them", () => {
    expect(SLASH_COMMANDS[0]).toEqual({ cmd: "/help", does: "This list." });
    expect(SLASH_COMMANDS.map((c) => c.cmd)).toContain("/status");
    expect(SLASH_COMMANDS.map((c) => c.cmd)).toContain("/plan <feature>");
    for (const c of SLASH_COMMANDS) expect(c.does, c.cmd).toMatch(/\.$/);
  });

  it("matches what was typed after the slash, and nothing once a space follows the command", () => {
    expect(slashMatches("/").length).toBe(SLASH_COMMANDS.length);
    expect(slashMatches("/fo").map((c) => c.name)).toEqual(["forecast"]);
    expect(slashMatches("/st").map((c) => c.name)).toEqual(["status"]);
    expect(slashMatches("/plan the export")).toEqual([]);
    expect(slashMatches("ask /status")).toEqual([]);
    // What the picker inserts: the command, and a space when it takes words.
    expect(slashMatches("/pl")[0]).toMatchObject({ name: "plan", insert: "/plan " });
    expect(slashMatches("/sta")[0]).toMatchObject({ name: "status", insert: "/status" });
  });
});

describe("PM-09: the placeholder fits the composer", () => {
  it("is the full sentence in a wide composer and a short one in a narrow one", () => {
    expect(composerPlaceholder(560)).toBe(
      "Ask Seshat about the board, an issue or a run… (/ for commands)",
    );
    expect(composerPlaceholder(320)).toBe("Ask Seshat… (/ for commands)");
  });
});
