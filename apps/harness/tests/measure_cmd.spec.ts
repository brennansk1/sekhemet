import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  applyProfileSwitches,
  autoAcceptRefusal,
  computeFootprint,
  profileForQueue,
  profileForRun,
  readMeasurementMarker,
  runMeasureCommand,
  withoutProfileFlags,
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

  it("refuses --profile, which would set four other flags (SUR-45)", () => {
    expect(() => profileForQueue(["queue", "--profile", "full"], {}, {})).toThrow(/--profile/);
  });

  it("SUR-45: applies --settings as one layer and records its path, SHA-256 and contents", () => {
    const dir = temp();
    const text = '{ "roles": { "manager": "dirk" }, "policies": { "review": true } }';
    write(dir, "arm.json", text);
    const p = profileForQueue(
      ["queue", "--settings", join(dir, "arm.json"), "--worker", "cyber-tiel"],
      {},
      { worker: "nail" },
    );
    expect(p.roles).toMatchObject({ worker: "cyber-tiel", manager: "dirk" });
    expect(p.policies.review).toBe(true);
    expect(p.sources).toMatchObject({ "roles.manager": "settings", "roles.worker": "flag" });
    expect(p.settingsFile).toEqual({
      path: join(dir, "arm.json"),
      sha256: createHash("sha256").update(text).digest("hex"),
      contents: text,
    });
    expect(() => profileForQueue(["queue", "--settings", join(dir, "none.json")], {}, {})).toThrow(
      /no settings file/,
    );
    // The queue then reads the profile's flags in place of the ones given.
    expect(
      withoutProfileFlags([
        "queue",
        "--repo",
        "/r",
        "--worker",
        "x",
        "--review",
        "--settings",
        "f.json",
        "--max-turns",
        "9",
        "--auto-accept",
      ]),
    ).toEqual(["queue", "--repo", "/r"]);
  });
});

