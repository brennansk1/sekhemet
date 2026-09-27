import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DeterministicGateRunner, type GateResult, type GateRunner } from "@sekhemet/gates";
import { type CardRecord, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CardRunOptions, CardRunner } from "../src/card_runner.js";

// NEW-gates-6 in the card run (gates rules 6, 6a, 32a): before any step, the
// runner judges the staged acceptance tests' strength — red at an assertion
// against the interface stub (GT-TQ-1), stub-kill (GT-TQ-2), the smell lint
// (GT-TQ-6) — at the internal-tool default profile (GT-TQ-12), and the
// evidence carries the record. Real git, a real SQLite ledger and real Vitest.

const REPO = join(import.meta.dirname, "..", "..", "..");
const VITEST = join(REPO, "node_modules", "vitest", "vitest.mjs");

let repo: string;
let dbDir: string;
let db: DatabaseSync;
let store: CardStore;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "strength-runner-")));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "T");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "package.json"), '{ "name": "s", "type": "module", "private": true }\n');
  writeFileSync(join(repo, "tsconfig.json"), '{ "compilerOptions": { "strict": true } }\n');
  writeFileSync(join(repo, "src", "keep.ts"), "export const keep = 1;\n");
  writeFileSync(join(repo, ".gitignore"), ".sekhemet/\nnode_modules/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");
  // The project's test gate: the real Vitest, as `gates.toml` declares it.
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
  dbDir = mkdtempSync(join(tmpdir(), "strength-runner-db-"));
  db = new DatabaseSync(join(dbDir, "events.db"));
  initSchema(db);
  store = new CardStore(db, new EventLog(db));
});

