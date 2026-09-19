import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTestWorktree } from "@sekhemet/eval";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { mutateAcceptedCards } from "../src/mutation_step.js";
import { runWave2Command } from "../src/wave2.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) (cleanups.pop() as () => void)();
});

async function acceptedRepo() {
  const wt = createTestWorktree("typescript");
  cleanups.push(wt.cleanup);
  writeFileSync(
    join(wt.path, "src/max.ts"),
    "export function max(a: number, b: number): number {\n  return a > b ? a : b;\n}\n",
  );
  // A weak test: max(3, 1) cannot tell `>` from `>=`.
  writeFileSync(
    join(wt.path, "tests/max.test.ts"),
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { max } from "../src/max.ts";\n\ntest("max", () => {\n  assert.equal(max(3, 1), 3);\n});\n',
  );
  wt.git("add", "-A");
  wt.git(
    "commit",
    "-q",
    "-m",
    "feat: max\n\nCard: c1\nAgent-Model: nail\nAgent-Harness: sekhemet\nAgent-Role: implementer\nCo-authored-by: nail <nail@models.sekhemet.local>",
  );
  const sha = wt.git("rev-parse", "HEAD");
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const log = new EventLog(db);
  const store = new CardStore(db, log);
  await store.createCard({ id: "c1", tier: "task", title: "Add max", status: "done" });
  await store.recordEvent({
    type: "card/accepted",
    cardId: "c1",
    actor: "human",
    payload: { sha },
  });
  return { wt, sha, log, store };
}

describe("E16: loop 10, mutants of accepted diffs become test proposals", () => {
  it("mutates the accepted change, runs the real gates, and proposes an advisory hardening card", async () => {
    const { wt, sha, log, store } = await acceptedRepo();
    const r = await mutateAcceptedCards(wt.path, store, log, { maxMutants: 6 });
    expect(r).toHaveLength(1);
    const run = r[0];
    expect(run?.sha).toBe(sha);
    expect(run?.total).toBeGreaterThan(0);
    expect(run?.survived.map((s) => `${s.file}:${s.original}->${s.replacement}`)).toContain(
      "src/max.ts:>->>=",
    );
    const card = await store.getCard(run?.proposalCardId as string);
    expect(card?.status).toBe("backlog");
    expect(card?.labels).toEqual(expect.arrayContaining(["mutation-hardening", "advisory"]));
    expect(card?.spec).toMatch(/src\/max\.ts:2 used `>=` instead of `>`/);
    // The accepted code is untouched and the throwaway checkout is gone.
    expect(wt.git("status", "--porcelain")).toBe("");
    expect(wt.git("worktree", "list").split("\n")).toHaveLength(1);
    const events = await log.getEventsByTypes(["improve/mutation"]);
    expect(events).toHaveLength(1);
    // Idempotent: an accepted card is mutated once.
    expect(await mutateAcceptedCards(wt.path, store, log, {})).toEqual([]);
  }, 120_000);

  it("`sekhemet improve --mutants` runs the step", async () => {
    const { wt, log, store } = await acceptedRepo();
    const lines: string[] = [];
    const code = await runWave2Command(
      "improve",
      ["--mutants", "--max-mutants", "3"],
      { repoPath: wt.path, log, cardStore: store },
      { print: (l) => lines.push(l) },
    );
    expect(code).toBe(0);
    expect(lines.some((l) => /^mutation c1 /.test(l))).toBe(true);
  }, 120_000);
});
