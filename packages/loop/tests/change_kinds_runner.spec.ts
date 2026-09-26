import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_PROJECT_CONFIG,
  DeterministicGateRunner,
  type GateResult,
  type GateRunner,
  loadGatesConfig,
} from "@sekhemet/gates";
import { type CardRecord, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CardRunOptions, CardRunner, projectTestGate } from "../src/card_runner.js";
import { verifyCardTree } from "../src/verification.js";

// B4.0b wired into the card run (DoD: a criterion is done when the product
// reaches it): a refactor card's exported surface (GT-TQ-8), an upgrade
// card's kept tests recorded at its start and run at its verification
// (GT-TQ-11), and the acceptance tests run alone for the mutation gate's
// acceptance-test score (GT-TQ-3). Real git, a real SQLite ledger and real
// Vitest through the project's gates.toml; a scripted Worker, no model.

const REPO = join(import.meta.dirname, "..", "..", "..");
const VITEST = join(REPO, "node_modules", "vitest", "vitest.mjs");

let repo: string;
let dbDir: string;
let db: DatabaseSync;
let store: CardStore;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function seed(files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "change-kinds-runner-")));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "T");
  writeFileSync(join(repo, "package.json"), '{ "name": "k", "type": "module", "private": true }\n');
  writeFileSync(join(repo, ".gitignore"), ".sekhemet/\nnode_modules/\n");
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  // The project's test gate: the real Vitest, as gates.toml declares it.
  writeFileSync(
    join(repo, ".sekhemet", "gates.toml"),
    `[project]
builtin = []

[[gate]]
id = "unit"
rung = "test"
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(VITEST)}, "run"]
parser = "vitest"
timeout_s = 120
`,
  );
  dbDir = mkdtempSync(join(tmpdir(), "change-kinds-runner-db-"));
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
  let turns = 0;
  const adapter: LocalInferenceAdapter = {
    modelId: "scripted",
    supportedArms: ["arm_a_flat"],
    generate: async () => {
      turns++;
      return { text: "", toolCalls: script(turns), usage };
    },
  };
  return { adapter, turns: () => turns };
}

const finish: ToolCall = { id: "f", name: "finish_card", arguments: {} };
const read = (path: string): ToolCall => ({ id: "r", name: "read_file", arguments: { path } });
const write = (path: string, content: string): ToolCall => ({
  id: "w",
  name: "write_file",
  arguments: { path, content },
});

/** The declared gates pass: what is judged here is the change-kind stage. */
const passing: GateRunner = {
  runGates: async (): Promise<GateResult> => ({
    passed: true,
    failures: [],
    durationMs: 1,
    rungResults: [],
  }),
};

function runner(c: CardRecord, over: Partial<CardRunOptions> = {}): CardRunner {
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
    ...over,
  });
}

describe("a refactor card keeps its scope's exported surface (GT-TQ-8)", () => {
  const edit = (turn: number) =>
    turn === 1
      ? [read("src/lib.ts")]
      : turn === 2
        ? [write("src/lib.ts", "export const a = 1;\nconst b = 2;\nexport const c = b;\n")]
        : [finish];

  it("fails the card's verification with refactor-surface naming the removed and added names", async () => {
    seed({ "src/lib.ts": "export const a = 1;\nexport const b = 2;\n" });
    const c = await store.createCard({
      id: "card_ref",
      tier: "task",
      title: "Tidy lib",
      scopeFiles: ["src/lib.ts"],
      stepBudget: 4,
      change: "refactor",
    });
    const result = await runner(c, { modelAdapter: scripted(edit).adapter }).run();
    expect(result.passed).toBe(false);
    const surface = result.evidence.failures.find((f) => f.gate === "refactor-surface");
    expect(surface?.errorExcerpt).toContain("src/lib.ts: removed b; added c");
  }, 60_000);

  it("passes when the card declares its surface change", async () => {
    seed({ "src/lib.ts": "export const a = 1;\nexport const b = 2;\n" });
    const c = await store.createCard({
      id: "card_ref2",
      tier: "task",
      title: "Tidy lib",
      scopeFiles: ["src/lib.ts"],
      stepBudget: 4,
      change: "refactor",
      gateChecks: { surfaceChange: true },
    });
    const result = await runner(c, { modelAdapter: scripted(edit).adapter }).run();
    expect(result.evidence.failures.map((f) => f.gate)).not.toContain("refactor-surface");
    expect(result.evidence.rungResults.find((r) => r.gate === "refactor-surface")?.passed).toBe(
      true,
    );
    expect(result.passed).toBe(true);
  }, 60_000);
});

