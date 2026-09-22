import { describe, expect, it } from "vitest";
import { FRONT_DOOR, routeFrontDoor } from "../src/front_door.js";

describe("the front door", () => {
  it("lists eight commands, and nothing else, in user-facing help", () => {
    expect(FRONT_DOOR.map((c) => c.usage.split(" ")[1] ?? "")).toEqual([
      "",
      '"<spec>"',
      "run",
      "review",
      "accept",
      "board",
      "doctor",
      "dev",
    ]);
  });

  it("treats no command as the product: set up if needed, then the board", () => {
    expect(routeFrontDoor([])).toEqual({ kind: "home", flags: [] });
    expect(routeFrontDoor(["--repo", "/r"])).toEqual({ kind: "home", flags: ["--repo", "/r"] });
  });

  it("plans and runs a spec in one verb", () => {
    expect(routeFrontDoor(["add rate limiting to the API", "--repo", "/r"])).toEqual({
      kind: "spec",
      spec: "add rate limiting to the API",
      flags: ["--repo", "/r"],
    });
  });

  it("refuses a mistyped command rather than planning it as work", () => {
    // A one-word "spec" is almost always a typo, and planning a typo writes
    // cards to the board.
    expect(routeFrontDoor(["reveiw"])).toEqual({
      kind: "unknown",
      word: "reveiw",
      suggest: "review",
    });
  });

  it("runs the queue when run names no card, and a card when it does", () => {
    expect(routeFrontDoor(["run", "--worker", "w"])).toEqual({
      kind: "argv",
      argv: ["queue", "--worker", "w"],
    });
    expect(routeFrontDoor(["run", "card_a"])).toEqual({ kind: "argv", argv: ["run", "card_a"] });
  });

  it("gives the board's triage actions to the command line, with their undo", () => {
    expect(routeFrontDoor(["send-back", "card_a", "use the shared parser"])).toEqual({
      kind: "send-back",
      cardId: "card_a",
      reason: "use the shared parser",
      flags: [],
    });
    expect(routeFrontDoor(["park", "card_a"])).toMatchObject({ kind: "park", cardId: "card_a" });
    expect(routeFrontDoor(["unpark", "card_a"])).toMatchObject({
      kind: "unpark",
      cardId: "card_a",
    });
    expect(routeFrontDoor(["review"])).toEqual({ kind: "review", flags: [] });
  });

  it("puts everything else behind dev, and still answers it called directly", () => {
    expect(routeFrontDoor(["dev", "replay", "card_a"])).toEqual({
      kind: "argv",
      argv: ["replay", "card_a"],
    });
    expect(routeFrontDoor(["dev"])).toEqual({ kind: "dev-help" });
    expect(routeFrontDoor(["dev", "--help"])).toEqual({ kind: "dev-help" });
    // Scripts and muscle memory keep working; the command is just not listed.
    expect(routeFrontDoor(["replay", "card_a"])).toEqual({
      kind: "argv",
      argv: ["replay", "card_a"],
    });
  });

  it("shows the front door for help", () => {
    expect(routeFrontDoor(["--help"])).toEqual({ kind: "help" });
    expect(routeFrontDoor(["help"])).toEqual({ kind: "help" });
  });
});
