import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import type { GateResult, GateRunner } from "@sekhemet/gates";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardExecutionSessionImpl } from "../src/session.js";
import { ToolExecutor } from "../src/tools.js";

describe("@sekhemet/loop shell command lines and the check tool", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "shellcheck-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "one\ntwo\nthree\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (command: string, args?: string[]) =>
    new ToolExecutor({ worktreePath: root }).execute({
      id: "c",
      name: "run_cmd",
      arguments: { command, ...(args ? { args } : {}) },
    });

  it("runs a whole command line with a pipe, as a developer would type it", async () => {
    const obs = await run("cat src/a.ts | wc -l");
    expect(obs.ok).toBe(true);
    expect(obs.content).toMatch(/\b3\b/);
  });

  it("still runs program-plus-args calls directly", async () => {
    const obs = await run("cat", ["src/a.ts"]);
    expect(obs.ok).toBe(true);
    expect(obs.content).toContain("two");
  });

  it("denies a destructive command hidden inside a shell line", async () => {
    const obs = await run("ls && rm -rf src");
    expect(obs.denied).toBe(true);
    expect(existsSync(join(root, "src", "a.ts"))).toBe(true);
  });

  it.runIf(platform() === "darwin")("keeps a shell line inside the sandbox", async () => {
    const target = join(homedir(), ".sekhemet_shell_escape_probe");
    const obs = await run(`echo pwned > ${target}`);
    expect(obs.ok).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it("check reports failing gates without ending the card", async () => {
    let calls = 0;
    const failing: GateRunner = {
      runGates: async (): Promise<GateResult> => {
        calls++;
        return {
          passed: false,
          durationMs: 1,
          failures: [
            {
              rung: "typecheck",
              gate: "typecheck",
              exitCode: 2,
              errorExcerpt: "src/a.ts:1:1 TS2304: Cannot find name 'x'.",
              suggestedFixFiles: ["src/a.ts"],
              location: { file: "src/a.ts", line: 1 },
            },
          ],
        };
      },
    };
    const session = new CardExecutionSessionImpl({
      cardId: "c",
      stepBudget: 5,
      worktreePath: root,
      gateRunner: failing,
      modelAdapter: new MockInferenceAdapter("m", [
        {
          text: "",
          toolCalls: [{ id: "1", name: "check", arguments: {} }],
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        },
      ]),
    });

    const turn = await session.executeTurn();
    expect(calls).toBe(1);
    expect(turn.observations[0]?.ok).toBe(false);
    expect(turn.observations[0]?.content).toContain("not submitted");
    expect(turn.observations[0]?.content).toContain("src/a.ts:1");
    // A self-check is not a submission: no stop reason, no repair-ladder step.
    expect(turn.stopReason).toBeUndefined();
    expect(turn.gateResult).toBeUndefined();
    expect(session.getLadderState().totalAttempts).toBe(0);
  });
});
