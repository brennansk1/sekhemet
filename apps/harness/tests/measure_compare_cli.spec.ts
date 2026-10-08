import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SuiteRunResult, resolveRunProfile, runProfileHash } from "@sekhemet/eval";
import { describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { cli, g2Dirs, g2Env, ledgerRows } from "./support/g2_cli.js";

/**
 * Two recorded suite runs compared through the command line (measurement §2
 * rules 10–11, MS-M12-2 to MS-M12-4; FINISH_LINE_PLAN C2d): `sekhemet measure
 * compare <baseline.json> <candidate.json>` spawned as the built binary, its
 * verdict printed and recorded on the real ledger.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned by
 * `support/g2_cli.ts`.
 */

const PROFILE = (() => {
  const p = resolveRunProfile({ env: {}, argv: ["--worker", "cyber-tiel", "--auto-accept"] });
  return { ...p, hash: runProfileHash(p) };
})();

/** A recorded run of `n` cards, `c0`…, passing where `pass(i)`. */
function run(n: number, pass: (i: number) => boolean): SuiteRunResult {
  const outcomes = Array.from({ length: n }, (_, i) => ({
    task: { suite: "alpha", cardId: `c${i}`, title: `c${i}` },
    passed: pass(i),
    wallClockSeconds: 1,
    tokens: 100,
    rungs: 0,
  }));
  const passed = outcomes.filter((o) => o.passed).length;
  return {
    suiteHash: "h",
    version: "1",
    passed,
    total: n,
    outcomes,
    cost: { wallClockSeconds: n, tokens: 100 * n, rungs: 0 },
    firstTry: passed,
    startedAt: "2026-09-20T10:00:00Z",
    at: "2026-09-20T10:00:00Z",
    runProfile: PROFILE,
  } as SuiteRunResult;
}

async function compare(baseline: SuiteRunResult, candidate: SuiteRunResult) {
  const where = g2Dirs();
  const { db } = openLocalLedger(where.cwd);
  db.close();
  const dir = join(where.root, "runs");
  mkdirSync(dir);
  const a = join(dir, "baseline.json");
  const b = join(dir, "candidate.json");
  writeFileSync(a, JSON.stringify(baseline));
  writeFileSync(b, JSON.stringify(candidate));
  const r = await cli(["measure", "compare", a, b], { cwd: where.cwd, env: g2Env(where.home) });
  const event = ledgerRows(where.cwd).find((x) => x.type === "measure/compared")?.payload;
  return { r, event };
}

describe("sekhemet measure compare", () => {
  it("MS-M12-2: pairs only the cards run in both, reports the discordant counts, the exact McNemar p and the smallest detectable difference", async () => {
    // The candidate ran five more cards; they are not paired.
    const { r, event } = await compare(
      run(30, (i) => i >= 10),
      run(35, () => true),
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(
      "+10 on 30 paired card(s) (10 gained, 0 lost; exact McNemar p = 0.0020) — improved",
    );
    expect(r.stdout).toMatch(/smallest difference detectable at 80% power: \d+ points/);
    expect(event).toMatchObject({
      paired: 30,
      candidateOnly: 10,
      baselineOnly: 0,
      verdict: "improved",
    });
    expect(event?.p as number).toBeCloseTo(2 * 0.5 ** 10, 10);
  });

  it("MS-M12-3: two runs that differ by one task, not significant, are never reported improved", async () => {
    const { r, event } = await compare(
      run(30, (i) => i !== 0),
      run(30, () => true),
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(
      "+1 on 30 paired card(s) (1 gained, 0 lost; exact McNemar p = 1.0000)",
    );
    expect(r.stdout).toContain("not established: not significant at 0.05");
    expect(r.stdout).not.toMatch(/— improved/);
    expect(event).toMatchObject({ improved: false, verdict: "not established" });
  });

  it("MS-M12-4: an effect under 20 points is marked not established — from 30 cards, and even when significant on more", async () => {
    // Five of thirty: under 20 points.
    const thirty = await compare(
      run(30, (i) => i >= 5),
      run(30, () => true),
    );
    expect(thirty.r.stdout).toContain("+5 on 30 paired card(s)");
    expect(thirty.r.stdout).toContain("— not established");
    expect(thirty.event).toMatchObject({ improved: false, verdict: "not established" });
    // Fifteen of a hundred is significant, and still under the claimable effect.
    const hundred = await compare(
      run(100, (i) => i >= 15),
      run(100, () => true),
    );
    expect(hundred.r.stdout).toContain("+15 on 100 paired card(s)");
    expect(hundred.r.stdout).toContain(
      "— not established: under the 20-point effect the suite can claim",
    );
    expect(hundred.event).toMatchObject({ improved: false, verdict: "not established" });
  });
});

describe("sekhemet measure compare: each run's pass rate and, over repeated runs, pass@k (MS-M12-1, MS-M12-5)", () => {
  it("MS-M12-1, MS-M12-5: prints and records each side's passed over measured with its exact interval, blocked and not-run apart, and pass@k and pass^k when a side names repeated runs", async () => {
    const where = g2Dirs();
    const { db } = openLocalLedger(where.cwd);
    db.close();
    const dir = join(where.root, "runs");
    mkdirSync(dir);
    const files = {
      a1: run(10, (i) => i < 6),
      a2: run(10, (i) => i < 4),
      b1: run(10, () => true),
    };
    const blocked = run(10, () => true);
    (blocked.outcomes[9] as { blocked?: boolean }).blocked = true;
    for (const [name, r] of Object.entries({ ...files, b2: blocked }))
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(r));
    const path = (n: string) => join(dir, `${n}.json`);
    const r = await cli(
      ["measure", "compare", `${path("a1")},${path("a2")}`, `${path("b1")},${path("b2")}`],
      { cwd: where.cwd, env: g2Env(where.home) },
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^Baseline: 6\/10 passed \(95% CI \d+%-\d+%; 6 first try\)/m);
    expect(r.stdout).toMatch(/^Candidate: 10\/10 passed \(95% CI \d+%-100%; 10 first try\)/m);
    // Over two runs each: cards 0-3 passed both, 4-5 once, 6-9 never.
    expect(r.stdout).toMatch(/^Baseline over 2 runs: pass@2 60%, pass\^2 40% \(10 issues\)$/m);
    // The candidate's blocked card is measured once only, so it is not in pass@2.
    expect(r.stdout).toMatch(/^Candidate over 2 runs: pass@2 100%, pass\^2 100% \(9 issues\)$/m);
    const event = ledgerRows(where.cwd).find((x) => x.type === "measure/compared")?.payload;
    expect(event).toMatchObject({
      baselineScore: { passed: 6, measured: 10, blocked: 0, notRun: 0 },
      candidateScore: { passed: 10, measured: 10 },
      passK: {
        baseline: { k: 2, cards: 10, passAtK: 0.6, passHatK: 0.4 },
        candidate: { k: 2, cards: 9, passAtK: 1, passHatK: 1 },
      },
    });
  }, 60_000);
});