describe("an upgrade card keeps its tests passing (GT-TQ-11)", () => {
  const project = {
    "src/greet.ts": "export function greet(n: string): string {\n  return `hi ${n}`;\n}\n",
    "tests/greet.spec.ts": `import { expect, it } from "vitest";
import { greet } from "../src/greet.js";
it("greets", () => { expect(greet("a")).toBe("hi a"); });
it("greets twice", () => { expect(greet(greet("b"))).toBe("hi hi b"); });
`,
  };

  it("records the tests passing on the base on the card, and fails verification naming a kept test that breaks", async () => {
    seed(project);
    const c = await store.createCard({
      id: "card_up",
      tier: "task",
      title: "Upgrade greet",
      scopeFiles: ["src/greet.ts"],
      stepBudget: 4,
      change: "upgrade",
    });
    const breaks = (turn: number) =>
      turn === 1
        ? [read("src/greet.ts")]
        : turn === 2
          ? [
              write(
                "src/greet.ts",
                "export function greet(n: string): string {\n  return `hello ${n}`;\n}\n",
              ),
            ]
          : [finish];
    const result = await runner(c, { modelAdapter: scripted(breaks).adapter }).run();
    // The list is on the card's record, from the base's passing tests.
    expect((await store.getCard("card_up"))?.gateChecks?.keptTests).toEqual([
      "tests/greet.spec.ts > greets",
      "tests/greet.spec.ts > greets twice",
    ]);
    expect(result.passed).toBe(false);
    const kept = result.evidence.failures.filter((f) => f.gate === "upgrade-tests");
    expect(kept.map((f) => f.errorExcerpt)).toContain(
      "tests/greet.spec.ts > greets: kept by the upgrade, fails after it",
    );
  }, 120_000);

  it("passes an upgrade that keeps every kept test passing", async () => {
    seed(project);
    const c = await store.createCard({
      id: "card_up2",
      tier: "task",
      title: "Upgrade greet",
      scopeFiles: ["src/greet.ts"],
      stepBudget: 4,
      change: "upgrade",
      gateChecks: { keptTests: ["tests/greet.spec.ts > greets"] },
    });
    const keeps = (turn: number) =>
      turn === 1
        ? [read("src/greet.ts")]
        : turn === 2
          ? [
              write(
                "src/greet.ts",
                'export function greet(n: string): string {\n  return "hi " + n;\n}\n',
              ),
            ]
          : [finish];
    const result = await runner(c, { modelAdapter: scripted(keeps).adapter }).run();
    expect(result.evidence.rungResults.find((r) => r.gate === "upgrade-tests")?.passed).toBe(true);
    expect(result.passed).toBe(true);
  }, 120_000);

  it("does not start when the kept list cannot be recorded on the card: the store's error stands", async () => {
    seed(project);
    const c = await store.createCard({
      id: "card_up4",
      tier: "task",
      title: "Upgrade greet",
      scopeFiles: ["src/greet.ts"],
      stepBudget: 4,
      change: "upgrade",
    });
    const failing = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "updateCard") {
          return async () => {
            throw new Error("the ledger is read-only");
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const model = scripted(() => [finish]);
    await expect(runner(c, { modelAdapter: model.adapter, store: failing }).run()).rejects.toThrow(
      /the ledger is read-only/,
    );
    expect(model.turns()).toBe(0);
  }, 120_000);

  it("refuses to start an upgrade with no test to keep, before any step", async () => {
    seed({ "src/greet.ts": project["src/greet.ts"] });
    const c = await store.createCard({
      id: "card_up3",
      tier: "task",
      title: "Upgrade greet",
      scopeFiles: ["src/greet.ts"],
      stepBudget: 4,
      change: "upgrade",
    });
    const model = scripted(() => [finish]);
    const result = await runner(c, { modelAdapter: model.adapter }).run();
    expect(model.turns()).toBe(0);
    expect(result.stopReason).toBe("base_not_green");
    expect(result.parked?.suggestion).toMatch(/no test to keep/);
  }, 60_000);
});

describe("the mutation gate scores the acceptance tests alone (GT-TQ-3)", () => {
  it("gives the card's verification an acceptance-test score, not 'no acceptance-test run given'", async () => {
    seed({ "src/keep.ts": "export const keep = 1;\n" });
    // The card's change and its staged acceptance test, in the worktree.
    writeFileSync(
      join(repo, "src", "math.ts"),
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );
    mkdirSync(join(repo, "tests"), { recursive: true });
    writeFileSync(
      join(repo, "tests", "a.spec.ts"),
      `import { expect, it } from "vitest";
import { add } from "../src/math.js";
it("adds", () => { expect(add(2, 3)).toBe(5); });
`,
    );
    const config = loadGatesConfig(repo);
    const result = await verifyCardTree({
      root: repo,
      base: "main",
      rungs: ["test"],
      runner: new DeterministicGateRunner(new ProcessSandbox(), {
        repoRoot: repo,
        expectedConfigSha256: config.sha256,
      }),
      staged: ["a.spec.ts"],
      builtin: { project: { ...DEFAULT_PROJECT_CONFIG, builtin: [], mutation: true } },
      card: { id: "card_mut", change: "feature" },
      acceptance: {
        testGate: projectTestGate(config) as NonNullable<ReturnType<typeof projectTestGate>>,
      },
      packageGates: false,
    });
    const measure = result.rungResults.find((r) => r.gate === "mutation")?.mutation;
    expect(measure?.acceptance.reason).toBeUndefined();
    expect(measure?.acceptance.total).toBeGreaterThan(0);
    expect(measure?.acceptance.killed).toBe(measure?.acceptance.total);
  }, 120_000);
});
