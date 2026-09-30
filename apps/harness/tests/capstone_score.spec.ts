import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
// @ts-expect-error: plain ESM scripts, run by hand and checked here.
import * as score from "../../../scripts/capstone/score.mjs";
// @ts-expect-error: plain ESM scripts, run by hand and checked here.
import * as seed from "../../../scripts/capstone/seed.mjs";

/**
 * The capstone's scorer (W2 G5, CAPSTONE_SELECTION "Protocol"). The hidden
 * suite is data here: it is run only against the empty seed (which must
 * score 0) and against the sealed reference solution (which must score
 * 100%), never against a contestant. Its per-test results stay inside the
 * sealed directory; what the scorer returns holds counts only. The blind
 * packet holds no arm identity.
 *
 * The sealed runs are heavy (the whole suite, twice per tree, with an
 * install) and copy the sealed reference, so they run only when asked
 * (`SEKHEMET_CAPSTONE_SEALED_TESTS=1`), never in every gate, and every copy of
 * the reference is made in the sealed scratch root beside the suite, never in
 * the shared temp directory.
 */

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const HIDDEN = resolve(
  process.env.SEKHEMET_CAPSTONE_HIDDEN || join(homedir(), ".sekhemet", "capstone-hidden"),
);
const RUN_SEALED =
  process.env.SEKHEMET_CAPSTONE_SEALED_TESTS === "1" && existsSync(join(HIDDEN, "run.mjs"));
