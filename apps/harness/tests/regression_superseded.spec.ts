import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DeterministicGateRunner, compileEvidence } from "@sekhemet/gates";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { withRegressionGate } from "../src/regression_gate.js";

// NEW-gates-7, GT-BF-1 (gates rule 25a): a card that changes behaviour an
// existing test asserts declares that test as superseded, with its new
// version staged; the regression gate accepts exactly those failures and
// lists each supersession for the evidence. Real git, real Vitest, real SQLite.

const REPO = join(import.meta.dirname, "..", "..", "..");
const VITEST = join(REPO, "node_modules", "vitest", "vitest.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "superseded-")));
  dirs.push(root);
  const files: Record<string, string> = {
    "package.json": '{ "name": "s", "type": "module", "private": true }\n',
    ".gitignore": ".sekhemet/state/\nnode_modules/\n",
    ".sekhemet/gates.toml": `
[[gate]]
id = "unit"
rung = "test"
command = "node"
args = [${JSON.stringify(VITEST)}, "run", "--reporter=default"]
parser = "vitest"
timeout_s = 120
`,
    "src/greet.ts": "export const greet = (n: string): string => `hi ${n}`;\n",
    "tests/greet.spec.ts": `import { expect, it } from "vitest";
import { greet } from "../src/greet.js";
it("greets", () => { expect(greet("a")).toBe("hi a"); });
it("keeps the name", () => { expect(greet("a")).toContain("a"); });
`,
  };
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  // The card changes the greeting; its new expectation is staged as its acceptance test.
  writeFileSync(
    join(root, "src/greet.ts"),
    "export const greet = (n: string): string => `hello ${n}`;\n",
  );
  writeFileSync(
    join(root, "tests/greet_hello.spec.ts"),
    // The new version of "greets": the same test, the new expectation.
    'import { expect, it } from "vitest";\nimport { greet } from "../src/greet.js";\nit("greets", () => { expect(greet("a")).toBe("hello a"); });\n',
  );
  return root;
}

const inner = (root: string) =>
  new DeterministicGateRunner(new ProcessSandbox(), {
    repoRoot: root,
    maxFailuresReported: Number.POSITIVE_INFINITY,
  });

