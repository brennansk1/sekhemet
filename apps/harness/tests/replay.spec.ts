import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { diffTrajectories, formatDiff, formatTrajectory, trajectories } from "../src/replay.js";

async function ledgerWithTwoAttempts() {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const log = new EventLog(db);
  const cards = new CardStore(db, log);
  await cards.createCard({ id: "card_r", tier: "task", title: "Replay me", status: "ready" });
  const step = async (
    attemptId: string,
    turn: number,
    calls: { name: string; target?: string; ok?: boolean }[],
    extra: Record<string, unknown> = {},
  ) =>
    cards.recordEvent({
      type: "card/step",
      cardId: "card_r",
      actor: "executor",
      attemptId,
      payload: {
        id: "card_r",
        turn,
        calls,
        usage: { promptTokens: 100, completionTokens: 20 },
        ...extra,
      },
    });
  const a = await cards.runs.startAttempt({
    cardId: "card_r",
    attemptNumber: 1,
    modelId: "cyber-tiel",
  });
  await cards.recordEvent({
    type: "card/repro",
    cardId: "card_r",
    actor: "harness",
    attemptId: a.id,
    payload: { model: { id: "cyber-tiel" }, promptSha: "p1", gatesSha: "g" },
  });
  await step(a.id, 1, [{ name: "read_file", target: "src/a.ts" }]);
  await step(a.id, 2, [{ name: "write_file", target: "src/a.ts" }], {
    gate: { passed: false, failed: ["typecheck"], errors: 2 },
  });
  await step(a.id, 3, [{ name: "finish_card" }], { stopReason: "repair_exhausted" });
  await cards.runs.finishAttempt({
    attemptId: a.id,
    status: "failed",
    stopReason: "repair_exhausted",
    tokensUsed: 360,
    secondsUsed: 30,
  });
  const b = await cards.runs.startAttempt({
    cardId: "card_r",
    attemptNumber: 2,
    modelId: "qwen3.8-27b",
    forkedFrom: { attemptId: a.id, step: 0 },
  });
  await cards.recordEvent({
    type: "card/repro",
    cardId: "card_r",
    actor: "harness",
    attemptId: b.id,
    payload: { model: { id: "qwen3.8-27b" }, promptSha: "p1", gatesSha: "g" },
  });
  await step(b.id, 1, [{ name: "read_file", target: "src/a.ts" }]);
  await step(b.id, 2, [{ name: "read_symbol", target: "src/b.ts" }]);
  await step(b.id, 3, [{ name: "write_file", target: "src/a.ts" }], {
    gate: { passed: true, failed: [] },
  });
  await cards.runs.finishAttempt({
    attemptId: b.id,
    status: "passed",
    stopReason: "completed",
    tokensUsed: 360,
    secondsUsed: 40,
  });
  return cards;
}

describe("sekhemet replay (H8)", () => {
  it("rebuilds each attempt's trajectory from the ledger", async () => {
    const cards = await ledgerWithTwoAttempts();
    const all = await trajectories(cards, "card_r");
    expect(all.map((t) => [t.attemptNumber, t.modelId, t.steps.length, t.outcome])).toEqual([
      [1, "cyber-tiel", 3, "failed"],
      [2, "qwen3.8-27b", 3, "passed"],
    ]);
    const text = formatTrajectory(all[0] as NonNullable<(typeof all)[0]>);
    expect(text).toMatch(/Attempt 1 .* on cyber-tiel: failed, 3 step\(s\), 360 tokens/);
    expect(text).toMatch(/2\. write_file src\/a\.ts \| gates FAIL typecheck/);
    expect(text).toMatch(/3\. finish_card \| stop: repair_exhausted/);
    expect(formatTrajectory(all[1] as NonNullable<(typeof all)[1]>)).toMatch(
      /forked from att_[\w-]+ at step 0/,
    );
  });

  it("aligns two attempts, names the first divergence and what changed between them", async () => {
    const cards = await ledgerWithTwoAttempts();
    const [a, b] = await trajectories(cards, "card_r");
    if (!a || !b) throw new Error("attempts missing");
    const d = diffTrajectories(a, b);
    expect(d).toMatchObject({ firstDivergence: 2, sameChoicesUntil: 1, reproChanged: ["model"] });
    const text = formatDiff(a, b, d);
    expect(text).toMatch(/outcome: failed vs passed/);
    expect(text).toMatch(
      /diverge at step 2:\n {4}write_file\(src\/a\.ts\)\n {4}read_symbol\(src\/b\.ts\)/,
    );
    expect(text).toMatch(/What changed between them: model\./);
    expect(diffTrajectories(a, a).firstDivergence).toBeUndefined();
  });
});
