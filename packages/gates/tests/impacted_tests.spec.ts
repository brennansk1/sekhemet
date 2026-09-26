import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeterministicGateRunner,
  IMPACTED_TESTS_NO_INDEX,
  quarantinedTests,
} from "../src/runner.js";

// GT-N3-2 (gates rule 33): with the source index (T2), the functional gate
// runs the tests reachable from the card's changes first and stops at their
// failure; only when they pass does it run the full suite, so the attempt
// that enters Review has run everything. Real git, real Vitest.

const REPO = join(import.meta.dirname, "..", "..", "..");
const VITEST = join(REPO, "node_modules", "vitest", "vitest.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const write = (root: string, files: Record<string, string>) => {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
};

/** A test file that leaves a mark when it runs, so a test can see which files ran. */
const marking = (name: string, importLine: string, assertion: string) => `${importLine}
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
mkdirSync(".log", { recursive: true });
writeFileSync(".log/${name}", "ran");
it("${name}", () => { ${assertion} });
`;

function repo(parser = "vitest", command = process.execPath, args = [VITEST, "run"]): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "impacted-")));
  dirs.push(root);
  write(root, {
    "package.json": '{ "name": "i", "type": "module", "private": true }\n',
    ".gitignore": ".sekhemet/\nnode_modules/\n.log/\n",
    ".sekhemet/gates.toml": `
[[gate]]
id = "unit"
rung = "test"
command = ${JSON.stringify(command)}
args = ${JSON.stringify(args)}
parser = "${parser}"
timeout_s = 120
`,
    "src/a.ts": "export const a = (): number => 1;\n",
    "src/c.ts": "export const c = (): number => 3;\n",
    "tests/a.spec.ts": marking("a", 'import { a } from "../src/a.js";', "expect(a()).toBe(1);"),
    "tests/c.spec.ts": marking("c", 'import { c } from "../src/c.js";', "expect(c()).toBe(3);"),
  });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@t.t");
  git(root, "config", "user.name", "T");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed");
  return root;
}

const runner = (root: string, base?: string) =>
  new DeterministicGateRunner(new ProcessSandbox(), {
    repoRoot: root,
    verdictCache: false,
    quarantine: { open: false, ...(base ? { base } : {}) },
  });

describe("impacted tests first (GT-N3-2)", () => {
  it("runs the tests reachable from the card's changes first and stops at their failure", async () => {
    const root = repo();
    write(root, { "src/a.ts": "export const a = (): number => 2;\n" });
    const r = await runner(root, "main").runGates(["test"], root);
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => /a\.spec\.ts/.test(f.location?.file ?? ""))).toBe(true);
    expect(existsSync(join(root, ".log", "a"))).toBe(true);
    // The unrelated test never ran: the full suite waits for the reachable ones to pass.
    expect(existsSync(join(root, ".log", "c"))).toBe(false);
    expect(r.rungResults?.[0]?.note).toBe(
      "impacted tests first: 1 test file reachable from the card's changes failed; the full suite did not run",
    );
  });

  it("runs the full suite once the reachable tests pass", async () => {
    const root = repo();
    write(root, { "src/a.ts": "export const a = (): number => 1; // unchanged behaviour\n" });
    const r = await runner(root, "main").runGates(["test"], root);
    expect(r.passed).toBe(true);
    expect(existsSync(join(root, ".log", "c"))).toBe(true);
    expect(r.rungResults?.[0]?.note).toBe(
      "impacted tests first: 1 test file reachable from the card's changes passed; the full suite ran",
    );
  });

  it("runs the full suite and says why when no test is reachable from the changes", async () => {
    const root = repo();
    write(root, { "README.md": "notes\n" });
    const r = await runner(root, "main").runGates(["test"], root);
    expect(existsSync(join(root, ".log", "a"))).toBe(true);
    expect(existsSync(join(root, ".log", "c"))).toBe(true);
    expect(r.rungResults?.[0]?.note).toBe(
      "impacted tests first: no test file is reachable from the card's changes; the full suite ran",
    );
  });

  it("says there is no source index to use when the card's base is unknown", async () => {
    const root = repo();
    write(root, { "src/a.ts": "export const a = (): number => 2;\n" });
    const r = await runner(root).runGates(["test"], root);
    expect(r.passed).toBe(false);
    expect(existsSync(join(root, ".log", "c"))).toBe(true);
    expect(r.rungResults?.[0]?.note).toBe(IMPACTED_TESTS_NO_INDEX);
  });

  it("runs the full suite for a runner it cannot hand test files to, and says so", async () => {
    const root = repo("generic", "sh", ["-c", "mkdir -p .log && echo all > .log/generic"]);
    write(root, { "src/a.ts": "export const a = (): number => 2;\n" });
    const r = await runner(root, "main").runGates(["test"], root);
    expect(existsSync(join(root, ".log", "generic"))).toBe(true);
    expect(r.rungResults?.[0]?.note).toBe(
      "impacted tests first: the generic runner cannot be given test files; the full suite ran",
    );
  });
});