describe("superseded tests (GT-BF-1, rule 25a)", () => {
  it("without a declaration the broken base test is a regression", async () => {
    const root = repo();
    const r = await withRegressionGate(inner(root), {
      ownTests: ["greet_hello.spec.ts"],
      base: "main",
    }).runGates(["test"], root);
    expect(r.passed).toBe(false);
    expect(r.failures.filter((f) => f.gate === "regression")).toHaveLength(1);
  });

  it("accepts exactly the declared superseded test whose new version is staged, and lists it", async () => {
    const root = repo();
    const r = await withRegressionGate(inner(root), {
      ownTests: ["greet_hello.spec.ts"],
      base: "main",
      superseded: ["tests/greet.spec.ts > greets"],
    }).runGates(["test"], root);
    expect(r.failures).toEqual([]);
    expect(r.passed).toBe(true);
    const outcome = r.rungResults?.find((o) => o.gate === "regression");
    expect(outcome?.superseded).toEqual([
      { test: "tests/greet.spec.ts > greets", staged: ["greet_hello.spec.ts"] },
    ]);
    expect(r.rungResults?.find((o) => o.gate === "unit")?.passed).toBe(true);
    // The evidence bundle lists every supersession (rule 35).
    const evidence = compileEvidence({
      cardId: "c1",
      attempt: 1,
      diff: "",
      filesTouched: [],
      linesAdded: 0,
      linesRemoved: 0,
      gateResult: r,
      turnsUsed: 1,
      stopReason: "gate_passed",
      checkpointShas: [],
      tokens: { promptTokens: 0, completionTokens: 0 },
      durationMs: 0,
      settings: {} as never,
      gatesConfigSha256: "x",
    });
    expect(evidence.superseded).toEqual([
      { test: "tests/greet.spec.ts > greets", staged: ["greet_hello.spec.ts"] },
    ]);
  });

  it("refuses a supersession with no new version staged, and any other broken base test", async () => {
    const root = repo();
    const unstaged = await withRegressionGate(inner(root), {
      ownTests: [],
      base: "main",
      superseded: ["tests/greet.spec.ts > greets"],
    }).runGates(["test"], root);
    expect(unstaged.passed).toBe(false);
    expect(unstaged.failures.some((f) => f.gate === "regression")).toBe(true);

    // The card also breaks a test it did not declare: that one stays a regression.
    writeFileSync(
      join(root, "src/greet.ts"),
      "export const greet = (_n: string): string => `hello`;\n",
    );
    const other = await withRegressionGate(inner(root), {
      ownTests: ["greet_hello.spec.ts"],
      base: "main",
      superseded: ["tests/greet.spec.ts > greets"],
    }).runGates(["test"], root);
    expect(other.passed).toBe(false);
    expect(
      other.failures
        .filter((f) => f.gate === "regression")
        .map((f) => f.errorExcerpt.split("\n")[0]),
    ).toEqual([expect.stringContaining("keeps the name")]);
  });

  // Minor 2: a supersession names tests, and counts only with the new
  // version of that test among the staged acceptance tests.
  it("refuses a bare file, and a test whose new version is not staged", async () => {
    const root = repo();
    const bare = await withRegressionGate(inner(root), {
      ownTests: ["greet_hello.spec.ts"],
      base: "main",
      superseded: ["tests/greet.spec.ts"],
    }).runGates(["test"], root);
    expect(bare.passed).toBe(false);
    expect(bare.failures.some((f) => f.gate === "regression")).toBe(true);

    writeFileSync(
      join(root, "tests/greet_hello.spec.ts"),
      'import { expect, it } from "vitest";\nimport { greet } from "../src/greet.js";\nit("says hello", () => { expect(greet("a")).toBe("hello a"); });\n',
    );
    const other = await withRegressionGate(inner(root), {
      ownTests: ["greet_hello.spec.ts"],
      base: "main",
      superseded: ["tests/greet.spec.ts > greets"],
    }).runGates(["test"], root);
    expect(other.passed).toBe(false);
    expect(other.rungResults?.find((o) => o.gate === "regression")?.superseded).toBeUndefined();
  });

  // Review B1: a supersession never turns an impacted-only run into a pass;
  // when it would forgive every failure, the full suite is judged instead.
  it("judges the full suite when a supersession would forgive every impacted failure", async () => {
    const root = repo();
    writeFileSync(
      join(root, "tests/data.spec.ts"),
      'import { readFileSync } from "node:fs";\nimport { expect, it } from "vitest";\nit("data", () => { expect(readFileSync("data.txt", "utf8").trim()).toBe("one"); });\n',
    );
    writeFileSync(join(root, "data.txt"), "one\n");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
    git("add", "tests/data.spec.ts", "data.txt");
    git("commit", "-q", "-m", "a test that reads data");
    writeFileSync(join(root, "data.txt"), "two\n");
    const impacted = new DeterministicGateRunner(new ProcessSandbox(), {
      repoRoot: root,
      maxFailuresReported: Number.POSITIVE_INFINITY,
      quarantine: { open: false, base: "main" },
    });
    const r = await withRegressionGate(impacted, {
      ownTests: ["greet_hello.spec.ts"],
      base: "main",
      superseded: ["tests/greet.spec.ts > greets"],
    }).runGates(["test"], root);
    expect(r.passed).toBe(false);
    expect(r.failures.filter((f) => f.gate === "regression").map((f) => f.location.file)).toEqual([
      "tests/data.spec.ts",
    ]);
  });

  it("the card stores its superseded tests (planner-pm PM-N6-3)", async () => {
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const store = new CardStore(db, new EventLog(db));
    const card = await store.createCard({
      tier: "task",
      title: "Say hello",
      supersedes: ["tests/greet.spec.ts > greets"],
    });
    expect((await store.getCard(card.id))?.supersedes).toEqual(["tests/greet.spec.ts > greets"]);
    await store.updateCard(card.id, { supersedes: null });
    expect((await store.getCard(card.id))?.supersedes).toBeUndefined();
  });
});
