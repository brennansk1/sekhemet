import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DeterministicGateRunner, captureBaseline, loadGatesConfig } from "@sekhemet/gates";
import { verifyCardTree } from "@sekhemet/loop";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { cardGateRunner } from "../src/card_gates.js";

// Review M3 and the lead's efficiency decision (gates rule 34a, GT-BF-1/2/4;
// review-git RG-N3-1): a workspace's package gates run inside the card's
// declared run — through the verdict cache, the onboarding baseline,
// supersession and quarantine — first; the declared suite then leaves out
// the tests of packages that passed on the same tree, so each test runs
// once; a package's own gates.toml is read from the base. A real pnpm
// workspace, real git, real confined processes.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A test runner in Vitest's output format that logs every test file it runs.
 * Each `check: <name> | <file> | <text>` line of a test file is one test,
 * which passes when that repository file contains the text.
 */
const runnerScript = (
  root: string,
) => `import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
const ROOT = ${JSON.stringify(root)};
try { mkdirSync(join(ROOT, ".log"), { recursive: true }); } catch {}
const args = process.argv.slice(2).filter((a) => !a.startsWith("-") && a !== "run");
const walk = (d) => readdirSync(d).flatMap((n) => {
  if (n === "node_modules" || n.startsWith(".")) return [];
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : /\\.spec\\.ts$/.test(n) ? [relative(process.cwd(), p)] : [];
});
const files = args.length ? args : walk(process.cwd());
let failed = 0, passed = 0, failedFiles = 0;
for (const f of files) {
  try {
    appendFileSync(join(ROOT, ".log", "runs"), relative(ROOT, join(process.cwd(), f)) + "\\n");
  } catch {}
  let bad = false;
  for (const line of readFileSync(f, "utf8").split("\\n")) {
    const m = /check: (.+?) \\| (.+?) \\| (.+)$/.exec(line);
    if (!m) continue;
    if (readFileSync(join(ROOT, m[2]), "utf8").includes(m[3])) { passed++; continue; }
    failed++; bad = true;
    console.log(" FAIL  " + f + " > " + m[1]);
    console.log("AssertionError: expected " + m[2] + " to contain " + m[3]);
  }
  if (bad) failedFiles++;
}
console.log(" Test Files  " + (failedFiles ? failedFiles + " failed | " : "") + (files.length - failedFiles) + " passed (" + files.length + ")");
console.log("      Tests  " + (failed ? failed + " failed | " : "") + passed + " passed (" + (failed + passed) + ")");
process.exit(failed ? 1 : 0);
`;

const GATES = `
[[gate]]
id = "unit"
rung = "test"
command = "node"
args = ["tools/vitest.mjs", "run"]
parser = "vitest"
timeout_s = 120
`;