afterEach(() => {
  db.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

const usage = { promptTokens: 7, completionTokens: 3, durationMs: 1 };

function scripted(script: (turn: number) => ToolCall[]) {
  const seen: InferenceRequest[] = [];
  const adapter: LocalInferenceAdapter = {
    modelId: "scripted",
    supportedArms: ["arm_a_flat"],
    generate: async (req) => {
      seen.push(req);
      return { text: "", toolCalls: script(seen.length), usage };
    },
  };
  return { adapter, seen };
}

const finish: ToolCall = { id: "f", name: "finish_card", arguments: {} };
const passing: GateRunner = {
  runGates: async (): Promise<GateResult> => ({
    passed: true,
    failures: [],
    durationMs: 1,
    rungResults: [],
  }),
};

/** Fails on the base (the red-first run), passes after. */
function redThenGreen(): GateRunner {
  let calls = 0;
  return {
    runGates: async (): Promise<GateResult> =>
      calls++ === 0
        ? {
            passed: false,
            failures: [
              {
                rung: "test",
                gate: "unit",
                exitCode: 1,
                errorExcerpt: "tests/a.spec.ts adds\nTypeError",
                suggestedFixFiles: [],
                location: { file: "tests/a.spec.ts" },
                expected: "the test to pass",
                actual: "TypeError",
                minimalRepro: "vitest run tests/a.spec.ts",
                suggestedAction: "Fix it.",
              },
            ],
            durationMs: 1,
            rungResults: [],
          }
        : { passed: true, failures: [], durationMs: 1, rungResults: [] },
  };
}

async function card(
  over: Partial<Parameters<CardStore["createCard"]>[0]> = {},
): Promise<CardRecord> {
  return store.createCard({
    id: "card_s",
    tier: "task",
    title: "Add math",
    scopeFiles: ["src/math.ts"],
    stepBudget: 10,
    spec: "Add add().",
    acceptanceTests: ["a.spec.ts"],
    ...over,
  });
}

function runner(c: CardRecord, test: string, over: Partial<CardRunOptions> = {}): CardRunner {
  return new CardRunner({
    card: c,
    repoRoot: repo,
    worktreePath: join(repo, ".sekhemet", "worktrees", c.id),
    stepBudget: c.stepBudget,
    modelAdapter: scripted(() => [finish]).adapter,
    gateRunner: passing,
    syncAdapter: new NodeGitSyncAdapter(repo),
    scopeFiles: c.scopeFiles,
    store,
    // These cards' tests were written for them (the Planner or a test author).
    acceptanceTestsOrigin: "card",
    onWorktreeReady: async (wt: string) => {
      mkdirSync(join(wt, "tests"), { recursive: true });
      writeFileSync(join(wt, "tests", "a.spec.ts"), test);
    },
    ...over,
  });
}

describe("test strength before any work (NEW-gates-6)", () => {
  it("stops a card whose test fails at import with tests_not_red_for_reason, before any step", async () => {
    const c = await card();
    const { adapter, seen } = scripted(() => [finish]);
    const result = await runner(
      c,
      `import { expect, it } from "vitest";
import { add } from "../src/math.js";
import { fixture } from "./fixtures/absent.js";
it("adds", () => { expect(add(fixture, 1)).toBe(2); });
`,
      { modelAdapter: adapter },
    ).run();
    expect(seen).toHaveLength(0);
    expect(result.stopReason).toBe("tests_not_red_for_reason");
    expect(result.parked?.suggestion).toContain("tests/a.spec.ts");
    expect(result.evidence.testStrength?.redAtAssertion.status).toBe("not_red_for_reason");
  });

  it("stops a card a trivial implementation satisfies with vacuous_tests, naming the stand-in", async () => {
    const c = await card();
    const { adapter, seen } = scripted(() => [finish]);
    const result = await runner(
      c,
      `import { expect, it } from "vitest";
import { add } from "../src/math.js";
it("adds nothing to nothing", () => { expect(add(0, 0)).toBe(0); });
`,
      { modelAdapter: adapter },
    ).run();
    expect(seen).toHaveLength(0);
    expect(result.stopReason).toBe("vacuous_tests");
    expect(result.parked?.suggestion).toContain("returns 0");
    expect(result.evidence.testStrength?.stubKill.status).toBe("survived");
  });

  it("runs a card whose tests are red at an assertion and kill every stand-in, and records the strength", async () => {
    const c = await card();
    const write: ToolCall = {
      id: "w",
      name: "write_file",
      arguments: {
        path: "src/math.ts",
        content: "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      },
    };
    const { adapter, seen } = scripted((t) => (t === 1 ? [write] : [finish]));
    const result = await runner(
      c,
      `import { expect, it } from "vitest";
import { add } from "../src/math.js";
it("adds", () => { expect(add(2, 3)).toBe(5); });
it("adds a negative", () => { expect(add(2, -7)).toBe(-5); });
`,
      { modelAdapter: adapter },
    ).run();
    expect(seen.length).toBeGreaterThan(0);
    expect(result.failToPass?.status).toBe("fails");
    const strength = result.evidence.testStrength;
    expect(strength?.profileNote).toBe("depth profile: internal tool (default)");
    expect(strength?.redAtAssertion.status).toBe("red");
    expect(strength?.stubKill.status).toBe("killed");
    // The Worker started from the base: no stand-in reached its change.
    expect(result.evidence.diff).not.toContain("sekhemet");
    expect(readFileSync(join(result.worktreePath, "src", "math.ts"), "utf8")).not.toContain(
      "__sekhemetStub",
    );
  });
});

// Lead ruling under DEC-42: the default is tests received from outside
// (until the test-author step marks its own), which need only fail on the
// base; a wrong-reason failure is recorded, and the card runs.
describe("tests from outside the card (DEC-42 ruling)", () => {
  it("runs a card whose external test fails in setup, recording redForWrongReason in the evidence", async () => {
    const c = await card();
    const { adapter, seen } = scripted(() => [finish]);
    const result = await runner(
      c,
      `import { beforeEach, expect, it } from "vitest";
import { add } from "../src/math.js";
const spy = { calls: undefined as unknown as { clear(): void } };
beforeEach(() => { spy.calls.clear(); });
it("adds", () => { expect(add(2, 3)).toBe(5); });
`,
      {
        modelAdapter: adapter,
        acceptanceTestsOrigin: undefined,
        // The gate run on the base fails (the test is red there); later runs pass.
        gateRunner: redThenGreen(),
      },
    ).run();
    expect(seen.length).toBeGreaterThan(0);
    expect(result.stopReason).not.toBe("tests_not_red_for_reason");
    const strength = result.evidence.testStrength;
    expect(strength?.origin).toBe("external");
    expect(strength?.redForWrongReason?.[0]?.test).toBe("tests/a.spec.ts > adds");
    expect(result.evidence.advisories.join("\n")).toContain("redForWrongReason");
  });
});

// Lead ruling (B4.0b review): each staged file's origin is its own — `card`
// when a Planner, test-author or PM carry-over `test/staged` record matches
// its SHA-256, `external` otherwise — and the frozen suite names `external`.
describe("test origin per file in the card run (lead ruling)", () => {
  const SETUP_BROKEN = `import { beforeEach, expect, it } from "vitest";
import { add } from "../src/math.js";
const spy = { calls: undefined as unknown as { clear(): void } };
beforeEach(() => { spy.calls.clear(); });
it("adds", () => { expect(add(2, 3)).toBe(5); });
`;
  const staged = async (cardId: string, content: string, author: string) =>
    store.recordEvent({
      type: "test/staged",
      cardId,
      actor: "planner",
      payload: {
        cardId,
        path: "tests/a.spec.ts",
        sha256: createHash("sha256").update(content).digest("hex"),
        author,
      },
    });

  it("stops a card whose test a Planner record matches: the card's own, so red for the wrong reason stops it", async () => {
    const c = await card();
    await staged(c.id, SETUP_BROKEN, "planner");
    const { adapter, seen } = scripted(() => [finish]);
    const result = await runner(c, SETUP_BROKEN, {
      modelAdapter: adapter,
      acceptanceTestsOrigin: undefined,
    }).run();
    expect(seen).toHaveLength(0);
    expect(result.stopReason).toBe("tests_not_red_for_reason");
    expect(result.evidence.testStrength?.origins).toEqual({ "tests/a.spec.ts": "card" });
  });

  it("runs the card when the record is for other content, or the caller names the tests external", async () => {
    const c = await card();
    await staged(c.id, "other content", "planner");
    const other = await runner(c, SETUP_BROKEN, {
      modelAdapter: scripted(() => [finish]).adapter,
      acceptanceTestsOrigin: undefined,
      gateRunner: redThenGreen(),
    }).run();
    expect(other.stopReason).not.toBe("tests_not_red_for_reason");
    expect(other.evidence.testStrength?.origins).toEqual({ "tests/a.spec.ts": "external" });
    const d = await card({ id: "card_t" });
    await staged(d.id, SETUP_BROKEN, "planner");
    const suite = await runner(d, SETUP_BROKEN, {
      modelAdapter: scripted(() => [finish]).adapter,
      acceptanceTestsOrigin: "external",
      gateRunner: redThenGreen(),
    }).run();
    expect(suite.stopReason).not.toBe("tests_not_red_for_reason");
    expect(suite.evidence.testStrength?.origins).toEqual({ "tests/a.spec.ts": "external" });
  });
});

// Rule 34 in the card run: a quarantine begins only at the card's first
// verification — never at red-first, never after the first repair rung —
// and the evidence records every one.
describe("flaky-test quarantine in the card run (rule 34)", () => {
  /** Fails on the run numbered by `.log/fail-on` (counting in `.log/runs`), passes otherwise. */
  const FLAKY = `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
it("is flaky", () => {
  mkdirSync(".log", { recursive: true });
  const runs = (existsSync(".log/runs") ? Number(readFileSync(".log/runs", "utf8")) : 0) + 1;
  writeFileSync(".log/runs", String(runs));
  const failOn = existsSync(".log/fail-on") ? Number(readFileSync(".log/fail-on", "utf8")) : 0;
  expect(runs).not.toBe(failOn);
});
`;
  const RED = `import { expect, it } from "vitest";
import { add } from "../src/math.js";
it("adds", () => { expect(add(2, 3)).toBe(5); });
it("adds a negative", () => { expect(add(2, -7)).toBe(-5); });
`;
  const write: ToolCall = {
    id: "w",
    name: "write_file",
    arguments: {
      path: "src/math.ts",
      content: "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    },
  };
  const seed = (failOn: number, test = RED) => {
    mkdirSync(join(repo, "tests"), { recursive: true });
    writeFileSync(join(repo, "tests", "flaky.spec.ts"), FLAKY);
    writeFileSync(join(repo, ".gitignore"), ".sekhemet/\nnode_modules/\n.log/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "a flaky test");
    return async (wt: string) => {
      mkdirSync(join(wt, "tests"), { recursive: true });
      writeFileSync(join(wt, "tests", "a.spec.ts"), test);
      mkdirSync(join(wt, ".log"), { recursive: true });
      writeFileSync(join(wt, ".log", "fail-on"), String(failOn));
    };
  };
  const real = () =>
    new DeterministicGateRunner(new ProcessSandbox(), {
      repoRoot: repo,
      maxFailuresReported: Number.POSITIVE_INFINITY,
    });

  it("quarantines a flaky test at the first verification and records it in the evidence", async () => {
    const c = await card();
    const { adapter } = scripted((t) => (t === 1 ? [write] : [finish]));
    const result = await runner(c, RED, {
      modelAdapter: adapter,
      gateRunner: real(),
      // The flaky test's first run is the first verification's full suite.
      onWorktreeReady: seed(1),
    }).run();
    expect(result.stopReason).toBe("gate_passed");
    expect(result.evidence.quarantined?.count).toBe(1);
    expect(result.evidence.quarantined?.tests[0]?.test).toContain("is flaky");
  }, 120_000);

  it("never quarantines after the first verification: a later flake is a failure", async () => {
    const c = await card({ stepBudget: 4 });
    // Turn 1 finishes with nothing written: the first verification fails on
    // the acceptance tests, which are the impacted tests, so the full suite
    // — and the flaky test — does not run (rule 33, GT-N3-2). Turn 2 writes
    // the fix: at the second verification the flaky test runs for the first
    // time and fails, and its re-run would pass; quarantine is closed.
    const { adapter } = scripted((t) => (t === 1 ? [finish] : t === 2 ? [write] : [finish]));
    const result = await runner(c, RED, {
      modelAdapter: adapter,
      gateRunner: real(),
      onWorktreeReady: seed(1),
    }).run();
    expect(result.evidence.quarantined).toBeUndefined();
    expect(result.stopReason).not.toBe("gate_passed");
  }, 120_000);

  it("never quarantines at red-first: a characterize card whose base flakes is refused", async () => {
    const c = await card({ change: "characterize" });
    const PINS = `import { expect, it } from "vitest";\nit("pins max", () => { expect(Math.max(2, 3)).toBe(3); });\n`;
    const result = await runner(c, PINS, {
      modelAdapter: scripted(() => [finish]).adapter,
      gateRunner: real(),
      // The red-first gate run is the flaky test's first run.
      onWorktreeReady: seed(1, PINS),
    }).run();
    expect(result.failToPass?.status).toBe("refused");
    expect(result.stopReason).toBe("base_not_green");
    expect(result.evidence.quarantined).toBeUndefined();
  }, 120_000);
});

// DS-P14-3 at the call site: the runner judges strength under the depth
// profile a person recorded for the card's project, not the default.
describe("the recorded depth profile in the card run (DS-P14-3)", () => {
  it("judges a card's tests under its project's recorded profile", async () => {
    const project = await store.ensureProject({ rootPath: repo, name: "Shop" });
    await store.depthProfiles.choose({ profile: "prototype", projectId: project.id }, "p_owner");
    const c = await card({ projectId: project.id });
    const result = await runner(
      c,
      `import { expect, it } from "vitest";
import { add } from "../src/math.js";
it("adds", () => { expect(add(2, 3)).toBe(5); });
`,
    ).run();
    expect(result.evidence.testStrength?.profileNote).toBe("depth profile: prototype");
  });
});