// Review B1: an impacted-only run did not run the full suite, so no layer
// that forgives a failure (quarantine, the baseline, a supersession) may turn
// it into a pass; when every failure it found would be forgiven, the full
// suite runs and is judged instead. Minor 3: an impacted run that finds no
// test file falls back to the full suite.
describe("an impacted-only run is never forgiven into a pass (B1)", () => {
  /** Fails on its first run only: a counter under .log/ (ignored). */
  const FLAKY_A = `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { a } from "../src/a.js";
it("a once", () => {
  mkdirSync(".log", { recursive: true });
  const n = existsSync(".log/n") ? Number(readFileSync(".log/n", "utf8")) : 0;
  writeFileSync(".log/n", String(n + 1));
  expect(n === 0 ? 0 : a()).toBe(1);
});
`;
  /** Reads a data file the card changes: not reachable through imports. */
  const DATA_C = `import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("data", () => { expect(readFileSync("data.txt", "utf8").trim()).toBe("one"); });
`;

  it("runs the full suite when quarantine would forgive every impacted failure", async () => {
    const root = repo();
    write(root, {
      "tests/a.spec.ts": FLAKY_A,
      "tests/c.spec.ts": DATA_C,
      "data.txt": "one\n",
    });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "flaky a, data c");
    // The card changes src/a.ts (a.spec is reachable) and data.txt (c.spec reads it).
    write(root, { "src/a.ts": "export const a = (): number => 1; // same\n", "data.txt": "two\n" });
    const r = await new DeterministicGateRunner(new ProcessSandbox(), {
      repoRoot: root,
      verdictCache: false,
      quarantine: { open: true, base: "main" },
    }).runGates(["test"], root);
    const unit = r.rungResults?.[0];
    expect(quarantinedTests(root).map((q) => q.test)).toEqual(["tests/a.spec.ts > a once"]);
    expect(unit?.fullSuite).not.toBe(false);
    expect(r.passed).toBe(false);
    expect(r.failures.map((f) => f.location.file)).toEqual(["tests/c.spec.ts"]);
  });

  it("marks an impacted-only failure as not the full suite", async () => {
    const root = repo();
    write(root, { "src/a.ts": "export const a = (): number => 2;\n" });
    const r = await runner(root, "main").runGates(["test"], root);
    expect(r.rungResults?.[0]?.fullSuite).toBe(false);
  });

  it("falls back to the full suite when the impacted run finds no test file", async () => {
    const root = repo();
    write(root, {
      "vitest.config.mjs":
        'export default { test: { exclude: ["**/node_modules/**", "tests/skip/**"] } };\n',
      "src/b.ts": "export const b = (): number => 2;\n",
      "tests/skip/b.spec.ts": marking(
        "b",
        'import { b } from "../../src/b.js";',
        "expect(b()).toBe(2);",
      ),
    });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "a test the config leaves out");
    // Only the left-out test is reachable from the change.
    write(root, { "src/b.ts": "export const b = (): number => 2; // same\n" });
    const r = await runner(root, "main").runGates(["test"], root);
    expect(r.passed).toBe(true);
    expect(existsSync(join(root, ".log", "a"))).toBe(true);
    expect(r.rungResults?.[0]?.note).toMatch(/found no test file; the full suite ran/);
  });
});