function workspace(extra: Record<string, string> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ws-gates-")));
  dirs.push(root);
  const pkg = (name: string, deps: Record<string, string>) =>
    JSON.stringify({
      name,
      version: "1.0.0",
      dependencies: deps,
      scripts: { test: "node ../../tools/vitest.mjs run" },
    });
  const files: Record<string, string> = {
    "package.json": '{ "name": "root", "private": true, "type": "module" }\n',
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    ".gitignore": ".log/\n.sekhemet/state/\nnode_modules/\n",
    ".sekhemet/gates.toml": GATES,
    "tools/vitest.mjs": runnerScript(root),
    "packages/a/package.json": pkg("@x/a", {}),
    "packages/a/src/index.ts": 'export const greeting = "hi";\n',
    "packages/a/tests/a1.spec.ts": "check: a greets | packages/a/src/index.ts | greeting\n",
    "packages/b/package.json": pkg("@x/b", { "@x/a": "workspace:*" }),
    "packages/b/src/index.ts": 'export const b = "b";\n',
    "packages/b/tests/b1.spec.ts": "check: b greets | packages/a/src/index.ts | hi\n",
    "packages/c/package.json": pkg("@x/c", {}),
    "packages/c/src/index.ts": 'export const c = "c";\n',
    "packages/c/tests/c1.spec.ts": 'check: c works | packages/c/src/index.ts | "c"\n',
    ...extra,
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
  return root;
}

const runs = (root: string): string[] => {
  try {
    return readFileSync(join(root, ".log", "runs"), "utf8")
      .split("\n")
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
};

const declared = (root: string) =>
  new DeterministicGateRunner(new ProcessSandbox(), {
    repoRoot: root,
    maxFailuresReported: Number.POSITIVE_INFINITY,
  });

const verify = (root: string, runner = declared(root)) =>
  verifyCardTree({ root, base: "main", rungs: ["test"], runner, staged: [], integrity: false });

describe("a card touching one package runs each test once (efficiency)", () => {
  it("runs the package gates first, then the declared suite without their tests", async () => {
    const root = workspace();
    writeFileSync(join(root, "packages/a/src/index.ts"), 'export const greeting = "hi"; // same\n');
    const r = await verify(root);
    expect(r.passed).toBe(true);
    expect(r.rungResults.map((o) => o.gate).slice(0, 2)).toEqual(["@x/a:test", "@x/b:test"]);
    expect(runs(root)).toEqual([
      "packages/a/tests/a1.spec.ts",
      "packages/b/tests/b1.spec.ts",
      "packages/c/tests/c1.spec.ts",
    ]);
    expect(r.rungResults.find((o) => o.gate === "unit")?.note).toMatch(
      /2 test files of packages whose own tests passed on this tree left out/,
    );
  });

  it("reads a package's own gates.toml from the base, never the card's copy", async () => {
    const own = `
[[gate]]
id = "test"
rung = "test"
command = "node"
args = ["../../tools/vitest.mjs", "run"]
parser = "vitest"
timeout_s = 120
`;
    const root = workspace({ "packages/c/.sekhemet/gates.toml": own });
    // The card weakens c's gates and touches c.
    writeFileSync(
      join(root, "packages/c/.sekhemet/gates.toml"),
      own.replace('args = ["../../tools/vitest.mjs", "run"]', 'args = ["-e", "0"]'),
    );
    writeFileSync(join(root, "packages/c/src/index.ts"), 'export const c = "x";\n');
    const r = await verify(root);
    // The base's gate ran the tests, and c's test fails on the card's change.
    expect(r.rungResults.find((o) => o.gate === "@x/c:test")?.passed).toBe(false);
    expect(
      r.allFailures
        .filter((f) => f.gate === "@x/c:test")
        .map(
          (f) =>
            `${f.location.file} ${f.errorExcerpt.split("\n")[0]?.split(" ").slice(1).join(" ")}`,
        ),
    ).toEqual(["packages/c/tests/c1.spec.ts c works"]);
    expect(loadGatesConfig(root).project.protected).toContain("**/.sekhemet/gates.toml");
  });
});

describe("package gates go through the baseline and supersession (M3, GT-BF-1/2)", () => {
  it("forgives a package test failing since onboarding", async () => {
    const root = workspace({
      "packages/b/tests/b2.spec.ts": "check: b legacy | packages/b/src/index.ts | never\n",
    });
    const baseline = await captureBaseline({
      runner: new DeterministicGateRunner(new ProcessSandbox(), {
        repoRoot: root,
        maxFailuresReported: Number.POSITIVE_INFINITY,
        verdictCache: false,
      }),
      root,
      rungs: ["test"],
      workspace: { base: "HEAD", changed: ["packages/a", "packages/b", "packages/c"] },
    });
    expect(baseline.entries.map((e) => `${e.gate}|${e.rule}`).sort()).toEqual([
      "@x/b:test|b legacy",
      "unit|b legacy",
    ]);
    writeFileSync(join(root, "packages/a/src/index.ts"), 'export const greeting = "hi"; // same\n');
    const runner = cardGateRunner({
      repoPath: root,
      gatesConfig: loadGatesConfig(root),
      restricted: false,
      card: {},
      baseline: baseline.entries,
    });
    const r = await verify(root, runner);
    const b = r.rungResults.find((o) => o.gate === "@x/b:test");
    expect(b?.passed).toBe(true);
    expect(b?.note).toMatch(/1 pre-existing finding/);
    expect(r.allFailures.filter((f) => f.rung === "test")).toEqual([]);
  });

  it("accepts a superseded package test whose new version is staged", async () => {
    const root = workspace();
    writeFileSync(join(root, "packages/a/src/index.ts"), 'export const greeting = "hello";\n');
    writeFileSync(
      join(root, "packages/b/tests/b_new.spec.ts"),
      '// it("b greets")\ncheck: b greets | packages/a/src/index.ts | hello\n',
    );
    const runner = cardGateRunner({
      repoPath: root,
      gatesConfig: loadGatesConfig(root),
      restricted: false,
      card: {
        acceptanceTests: ["packages/b/tests/b_new.spec.ts"],
        supersedes: ["packages/b/tests/b1.spec.ts > b greets"],
      },
    });
    const r = await verify(root, runner);
    expect(r.rungResults.find((o) => o.gate === "@x/b:test")?.passed).toBe(true);
    expect(r.rungResults.find((o) => o.gate === "regression")?.superseded?.[0]?.test).toBe(
      "packages/b/tests/b1.spec.ts > b greets",
    );
    expect(r.allFailures.filter((f) => f.rung === "test" || f.gate === "regression")).toEqual([]);
  });
});

// B1 (gates rule 34a): asked for the full suite, a package gate is not
// answered by an impacted-only verdict, from the cache or a first run.
describe("the package stage honours a full-suite request (B1)", () => {
  it("runs a package's full suite when the full suite is asked for", async () => {
    const root = workspace({
      "packages/a/tests/a1.spec.ts":
        'import { greeting } from "../src/index.js";\nvoid greeting;\n// check: a greets | packages/a/src/index.ts | greeting\n',
      "packages/a/tests/a2.spec.ts": "check: a is a | packages/a/package.json | @x/a\n",
    });
    writeFileSync(join(root, "packages/a/src/index.ts"), 'export const hello = "hi";\n');
    // A card's run: its base known, so the impacted tests run first.
    const runner = new DeterministicGateRunner(new ProcessSandbox(), {
      repoRoot: root,
      maxFailuresReported: Number.POSITIVE_INFINITY,
      quarantine: { open: false, base: "main" },
    });
    const ws = { base: "main", changed: ["packages/a/src/index.ts"] };
    const impacted = await runner.runGates(["test"], root, { workspace: ws });
    const first = impacted.rungResults?.find((o) => o.gate === "@x/a:test");
    expect(first).toMatchObject({ passed: false, fullSuite: false });
    expect(runs(root)).not.toContain("packages/a/tests/a2.spec.ts");
    const full = await runner.runGates(["test"], root, { workspace: ws, fullSuite: true });
    const a = full.rungResults?.find((o) => o.gate === "@x/a:test");
    expect(a?.passed).toBe(false);
    expect(a?.cached).toBeUndefined();
    expect(a?.fullSuite).not.toBe(false);
    expect(runs(root)).toContain("packages/a/tests/a2.spec.ts");
  });
});
