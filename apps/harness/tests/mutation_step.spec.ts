import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTestWorktree } from "@sekhemet/eval";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { mutateAcceptedCards } from "../src/mutation_step.js";
import { runDevCommand } from "../src/wave2.js";

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
  await store.createCard({ id: "c1", tier: "task", title: "Add max" });
  await store.updateCardStatus("c1", "done", "test setup", "harness", { override: true });
  await store.recordEvent({
    type: "card/accepted",
    cardId: "c1",
    actor: "human",
    // The payload Accept writes (review-git §3; the schema requires the id).
    payload: { id: "c1", sha },
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
    const code = await runDevCommand(
      "improve",
      ["--mutants", "--max-mutants", "3"],
      { repoPath: wt.path, log, cardStore: store },
      { print: (l) => lines.push(l) },
    );
    expect(code).toBe(0);
    expect(lines.some((l) => /^mutation c1 /.test(l))).toBe(true);
  }, 120_000);
});

/** An accepted commit with the given files, committed on top of a fresh worktree. */
async function acceptedWith(files: Record<string, string>) {
  const wt = createTestWorktree("typescript");
  cleanups.push(wt.cleanup);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(wt.path, rel)), { recursive: true });
    writeFileSync(join(wt.path, rel), text);
  }
  wt.git("add", "-A");
  wt.git("commit", "-q", "-m", "feat: change");
  const sha = wt.git("rev-parse", "HEAD");
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const log = new EventLog(db);
  const store = new CardStore(db, log);
  await store.createCard({ id: "c1", tier: "task", title: "Change" });
  await store.updateCardStatus("c1", "done", "test setup", "harness", { override: true });
  await store.recordEvent({
    type: "card/accepted",
    cardId: "c1",
    actor: "human",
    // The payload Accept writes (review-git §3; the schema requires the id).
    payload: { id: "c1", sha },
  });
  return { wt, log, store };
}

describe("M10: mutation scores that cannot lie", () => {
  it("MS-M10-1: refuses to score when the tests fail on the unmutated checkout, and says why", async () => {
    const { wt, log, store } = await acceptedWith({
      "src/max.ts":
        "export function max(a: number, b: number): number {\n  return a > b ? a : b;\n}\n",
    });
    let calls = 0;
    const [run] = await mutateAcceptedCards(wt.path, store, log, {
      runTests: async () => {
        calls++;
        return false;
      },
    });
    expect(calls).toBe(1);
    expect(run?.score).toBeNull();
    expect(run?.refused).toMatch(/tests fail on the unmutated checkout/);
    expect(run?.total).toBe(0);
    const [event] = await log.getEventsByTypes(["improve/mutation"]);
    expect(event?.payload).toMatchObject({ score: null, refused: run?.refused });
  }, 120_000);

  it("MS-M10-2: a change with no mutable lines scores null, not 1", async () => {
    const { wt, log, store } = await acceptedWith({ "src/names.ts": 'export const name = "x";\n' });
    const [run] = await mutateAcceptedCards(wt.path, store, log, { runTests: async () => true });
    expect(run?.total).toBe(0);
    expect(run?.score).toBeNull();
  }, 120_000);

  it("MS-M10-3: reports changed files in a language it cannot mutate as not measured", async () => {
    const { wt, log, store } = await acceptedWith({
      "src/max.ts":
        "export function max(a: number, b: number): number {\n  return a > b ? a : b;\n}\n",
      "tools/check.py": "def ok(x):\n    return x > 1\n",
      "native/lib.rs": "pub fn ok(x: i32) -> bool { x > 1 }\n",
      // Any code outside JS/TS, not only a listed language (review minor).
      "scripts/build.lua": "return 1\n",
      "scripts/run.sh": "echo ok\n",
      // Not code: never reported.
      "README.md": "# x\n",
      "config/app.json": "{}\n",
    });
    const [run] = await mutateAcceptedCards(wt.path, store, log, { runTests: async () => true });
    expect(run?.notMeasured).toEqual([
      "native/lib.rs",
      "scripts/build.lua",
      "scripts/run.sh",
      "tools/check.py",
    ]);
    expect(run?.total).toBeGreaterThan(0);
  }, 120_000);
});
