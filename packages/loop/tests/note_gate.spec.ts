import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimatePromptTokens, measureToolInterface, workerCopy } from "@sekhemet/context";
import { DeterministicGateRunner, type GateRunner } from "@sekhemet/gates";
import type { InferenceRequest, LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import type { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardExecutionSessionImpl } from "../src/session.js";
import { TOOL_CATALOG, toolsForClass } from "../src/tool_catalog.js";

// Gates rule 18, GT-M6-5 (option A): `note` takes an optional `gate`, an enum
// of the attempt's gates. A note that names a gate stops the card with
// `gate_suspected`; a note without one never stops anything.

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "note-gate-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 0;\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const passing: GateRunner = {
  runGates: async () => ({ passed: true, failures: [], durationMs: 1, rungResults: [] }),
};
const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };

function session(
  calls: ToolCall[][],
  suspectableGates = ["unit", "typecheck", "bounds"],
  extra: Record<string, unknown> = {},
) {
  const seen: InferenceRequest[] = [];
  let i = 0;
  const adapter: LocalInferenceAdapter = {
    modelId: "m",
    supportedArms: ["arm_a_flat"],
    nativeTools: true,
    generate: async (req) => {
      seen.push(req);
      return { text: "", toolCalls: calls[Math.min(i++, calls.length - 1)] ?? [], usage };
    },
  } as LocalInferenceAdapter;
  const s = new CardExecutionSessionImpl({
    cardId: "c",
    stepBudget: 5,
    worktreePath: root,
    modelAdapter: adapter,
    gateRunner: passing,
    suspectableGates,
    integrityGate: false,
    ...extra,
  });
  return { s, seen };
}

const note = (args: Record<string, unknown>): ToolCall => ({
  id: "n",
  name: "note",
  arguments: args,
});

describe("note with a gate stops the card (GT-M6-5)", () => {
  it("stops with gate_suspected, naming the gate and the Worker's reason", async () => {
    const reason = "unit asserts the old API that this card replaces";
    const { s } = session([[note({ message: reason, gate: "unit" })]]);
    const turn = await s.executeTurn();
    expect(turn.stopReason).toBe("gate_suspected");
    expect(turn.suspectedGate).toEqual({ gate: "unit", reason });
    expect(turn.observations[0]?.ok).toBe(true);
  });

  it("never stops on a note without a gate, even one that mentions a gate", async () => {
    const { s } = session([[note({ message: "the unit gate looks wrong to me" })], []]);
    const turn = await s.executeTurn();
    expect(turn.stopReason).toBeUndefined();
    expect(turn.suspectedGate).toBeUndefined();
  });

  it("refuses an unknown gate in one line, and does not stop", async () => {
    const { s } = session([[note({ message: "bad gate", gate: "made_up" })], []]);
    const turn = await s.executeTurn();
    expect(turn.stopReason).toBeUndefined();
    expect(turn.observations[0]?.ok).toBe(false);
    expect(turn.observations[0]?.content).toBe(
      workerCopy.unknownGate("made_up", "bounds, typecheck, unit"),
    );
    expect(turn.observations[0]?.content.split("\n")).toHaveLength(1);
  });

  it("offers the attempt's gates as a sorted enum on note, described from the copy module", async () => {
    const { s, seen } = session([[]]);
    await s.executeTurn();
    const noteTool = seen[0]?.tools?.find((t) => t.name === "note");
    const gate = (noteTool?.parameters as { properties: Record<string, Record<string, unknown>> })
      .properties.gate;
    expect(gate).toEqual({
      type: "string",
      enum: ["bounds", "typecheck", "unit"],
      description: workerCopy.noteGate,
    });
    expect((noteTool?.parameters as { required?: string[] }).required).toEqual(["message"]);
  });

  it("offers no gate parameter when the attempt names no gates", async () => {
    const { s, seen } = session([[]], []);
    await s.executeTurn();
    const noteTool = seen[0]?.tools?.find((t) => t.name === "note");
    expect(
      (noteTool?.parameters as { properties: Record<string, unknown> }).properties.gate,
    ).toBeUndefined();
  });
});

describe("the gate list comes from what emits the ids (review of B2.3)", () => {
  const enumOf = async (extra: Record<string, unknown>, declared: string[] = ["unit"]) => {
    const { s, seen } = session([[]], declared, extra);
    await s.executeTurn();
    const noteTool = seen[0]?.tools?.find((t) => t.name === "note");
    return (noteTool?.parameters as { properties: Record<string, { enum?: string[] }> }).properties
      .gate?.enum;
  };

  it("adds bounds, integrity, the hook and the built-in layers only when they run", async () => {
    expect(await enumOf({})).toEqual(["unit"]);
    expect(
      await enumOf({
        bounds: { maxFiles: 3, maxLines: 200 },
        integrityGate: true,
        hooks: { emit: async () => ({ blocked: false, messages: [] }) },
        builtinGates: {
          protected: [],
          maxFiles: 3,
          maxDiffLines: 200,
          builtin: ["secrets"],
          mutation: true,
        },
      }),
    ).toEqual(["bounds", "hook", "integrity", "mutation", "secrets", "unit"]);
  });
});

