import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PROJECT_CONFIG,
  DeterministicGateRunner,
  loadGatesConfig,
  readMutationQueue,
  sha256,
  writeMutationQueue,
} from "@sekhemet/gates";
import { CardStore } from "@sekhemet/kernel";
import { projectTestGate, verifyCardTree } from "@sekhemet/loop";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { MUTATION_COMPLETED, runQueuedMutations } from "../src/mutation_step.js";
import { recordOnboardingBaseline } from "../src/onboard.js";
import { runOvernight } from "../src/overnight.js";

// GT-N5-5 wired into the product: a card's verification scores the first
// `mutation_max` mutants and queues the rest; the overnight run runs the
// queue on the card's tree and records the full score on the card's ledger.
// Real git worktrees, real Vitest, a real SQLite ledger; no model.

const REPO = join(import.meta.dirname, "..", "..", "..");
const VITEST = join(REPO, "node_modules", "vitest", "vitest.mjs");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the deferred mutants run overnight (GT-N5-5)", () => {
  it("scores the queue on the card's worktree and records the full score on the card", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "nightly-mutation-")));
    dirs.push(repo);
    const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "ignore" });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "Jane Doe");
    git(repo, "config", "user.email", "jane@example.com");
    writeFileSync(
      join(repo, "package.json"),
      '{ "name": "n", "type": "module", "private": true }\n',
    );
    writeFileSync(join(repo, ".gitignore"), ".sekhemet/\n");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "keep.ts"), "export const keep = 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "seed");
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    writeFileSync(
      join(repo, ".sekhemet", "gates.toml"),
      `[[gate]]
id = "unit"
rung = "test"
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(VITEST)}, "run"]
parser = "vitest"
timeout_s = 120
`,
    );
    // The card's worktree and its change: more mutants than mutation_max.
    const tree = join(repo, ".sekhemet", "worktrees", "card_n");
    git(repo, "worktree", "add", "-q", "-b", "card_n", tree, "main");
    mkdirSync(join(tree, ".sekhemet"), { recursive: true });
    copyFileSync(join(repo, ".sekhemet", "gates.toml"), join(tree, ".sekhemet", "gates.toml"));
    writeFileSync(
      join(tree, "src", "math.ts"),
      `export function add(a: number, b: number): number {
  return a + b;
}
export function isAdult(age: number): boolean {
  return age >= 18;
}
export function larger(a: number, b: number): number {
  return a > b ? a : b;
}
`,
    );
    mkdirSync(join(tree, "tests"), { recursive: true });
    writeFileSync(
      join(tree, "tests", "math.spec.ts"),
      `import { expect, it } from "vitest";
import { add, isAdult, larger } from "../src/math.js";
it("adds", () => { expect(add(2, 3)).toBe(5); });
it("is adult at 18, not at 17", () => { expect(isAdult(18)).toBe(true); expect(isAdult(17)).toBe(false); });
it("takes the larger", () => { expect(larger(1, 2)).toBe(2); expect(larger(3, 1)).toBe(3); });
`,
    );
    const config = loadGatesConfig(tree);
    const verified = await verifyCardTree({
      root: tree,
      base: "main",
      rungs: ["test"],
      runner: new DeterministicGateRunner(new ProcessSandbox(), {
        repoRoot: tree,
        expectedConfigSha256: config.sha256,
      }),
      staged: ["math.spec.ts"],
      builtin: {
        project: { ...DEFAULT_PROJECT_CONFIG, builtin: [], mutation: true, mutationMax: 1 },
        stateDir: join(repo, ".sekhemet"),
      },
      card: { id: "card_n" },
      acceptance: {
        testGate: projectTestGate(config) as NonNullable<ReturnType<typeof projectTestGate>>,
      },
      packageGates: false,
    });
    const scored = verified.rungResults.find((r) => r.gate === "mutation")?.mutation;
    expect(scored?.partial?.deferred).toBeGreaterThan(0);
    const queuePath = join(repo, ".sekhemet", "nightly", "mutation", "card_n.json");
    expect(readMutationQueue(queuePath)?.cardId).toBe("card_n");

    const { db, log } = openLocalLedger(repo);
    const cards = new CardStore(db, log);
    const said: string[] = [];
    try {
      const summary = await runOvernight({
        repoPath: repo,
        log,
        cardStore: cards,
        hours: "none",
        limits: { kwhPerDay: 0, maxConsecutiveFailures: 3 },
        queueArgs: [],
        say: (l) => said.push(l),
        runQueue: async () => 0,
        vulnScan: async () => ({ passed: true, skipped: "not in this test" }),
      });
      expect(summary.stoppedBecause).toBe("no Ready cards left");
      const queue = readMutationQueue(queuePath);
      // Every queued mutant was judged at night (none stillborn: the project
      // declares no typecheck), and the night's kills add to the card's.
      expect(queue?.completed?.total).toBe((scored?.total ?? 0) + (scored?.partial?.deferred ?? 0));
      expect(queue?.completed?.stillborn).toBe(0);
      expect(queue?.completed?.killed).toBeGreaterThan(scored?.killed ?? 0);
      const events = await log.getEventsByTypes([MUTATION_COMPLETED]);
      expect(events).toHaveLength(1);
      expect(events[0]?.cardId).toBe("card_n");
      expect(events[0]?.payload).toMatchObject({
        queue: ".sekhemet/nightly/mutation/card_n.json",
        measure: { total: queue?.completed?.total, killed: queue?.completed?.killed },
      });
      expect(said.join("\n")).toMatch(/Nightly mutation card_n: \d+\/\d+ killed/);
    } finally {
      db.close();
    }
  }, 180_000);

  // GT-TQ-4 on a repository with a baselined type error: the typecheck is
  // read through the onboarding baseline, so it passes on the unmutated tree
  // and a mutant is stillborn only for an error of its own.
  it("reads the typecheck through the onboarding baseline before judging a mutant stillborn", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "nightly-stillborn-")));
    dirs.push(repo);
    const git = (...a: string[]) =>
      execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const files: Record<string, string> = {
      "package.json": '{ "name": "n", "type": "module", "private": true }\n',
      ".gitignore": ".sekhemet/*\n!.sekhemet/gates.toml\n",
      // The project's typecheck: an old error always; a new one for `>=` in b.ts.
      "check.mjs": `import { readFileSync } from "node:fs";
console.log("src/a.ts(2,10): error TS2304: Cannot find name 'missing'.");
if (readFileSync("src/b.ts", "utf8").includes(">= 10")) console.log("src/b.ts(1,35): error TS2365: Operator '>=' cannot be applied.");
process.exit(2);
`,
      ".sekhemet/gates.toml": `[[gate]]
id = "typecheck"
rung = "typecheck"
command = ${JSON.stringify(process.execPath)}
args = ["check.mjs"]
parser = "tsc"
`,
      "src/a.ts": "export function a(): number {\n  return missing;\n}\n",
      "src/b.ts":
        "export const big = (n: number) => n > 10;\nexport const small = (n: number) => n < 3;\n",
    };
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(join(repo, p, ".."), { recursive: true });
      writeFileSync(join(repo, p), text);
    }
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Jane Doe");
    git("config", "user.email", "jane@example.com");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    const sha = git("rev-parse", "HEAD").trim();

    const { db, log } = openLocalLedger(repo);
    try {
      mkdirSync(join(repo, ".sekhemet", "onboard"), { recursive: true });
      const baseline = await recordOnboardingBaseline(
        repo,
        join(repo, ".sekhemet", "onboard"),
        log,
      );
      expect(baseline.entries).toBe(1);
      await log.append({
        actor: "human",
        type: "card/accepted",
        cardId: "card_s",
        payload: { id: "card_s", sha },
      });
      // Two deferred mutants: `>` to `>=` (the typecheck rejects it: stillborn)
      // and `<` to `<=` (it typechecks; the tests kill it).
      const text = readFileSync(join(repo, "src", "b.ts"), "utf8");
      const at = (token: string) => text.indexOf(token);
      writeMutationQueue(join(repo, ".sekhemet"), "card_s", {
        cardId: "card_s",
        scored: { killed: 0, total: 0, stillborn: 0, equivalent: 0, acceptance: null },
        mutants: [
          { file: "src/b.ts", line: 1, start: at("> 10"), original: ">", replacement: ">=" },
          { file: "src/b.ts", line: 2, start: at("< 3"), original: "<", replacement: "<=" },
        ].map((m) => ({ ...m, fileSha256: sha256(text) })),
      });
      const runs = await runQueuedMutations(repo, log, {
        // The suite: pins `small` only.
        runTests: async (cwd) => readFileSync(join(cwd, "src", "b.ts"), "utf8").includes("n < 3"),
      });
      expect(runs.map((r) => r.skipped)).toEqual([undefined]);
      expect(runs[0]?.measure).toMatchObject({ stillborn: 1, total: 1, killed: 1, score: 1 });
      expect(runs[0]?.measure?.stillbornNotJudged).toBeUndefined();
      const events = await log.getEventsByTypes([MUTATION_COMPLETED]);
      expect(events[0]?.payload).toMatchObject({ measure: { stillborn: 1, total: 1 } });
    } finally {
      db.close();
    }
  }, 120_000);
});