describe("the profile's switches reach the code that reads them (MS-T7-6)", () => {
  it("sets the prune switch for this process when a flag or settings file named it", () => {
    const env: Record<string, string | undefined> = {};
    applyProfileSwitches(profileForRun(["run", "c1", "--prune", "random"], {}), env);
    expect(env.SEKHEMET_PRUNE).toBe("random");
    const none: Record<string, string | undefined> = {};
    applyProfileSwitches(profileForRun(["run", "c1"], {}), none);
    expect(none.SEKHEMET_PRUNE).toBeUndefined();
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
    // Interleaved A, B, A, B (MS-T7-4).
    const t = (m: number) => `2026-09-20T10:0${m}:00.000Z`;
    write(d, "b1.json", JSON.stringify(underEntry(run(same, Array(20).fill(100), t(0)))));
    write(d, "b2.json", JSON.stringify(underEntry(run(same, Array(20).fill(100), t(2)))));
    write(d, "c1.json", JSON.stringify(underEntry(run(same, Array(20).fill(90), t(1)))));
    write(d, "c2.json", JSON.stringify(run(same, Array(20).fill(90), t(3))));
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
    write(d, "c2.json", JSON.stringify(underEntry(run(same, Array(20).fill(90), t(3)))));
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
    const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
    expect(events[0]?.payload).toMatchObject({
      verdict: "not established — cheaper",
      adopted: true,
      // Resolved paths with their hashes, and what a later run must match (review B1, minor 6).
      baselineRuns: [
        { path: join(d, "b1.json"), sha256: sha(join(d, "b1.json")) },
        { path: join(d, "b2.json"), sha256: sha(join(d, "b2.json")) },
      ],
      baselineProfileHash: PROFILE.hash,
      baselineMode: "sequential",
    });

    // After a later suite run, every adopted change is watched against the
    // runs it was compared with (MS-T8-3: watch started after a suite run).
    const lossy = run(Array(20).fill(false), Array(20).fill(90), "2026-09-21T10:00:00.000Z");
    // Runs that are not comparable are skipped and named, never tested.
    write(d, "other-worker.json", JSON.stringify({ ...lossy, worker: "nail" }));
    write(d, "an-ab.json", JSON.stringify(underEntry(lossy)));
    for (const f of ["other-worker.json", "an-ab.json"]) {
      lines.length = 0;
      expect(
        await runMeasureCommand(["watch-adopted", "--with", join(d, f)], k, (l) => lines.push(l)),
      ).toBe(0);
      expect(lines.join("\n")).toMatch(/not comparable/);
    }
    expect(await k.log.getEventsByTypes(["measure/rolled_back"])).toEqual([]);
    write(d, "later.json", JSON.stringify(lossy));
    lines.length = 0;
    expect(
      await runMeasureCommand(["watch-adopted", "--with", join(d, "later.json")], k, (l) =>
        lines.push(l),
      ),
    ).toBe(0);
    // The first look (after one later run): 10 losses resolve at 0.05 / 3.
    expect(lines.join("\n")).toMatch(
      /rolled back: bbbbbbbbbbbb: stopped: 0 gained, 10 lost over 20 paired cards after 1 later run \(look 1\)/,
    );
    const rolled = await k.log.getEventsByTypes(["measure/rolled_back"]);
    expect(rolled[0]?.payload).toMatchObject({ changeId: "bbbbbbbbbbbb", kind: "harness" });
    // A change already rolled back is not watched again.
    lines.length = 0;
    await runMeasureCommand(["watch-adopted", "--with", join(d, "later.json")], k, (l) =>
      lines.push(l),
    );
    expect(lines.join("\n")).toMatch(/no adopted change to watch/);
  });

  it("watch-adopted: an admission recorded before the profile record is named not watchable, once", async () => {
    const k = kernel();
    const d = temp();
    write(d, "b.json", JSON.stringify(run([true, true], [1, 1])));
    await k.log.append({
      actor: "harness",
      type: "measure/admission",
      payload: {
        verdict: "admitted",
        adopted: true,
        version: "ctx-old",
        baselineRuns: [join(d, "b.json")],
      },
    });
    write(d, "later.json", JSON.stringify(run([true, true], [1, 1], "2026-09-21T10:00:00.000Z")));
    const lines: string[] = [];
    await runMeasureCommand(["watch-adopted", "--with", join(d, "later.json")], k, (l) =>
      lines.push(l),
    );
    await runMeasureCommand(["watch-adopted", "--with", join(d, "later.json")], k, (l) =>
      lines.push(l),
    );
    expect(
      lines.filter((l) =>
        /ctx-old: not watchable: admitted before B2\.4's profile record; re-admit to watch/.test(l),
      ),
    ).toHaveLength(1);
    expect(await k.log.getEventsByTypes(["measure/not_watchable"])).toHaveLength(1);
  });

  it("watch-adopted: a baseline run that changed since admission is named, and the other changes are still watched", async () => {
    const k = kernel();
    const d = temp();
    write(d, "b.json", JSON.stringify(run([true, true], [1, 1])));
    const sha = createHash("sha256")
      .update(readFileSync(join(d, "b.json")))
      .digest("hex");
    const admitted = (version: string, path: string, sha256: string) =>
      k.log.append({
        actor: "harness",
        type: "measure/admission",
        payload: {
          verdict: "admitted",
          adopted: true,
          version,
          baselineRuns: [{ path, sha256 }],
          baselineProfileHash: PROFILE.hash,
          baselineMode: "sequential",
        },
      });
    await admitted("ctx-a", join(d, "b.json"), "0".repeat(64));
    await admitted("ctx-b", join(d, "b.json"), sha);
    write(d, "later.json", JSON.stringify(run([true, true], [1, 1], "2026-09-21T10:00:00.000Z")));
    const lines: string[] = [];
    expect(
      await runMeasureCommand(["watch-adopted", "--with", join(d, "later.json")], k, (l) =>
        lines.push(l),
      ),
    ).toBe(0);
    const text = lines.join("\n");
    expect(text).toMatch(/ctx-a: .*changed since it was admitted/);
    expect(text).toMatch(/watching ctx-b/);
  });

  it("promote: a person promotes a generated test, labelled with the adopted change in force (MS-T8-10)", async () => {
    const k = kernel();
    await k.cardStore.createCard({
      id: "gen_9",
      tier: "task",
      title: "Pin add()",
      status: "backlog",
      labels: ["mutation-hardening", "advisory"],
    });
    await k.log.append({
      actor: "harness",
      type: "measure/admission",
      payload: { verdict: "admitted", adopted: true, version: "ctx-12", baselineRuns: [] },
    });
    const lines: string[] = [];
    const promoted = await runMeasureCommand(["promote", "gen_9"], k, (l) => lines.push(l));
    expect(lines.join("\n")).toMatch(/promoted gen_9/);
    expect(promoted).toBe(0);
    expect((await k.cardStore.getCard("gen_9"))?.labels).toEqual([
      "mutation-hardening",
      "promoted",
      "promoted-by:ctx-12",
    ]);
    expect(lines.join("\n")).toMatch(/promoted gen_9.*ctx-12/);
    // With more than one change in force, the person names which (review minor 8).
    await k.log.append({
      actor: "harness",
      type: "measure/admission",
      payload: { verdict: "admitted", adopted: true, version: "ctx-13", baselineRuns: [] },
    });
    await k.cardStore.createCard({
      id: "gen_10",
      tier: "task",
      title: "Pin sub()",
      status: "backlog",
      labels: ["mutation-hardening", "advisory"],
    });
    const more: string[] = [];
    expect(await runMeasureCommand(["promote", "gen_10"], k, (l) => more.push(l))).toBe(1);
    expect(more.join("\n")).toMatch(
      /2 changes are adopted \(ctx-12, ctx-13\): name one with --because/,
    );
    expect(await runMeasureCommand(["promote", "gen_10", "--because", "ctx-13"], k, () => {})).toBe(
      0,
    );
    // Only a generated test can be promoted.
    await k.cardStore.createCard({ id: "plain", tier: "task", title: "x", status: "backlog" });
    expect(await runMeasureCommand(["promote", "plain"], k, () => {})).toBe(1);
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

describe("sekhemet measure compare: two recorded runs, paired (MS-M12-2, compareRuns wired)", () => {
  it("prints the paired verdict and pass@k over repeated runs, and records it", async () => {
    const k = kernel();
    const d = temp();
    write(d, "a.json", JSON.stringify(run(Array(30).fill(true), Array(30).fill(1))));
    write(
      d,
      "b.json",
      JSON.stringify(run(Array(30).fill(true).fill(false, 0, 22), Array(30).fill(1))),
    );
    const lines: string[] = [];
    expect(
      await runMeasureCommand(["compare", join(d, "a.json"), join(d, "b.json")], k, (l) =>
        lines.push(l),
      ),
    ).toBe(0);
    expect(lines.join("\n")).toMatch(/-22 on 30 paired card\(s\).*worse/);
    const [event] = await k.log.getEventsByTypes(["measure/compared"]);
    expect(event?.payload).toMatchObject({ verdict: "worse", baselineOnly: 22 });
    expect(await runMeasureCommand(["compare", join(d, "a.json")], k, () => {})).toBe(1);
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
