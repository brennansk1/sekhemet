import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type SuiteTask,
  compareRuns,
  loadFrozenSuite,
  runFrozenSuite,
  summarise,
} from "../src/suite.js";

/** A repository with a two-fixture suite, so the hash has something to cover. */
function repo(opts: { body?: string; tasks?: number } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "suite-"));
  mkdirSync(join(root, "fixtures", "alpha", "src"), { recursive: true });
  writeFileSync(
    join(root, "fixtures", "suite.json"),
    JSON.stringify({
      version: "1.0.0",
      fixtures: [{ name: "alpha", tasks: opts.tasks ?? 2 }],
    }),
  );
  writeFileSync(
    join(root, "fixtures", "alpha", "cards.json"),
    JSON.stringify([
      { id: "card_a", title: "A" },
      { id: "card_b", title: "B" },
    ]),
  );
  writeFileSync(
    join(root, "fixtures", "alpha", "src", "a.ts"),
    opts.body ?? "export const a = 1;\n",
  );
  return root;
}

const outcome = (passed: boolean, rungs = 0) => ({
  passed,
  wallClockSeconds: 60,
  tokens: 1000,
  rungs,
});

describe("the frozen suite", () => {
  it("loads its tasks from the fixtures the manifest names", () => {
    const suite = loadFrozenSuite(repo());
    expect(suite.version).toBe("1.0.0");
    expect(suite.tasks.map((t) => t.cardId)).toEqual(["card_a", "card_b"]);
    expect(suite.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes its hash when a fixture's contents change", () => {
    // This is what "frozen" means: editing a task to flatter a result makes
    // the two runs incomparable instead of making the result look better.
    const before = loadFrozenSuite(repo({ body: "export const a = 1;\n" }));
    const after = loadFrozenSuite(repo({ body: "export const a = 2;\n" }));
    expect(after.hash).not.toBe(before.hash);
  });

  it("gives the same hash for the same bytes", () => {
    expect(loadFrozenSuite(repo()).hash).toBe(loadFrozenSuite(repo()).hash);
  });

  it("refuses a fixture that has lost a task rather than scoring fewer", () => {
    // A vanished task would otherwise read as a clean run over a shorter list.
    expect(() => loadFrozenSuite(repo({ tasks: 3 }))).toThrow(/declares 3 tasks, found 2/);
  });

  it("names the fixture that is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "suite-"));
    mkdirSync(join(root, "fixtures"), { recursive: true });
    writeFileSync(
      join(root, "fixtures", "suite.json"),
      JSON.stringify({ version: "1.0.0", fixtures: [{ name: "ghost", tasks: 1 }] }),
    );
    expect(() => loadFrozenSuite(root)).toThrow(/no fixture ghost/);
  });
});

describe("running it", () => {
  it("reduces a run to one number and the cost that bought it", async () => {
    const suite = loadFrozenSuite(repo());
    const r = await runFrozenSuite(suite, async (t: SuiteTask) =>
      outcome(t.cardId === "card_a", t.cardId === "card_a" ? 0 : 2),
    );
    expect(r.passed).toBe(1);
    expect(r.total).toBe(2);
    expect(r.firstTry).toBe(1);
    expect(r.cost).toEqual({ wallClockSeconds: 120, tokens: 2000, rungs: 2 });
    expect(r.suiteHash).toBe(suite.hash);
  });

  it("counts a task that throws as a task that did not pass", async () => {
    const suite = loadFrozenSuite(repo());
    const r = await runFrozenSuite(suite, async (t) => {
      if (t.cardId === "card_b") throw new Error("model unreachable");
      return outcome(true);
    });
    expect(r.passed).toBe(1);
    expect(r.total).toBe(2);
    expect(r.outcomes[1]?.stopReason).toContain("model unreachable");
  });

  it("separates a pass that needed repair from one that did not", async () => {
    const suite = loadFrozenSuite(repo());
    const r = await runFrozenSuite(suite, async () => outcome(true, 3));
    expect(r.passed).toBe(2);
    expect(r.firstTry).toBe(0);
  });
});

describe("comparing two runs", () => {
  const base = {
    suiteHash: "h",
    version: "1.0.0",
    passed: 5,
    total: 10,
    firstTry: 3,
    outcomes: [],
    cost: { wallClockSeconds: 100, tokens: 10, rungs: 8 },
    at: "2026-09-20T00:00:00.000Z",
  };

  it("reports more passes as an improvement", () => {
    const v = compareRuns(base, { ...base, passed: 7 });
    expect(v).toMatchObject({ comparable: true, improved: true, delta: 2 });
  });

  it("reports fewer passes as a regression", () => {
    expect(compareRuns(base, { ...base, passed: 4 }).improved).toBe(false);
  });

  it("refuses to compare runs of different suites", () => {
    const v = compareRuns(base, { ...base, suiteHash: "other", passed: 9 });
    expect(v.comparable).toBe(false);
    expect(v.improved).toBe(false);
    expect(v.reason).toContain("different suites");
  });

  it("breaks a tie on what the score cost", () => {
    const cheaper = { ...base, cost: { ...base.cost, rungs: 5 } };
    expect(compareRuns(base, cheaper)).toMatchObject({ improved: true, delta: 0 });
    expect(compareRuns(base, cheaper).reason).toContain("fewer");
    expect(compareRuns(base, { ...base }).improved).toBe(false);
  });

  it("summarises a run in one line", () => {
    expect(summarise(base)).toContain("5/10 passed (3 first try)");
    expect(summarise(base)).toContain("repair rung");
  });
});
