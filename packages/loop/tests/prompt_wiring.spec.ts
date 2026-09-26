import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PromptZoneBudgetError,
  PromptZoneFractionError,
  TOOL_INTERFACE_HEADER,
  buildWorkerPrompt,
} from "@sekhemet/context";
import type { GateResult, GateRunner } from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardExecutionSessionImpl } from "../src/session.js";
import { TOOL_CATALOG } from "../src/tool_catalog.js";

/** Records every request; replies with the scripted calls, then with `read_file`. */
function recorder(
  script: { name: string; arguments: Record<string, unknown> }[][],
  opts: { nativeTools?: boolean } = {},
) {
  const seen: InferenceRequest[] = [];
  let i = 0;
  const adapter: LocalInferenceAdapter = {
    modelId: "rec",
    supportedArms: ["arm_a_flat"],
    ...(opts.nativeTools !== undefined ? { nativeTools: opts.nativeTools } : {}),
    contextWindow: { contextTokens: 32768, maxTokens: 2048 },
    generate: async (req) => {
      seen.push(req);
      const calls = script[i++] ?? [{ name: "read_file", arguments: { path: "src/a.ts" } }];
      return {
        text: "",
        toolCalls: calls.map((c, n) => ({ id: `c${i}-${n}`, ...c })),
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      };
    },
  };
  return { adapter, seen };
}

const failingGate = (lines = 1): GateRunner => ({
  runGates: async (): Promise<GateResult> => ({
    passed: false,
    durationMs: 1,
    failures: Array.from({ length: lines }, (_, k) => ({
      rung: "typecheck" as const,
      gate: "typecheck",
      exitCode: 2,
      errorExcerpt: `src/a.ts:1:1 TS2304: Cannot find name 'x${k}'.`,
      suggestedFixFiles: ["src/a.ts"],
      expected: "the gate to pass",
      actual: "it failed",
      minimalRepro: "pnpm test",
      suggestedAction: "Fix the failure shown.",
      location: { file: "src/a.ts", line: 1 },
    })),
  }),
});

describe("the session builds its prompt with buildWorkerPrompt (C4, C7, M6, C8)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "promptwire-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const session = (adapter: LocalInferenceAdapter, gateRunner: GateRunner = failingGate()) =>
    new CardExecutionSessionImpl({
      cardId: "card_w",
      stepBudget: 10,
      worktreePath: root,
      modelAdapter: adapter,
      gateRunner,
      scopeFiles: ["src/a.ts"],
    });

  it("describes the tools once: natively when the adapter sends schemas, as text otherwise", async () => {
    const native = recorder([], { nativeTools: true });
    await session(native.adapter).executeTurn();
    expect(native.seen[0]?.systemPrompt).not.toContain(TOOL_INTERFACE_HEADER);
    expect(native.seen[0]?.systemPrompt).toContain("function-calling interface");
    expect(native.seen[0]?.tools?.length).toBeGreaterThan(0);

    const text = recorder([]);
    await session(text.adapter).executeTurn();
    expect(text.seen[0]?.systemPrompt).toContain(TOOL_INTERFACE_HEADER);
  });

  it("keeps the system prompt byte-stable across turns, even when a gate fails", async () => {
    const { adapter, seen } = recorder([[{ name: "check", arguments: {} }]]);
    const s = session(adapter);
    await s.executeTurn();
    await s.executeTurn();
    await s.executeTurn();
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((r) => r.systemPrompt)).size).toBe(1);
    // The failure rides in the volatile tail, the goal last.
    const last = seen[2]?.prompt ?? "";
    expect(last).toContain("=== LAST GATE FAILURE ===");
    expect(last.lastIndexOf("=== GOAL (RE-INJECTED) ===")).toBeGreaterThan(
      last.indexOf("=== LAST GATE FAILURE ==="),
    );
    expect(s.getLastPromptReport()?.tier).toBe("nominal");
  });

  it("asks for no reasoning on ordinary steps (M6 reasoningForStep)", async () => {
    const { adapter, seen } = recorder([]);
    await session(adapter).executeTurn();
    expect(seen[0]?.reasoning).toBe("off");
    expect(seen[0]?.reasoningBudgetTokens).toBe(0);
  });

  it("turns reasoning on once the ladder reaches fresh_context", async () => {
    // Two failed finish_card verifications climb past direct repair, with a
    // repair edit between them: back-to-back identical turns are a stall (L13).
    const finish = [{ name: "finish_card", arguments: {} }];
    const fix = (n: number) => [
      { name: "write_file", arguments: { path: "src/a.ts", content: `export const a = ${n};\n` } },
    ];
    const { adapter, seen } = recorder([finish, fix(2), finish, fix(3), finish]);
    const s = session(adapter);
    for (let t = 0; t < 5; t++) await s.executeTurn();
    const levels = seen.map((r) => r.reasoning);
    expect(levels[0]).toBe("off");
    expect(levels.some((l) => l !== "off")).toBe(true);
    const on = seen.find((r) => r.reasoning !== "off");
    expect(on?.reasoningBudgetTokens).toBeGreaterThan(0);
  });

  it("condenses long check output with a recall footer", async () => {
    const { adapter } = recorder([[{ name: "check", arguments: {} }]]);
    const s = session(adapter, failingGate(200));
    const turn = await s.executeTurn();
    const content = turn.observations[0]?.content ?? "";
    expect(content).toContain("Gates failing");
    expect(content).toMatch(/recall\(ref="[^"]+"\)/);
  });
});