describe("the Worker's reason is kept short", () => {
  it("records at most 300 characters of the note as the reason", async () => {
    const long = "x".repeat(500);
    const { s } = session([[note({ message: long, gate: "unit" })]]);
    const turn = await s.executeTurn();
    expect(turn.suspectedGate?.reason).toHaveLength(300);
  });
});

/**
 * Ratchets, not budgets: the tool interface a session sends, with note's gate
 * enum, measured 2026-09-25 with the allocator's estimator. Each is over
 * DEC-27's 1,700 because the default arm keeps the whole catalog; worker-loop
 * WL-M2-3's fixed set must bring each to at most 1,700, and these constants
 * only ever fall toward that.
 */
const IMPLEMENT_TOOL_INTERFACE_TOKENS = 2_012;
/** With `run_script`, for a script-capable Worker (WL-M2-4). */
const SCRIPT_CAPABLE_TOOL_INTERFACE_TOKENS = 2_099;
/** With a 23-gate enum: a project with mutation, the visual layer and every project gate. */
const IMPLEMENT_23_GATES_TOOL_INTERFACE_TOKENS = 2_043;

describe("the gate enum's cost against DEC-27's 1,700-token tool interface", () => {
  const gates15 = [
    "architecture",
    "bounds",
    "dependencies",
    "hook",
    "hygiene",
    "integrity",
    "licenses",
    "lint",
    "osv",
    "reachability",
    "regression",
    "secrets",
    "semgrep",
    "typecheck",
    "unit",
  ];
  const gates23 = [
    ...gates15,
    "mutation",
    "trailers",
    "visual",
    "visual-a11y",
    "visual-confinement",
    "visual-console",
    "visual-layout",
    "visual-snapshot",
  ];
  /** The tools a session sends: its own note gate enum, not a copy of it. */
  const sent = (tools: ReturnType<typeof toolsForClass>, gates: string[]) =>
    session([[]], gates, { tools }).s.getToolSpecs();
  // The allocator's estimator (the one the zone budgets are asserted with).
  const tokens = (tools: ReturnType<typeof toolsForClass>) =>
    estimatePromptTokens(measureToolInterface(tools).rendered);

  it("adds at most 70 tokens with fifteen gate ids", () => {
    const tools = toolsForClass("implement");
    expect(tokens(sent(tools, gates15)) - tokens(sent(tools, []))).toBeLessThanOrEqual(70);
  });

  it("keeps every class with a fixed tool set within 1,700 tokens", () => {
    for (const cls of ["review", "research", "spike"] as const) {
      expect(tokens(sent(toolsForClass(cls), gates15)), cls).toBeLessThanOrEqual(1_700);
    }
  });

  it("never lets the implement class's interface grow past its measured size", () => {
    expect(gates23).toHaveLength(23);
    expect(tokens(sent(toolsForClass("implement"), gates15))).toBeLessThanOrEqual(
      IMPLEMENT_TOOL_INTERFACE_TOKENS,
    );
    expect(tokens(sent(toolsForClass("implement"), gates23))).toBeLessThanOrEqual(
      IMPLEMENT_23_GATES_TOOL_INTERFACE_TOKENS,
    );
    const scriptCapable = toolsForClass("implement", TOOL_CATALOG, { scriptCapable: true });
    expect(tokens(sent(scriptCapable, gates15))).toBeLessThanOrEqual(
      SCRIPT_CAPABLE_TOOL_INTERFACE_TOKENS,
    );
  });
});

describe("a gate that could not run never counts against the model (review blocker 1)", () => {
  it("ends done_pending_gates when finishing meets only gates that could not start", async () => {
    const sandbox = {
      execute: async () => {
        throw new Error("spawn pnpm ENOENT");
      },
    } as unknown as ProcessSandbox;
    const { s } = session([[{ id: "f", name: "finish_card", arguments: {} }]], [], {
      gateRunner: new DeterministicGateRunner(sandbox, { repoRoot: root }),
      gateRungs: ["typecheck"],
    });
    const turn = await s.executeTurn();
    expect(turn.stopReason).toBe("done_pending_gates");
  });
});

describe("a re-check after an edit that meets only gates that could not run", () => {
  it("stops done_pending_gates rather than keep repairing", async () => {
    let calls = 0;
    const real = {
      rung: "typecheck" as const,
      gate: "typecheck",
      layer: "static" as const,
      exitCode: 2,
      errorExcerpt: "src/a.ts:1:1 TS2322: bad",
      suggestedFixFiles: ["src/a.ts"],
      location: { file: "src/a.ts", line: 1 },
      expected: "type-correct program",
      actual: "TS2322: bad",
      minimalRepro: "pnpm typecheck",
      suggestedAction: "Fix it.",
    };
    const runner: GateRunner = {
      runGates: async () => {
        calls++;
        return calls === 1
          ? { passed: false, durationMs: 1, failures: [real] }
          : {
              passed: false,
              durationMs: 1,
              failures: [{ ...real, errorExcerpt: "typecheck not run", notRun: true }],
            };
      },
    };
    const { s } = session(
      [
        [{ id: "f", name: "finish_card", arguments: {} }],
        [
          {
            id: "w",
            name: "write_file",
            arguments: { path: "src/new.ts", content: "export const n = 1;\n" },
          },
        ],
      ],
      [],
      { gateRunner: runner },
    );
    await s.executeTurn();
    const turn = await s.executeTurn();
    expect(turn.stopReason).toBe("done_pending_gates");
  });
});
