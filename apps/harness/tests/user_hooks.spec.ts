import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hookEngineFor, loadUserHooks } from "../src/user_hooks.js";

function project(toml: string): string {
  const repo = mkdtempSync(join(tmpdir(), "hooks-"));
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  writeFileSync(join(repo, ".sekhemet", "hooks.toml"), toml);
  return repo;
}

describe("user hooks from .sekhemet/hooks.toml (K12)", () => {
  it("loads hooks and reports bad entries", () => {
    const repo = project(
      '[[hook]]\nevent = "post-tool"\ntool = "write_file"\ncommand = "true"\n\n[[hook]]\nevent = "nope"\ncommand = "x"\n\n[[hook]]\nevent = "pre-gate"\n',
    );
    const { hooks, errors } = loadUserHooks(repo);
    expect(hooks).toEqual([
      { event: "post-tool", tool: "write_file", command: "true", timeoutMs: 30_000 },
    ]);
    expect(errors).toEqual(['hook 2: unknown event "nope"', "hook 3: missing command"]);
    expect(loadUserHooks(mkdtempSync(join(tmpdir(), "nohooks-")))).toEqual({
      hooks: [],
      errors: [],
    });
  });

  it("exit 2 blocks with stderr as the reason; stdout JSON injects a message; env and stdin carry the context", async () => {
    const repo = project(
      [
        "[[hook]]",
        'event = "pre-tool"',
        'tool = "run_cmd"',
        `command = "grep -q rm && { echo 'no rm in this repo' >&2; exit 2; } || exit 0"`,
        "",
        "[[hook]]",
        'event = "post-tool"',
        `command = "echo '{\\"message\\": \\"formatted '$SEKHEMET_TOOL_TARGET' for '$SEKHEMET_CARD'\\"}'"`,
        "",
      ].join("\n"),
    );
    const { engine, count } = hookEngineFor(repo);
    expect(count).toBe(2);
    const blocked = await engine.emit("pre-tool", {
      cardId: "card_a",
      toolName: "run_cmd",
      toolArgs: { command: "rm -rf build" },
    });
    expect(blocked).toMatchObject({ blocked: true, reason: "no rm in this repo" });
    const fine = await engine.emit("pre-tool", {
      cardId: "card_a",
      toolName: "run_cmd",
      toolArgs: { command: "ls" },
    });
    expect(fine.blocked).toBe(false);
    const other = await engine.emit("pre-tool", {
      cardId: "card_a",
      toolName: "read_file",
      toolArgs: { command: "rm" },
    });
    expect(other.blocked).toBe(false); // the hook is for run_cmd only
    const after = await engine.emit("post-tool", {
      cardId: "card_a",
      toolName: "write_file",
      toolArgs: { path: "src/a.ts" },
    });
    expect(JSON.stringify(after)).toContain("formatted src/a.ts for card_a");
  });

  it("a crashing pre-* hook fails closed; a crashing post-* hook does not block", async () => {
    const repo = project(
      '[[hook]]\nevent = "pre-gate"\ncommand = "exit 7"\n\n[[hook]]\nevent = "post-gate"\ncommand = "exit 7"\n',
    );
    const { engine } = hookEngineFor(repo);
    expect((await engine.emit("pre-gate", { cardId: "c" })).blocked).toBe(true);
    expect((await engine.emit("post-gate", { cardId: "c" })).blocked).toBe(false);
  });
});
