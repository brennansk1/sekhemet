import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runFrozenSuite, runScore, summarise } from "../src/suite.js";
import {
  type CardInfo,
  type QueueEntryRecord,
  type QueueRunDriver,
  cardOutcome,
  seededCards,
  suiteQueueRunner,
  unmetDependencies,
} from "../src/suite_runner.js";

/** A prepared fixture repository: b builds on a's module, c on nothing. */
function fixtureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "suite-runner-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "acceptance"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "");
  writeFileSync(join(repo, "src", "b.ts"), "");
  writeFileSync(join(repo, "acceptance", "b.test.ts"), 'import { a } from "../src/a.js";\n');
  return repo;
}

const INFO: Record<string, CardInfo> = {
  card_a: { scope: ["src/a.ts"], tests: [], spec: "Write a." },
  card_b: { scope: ["src/b.ts"], tests: ["b.test.ts"], spec: "Use a." },
  card_c: { scope: ["src/c.ts"], tests: [], spec: "Write c." },
};

function writeBundle(
  repo: string,
  name: string,
  body: { cardId: string; attempt: number; passed: boolean; stopReason?: string; tokens?: object },
): void {
  const dir = join(repo, ".sekhemet", "evidence");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(body));
}

const entry = (
  cardId: string,
  attempt: number,
  passed: boolean,
  extra: Partial<QueueEntryRecord> = {},
): QueueEntryRecord => ({
  cardId,
  attempt,
  passed,
  accepted: passed,
  stopReason: passed ? "gates_passed" : "gates_failed",
  durationMs: 10_000,
  promptTokens: 100 * attempt,
  completionTokens: attempt,
  ...extra,
});

/**
 * A driver whose "queue" is scripted: it writes the queue report, the
 * evidence bundles and what acceptance merged. No model, no child process.
 */
function driver(
  repo: string,
  script: {
    entries?: QueueEntryRecord[];
    bundles?: Parameters<typeof writeBundle>[2][];
    merge?: Record<string, string>;
    timedOut?: boolean;
    noReport?: boolean;
    waitingOn?: Record<string, string[]>;
  },
): QueueRunDriver & { runs: { repo: string; timeoutMs: number }[] } {
  const runs: { repo: string; timeoutMs: number }[] = [];
  return {
    runs,
    prepare: () => repo,
    resolveCardId: (task) => task.cardId,
    cardInfo: (_repo, id) => INFO[id],
    waitingOn: (_repo, id) => script.waitingOn?.[id] ?? [],
    runQueue: (r, timeoutMs) => {
      runs.push({ repo: r, timeoutMs });
      for (const b of script.bundles ?? [])
        writeBundle(repo, `ev_${b.cardId}_${b.attempt}.json`, b);
      for (const [file, text] of Object.entries(script.merge ?? {}))
        writeFileSync(join(repo, file), text);
      // The queue writes its report after every entry (review M4): a run the
      // timeout stopped leaves a partial one.
      if (!script.noReport) {
        mkdirSync(join(repo, ".sekhemet"), { recursive: true });
        writeFileSync(
          join(repo, ".sekhemet", "queue_report.json"),
          JSON.stringify({
            entries: script.entries ?? [],
            ...(script.timedOut ? { partial: true } : {}),
          }),
        );
      }
      return { timedOut: script.timedOut === true };
    },
  };
}

const TASKS = ["card_a", "card_b", "card_c"].map((cardId) => ({
  suite: "alpha",
  cardId,
  title: cardId,
}));
const suite = { version: "1", hash: "h", tasks: TASKS };