describe("C5: prompt zone budgets on the live tool catalog", () => {
  /** A real tier's working budget: a 16k window less its output reserve. */
  const W = 16_384 - 2048 - 256;
  const CORE = ["read_file", "edit", "write_file", "check", "finish_card"];

  const card: CardRecord = {
    id: "card_zones",
    tier: "task",
    title: "Add a hasher",
    status: "in_progress",
    scopeFiles: ["src/a.ts"],
    stepBudget: 20,
    stepsUsed: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const zones = (r: ReturnType<typeof buildWorkerPrompt>) =>
    new Map(r.zoneBudgets.map((z) => [z.zone, z]));

  /** The Worker's prompt as `executeCard` builds it: progressive catalog (C19). */
  const progressive = (extra: Partial<Parameters<typeof buildWorkerPrompt>[0]> = {}) =>
    buildWorkerPrompt({
      card,
      tools: TOOL_CATALOG.filter((t) => CORE.includes(t.name)),
      toolIndex: TOOL_CATALOG,
      budgetTokens: W,
      goal: "Add a hasher to src/a.ts.",
      ...extra,
    });

  it("holds every zone to its fraction of the working budget", () => {
    expect(TOOL_CATALOG.length).toBeGreaterThanOrEqual(29);
    const r = progressive({
      acceptanceCriteria: ["sha256 of the input", "no new dependency"],
      conventions: "Named exports only.",
      repoMap: Array.from({ length: 30 }, (_, i) => `src/m${i}.ts: export const m${i}`).join("\n"),
      scopeFiles: [
        { path: "src/a.ts", content: Array.from({ length: 80 }, (_, i) => `// l${i}`).join("\n") },
      ],
      turns: [{ turn: 1, action: "read_file", result: "ok" }],
    });
    const z = zones(r);
    expect([...z.keys()].sort()).toEqual([1, 2, 3, 4]);
    for (const zone of [1, 2, 3, 4]) {
      expect({ zone, within: z.get(zone)?.withinBudget }).toEqual({ zone, within: true });
    }
    expect(z.get(1)?.budget).toBe(Math.floor(W * 0.12));
    // Zone 4 is a floor on what is left for the tail, not a ceiling on it.
    expect(z.get(4)?.budget).toBe(Math.floor(W * 0.2));
    const spent = [1, 2, 3].reduce((n, k) => n + (z.get(k)?.tokens ?? 0), 0);
    expect(W - spent).toBeGreaterThanOrEqual(z.get(4)?.budget ?? 0);
  });

  it("only fits the live catalog in zone 1 because it is disclosed progressively", () => {
    expect(zones(progressive()).get(1)?.withinBudget).toBe(true);
    // The same catalog rendered in full, as every turn carried it before C19.
    // Counted with the one estimator (CX-N1-2), its tool interface alone is
    // over the tool-interface cap, which refuses it before the fractions do.
    expect(() =>
      buildWorkerPrompt({
        card,
        tools: TOOL_CATALOG,
        budgetTokens: W,
        goal: "Add a hasher to src/a.ts.",
      }),
    ).toThrow(PromptZoneBudgetError);
    expect(() =>
      buildWorkerPrompt({
        card,
        tools: TOOL_CATALOG,
        budgetTokens: W,
        goal: "Add a hasher to src/a.ts.",
      }),
    ).toThrow(/"tool_interface"/);
  });

  it("refuses a playbook that would crowd the prefix instead of overflowing it", () => {
    const sentence = "Keep every public helper documented with a full worked example. ".repeat(40);
    expect(() =>
      progressive({
        rules: Array.from({ length: 8 }, (_, i) => ({
          id: `r${i}`,
          pattern: ".*",
          instruction: sentence,
        })),
        skills: Array.from({ length: 3 }, (_, i) => ({
          name: `skill${i}`,
          description: sentence,
          content: sentence,
          triggers: [],
        })),
      }),
    ).toThrow(PromptZoneFractionError);
  });
});
