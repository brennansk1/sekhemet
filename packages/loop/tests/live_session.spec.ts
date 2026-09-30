import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateRunner } from "@sekhemet/gates";
import type { InferenceRequest, LocalInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardExecutionSessionImpl } from "../src/session.js";

// models rule 20i, MD-N14-36: a card's Worker requests name the card as their
// live session, so its slot is saved on swap-out (and re-prefilled on return
// until the equivalence check passes).
describe("a card's attempt is a live session on its slot", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "live-session-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("sends session { owner: the card, kind: live_card } with every Worker request", async () => {
    const seen: InferenceRequest[] = [];
    const adapter: LocalInferenceAdapter = {
      modelId: "rec",
      supportedArms: ["arm_a_flat"],
      contextWindow: { contextTokens: 32768, maxTokens: 2048 },
      generate: async (req) => {
        seen.push(req);
        return {
          text: "",
          toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "src/a.ts" } }],
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        };
      },
    };
    const gateRunner: GateRunner = {
      runGates: async () => ({ passed: false, durationMs: 1, failures: [] }),
    };
    const s = new CardExecutionSessionImpl({
      cardId: "card_live",
      stepBudget: 5,
      worktreePath: root,
      modelAdapter: adapter,
      gateRunner,
      scopeFiles: ["src/a.ts"],
    });
    await s.executeTurn();
    await s.executeTurn();
    expect(seen.map((r) => r.session)).toEqual([
      { owner: "card_live", kind: "live_card" },
      { owner: "card_live", kind: "live_card" },
    ]);
    // Without a slot lease the request names no slot (the server's slot 0).
    expect(seen.every((r) => r.slot === undefined)).toBe(true);

    // RUN-35: under a slot lease, every request runs on that server slot.
    seen.length = 0;
    const leased = new CardExecutionSessionImpl({
      cardId: "card_two",
      stepBudget: 5,
      worktreePath: root,
      modelAdapter: adapter,
      gateRunner,
      scopeFiles: ["src/a.ts"],
      serverSlot: 1,
    });
    await leased.executeTurn();
    expect(seen.map((r) => [r.slot, r.session?.owner])).toEqual([[1, "card_two"]]);
  });

  // Measurement rule 4a: a step's usage is on the ledger as `card/step`, so
  // the one path to a model does not record it again as `model/usage`.
  it("marks every Worker step's request as recorded by its card step", async () => {
    const seen: InferenceRequest[] = [];
    const adapter: LocalInferenceAdapter = {
      modelId: "rec",
      supportedArms: ["arm_a_flat"],
      contextWindow: { contextTokens: 32768, maxTokens: 2048 },
      generate: async (req) => {
        seen.push(req);
        return {
          text: "",
          toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "src/a.ts" } }],
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        };
      },
    };
    const s = new CardExecutionSessionImpl({
      cardId: "card_steps",
      stepBudget: 5,
      worktreePath: root,
      modelAdapter: adapter,
      gateRunner: { runGates: async () => ({ passed: false, durationMs: 1, failures: [] }) },
      scopeFiles: ["src/a.ts"],
    });
    await s.executeTurn();
    await s.executeTurn();
    expect(seen.map((r) => r.recordedAsCardStep)).toEqual([true, true]);
  });
});
