import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { RUN_PROFILE_FLAGS } from "@sekhemet/eval";
import { describe, expect, it } from "vitest";
import { KNOWN_FLAGS, PRIMARY_COMMANDS, routeFrontDoor, unknownFlag } from "../src/cli_commands.js";

describe("the front door", () => {
  it("lists eight commands, and nothing else, in user-facing help", () => {
    expect(PRIMARY_COMMANDS.map((c) => c.usage.split(" ")[1] ?? "")).toEqual([
      "",
      '"<spec>"',
      "run",
      "review",
      "accept",
      "ask",
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

  it("names Request changes as GitHub does, with send-back kept as its alias (DEC-52)", () => {
    expect(routeFrontDoor(["request-changes", "card_a", "use the shared parser"])).toEqual({
      kind: "send-back",
      cardId: "card_a",
      reason: "use the shared parser",
      flags: [],
    });
    expect(routeFrontDoor(["request-changes"])).toEqual({
      kind: "unknown",
      word: "request-changes needs an issue ID",
    });
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

describe("S10, SUR-15: the list of known flags cannot fall behind the source", () => {
  /** Flags the harness passes to other programs (git, gh, rg, docker, secret-tool), not its own. */
  const TOOL_FLAGS = new Set(
    "--porcelain --no-ext-diff --no-textconv --name-only --oneline --max-count --line-number --no-heading --unified --cached --short --hard --detach --grep --jq --no-verify --body --head --title --state --format --hostname --others --exclude-standard --no-merges --count --all --no-merged --ignore-scripts --no-audit --no-fund --recursive --offline-vulnerabilities --reporter --diff-filter --label --list --sort --is-ancestor --tags --abbrev --app-name --write-tree --first-parent --parents --what --who --why --mode --pid --is-inside-work-tree --git-common-dir --show-toplevel".split(
      " ",
    ),
  );
  it("knows every flag the command line's source reads", () => {
    const src = resolve(import.meta.dirname, "../src");
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) =>
      f.endsWith(".ts"),
    );
    const missing = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(join(src, f), "utf8").matchAll(/["'`](--[a-z][a-z0-9-]*)/g)) {
        const flag = m[1] as string;
        if (!KNOWN_FLAGS.has(flag) && !TOOL_FLAGS.has(flag)) missing.add(`${flag} (${f})`);
      }
    }
    for (const flag of Object.keys(RUN_PROFILE_FLAGS)) {
      if (!KNOWN_FLAGS.has(flag)) missing.add(`${flag} (RUN_PROFILE_FLAGS)`);
    }
    expect([...missing]).toEqual([]);
  });

  it("names the first unknown flag, judging --name=value by its name and skipping values", () => {
    expect(unknownFlag(["doctor", "--repo", "/r"])).toBeUndefined();
    expect(unknownFlag(["doctor", "--bogus"])).toBe("--bogus");
    expect(unknownFlag(["--set=review.x=1", "--terminl=1"])).toBe("--terminl");
    expect(unknownFlag(["run", "c1", "--", "--anything"])).toBeUndefined();
    expect(routeFrontDoor(["doctor", "--bogus"])).toEqual({
      kind: "unknown-flag",
      flag: "--bogus",
    });
    expect(routeFrontDoor(["-v"])).toEqual({ kind: "version" });
  });
});