describe("the suite runner module, on the product's queue path (MS-M9-3, MS-M9-1)", () => {
  it("runs each fixture's cards in one queue run, with a timeout for all of them", async () => {
    const repo = fixtureRepo();
    const d = driver(repo, {
      entries: [entry("card_a", 1, true), entry("card_b", 1, true), entry("card_c", 1, true)],
      merge: { "src/a.ts": "export const a = 1;\n" },
    });
    const r = await runFrozenSuite(
      suite,
      suiteQueueRunner(d, { tasks: TASKS, cardTimeoutMs: 60_000 }),
    );
    expect(d.runs).toEqual([{ repo, timeoutMs: 180_000 }]);
    expect(r.passed).toBe(3);
  });

  it("records a card the queue deferred, or ran against a dependency never built, as blocked", async () => {
    const repo = fixtureRepo();
    // The queue deferred b (its prerequisite a did not merge) …
    const deferred = await runFrozenSuite(
      suite,
      suiteQueueRunner(
        driver(repo, {
          entries: [entry("card_a", 1, false), entry("card_c", 1, true)],
          waitingOn: { card_b: ["card_a"] },
        }),
        { tasks: TASKS, cardTimeoutMs: 60_000 },
      ),
    );
    expect(deferred.outcomes[1]).toMatchObject({
      blocked: true,
      stopReason: "blocked: the queue deferred it; prerequisites card_a did not merge",
    });
    // … or ran it, but src/a was still empty on main when the run ended.
    const ranAnyway = await runFrozenSuite(
      suite,
      suiteQueueRunner(
        driver(fixtureRepo(), {
          entries: [entry("card_a", 1, false), entry("card_b", 1, false), entry("card_c", 1, true)],
        }),
        { tasks: TASKS, cardTimeoutMs: 60_000 },
      ),
    );
    expect(ranAnyway.outcomes[1]?.blocked).toBe(true);
    expect(ranAnyway.outcomes[1]?.stopReason).toMatch(
      /^blocked: src\/a never built \(an earlier card failed\); the queue ran it: gates_failed$/,
    );
    expect(unmetDependencies(repo, INFO.card_b as CardInfo)).toEqual(["src/a"]);
  });

  it("says when a passing card was not accepted, so later cards could not build on it", async () => {
    const r = await runFrozenSuite(
      suite,
      suiteQueueRunner(
        driver(fixtureRepo(), {
          entries: [
            entry("card_a", 1, true, { accepted: false, held: "review: WIP limit" }),
            entry("card_c", 1, true),
          ],
          waitingOn: { card_b: ["card_a"] },
        }),
        { tasks: TASKS, cardTimeoutMs: 60_000 },
      ),
    );
    expect(r.outcomes[0]).toMatchObject({
      passed: true,
      stopReason:
        "passed, but not accepted (held: review: WIP limit): later cards cannot build on it",
    });
  });

  it("after a timeout, reads the partial report: finished cards keep their outcome, the killed card is the runner's, the rest are not run (review M4)", async () => {
    const repo = fixtureRepo();
    const r = await runFrozenSuite(
      suite,
      suiteQueueRunner(
        driver(repo, {
          timedOut: true,
          // card_a finished and was accepted; card_b was running when the queue was killed.
          entries: [entry("card_a", 1, true)],
          merge: { "src/a.ts": "export const a = 1;\n" },
          bundles: [
            {
              cardId: "card_b",
              attempt: 1,
              passed: false,
              stopReason: "gates failed",
              tokens: { promptTokens: 100, completionTokens: 10 },
            },
          ],
        }),
        { tasks: TASKS, cardTimeoutMs: 20 * 60_000 },
      ),
    );
    expect(r.outcomes[0]).toMatchObject({ passed: true, tokens: 101 });
    expect(r.outcomes[0]?.stopReason).toBeUndefined();
    expect(r.outcomes[1]?.stopReason).toBe(
      "timed out after 60 min (last recorded attempt 1: gates failed)",
    );
    expect(r.outcomes[1]?.tokens).toBe(110);
    expect(r.outcomes[2]).toMatchObject({
      passed: false,
      notRun: true,
      stopReason: "no attempt recorded: the runner stopped the queue after 60 min",
    });
    // Not run is unmeasured, like blocked: 1 of 2 measured cards passed.
    expect(runScore(r)).toMatchObject({ passed: 1, measured: 2, notRun: 1 });
    expect(summarise(r)).toMatch(/1\/2 passed .*1 not run/);
    // Timed-out cards on bundles alone keep their own label (no bundle: did not start).
    expect(cardOutcome(fixtureRepo(), "card_a", 1).stopReason).toBe(
      "card did not start (no evidence bundle)",
    );
  });

  it("totals tokens and time over every attempt the queue ran, and counts repair rungs", async () => {
    const r = await runFrozenSuite(
      suite,
      suiteQueueRunner(
        driver(fixtureRepo(), {
          entries: [entry("card_a", 1, false), entry("card_a", 2, true), entry("card_c", 1, true)],
          merge: { "src/a.ts": "export const a = 1;\n" },
          waitingOn: {},
        }),
        { tasks: TASKS, cardTimeoutMs: 60_000 },
      ),
    );
    expect(r.outcomes[0]).toMatchObject({
      passed: true,
      tokens: 303,
      rungs: 1,
      wallClockSeconds: 20,
    });
    expect(r.cost.tokens).toBe(303 + 101);
  });

  it("names a queue that wrote no report instead of scoring its cards as the model's failures", async () => {
    const r = await runFrozenSuite(
      suite,
      suiteQueueRunner(driver(fixtureRepo(), { noReport: true }), {
        tasks: TASKS,
        cardTimeoutMs: 60_000,
      }),
    );
    expect(r.outcomes.map((o) => o.stopReason)).toEqual(
      Array(3).fill("not run: the queue wrote no report (it refused to run or crashed)"),
    );
    // Unmeasured, not the model's failures (review M4).
    expect(r.outcomes.every((o) => o.notRun === true)).toBe(true);
    expect(runScore(r)).toMatchObject({ passed: 0, measured: 0, notRun: 3 });
  });

  it("reads the seeded cards from the board and checks the count against the manifest", () => {
    const repo = fixtureRepo();
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    db.exec(
      "create table cards (id text, order_key text, scope_files text, acceptance_tests text, spec text)",
    );
    const ins = db.prepare("insert into cards values (?, ?, ?, ?, ?)");
    ins.run("card_b", "2", '["src/b.ts"]', '["b.test.ts"]', "Use a.");
    ins.run("card_a", "1", '["src/a.ts"]', "[]", "Write a.");
    db.close();
    const cards = seededCards(repo, 2);
    expect(cards.map((c) => c.id)).toEqual(["card_a", "card_b"]);
    expect(cards[1]?.info).toEqual(INFO.card_b);
    expect(() => seededCards(repo, 3)).toThrow(/seeded 2 card\(s\), manifest declares 3/);
  });
});
