import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    // (cat/grep/sed are redirected to the file tools since L8; sort is not.)
    const obs = await run("sort src/a.ts | wc -l");
    expect(obs.ok).toBe(true);
    expect(obs.content).toMatch(/\b3\b/);
  });

  it("still runs program-plus-args calls directly", async () => {
    const obs = await run("sort", ["src/a.ts"]);
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

  it("re-checks after an edit while a failure stands, and finishes when the gates go green", async () => {
    let calls = 0;
    const failure = (n: number) => ({
      rung: "typecheck" as const,
      gate: "typecheck",
      exitCode: 2,
      errorExcerpt: `src/a.ts:${n}:1 TS2304: Cannot find name 'x${n}'.`,
      suggestedFixFiles: ["src/a.ts"],
    });
    // Fails with two errors on submit, then passes on the re-check after the edit.
    const runner: GateRunner = {
      runGates: async (): Promise<GateResult> => {
        calls++;
        return calls === 1
          ? { passed: false, durationMs: 1, failures: [failure(1), failure(2)] }
          : { passed: true, durationMs: 1, failures: [] };
      },
    };
    const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
    const adapter = new MockInferenceAdapter("m", [
      { text: "", toolCalls: [{ id: "1", name: "finish_card", arguments: {} }], usage },
      {
        text: "",
        toolCalls: [
          { id: "2", name: "write_file", arguments: { path: "src/a.ts", content: "ok\n" } },
        ],
        usage,
      },
    ]);
    const session = new CardExecutionSessionImpl({
      cardId: "c",
      stepBudget: 5,
      worktreePath: root,
      gateRunner: runner,
      modelAdapter: adapter,
      // Pinned, so the agent has seen it before overwriting (L17).
      scopeFiles: ["src/a.ts"],
    });

    const first = await session.executeTurn();
    expect(first.stopReason).toBeUndefined();
    // Both failures reach the next prompt, not just the first.
    const prompt = (session as unknown as { buildPrompt(): { prompt: string } }).buildPrompt()
      .prompt;
    expect(prompt).toContain("x1");
    expect(prompt).toContain("Also failing");
    expect(prompt).toContain("x2");

    const second = await session.executeTurn();
    expect(calls).toBe(2);
    expect(second.stopReason).toBe("gate_passed");
    expect(second.gateResult?.passed).toBe(true);
    // The pass came from the harness re-check, not from a second submission.
    expect(second.toolCalls.map((c) => c.name)).toEqual(["write_file"]);
    expect(session.getHistory().some((h) => h.action === "re-check after edit")).toBe(true);
  });

  it("a repeated check with no edit in between does not re-run the gates", async () => {
    let calls = 0;
    const runner: GateRunner = {
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
              errorExcerpt:
                "src/a.ts:29:6 TS2339: Property 'run' does not exist on type 'DatabaseSync'.",
              suggestedFixFiles: ["src/a.ts"],
            },
          ],
        };
      },
    };
    const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
    const check = { text: "", toolCalls: [{ id: "c", name: "check", arguments: {} }], usage };
    const session = new CardExecutionSessionImpl({
      cardId: "c",
      stepBudget: 5,
      worktreePath: root,
      gateRunner: runner,
      modelAdapter: new MockInferenceAdapter("m", [check, check]),
    });

    await session.executeTurn();
    // The check's failure is now the standing failure the prompt shows.
    expect(session.getLastGateFailure()?.errorExcerpt).toContain("TS2339");
    const second = await session.executeTurn();
    expect(calls).toBe(1);
    expect(second.observations[0]?.content).toContain("Nothing has changed");
  });

  it("a passing check finishes the card without a separate finish_card", async () => {
    const runner: GateRunner = {
      runGates: async (): Promise<GateResult> => ({ passed: true, durationMs: 1, failures: [] }),
    };
    const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
    const session = new CardExecutionSessionImpl({
      cardId: "c",
      stepBudget: 5,
      worktreePath: root,
      gateRunner: runner,
      modelAdapter: new MockInferenceAdapter("m", [
        { text: "", toolCalls: [{ id: "c", name: "check", arguments: {} }], usage },
      ]),
    });
    const turn = await session.executeTurn();
    expect(turn.stopReason).toBe("gate_passed");
    expect(turn.gateResult?.passed).toBe(true);
  });

  it("shows the code at the failing line, in the prompt and in a refused re-check", async () => {
    writeFileSync(
      join(root, "src", "a.ts"),
      "export function f() {\n  const x = 1;\n  return { valid: false, at: undefined };\n}\n",
    );
    const runner: GateRunner = {
      runGates: async (): Promise<GateResult> => ({
        passed: false,
        durationMs: 1,
        failures: [
          {
            rung: "typecheck",
            gate: "typecheck",
            exitCode: 2,
            errorExcerpt:
              "src/a.ts:3:10 TS2375: Type is not assignable with exactOptionalPropertyTypes.",
            suggestedFixFiles: ["src/a.ts"],
            location: { file: "src/a.ts", line: 3 },
          },
        ],
      }),
    };
    const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
    const check = { text: "", toolCalls: [{ id: "c", name: "check", arguments: {} }], usage };
    const session = new CardExecutionSessionImpl({
      cardId: "c",
      stepBudget: 5,
      worktreePath: root,
      gateRunner: runner,
      modelAdapter: new MockInferenceAdapter("m", [check, check]),
    });

    await session.executeTurn();
    const prompt = (session as unknown as { buildPrompt(): { prompt: string } }).buildPrompt()
      .prompt;
    expect(prompt).toContain(">   3 |   return { valid: false, at: undefined };");

    const refused = await session.executeTurn();
    expect(refused.observations[0]?.content).toContain("return { valid: false, at: undefined }");
  });

  it("runs the stylistic fixer once per rule, on the scope files only", async () => {
    const runner: GateRunner = {
      runGates: async (): Promise<GateResult> => ({ passed: true, durationMs: 1, failures: [] }),
    };
    const session = new CardExecutionSessionImpl({
      cardId: "c",
      stepBudget: 5,
      worktreePath: root,
      gateRunner: runner,
      scopeFiles: ["src/a.ts"],
      // $0 is "sh"; the rule and the appended scope file follow.
      styleFixCommands: [
        ["/bin/sh", "-c", 'echo "$1 $2" >> fix.log', "sh", "rule-one"],
        ["/bin/sh", "-c", 'echo "$1 $2" >> fix.log', "sh", "rule-two"],
      ],
      modelAdapter: new MockInferenceAdapter("m", []),
    });
    await session.runVerification();
    const log = readFileSync(join(root, "fix.log"), "utf8").trim().split("\n");
    expect(log).toEqual(["rule-one src/a.ts", "rule-two src/a.ts"]);
  });

  it("names a type's real members when the code calls one that does not exist", async () => {
    mkdirSync(join(root, "node_modules", "@types", "node"), { recursive: true });
    writeFileSync(
      join(root, "node_modules", "@types", "node", "sqlite.d.ts"),
      `declare module "node:sqlite" {
  class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
    readonly isOpen: boolean;
  }
}
`,
    );
    const runner: GateRunner = {
      runGates: async (): Promise<GateResult> => ({
        passed: false,
        durationMs: 1,
        failures: [
          {
            rung: "typecheck",
            gate: "typecheck",
            exitCode: 2,
            errorExcerpt:
              "src/a.ts:2:5 TS2339: Property 'run' does not exist on type 'DatabaseSync'.",
            suggestedFixFiles: ["src/a.ts"],
            location: { file: "src/a.ts", line: 2 },
          },
        ],
      }),
    };
    const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
    const session = new CardExecutionSessionImpl({
      cardId: "c",
      stepBudget: 5,
      worktreePath: root,
      gateRunner: runner,
      modelAdapter: new MockInferenceAdapter("m", [
        { text: "", toolCalls: [{ id: "c", name: "check", arguments: {} }], usage },
      ]),
    });
    const turn = await session.executeTurn();
    expect(turn.observations[0]?.content).toContain(
      "DatabaseSync has no 'run'. Its actual members are: close, exec, isOpen, prepare.",
    );
  });

  it("lists a contract type's members when a required property is missing", async () => {
    const { apiHints } = await import("../src/api_surface.js");
    writeFileSync(
      join(root, "src", "types.ts"),
      "export interface Event {\n  id: string;\n  timestamp: number;\n  hash: string;\n}\n",
    );
    expect(
      apiHints(root, [
        "src/l.ts:9:5 TS2741: Property 'timestamp' is missing in type '{ id: string; }' but required in type 'Event'.",
      ]),
    ).toEqual([
      "Event requires timestamp. All of its members: hash, id, timestamp. Set every required one.",
    ]);
  });

  it("answers the Worker's question from the card's contract, or tells it to proceed conservatively", async () => {
    const runner: GateRunner = {
      runGates: async (): Promise<GateResult> => ({ passed: false, durationMs: 1, failures: [] }),
    };
    const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
    const ask = (question: string) => ({
      text: "",
      toolCalls: [{ id: "a", name: "ask", arguments: { question } }],
      usage,
    });
    const session = new CardExecutionSessionImpl({
      cardId: "c",
      stepBudget: 5,
      worktreePath: root,
      gateRunner: runner,
      card: {
        id: "c",
        tier: "task",
        title: "Ledger",
        status: "in_progress",
        scopeFiles: [],
        stepBudget: 5,
        stepsUsed: 0,
        createdAt: "",
        updatedAt: "",
        spec: "Append events to the ledger. Replaying an idempotency key returns the existing event.",
        acceptanceCriteria: ["sequence numbers start at one"],
      } as never,
      modelAdapter: new MockInferenceAdapter("m", [
        ask("What happens when an idempotency key is replayed?"),
        ask("Which colour is the logo?"),
      ]),
    });
    const answered = await session.executeTurn();
    expect(answered.observations[0]?.content).toContain(
      "(spec) Replaying an idempotency key returns the existing event.",
    );
    const unknown = await session.executeTurn();
    expect(unknown.observations[0]?.content).toMatch(/most conservative reading/);
  });

  it("routes a question the contract cannot answer to the team: now if Seshat is resident, queued otherwise", async () => {
    const runner: GateRunner = {
      runGates: async (): Promise<GateResult> => ({ passed: false, durationMs: 1, failures: [] }),
    };
    const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
    const ask = {
      text: "",
      toolCalls: [
        { id: "a", name: "ask", arguments: { question: "Which port should the server use?" } },
      ],
      usage,
    };
    const make = (reply: string | undefined) =>
      new CardExecutionSessionImpl({
        cardId: "c",
        stepBudget: 3,
        worktreePath: root,
        gateRunner: runner,
        teamNote: "Seshat answers questions.",
        askTeam: async () => reply,
        modelAdapter: new MockInferenceAdapter("m", [ask]),
      });
    const now = await make("Use port 0 and read the bound port back.").executeTurn();
    expect(now.observations[0]?.content).toBe(
      "Seshat (project manager) answers: Use port 0 and read the bound port back.",
    );
    const later = await make(undefined).executeTurn();
    expect(later.observations[0]?.content).toMatch(/queued for it/);
  });
});