const SCORER_RESULTS = join(HIDDEN, "results", `scorer-spec-${process.pid}`);

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
afterAll(() => rmSync(SCORER_RESULTS, { recursive: true, force: true }));
function temp(prefix = "capstone-scorer-spec-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}
/** A scratch directory in the sealed scratch root, for anything that holds the reference. */
function sealedTemp(): string {
  const d = score.sealedScratch(HIDDEN, "scorer-spec-");
  temps.push(d);
  return d;
}
function git(dir: string, ...args: string[]): string {
  const r = spawnSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.name=Contestant",
      "-c",
      "user.email=c@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      encoding: "utf8",
    },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A fresh seed repository whose release-1 tag is the seed itself: an arm that wrote nothing. */
function emptyRun(): string {
  const repo = join(temp(), "repo");
  seed.materialise(repo);
  git(repo, "tag", "release-1");
  return repo;
}

/**
 * The reference solution as a contestant's history: edition 1 tagged release-1
 * at 1.0.0, then edition 2 at 2.0.0. The seed is made in the temp directory
 * (seed.mjs refuses the sealed one), then moved into the sealed scratch root
 * before any of the reference is copied in.
 */
function referenceRun(): string {
  const made = join(temp(), "repo");
  seed.materialise(made);
  const repo = join(sealedTemp(), "repo");
  renameSync(made, repo);
  const ref = join(HIDDEN, "reference");
  const edition = (n: number, version: string) => {
    cpSync(ref, repo, {
      recursive: true,
      filter: (src) => !/[/\\](node_modules|dist|data)([/\\]|$)/.test(src.slice(ref.length)),
    });
    writeFileSync(
      join(repo, "src", "edition.ts"),
      `// 1: release 1 (US federal weekly overtime). 2: after the California change request.\n// prove.mjs writes 1 here for the release-1 reference.\nexport const EDITION: number = ${n};\n`,
    );
    for (const f of ["package.json", "package-lock.json"]) {
      const j = JSON.parse(readFileSync(join(repo, f), "utf8"));
      j.version = version;
      if (j.packages?.[""]) j.packages[""].version = version;
      writeFileSync(join(repo, f), `${JSON.stringify(j, null, 2)}\n`);
    }
    git(repo, "add", "--all");
    git(repo, "commit", "--quiet", "-m", `Release ${version}`);
  };
  edition(1, "1.0.0");
  git(repo, "tag", "release-1");
  git(repo, "tag", "v1.0.0");
  edition(2, "2.0.0");
  git(repo, "tag", "v2.0.0");
  return repo;
}

/** Every test name in the sealed results the scorer wrote. */
function sealedNames(dir: string): string[] {
  const names: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      if (n.isDirectory()) walk(join(d, n.name));
      else if (n.name.endsWith(".json")) {
        const r = JSON.parse(readFileSync(join(d, n.name), "utf8"));
        for (const t of [...(r.tests ?? []), ...(r.notScored ?? [])]) names.push(t.name);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return names;
}

const runsEnv = () => ({
  ...process.env,
  SEKHEMET_CAPSTONE_RUNS: join(temp(), "runs"),
  SEKHEMET_CAPSTONE_HIDDEN: HIDDEN,
});

describe.skipIf(!RUN_SEALED)("the hidden suite through the scorer", () => {
  it("is the frozen suite: every file's SHA-256 is the manifest's", () => {
    expect(score.suiteDrift(HIDDEN)).toEqual([]);
  });

  it(
    "scores the empty seed 0 in both phases, with counts only",
    async () => {
      const sealedDir = join(SCORER_RESULTS, "seed");
      const s = await score.scoreRun({
        armId: "one-shot-haiku",
        run: 1,
        tree: emptyRun(),
        env: runsEnv(),
        findingsToo: false,
        showcase: temp(),
        sealedDir,
      });
      expect(s.releaseOne.passed).toBe(0);
      expect(s.releaseOne.total).toBeGreaterThan(0);
      expect(s.afterChange.passed).toBe(0);
      expect(s.afterChange.total).toBeGreaterThan(s.releaseOne.total);
      expect(s.releaseOne.build).toBe(false);
      expect(s.regressions.count).toBe(0);
      expect(s.mutation.notRun).toMatch(/Stryker/);
      const text = JSON.stringify(s);
      const names = sealedNames(sealedDir);
      expect(names.length).toBeGreaterThan(100);
      // Only a count on failure: a test's name is never printed.
      expect(names.filter((n) => text.includes(n)).length).toBe(0);
    },
    30 * 60_000,
  );

  it(
    "scores the reference solution 100% in both phases, with no regressions, and reports its findings",
    async () => {
      const sealedDir = join(SCORER_RESULTS, "reference");
      const s = await score.scoreRun({
        armId: "claude-code-opus",
        run: 1,
        tree: referenceRun(),
        env: runsEnv(),
        showcase: temp(),
        sealedDir,
      });
      expect(s.releaseOne.passed).toBe(s.releaseOne.total);
      expect(s.releaseOne.passRate).toBe(1);
      expect(s.afterChange.passed).toBe(s.afterChange.total);
      expect(s.afterChange.passRate).toBe(1);
      expect(s.regressions).toMatchObject({ count: 0 });
      expect(s.regressions.comparable).toBeGreaterThan(50);
      expect(s.releases).toMatchObject({
        count: 2,
        tags: ["v1.0.0", "v2.0.0"],
        versionAtReleaseOne: "1.0.0",
        versionAtEnd: "2.0.0",
      });
      expect(s.findings.type.errors).toBe(0);
      expect(typeof s.findings.lint.errors).toBe("number");
      expect(s.findings.lint.filesChecked).toBeGreaterThan(3);
      expect(typeof s.findings.hygiene.findings).toBe("number");
      expect(typeof s.findings.security.findings).toBe("number");
      expect(
        s.findings.sekhemetGates.find((g: { id: string }) => g.id === "typecheck")?.passed,
      ).toBe(true);
      expect(s.accessibility.notRun).toMatch(/no screenshots run/);
      // A run with no log is scored but never pooled, and nothing is published unregistered.
      expect(s.valid).toBe(false);
      expect(s.hiddenSuite.registered).toBe(false);
      const text = JSON.stringify(s);
      expect(sealedNames(sealedDir).filter((n) => text.includes(n)).length).toBe(0);
      // Nothing of the reference was left in the shared temp directory.
      expect(readdirSync(tmpdir()).filter((n) => /^(capstone-score-|ts-hidden-)/.test(n))).toEqual(
        [],
      );
    },
    30 * 60_000,
  );

  it("keeps the hidden suite's results inside its sealed directory", async () => {
    await expect(
      score.scoreRun({
        armId: "one-shot-opus",
        run: 1,
        tree: emptyRun(),
        env: runsEnv(),
        findingsToo: false,
        sealedDir: join(temp(), "out"),
      }),
    ).rejects.toThrow(/sealed directory/);
  });
});

describe("the scorer's parts", () => {
  it("reads the suite's record beside the contestant-visible directory, never inside it", () => {
    const record = join(ROOT, "fixtures", "capstone", "hidden.manifest.json");
    expect(existsSync(record)).toBe(true);
    expect(
      existsSync(join(ROOT, "fixtures", "capstone", "timesheet", "hidden.manifest.json")),
    ).toBe(false);
    const fake = temp();
    writeFileSync(join(fake, "run.mjs"), "// not the suite\n");
    const drift = score.suiteDrift(fake);
    expect(drift[0]).toMatch(/not the frozen/);
    expect(drift[0]).toContain(JSON.parse(readFileSync(record, "utf8")).suiteSha256);
  });

  it("refuses a hidden suite that is not the frozen one", () => {
    const fake = temp();
    writeFileSync(join(fake, "run.mjs"), "// not the suite\n");
    expect(score.suiteDrift(fake).length).toBeGreaterThan(0);
    expect(score.suiteDrift(join(fake, "missing"))[0]).toMatch(/no hidden suite/);
  });

  const t = (name: string, status: string, release = "release 1", priority = "Must") => ({
    name,
    status,
    release,
    priority,
  });

  it("counts a regression as a release-1 test that passed at the tag and fails after the change", () => {
    const r1 = { tests: [t("a", "pass"), t("b", "pass"), t("c", "fail"), t("d", "pass")] };
    const r2 = {
      tests: [t("a", "pass"), t("b", "fail"), t("c", "fail"), t("e", "fail", "change request")],
    };
    expect(score.regressions(r1, r2)).toEqual({ count: 1, byPriority: { Must: 1 }, comparable: 3 });
  });

  it("reads wall-clock, hands-on minutes, simulated decisions and tokens from the log", () => {
    const log = [
      { at: "2026-10-01T10:00:00.000Z", kind: "start" },
      { at: "2026-10-01T10:05:00.000Z", kind: "person", minutes: 7 },
      { at: "2026-10-01T10:06:00.000Z", kind: "person", minutes: 0, simulated: true },
      {
        at: "2026-10-01T10:07:00.000Z",
        kind: "usage",
        inputTokens: 100,
        outputTokens: 40,
        costUsd: 0.25,
      },
      {
        at: "2026-10-01T10:08:00.000Z",
        kind: "usage",
        inputTokens: 10,
        outputTokens: 4,
        costUsd: 0.5,
      },
      { at: "2026-10-01T10:08:00.000Z", kind: "reply", unparsedCount: 2 },
      { at: "2026-10-01T11:30:00.000Z", kind: "end" },
    ];
    expect(score.effort(log)).toEqual({
      wallClockMinutes: 90,
      handsOnMinutes: 7,
      simulatedDecisions: 1,
      inputTokens: 110,
      outputTokens: 44,
      costUsd: 0.75,
      unparsedFiles: 2,
      tokensNotCounted: null,
      tokensByRole: null,
    });
  });

  // Measurement rule 4a: the Sekhemet arm's usage names every role's tokens
  // from the product's ledger; the scorer totals them by role over the run.
  it("totals every role's tokens over a run's phases", () => {
    const role = (i: number, o: number, c = 0, requests = 1) => ({
      inputTokens: i,
      outputTokens: o,
      cacheReadTokens: c,
      requests,
    });
    const log = [
      { at: "2026-10-01T10:00:00.000Z", kind: "start" },
      {
        at: "2026-10-01T10:07:00.000Z",
        kind: "usage",
        phase: "release-1",
        inputTokens: 1900,
        outputTokens: 330,
        byRole: { worker: role(900, 130, 500, 2), seshat: role(1000, 200, 0, 3) },
      },
      {
        at: "2026-10-01T10:08:00.000Z",
        kind: "usage",
        phase: "change-request",
        inputTokens: 700,
        outputTokens: 90,
        byRole: { seshat: role(400, 50), reviewer: role(300, 40, 100) },
      },
      { at: "2026-10-01T11:30:00.000Z", kind: "end" },
    ];
    expect(score.effort(log)).toMatchObject({
      inputTokens: 2600,
      outputTokens: 420,
      tokensNotCounted: null,
      tokensByRole: {
        worker: role(900, 130, 500, 2),
        seshat: role(1400, 250, 0, 4),
        reviewer: role(300, 40, 100),
      },
    });
  });

  it("marks tokens that leave some models out, so they are not compared across arms", () => {
    const notCounted =
      "Seshat's, the Planning model's and the Review model's tokens: the product's ledger does not record them";
    const log = [
      { at: "2026-10-01T10:00:00.000Z", kind: "start" },
      {
        at: "2026-10-01T10:07:00.000Z",
        kind: "usage",
        inputTokens: 100,
        outputTokens: 40,
        notCounted,
      },
      {
        at: "2026-10-01T10:08:00.000Z",
        kind: "usage",
        inputTokens: 10,
        outputTokens: 4,
        notCounted,
      },
      { at: "2026-10-01T11:30:00.000Z", kind: "end" },
    ];
    expect(score.effort(log)).toMatchObject({
      inputTokens: 110,
      outputTokens: 44,
      tokensNotCounted: notCounted,
    });
  });

  const result = (passes: boolean[]) => {
    const tests = passes.map((p, i) => ({ name: `t${i}`, status: p ? "pass" : "fail" }));
    const passed = passes.filter(Boolean).length;
    return { tests, passed, total: passes.length, passRate: passed / passes.length };
  };

  it("reports pass^k and pass@k over an arm's runs, each with an exact interval", async () => {
    const s = await score.armStats([
      result([true, true, false, false]),
      result([true, false, true, false]),
    ]);
    expect(s.runs).toBe(2);
    expect(s.passHatK).toMatchObject({ k: 2, passed: 1, rate: 0.25 });
    expect(s.passAtK).toMatchObject({ k: 2, passed: 3, rate: 0.75 });
    expect(s.passHatK.interval.low).toBeLessThan(0.25);
    expect(s.passHatK.interval.high).toBeGreaterThan(0.25);
    expect(s.perRun[0].interval.high).toBeLessThanOrEqual(1);
  });

  it("says no clear difference when the paired tests cannot separate two arms", async () => {
    const a = [result(Array.from({ length: 40 }, (_, i) => i % 2 === 0))];
    const b = [result(Array.from({ length: 40 }, (_, i) => i % 2 === 0 || i === 1))];
    const close = await score.compareArms(a, b);
    expect(close).toMatchObject({
      pairedTests: 40,
      onlyFirstPassed: 0,
      onlySecondPassed: 1,
      verdict: "no clear difference",
    });
    expect(close.smallestDetectablePoints).toBeGreaterThan(0);
    const far = await score.compareArms(
      [result(Array.from({ length: 40 }, () => true))],
      [result(Array.from({ length: 40 }, (_, i) => i >= 30))],
    );
    expect(far.verdict).toBe("the first arm ahead");
    expect(far.pValue).toBeLessThan(0.05);
  });

  it("compares two arms over the same number of runs, so more runs never mean a stricter pass^k", async () => {
    const all = result([true, true, true, true]);
    const three = [all, all, result([true, true, true, false])];
    const two = [all, all];
    const c = await score.compareArms(three, two);
    expect(c).toMatchObject({
      k: 2,
      runsLeftOut: { first: 1, second: 0 },
      onlyFirstPassed: 0,
      onlySecondPassed: 0,
    });
  });

  const log = (events: Record<string, unknown>[]) => events;
  const PROMPT_SHA = JSON.parse(
    readFileSync(join(ROOT, "fixtures", "capstone", "timesheet", "manifest.json"), "utf8"),
  ).files;
  const complete = (row: "one-shot" | "harness") =>
    log([
      { kind: "start" },
      { kind: "given", phase: "release-1", frozenSha256: PROMPT_SHA["prompt.md"].sha256 },
      ...(row === "one-shot"
        ? [{ kind: "reply", phase: "release-1" }]
        : [{ kind: "release_1_finished" }]),
      { kind: "change_given", frozenSha256: PROMPT_SHA["change_request.md"].sha256 },
      ...(row === "one-shot" ? [{ kind: "reply", phase: "change-request" }] : []),
      { kind: "end" },
    ]);

  it("lets into the statistics only runs given the frozen input whole that finished", () => {
    expect(score.runValidity(complete("one-shot"), "one-shot-opus")).toEqual([]);
    expect(score.runValidity(complete("harness"), "claude-code-opus")).toEqual([]);
    expect(score.runValidity([], "claude-code-opus").length).toBeGreaterThan(2);
    const noChange = complete("harness").filter((e) => e.kind !== "change_given");
    expect(score.runValidity(noChange, "claude-code-opus")).toContain(
      "change_request.md was never given",
    );
    const stopped = [...complete("harness"), { kind: "stopped", why: "Seshat refused" }];
    expect(score.runValidity(stopped, "sekhemet-local").join()).toMatch(/stopped: Seshat refused/);
    const wrong = complete("one-shot").map((e) =>
      e.kind === "given" ? { ...e, frozenSha256: "0".repeat(64) } : e,
    );
    expect(score.runValidity(wrong, "one-shot-opus")).toContain(
      "what was given first is not the frozen prompt.md",
    );
  });

  it("pools only valid runs, in run order, and says which it left out and why", () => {
    const hidden = temp();
    const put = (arm: string, run: number, valid: boolean | null, passes: boolean[]) => {
      const d = join(hidden, "results", "scored", arm, String(run));
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "change-request.json"), JSON.stringify(result(passes)));
      if (valid !== null)
        writeFileSync(
          join(d, "validity.json"),
          JSON.stringify({ valid, problems: valid ? [] : ["the run did not end"] }),
        );
    };
    put("claude-code-opus", 2, true, [false]);
    put("claude-code-opus", 1, true, [true]);
    put("claude-code-opus", 3, false, [true]);
    put("sekhemet-local", 1, null, [true]);
    const pooled = score.sealedResults(hidden, "change-request");
    expect(Object.keys(pooled)).toEqual(["claude-code-opus"]);
    expect(pooled["claude-code-opus"].map((r: { passed: number }) => r.passed)).toEqual([1, 0]);
    expect(pooled.excluded).toEqual([
      { arm: "claude-code-opus", run: 3, why: ["the run did not end"] },
      { arm: "sekhemet-local", run: 1, why: ["no validity record"] },
    ]);
  });

  it("counts only the hygiene findings that hold every arm alike: debug output, not Sekhemet's trailers or changelog", () => {
    const f = (errorExcerpt: string) => ({ gate: "hygiene", errorExcerpt });
    expect(
      score.neutralHygiene([
        f("src/a.ts:3 leaves debug output: console.log(x)"),
        f("commit abc lacks the Agent-Model: and Agent-Harness: trailer(s)"),
        f("Source changed but CHANGELOG.md has no entry for it"),
        { gate: "secrets", errorExcerpt: "leaves debug output" },
      ]),
    ).toHaveLength(1);
  });

  it("publishes nothing until the suite is registered at its hash with a person's labels", async () => {
    const record = join(ROOT, "fixtures", "capstone", "hidden.manifest.json");
    const suite = JSON.parse(readFileSync(record, "utf8")).suiteSha256;
    expect((await score.suiteRegistration(record)).registered).toBe(false);
    const assets = (labelledBy: string, hash = suite) => {
      const f = join(temp(), "eval_assets.json");
      writeFileSync(
        f,
        JSON.stringify({
          about: "",
          assets: [{ name: "capstone-hidden-suite", hash, labelledBy }],
        }),
      );
      return f;
    };
    expect((await score.suiteRegistration(record, assets("person: A. Reviewer"))).registered).toBe(
      true,
    );
    expect((await score.suiteRegistration(record, assets("claude-opus-5-5"))).registered).toBe(
      false,
    );
    expect(
      (await score.suiteRegistration(record, assets("executed against the reference"))).registered,
    ).toBe(false);
    expect(
      (await score.suiteRegistration(record, assets("person: A. Reviewer", "0".repeat(64))))
        .registered,
    ).toBe(false);
  });

  it("compares rows for the harness's effect and columns for the models', only where both arms have runs", async () => {
    const r = [result([true, false, true])];
    const g = await score.gridStats({
      "one-shot-nail-mtp": r,
      "sekhemet-local": r,
      "one-shot-opus": r,
    });
    expect(
      g.comparisons.map(
        (c: { kind: string; first: string; second: string }) =>
          `${c.kind}: ${c.first} / ${c.second}`,
      ),
    ).toEqual([
      "harness effect: one-shot-nail-mtp / sekhemet-local",
      "model effect: one-shot-nail-mtp / one-shot-opus",
    ]);
  });
});

