import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  BudgetPolicyStore,
  type SuiteRunResult,
  profileSwitchCount,
  resolveRunProfile,
  runProfileHash,
} from "@sekhemet/eval";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { TOOL_CATALOG } from "@sekhemet/loop";
import { afterEach, describe, expect, it } from "vitest";
import {
  autoAcceptRefusal,
  computeFootprint,
  profileForQueue,
  profileForRun,
  readMeasurementMarker,
  runMeasureCommand,
  writeMeasurementMarker,
} from "../src/measure_cmd.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "sek-measure-"));
  dirs.push(d);
  return d;
};
const write = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

function kernel() {
  const repoPath = temp();
  mkdirSync(join(repoPath, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(repoPath, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  return { repoPath, log, cardStore: new CardStore(db, log) };
}

function run(
  passes: boolean[],
  tokens: number[],
  startedAt = "2026-09-20T10:00:00Z",
): SuiteRunResult {
  const outcomes = passes.map((passed, i) => ({
    task: { suite: "alpha", cardId: `c${i}`, title: `c${i}` },
    passed,
    wallClockSeconds: 1,
    tokens: tokens[i] ?? 0,
    rungs: 0,
  }));
  return {
    suiteHash: "h",
    version: "1",
    passed: passes.filter(Boolean).length,
    total: passes.length,
    outcomes,
    cost: { wallClockSeconds: passes.length, tokens: tokens.reduce((a, b) => a + b, 0), rungs: 0 },
    firstTry: passes.filter(Boolean).length,
    startedAt,
    at: startedAt,
    runProfile: PROFILE,
  };
}

const PROFILE = (() => {
  const p = resolveRunProfile({ env: {}, argv: ["--worker", "cyber-tiel", "--auto-accept"] });
  return { ...p, hash: runProfileHash(p) };
})();

const ENTRY = JSON.stringify({
  costMeasure: "median tokens per card",
  recordedAt: "2026-09-19T00:00:00Z",
});
/** A run started under the A/B entry, as `run_suite.mjs --ab-entry` records it. */
const underEntry = (r: SuiteRunResult): SuiteRunResult => ({
  ...r,
  abEntry: {
    sha256: createHash("sha256").update(ENTRY).digest("hex"),
    costMeasure: "median tokens per card",
    recordedAt: "2026-09-19T00:00:00Z",
  },
});

describe("the run's profile for `sekhemet run` (MS-M9-4, MS-M9-5)", () => {
  it("records a settings file's hash and applies its switches", () => {
    const dir = temp();
    write(dir, "arm.json", '{ "switches": { "thinking": "surgical" } }');
    const p = profileForRun(["run", "c1", "--settings", join(dir, "arm.json")], {});
    expect(p.switches.thinking).toBe("surgical");
    expect(p.settingsFile?.path).toBe(join(dir, "arm.json"));
    expect(p.settingsFile?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses --profile, and a queue setting `run` would not honour", () => {
    expect(() => profileForRun(["run", "c1", "--profile", "full"], {})).toThrow(
      /--settings <file>/,
    );
    expect(() => profileForRun(["run", "c1", "--review"], {})).toThrow(
      /sekhemet run does not run policies.review/,
    );
  });
});

describe("the queue's profile, the suite's path (MS-M9-1, MS-M9-4)", () => {
  it("records configuration, the tuned step budget, the environment's Researcher and flags", () => {
    const p = profileForQueue(
      ["queue", "--worker", "cyber-tiel", "--auto-accept"],
      { SEKHEMET_RESEARCHER: "apodex", SEKHEMET_THINKING: "off" },
      { worker: "nail", manager: "dirk" },
      16,
    );
    expect(p.roles).toEqual({ worker: "cyber-tiel", manager: "dirk", researcher: "apodex" });
    expect(p.policies).toMatchObject({ stepCap: 16, autoAccept: true, review: false });
    expect(p.sources).toMatchObject({
      "roles.worker": "flag",
      "roles.manager": "config",
      "roles.researcher": "env",
      "policies.stepCap": "config",
    });
  });

  it("refuses --profile and --settings, which the queue does not resolve into one profile", () => {
    expect(() => profileForQueue(["queue", "--profile", "full"], {}, {})).toThrow(/--profile/);
    expect(() => profileForQueue(["queue", "--settings", "x.json"], {}, {})).toThrow(
      /the queue does not read --settings/,
    );
  });
});

describe("--auto-accept is bounded to measured runs (review M5)", () => {
  it("refuses --auto-accept in a repository no measured run prepared", () => {
    const repo = temp();
    expect(autoAcceptRefusal(["queue", "--worker", "w"], repo)).toBeUndefined();
    expect(autoAcceptRefusal(["queue", "--auto-accept"], repo)).toMatch(
      /only in a repository a measured run prepared.*the human is the rate limiter/,
    );
  });

  it("allows it where the suite runner or m0 wrote the measurement marker, and reads the marker back", () => {
    const repo = temp();
    writeMeasurementMarker(repo, "frozen suite", "scripts/run_suite.mjs");
    expect(autoAcceptRefusal(["queue", "--auto-accept"], repo)).toBeUndefined();
    expect(readMeasurementMarker(repo)).toMatchObject({
      purpose: "frozen suite",
      by: "scripts/run_suite.mjs",
    });
  });
});

describe("the footprint of a build (rule 16c, MS-T8-13)", () => {
  it("counts non-test TypeScript lines, the tool catalog and the switches, stamped with its commit", () => {
    const root = temp();
    write(root, "packages/a/src/x.ts", "export const a = 1;\n\nexport const b = 2;\n");
    write(root, "packages/a/src/x.spec.ts", "test\ntest\n");
    write(root, "packages/a/tests/y.ts", "ignored\n");
    write(root, "apps/b/src/y.ts", "export {};\n");
    write(root, "apps/b/src/__tests__/z.ts", "ignored\n");
    write(root, "scripts/s.ts", "ignored\n");
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=T", ...a], { cwd: root });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    const f = computeFootprint(root);
    expect(f.linesOfCode).toBe(3);
    expect(f.tools).toBe(TOOL_CATALOG.length);
    expect(f.switches).toBe(profileSwitchCount());
    expect(f.stablePromptTokens).toBeGreaterThan(0);
    expect(f.stablePromptTokensEstimated).toBe(true);
    expect(f.commit).toMatch(/^[0-9a-f]{12}$/);
    expect(f.dirty).toBe(false);
  });
});

describe("sekhemet measure (MS-T8-13, MS-T8-14 wired)", () => {
  it("admit: evaluates two paired runs per arm against recorded footprints and records the verdict", async () => {
    const k = kernel();
    const d = temp();
    const same = Array(10).fill(true).concat(Array(10).fill(false));
    write(d, "b1.json", JSON.stringify(underEntry(run(same, Array(20).fill(100)))));
    write(d, "b2.json", JSON.stringify(underEntry(run(same, Array(20).fill(100)))));
    write(d, "c1.json", JSON.stringify(underEntry(run(same, Array(20).fill(90)))));
    write(d, "c2.json", JSON.stringify(run(same, Array(20).fill(90))));
    write(d, "entry.json", ENTRY);
    const fp = { stablePromptTokens: 900, tools: 20, switches: 12, linesOfCode: 1000 };
    write(d, "before.json", JSON.stringify({ ...fp, commit: "aaaaaaaaaaaa", dirty: false }));
    write(
      d,
      "after.json",
      JSON.stringify({ ...fp, switches: 13, commit: "bbbbbbbbbbbb", dirty: false }),
    );
    const lines: string[] = [];
    const code = await runMeasureCommand(
      [
        "admit",
        "--baseline",
        `${join(d, "b1.json")},${join(d, "b2.json")}`,
        "--candidate",
        `${join(d, "c1.json")},${join(d, "c2.json")}`,
        "--entry",
        join(d, "entry.json"),
        "--before",
        join(d, "before.json"),
        "--after",
        join(d, "after.json"),
      ],
      k,
      (l) => lines.push(l),
    );
    // One candidate run was not started under the entry: refused (review M2).
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/does not carry the A\/B entry/);
    write(d, "c2.json", JSON.stringify(underEntry(run(same, Array(20).fill(90)))));
    lines.length = 0;
    // A dirty footprint names a commit it does not match (review minor).
    write(d, "dirty.json", JSON.stringify({ ...fp, commit: "cccccccccccc", dirty: true }));
    const argv = (after: string) => [
      "admit",
      "--baseline",
      `${join(d, "b1.json")},${join(d, "b2.json")}`,
      "--candidate",
      `${join(d, "c1.json")},${join(d, "c2.json")}`,
      "--entry",
      join(d, "entry.json"),
      "--before",
      join(d, "before.json"),
      "--after",
      join(d, after),
    ];
    expect(await runMeasureCommand(argv("dirty.json"), k, (l) => lines.push(l))).toBe(1);
    expect(lines.join("\n")).toMatch(/dirty checkout/);
    lines.length = 0;
    expect(await runMeasureCommand(argv("after.json"), k, (l) => lines.push(l))).toBe(0);
    // Same passes, fewer tokens on every card, but a switch added: "cheaper".
    expect(lines.join("\n")).toMatch(/not established — cheaper \(bbbbbbbbbbbb\)/);
    const events = await k.log.getEventsByTypes(["measure/admission"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ verdict: "not established — cheaper" });
  });

  it("admit: refuses a footprint that is not stamped with its commit", async () => {
    const k = kernel();
    const d = temp();
    write(
      d,
      "fp.json",
      JSON.stringify({ stablePromptTokens: 1, tools: 1, switches: 1, linesOfCode: 1 }),
    );
    const lines: string[] = [];
    const code = await runMeasureCommand(
      [
        "admit",
        "--baseline",
        "x",
        "--candidate",
        "y",
        "--entry",
        "z",
        "--before",
        join(d, "fp.json"),
        "--after",
        join(d, "fp.json"),
      ],
      k,
      (l) => lines.push(l),
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/not stamped with its commit/);
  });

  it("rule-credit: computes a rule's credit from attempt/finished records and records it", async () => {
    const k = kernel();
    for (let i = 0; i < 4; i++) {
      await k.log.append({
        actor: "harness",
        type: "attempt/finished",
        payload: {
          cardId: `c${i}`,
          projectId: "p",
          cardClass: "task",
          attemptNumber: 1,
          stopReason: i % 2 ? "passed" : "gates_failed",
          rules: i % 2 ? ["rule_x"] : [],
          withheldRules: i % 2 ? [] : ["rule_x"],
        },
      });
    }
    const lines: string[] = [];
    expect(await runMeasureCommand(["rule-credit", "rule_x"], k, (l) => lines.push(l))).toBe(0);
    expect(lines.join("\n")).toMatch(/rule_x: .*insufficient data/);
    const events = await k.log.getEventsByTypes(["learning/credit"]);
    expect(events[0]?.payload).toMatchObject({ ruleId: "rule_x", status: "insufficient data" });
  });
});

describe("sekhemet measure watch: the paired rollback (MS-T8-3, MS-T8-10)", () => {
  async function setup() {
    const k = kernel();
    const d = temp();
    const without = run(Array(20).fill(true).concat(Array(10).fill(false)), Array(30).fill(100));
    const lossy = run(Array(10).fill(true).concat(Array(20).fill(false)), Array(30).fill(100));
    write(d, "w1.json", JSON.stringify(lossy));
    write(d, "w2.json", JSON.stringify(lossy));
    write(d, "o1.json", JSON.stringify(without));
    write(d, "o2.json", JSON.stringify(without));
    // A generated test promoted because of the change, and one that was not.
    await k.cardStore.createCard({
      id: "gen_1",
      tier: "task",
      title: "Pin add()",
      status: "backlog",
      spec: "Add a test.",
      labels: ["generated-test", "promoted-by:budget_x"],
    });
    await k.cardStore.createCard({
      id: "gen_2",
      tier: "task",
      title: "Pin sub()",
      status: "backlog",
      labels: ["generated-test", "promoted-by:other"],
    });
    const args = (id: string, kind: string) => [
      "watch",
      id,
      "--kind",
      kind,
      "--with",
      `${join(d, "w1.json")},${join(d, "w2.json")}`,
      "--without",
      `${join(d, "o1.json")},${join(d, "o2.json")}`,
    ];
    return { k, args };
  }

  it("rolls back a budget change a paired loss resolves, flags it, and demotes the tests it promoted", async () => {
    const { k, args } = await setup();
    const store = new BudgetPolicyStore(join(k.repoPath, ".sekhemet", "budget_policy.json"));
    const before = store.current();
    const applied = store.apply({ stepBudget: before.stepBudget + 4, maxFailedChecks: 3 }, "tuned");
    // The generated test names this change.
    await k.cardStore.updateCard("gen_1", {
      labels: ["generated-test", `promoted-by:${applied.id}`],
    });
    const lines: string[] = [];
    expect(await runMeasureCommand(args(applied.id, "budget"), k, (l) => lines.push(l))).toBe(0);
    expect(lines.join("\n")).toMatch(/rolled back: budget_\w+ lost 20 and gained 0/);
    expect(
      new BudgetPolicyStore(join(k.repoPath, ".sekhemet", "budget_policy.json")).current(),
    ).toEqual(before);
    const demoted = await k.cardStore.getCard("gen_1");
    expect(demoted?.labels).toEqual(["generated-test", "advisory"]);
    expect(demoted?.spec).toMatch(/Demoted to advisory: .* was rolled back/);
    expect((await k.cardStore.getCard("gen_2"))?.labels).toContain("promoted-by:other");
    const events = await k.log.getEventsByTypes(["measure/rolled_back"]);
    expect(events[0]?.payload).toMatchObject({
      changeId: applied.id,
      kind: "budget",
      demoted: ["gen_1"],
    });
  });

  it("records a harness change's rollback for its revert, which the harness cannot make itself", async () => {
    const { k, args } = await setup();
    const lines: string[] = [];
    expect(await runMeasureCommand(args("ctx-9", "harness"), k, (l) => lines.push(l))).toBe(0);
    expect(lines.join("\n")).toMatch(/revert ctx-9/);
    expect((await k.log.getEventsByTypes(["measure/rolled_back"]))[0]?.payload).toMatchObject({
      changeId: "ctx-9",
      kind: "harness",
    });
  });

  it("refuses to watch a project rule: its credit decides it, never the suite (rule 16b)", async () => {
    const { k, args } = await setup();
    const lines: string[] = [];
    expect(await runMeasureCommand(args("rule_1", "rule"), k, (l) => lines.push(l))).toBe(1);
    expect(lines.join("\n")).toMatch(/rule-credit/);
  });
});