describe("the blind packet", () => {
  function contestant(files: Record<string, string>): string {
    const repo = temp();
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(join(repo, p, ".."), { recursive: true });
      writeFileSync(join(repo, p), text);
    }
    spawnSync("git", ["init", "-q", repo]);
    return repo;
  }

  it("holds each run's code under a random name with no arm, harness or model named anywhere", () => {
    const runs = [
      {
        arm: "claude-code-opus",
        run: 1,
        repo: contestant({
          "CLAUDE.md": "# Notes for Claude\n",
          ".claude/settings.json": "{}\n",
          "src/main.ts":
            "// Written with Claude Code (claude-opus-5-5) for Anthropic's grid.\nexport const thumbnail = 1;\n",
          "src/sonnet-notes.md": "Sonnet said so.\n",
          "package.json": '{ "name": "timesheet", "author": "Sekhemet agent" }\n',
        }),
      },
      {
        arm: "sekhemet-local",
        run: 2,
        repo: contestant({
          ".sekhemet/events.db": "binary",
          "src/pay.ts":
            "// Agent: nail-mtp through Seshat; one-shot? no. qwen3.8\nexport const pay = 2;\n",
        }),
      },
    ];
    const base = temp();
    const out = join(base, "packet");
    const key = join(base, "key.json");
    const r = score.blindPacket({ runs, out, keyFile: key });
    expect(r.entries).toHaveLength(2);
    for (const e of r.entries) expect(e).toMatch(/^entry-[0-9a-f]{8}$/);
    expect(score.identityLeaks(out)).toEqual([]);
    const all = JSON.stringify(readdirSync(out, { recursive: true }));
    expect(all).not.toMatch(/CLAUDE\.md|\.claude|\.sekhemet|\.git/);
    const texts = r.entries.map((e: string) => readdirSync(join(out, e), { recursive: true }));
    // Four files and each entry's src directory: the harness files are dropped.
    expect(texts.flat().length).toBe(6);
    const keyed = JSON.parse(readFileSync(key, "utf8")).key;
    expect(keyed.map((k: { arm: string }) => k.arm).sort()).toEqual([
      "claude-code-opus",
      "sekhemet-local",
    ]);
    const opus = keyed.find((k: { arm: string }) => k.arm === "claude-code-opus");
    expect(readFileSync(join(out, opus.entry, "src", "main.ts"), "utf8")).toContain(
      "export const thumbnail = 1;",
    );
  });

  it("drops the frozen input a long message committed, so it is not a fingerprint", () => {
    const prompt = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "fixtures", "capstone", "timesheet", "prompt.md"),
      "utf8",
    );
    const runs = [
      {
        arm: "sekhemet-local",
        run: 1,
        repo: contestant({
          "docs/product/inputs/2026-09-29-what-i-need-timesheets-and-overtime-for-hollis-bakery.md":
            prompt.trim(),
          "docs/product/brief.md": "# The brief\n",
          "src/pay.ts": "export const pay = 2;\n",
        }),
      },
    ];
    const base = temp();
    const out = join(base, "packet");
    const r = score.blindPacket({ runs, out, keyFile: join(base, "key.json") });
    const files = readdirSync(join(out, r.entries[0]), { recursive: true }).map(String);
    expect(files.some((f: string) => f.includes("inputs"))).toBe(false);
    expect(files).toContain(join("docs", "product", "brief.md"));
    expect(files).toContain(join("src", "pay.ts"));
    const keyed = JSON.parse(readFileSync(join(base, "key.json"), "utf8")).key;
    expect(keyed[0].harnessFilesDropped).toBe(1);
  });

  it("refuses a key inside the packet", () => {
    const base = temp();
    expect(() =>
      score.blindPacket({ runs: [], out: join(base, "p"), keyFile: join(base, "p", "key.json") }),
    ).toThrow(/key may not be inside/);
  });
});
