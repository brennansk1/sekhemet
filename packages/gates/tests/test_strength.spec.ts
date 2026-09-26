import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { astGrepProgram, scanHalfDone } from "../src/half_done.js";
import { parseJUnit } from "../src/junit.js";
import {
  STAND_INS,
  STRENGTH_TABLE,
  checkTestStrength,
  declaredInterface,
  lintTestSmells,
  preserveTree,
  runAcceptanceTests,
  stageStandIn,
  testOrigins,
} from "../src/test_strength.js";
import type { GateDefinition } from "../src/types.js";

// NEW-gates-6 (gates rules 6, 6a, 32a): tests that can fail, checked before
// the Worker starts — red at an assertion against a stub of the card's
// declared interface (GT-TQ-1), stub-kill (GT-TQ-2), the test-smell lint and
// Vitest's `requireAssertions` (GT-TQ-6), and the internal-tool default
// profile with test gaps routed to a person (GT-TQ-12). Every run below is a
// real Vitest process in a real git repository.

const REPO = join(import.meta.dirname, "..", "..", "..");
const VITEST = join(REPO, "node_modules", "vitest", "vitest.mjs");

const unit: GateDefinition = {
  id: "unit",
  rung: "test",
  layer: "functional",
  command: process.execPath,
  args: [VITEST, "run"],
  timeoutMs: 120_000,
  parser: "vitest",
  blocking: true,
};

const sandbox = new ProcessSandbox();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A committed repository holding `files`; the acceptance tests are staged afterwards, untracked. */
function repo(files: Record<string, string>, staged: Record<string, string> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "strength-")));
  dirs.push(root);
  const put = (all: Record<string, string>) => {
    for (const [p, text] of Object.entries(all)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
  };
  put({
    "package.json": '{ "name": "seed", "type": "module", "private": true }\n',
    "tsconfig.json": '{ "compilerOptions": { "strict": true } }\n',
    // As in any project: the runner's own cache is not the card's work.
    ".gitignore": "node_modules/\n",
    ...files,
  });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@t.t");
  git(root, "config", "user.name", "T");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed");
  put(staged);
  return root;
}

const STRONG = `import { describe, expect, it } from "vitest";
import { add } from "../src/math.js";
describe("add", () => {
  it("adds two numbers", () => {
    expect(add(2, 3)).toBe(5);
  });
  it("adds a negative", () => {
    expect(add(2, -7)).toBe(-5);
  });
});
`;

describe("the declared interface (GT-TQ-1)", () => {
  it("is what the acceptance tests import from project modules, the missing names marked", () => {
    const root = repo(
      { "src/math.ts": "export function sub(a: number, b: number) { return a - b; }\n" },
      {
        "tests/a.spec.ts": `import { expect, it } from "vitest";
import type { Shape } from "../src/shape.js";
import { add, sub } from "../src/math.js";
import area, { perimeter } from "../src/shape.js";
import * as geo from "../src/geo.js";
it("x", () => { expect(add(1, sub(2, 1)) + area(1) + perimeter(1) + geo.dist(1)).toBe(0); });
`,
      },
    );
    const iface = declaredInterface(root, ["tests/a.spec.ts"]);
    const byFile = Object.fromEntries(iface.map((m) => [m.file, m]));
    expect(byFile["src/math.ts"]?.exists).toBe(true);
    expect(byFile["src/math.ts"]?.missing).toEqual(["add"]);
    expect(byFile["src/shape.ts"]?.exists).toBe(false);
    // A type-only import is not a runtime export; the default import is.
    expect(byFile["src/shape.ts"]?.missing.sort()).toEqual(["default", "perimeter"]);
    expect(byFile["src/geo.ts"]?.missing).toEqual(["dist"]);
    // Nothing outside relative project imports: vitest itself is not the interface.
    expect(iface.map((m) => m.file).sort()).toEqual(["src/geo.ts", "src/math.ts", "src/shape.ts"]);
  });

  it("stages a stand-in and restores the tree exactly, created directories included", () => {
    const root = repo(
      { "src/math.ts": "export const one = 1;\n" },
      {
        "tests/a.spec.ts": `import { expect, it } from "vitest";
import { add } from "../src/math.js";
import { mul } from "../src/deep/ops.js";
it("x", () => { expect(add(1, mul(1, 1))).toBe(2); });
`,
      },
    );
    const before = git(root, "status", "--porcelain", "--untracked-files=all");
    const original = readFileSync(join(root, "src", "math.ts"), "utf8");
    const iface = declaredInterface(root, ["tests/a.spec.ts"]);
    const restore = stageStandIn(root, iface, "not-implemented");
    expect(readFileSync(join(root, "src", "math.ts"), "utf8")).toContain("export");
    expect(readFileSync(join(root, "src", "deep", "ops.ts"), "utf8")).toContain("mul");
    restore();
    expect(readFileSync(join(root, "src", "math.ts"), "utf8")).toBe(original);
    expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe(before);
  });
});

describe("one JUnit path (DEC-44)", () => {
  it("reads a real Vitest report: an assertion, a thrown error, an import failure and a pass", async () => {
    const root = repo(
      { "src/math.ts": "export function add(a: number, b: number) { return a + b; }\n" },
      {
        "tests/a.spec.ts": `import { expect, it } from "vitest";
import { add } from "../src/math.js";
it("asserts", () => { expect(add(1, 1)).toBe(3); });
it("throws", () => { throw new TypeError("boom"); });
it("passes", () => { expect(add(1, 1)).toBe(2); });
`,
        "tests/b.spec.ts": `import { expect, it } from "vitest";
import { nope } from "../src/missing.js";
it("never runs", () => { expect(nope()).toBe(1); });
`,
      },
    );
    const run = await runAcceptanceTests(sandbox, root, unit, [
      "tests/a.spec.ts",
      "tests/b.spec.ts",
    ]);
    if ("unavailable" in run) throw new Error(run.unavailable);
    const kinds = Object.fromEntries(run.results.map((r) => [r.test, r.kind]));
    expect(kinds["tests/a.spec.ts > asserts"]).toBe("assertion");
    expect(kinds["tests/a.spec.ts > throws"]).toBe("error");
    expect(kinds["tests/a.spec.ts > passes"]).toBe("passed");
    expect(kinds["tests/b.spec.ts"]).toBe("import");
    // The report is the harness's: nothing is left in the tree.
    expect(git(root, "status", "--porcelain", "--untracked-files=all")).not.toContain("sekhemet");
  });

  it("refuses text that is not a JUnit report rather than read it as an empty run", () => {
    expect(() => parseJUnit("<html><body>nope</body></html>")).toThrow(/not a JUnit report/);
  });

  it("reads pytest's collection error as an error, not a failure", () => {
    const cases = parseJUnit(`<?xml version="1.0"?>
<testsuites><testsuite name="pytest" tests="2">
<testcase classname="tests.test_a" name="test_x" file="tests/test_a.py"><error message="collection failure">ImportError</error></testcase>
<testcase classname="tests.test_a" name="test_y" file="tests/test_a.py"><failure message="AssertionError: assert 1 == 2">assert 1 == 2</failure></testcase>
</testsuite></testsuites>`);
    expect(cases.map((c) => c.status)).toEqual(["error", "failure"]);
    expect(cases[0]?.file).toBe("tests/test_a.py");
  });
});

describe("red at an assertion against the interface stub (GT-TQ-1)", () => {
  it("counts a card red when every acceptance test fails at an assertion or at the stub", async () => {
    const root = repo({ "src/other.ts": "export const x = 1;\n" }, { "tests/a.spec.ts": STRONG });
    const record = await checkTestStrength({
      sandbox,
      root,
      testGate: unit,
      tests: ["tests/a.spec.ts"],
      change: "feature",
      origin: "card",
    });
    expect(record.redAtAssertion.status).toBe("red");
    expect(record.redAtAssertion.results.every((r) => r.kind === "not_implemented")).toBe(true);
    expect(record.verdict.stopReason).toBeUndefined();
    // Vitest's own "a test must assert" switch was on for the acceptance run.
    expect(record.redAtAssertion.requireAssertions).toBe(true);
    // The stub is gone: the Worker starts from the base.
    expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe("?? tests/a.spec.ts");
  });

  it("stops a card whose test fails at import with tests_not_red_for_reason, naming the test and the error", async () => {
    const root = repo(
      {},
      {
        "tests/a.spec.ts": `import { expect, it } from "vitest";
import { add } from "../src/math.js";
import { helper } from "./helpers/not-there.js";
it("adds", () => { expect(add(helper(), 1)).toBe(2); });
`,
      },
    );
    const record = await checkTestStrength({
      sandbox,
      root,
      testGate: unit,
      tests: ["tests/a.spec.ts"],
      change: "feature",
      origin: "card",
    });
    expect(record.redAtAssertion.status).toBe("not_red_for_reason");
    expect(record.verdict.stopReason).toBe("tests_not_red_for_reason");
    expect(record.verdict.detail).toContain("tests/a.spec.ts");
    expect(record.verdict.detail).toMatch(/not-there/);
  });

  it("stops a test that fails with a runtime error of its own, not at an assertion", async () => {
    const root = repo(
      {},
      {
        "tests/a.spec.ts": `import { expect, it } from "vitest";
import { add } from "../src/math.js";
it("adds", () => {
  const cfg = undefined as unknown as { base: number };
  expect(add(cfg.base, 1)).toBe(2);
});
`,
      },
    );
    const record = await checkTestStrength({
      sandbox,
      root,
      testGate: unit,
      tests: ["tests/a.spec.ts"],
      change: "feature",
      origin: "card",
    });
    expect(record.verdict.stopReason).toBe("tests_not_red_for_reason");
    expect(record.verdict.detail).toMatch(/TypeError|Cannot read/);
  });

  it("stops a test that passes against the throwing stub as vacuous, naming it", async () => {
    const root = repo(
      {},
      {
        "tests/a.spec.ts": `import { expect, it } from "vitest";
import { add } from "../src/math.js";
it("adds", () => { expect(add(2, 3)).toBe(5); });
it("throws on bad input", () => { expect(() => add(Number.NaN, 1)).toThrow(); });
`,
      },
    );
    const record = await checkTestStrength({
      sandbox,
      root,
      testGate: unit,
      tests: ["tests/a.spec.ts"],
      change: "feature",
      origin: "card",
    });
    expect(record.redAtAssertion.status).toBe("vacuous");
    expect(record.verdict.stopReason).toBe("vacuous_tests");
    expect(record.verdict.detail).toContain("throws on bad input");
  });

  it("judges a fix card's reproduction test on the base itself: red at an assertion", async () => {
    const root = repo(
      { "src/math.ts": "export function add(a: number, b: number) { return a - b; }\n" },
      { "tests/a.spec.ts": STRONG },
    );
    const record = await checkTestStrength({
      sandbox,
      root,
      testGate: unit,
      tests: ["tests/a.spec.ts"],
      change: "fix",
      origin: "card",
    });
    expect(record.redAtAssertion.status).toBe("red");
    expect(record.redAtAssertion.results.every((r) => r.kind === "assertion")).toBe(true);
    // A fix card declares no new export: stub-kill has nothing to replace.
    expect(record.stubKill.status).toBe("not_applicable");
  });

  it("says it did not judge when the test runner has no JUnit path, never red or refused", async () => {
    const root = repo({}, { "tests/a.spec.ts": STRONG });
    const record = await checkTestStrength({
      sandbox,
      root,
      testGate: { ...unit, command: "sh", args: ["-c", "exit 1"], parser: "generic" },
      tests: ["tests/a.spec.ts"],
      change: "feature",
      origin: "card",
    });
    expect(record.redAtAssertion.status).toBe("not_judged");
    expect(record.redAtAssertion.reason).toMatch(/JUnit/);
    expect(record.verdict.stopReason).toBeUndefined();
  });
});

describe("stub-kill (GT-TQ-2)", () => {
  it("stops a card whose tests a trivial implementation passes, naming the stand-in and the tests", async () => {
    const root = repo(
      {},
      {
        "tests/a.spec.ts": `import { expect, it } from "vitest";
import { listOpen } from "../src/board.js";
it("lists nothing on an empty board", () => {
  expect(listOpen([])).toEqual([]);
});
`,
      },
    );
    const record = await checkTestStrength({
      sandbox,
      root,
      testGate: unit,
      tests: ["tests/a.spec.ts"],
      change: "feature",
      origin: "card",
    });
    expect(record.redAtAssertion.status).toBe("red");
    expect(record.stubKill.status).toBe("survived");
    expect(record.stubKill.standIn).toBe("returns []");
    expect(record.verdict.stopReason).toBe("vacuous_tests");
    expect(record.verdict.detail).toContain("returns []");
    expect(record.verdict.detail).toContain("lists nothing on an empty board");
    expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe("?? tests/a.spec.ts");
  });

  it("passes tests that every stand-in fails, recording one run per stand-in", async () => {
    const root = repo({}, { "tests/a.spec.ts": STRONG });
    const record = await checkTestStrength({
      sandbox,
      root,
      testGate: unit,
      tests: ["tests/a.spec.ts"],
      change: "feature",
      origin: "card",
    });
    expect(record.stubKill.status).toBe("killed");
    expect(record.stubKill.runs.map((r) => r.standIn)).toEqual([...STAND_INS]);
    expect(record.stubKill.runs.filter((r) => r.failed === 0)).toEqual([]);
    expect(record.stubKill.runs[0]?.killedBy).toBe("tests/a.spec.ts > add > adds two numbers");
  });

  it("is an advisory test gap for a person at the prototype profile, never a stop", async () => {
    const root = repo(
      {},
      {
        "tests/a.spec.ts": `import { expect, it } from "vitest";
import { isEmpty } from "../src/board.js";
it("a board with a card is not empty", () => { expect(isEmpty([1])).toBeFalsy(); });
`,
      },
    );
    const record = await checkTestStrength({
      sandbox,
      root,
      testGate: unit,
      tests: ["tests/a.spec.ts"],
      change: "feature",
      origin: "card",
      profile: "prototype",
    });
    expect(STRENGTH_TABLE.prototype.stubKill).toBe("advisory");
    expect(record.stubKill.status).toBe("survived");
    expect(record.verdict.stopReason).toBeUndefined();
    expect(record.testGaps.join("\n")).toMatch(/stand-in/);
  });
});

describe("the test-smell lint (GT-TQ-6)", () => {
  const SMELLY = `import { describe, expect, it } from "vitest";
import { add, total } from "../src/math.js";
function check(n: number) { expect(n).toBeGreaterThan(0); }
describe("smells", () => {
  it("no assertion at all", () => { add(1, 2); });
  it("asserts through a helper", () => { check(add(1, 2)); });
  it("oracle from the code", () => { expect(total([1, 2])).toBe(add(1, 2)); });
  it("oracle through a local", () => { const want = add(1, 2); expect(total([1, 2])).toEqual(want); });
  it("tautology", () => { expect(add(1, 2)).toBe(add(1, 2)); });
  it("metamorphic", () => { expect(add(1, 2)).toBe(add(2, 1)); });
  it("two constants", () => { expect(3).toBe(3); });
  it("in a catch", () => { try { add(1, 2); } catch (e) { expect(e).toBeTruthy(); } });
  it("guarded catch", () => { expect.assertions(1); try { add(1, 2); } catch (e) { expect(e).toBeTruthy(); } });
  it("after a return", () => { add(1, 2); return; expect(1).toBe(add(0, 1)); });
  it.skip("skipped", () => { expect(add(1, 1)).toBe(2); });
  it("fine", () => { expect(add(1, 1)).toBe(2); });
});
`;

  it("finds each smell at its test, and passes the tests that have none", () => {
    const root = repo({}, { "tests/a.spec.ts": SMELLY });
    const smells = lintTestSmells(root, ["tests/a.spec.ts"]);
    const by = (test: string) => smells.filter((s) => s.test === test).map((s) => s.smell);
    expect(by("no assertion at all")).toEqual(["no_assertion"]);
    expect(by("asserts through a helper")).toEqual([]);
    expect(by("oracle from the code")).toEqual(["computed_expected"]);
    expect(by("oracle through a local")).toEqual(["computed_expected"]);
    expect(by("tautology")).toEqual(["computed_expected"]);
    // The same function on different inputs is a relation, not a borrowed oracle.
    expect(by("metamorphic")).toEqual([]);
    expect(by("two constants")).toEqual(["constant_assertion"]);
    expect(by("in a catch")).toEqual(["assertion_in_catch"]);
    expect(by("guarded catch")).toEqual([]);
    expect(by("after a return")).toContain("unreachable_assertion");
    expect(by("skipped")).toEqual(["skipped"]);
    expect(by("fine")).toEqual([]);
    for (const s of smells) expect(s.line).toBeGreaterThan(0);
  });

  it("stops the card before any run at the internal-tool profile, the default", async () => {
    const root = repo({}, { "tests/a.spec.ts": SMELLY });
    const record = await checkTestStrength({
      sandbox,
      root,
      testGate: unit,
      tests: ["tests/a.spec.ts"],
      change: "feature",
      origin: "card",
    });
    expect(record.profile).toBe("internal tool");
    expect(record.profileNote).toBe("depth profile: internal tool (default)");
    expect(record.verdict.stopReason).toBe("vacuous_tests");
    expect(record.verdict.detail).toContain("no assertion at all");
    expect(record.redAtAssertion.status).toBe("not_judged");
  });

  it("runs ast-grep outside the repository, so the repository's sgconfig.yml never applies", () => {
    const root = repo(
      { "sgconfig.yml": "ruleDirs: [evil]\n", "src/a.ts": "export const a = 1;\n" },
      { "tests/a.spec.ts": 'import { it } from "vitest";\nit.only("a", () => {});\n' },
    );
    const bin = realpathSync(mkdtempSync(join(tmpdir(), "sg-bin-")));
    dirs.push(bin);
    const seen = join(bin, "seen");
    const fake = join(bin, "ast-grep");
    writeFileSync(
      fake,
      `#!/bin/sh\npwd > ${JSON.stringify(seen)}\nfor a in "$@"; do echo "$a" >> ${JSON.stringify(seen)}; done\nlast=""; for a in "$@"; do last="$a"; done\necho "{\\"file\\":\\"$last\\",\\"ruleId\\":\\"only-TypeScript\\",\\"text\\":\\"it.only\\",\\"range\\":{\\"start\\":{\\"line\\":1}}}"\nexit 1\n`,
    );
    chmodSync(fake, 0o755);
    const found = scanHalfDone(root, ["tests/a.spec.ts"], { astGrep: fake });
    const lines = readFileSync(seen, "utf8").trim().split("\n");
    expect(lines[0]?.startsWith(root)).toBe(false);
    expect(lines).toContain(join(root, "tests", "a.spec.ts"));
    expect(found).toEqual([
      { file: "tests/a.spec.ts", line: 2, kind: "only", text: "it.only", tool: "ast-grep" },
    ]);
  });

  it("uses the short name sg only when it is ast-grep, never another program called sg", () => {
    const bin = realpathSync(mkdtempSync(join(tmpdir(), "sg-alias-")));
    dirs.push(bin);
    const sg = join(bin, "sg");
    const path = process.env.PATH;
    try {
      // Only this directory and the system's: no ast-grep elsewhere on PATH.
      process.env.PATH = `${bin}:/usr/bin:/bin`;
      writeFileSync(sg, "#!/bin/sh\necho \"sg: group '$1' does not exist\" >&2\nexit 1\n");
      chmodSync(sg, 0o755);
      expect(astGrepProgram()).toBeUndefined();
      writeFileSync(sg, '#!/bin/sh\necho "ast-grep 0.39.0"\n');
      expect(astGrepProgram()).toBe("sg");
    } finally {
      process.env.PATH = path;
    }
  });

  it("finds skipped, focused and todo tests and stubs by the text fallback when ast-grep is absent", () => {
    const root = repo(
      {
        "src/a.ts": 'export function f() { throw new Error("not implemented"); }\n',
        "src/b.py": "def g():\n    raise NotImplementedError\n",
      },
      {
        "tests/a.spec.ts":
          'import { it, test } from "vitest";\nit.only("a", () => {});\ntest.todo("b");\nxit("c", () => {});\n',
        "tests/test_b.py": "import pytest\n@pytest.mark.skip\ndef test_x():\n    assert 1\n",
      },
    );
    const found = scanHalfDone(
      root,
      ["tests/a.spec.ts", "tests/test_b.py", "src/a.ts", "src/b.py"],
      { astGrep: false },
    );
    const kinds = found.map((f) => `${f.file}:${f.line}:${f.kind}`).sort();
    expect(kinds).toEqual([
      "src/a.ts:1:stub",
      "src/b.py:2:stub",
      "tests/a.spec.ts:2:only",
      "tests/a.spec.ts:3:todo",
      "tests/a.spec.ts:4:skip",
      "tests/test_b.py:2:skip",
    ]);
    expect(found.every((f) => f.tool === "text")).toBe(true);
  });

  it("fails a test with no executed assertion at run time through requireAssertions", async () => {
    // The static lint cannot see an assertion that never runs; Vitest can.
    const root = repo(
      {},
      {
        "tests/a.spec.ts": `import { expect, it } from "vitest";
import { add } from "../src/math.js";
it("asserts only when it can", () => {
  let r = 0;
  try { r = add(1, 1); } catch { return; }
  expect(r).toBe(2);
});
`,
      },
    );
    const iface = declaredInterface(root, ["tests/a.spec.ts"]);
    const restore = stageStandIn(root, iface, "not-implemented");
    try {
      const red = await runAcceptanceTests(sandbox, root, unit, ["tests/a.spec.ts"]);
      if ("unavailable" in red) throw new Error(red.unavailable);
      expect(red.requireAssertions).toBe(true);
      expect(red.results.map((r) => r.kind)).toEqual(["no_assertion"]);
    } finally {
      restore();
    }
  });
});

// Lead ruling under DEC-42 (surfaced by the frozen suite's card_vang_2_hmac):
// tests the card receives from outside — the frozen suite's, a person's, a
// repository's own — cannot be changed by the Worker, so they need only fail
// on the base; a failure for the wrong reason is a visible finding, never a stop.
describe("tests from outside the card (DEC-42 ruling)", () => {
  const SETUP_BROKEN = `import { beforeEach, expect, it } from "vitest";
import { add } from "../src/math.js";
const spy = { calls: undefined as unknown as { clear(): void } };
beforeEach(() => { spy.calls.clear(); });
it("adds", () => { expect(add(2, 3)).toBe(5); });
`;

  it("records a failure in setup as redForWrongReason with its phase, and does not stop the card", async () => {
    const root = repo({}, { "tests/a.spec.ts": SETUP_BROKEN });
    const record = await checkTestStrength({
      sandbox,
      root,
      testGate: unit,
      tests: ["tests/a.spec.ts"],
      change: "feature",
      origin: "external",
    });
    expect(record.origin).toBe("external");
    expect(record.verdict.stopReason).toBeUndefined();
    expect(record.redForWrongReason).toEqual([
      expect.objectContaining({ test: "tests/a.spec.ts > adds", phase: "error" }),
    ]);
    expect(record.testGaps.join("\n")).toContain("redForWrongReason");
  });

  it("stops the same test when the card's own test author wrote it", async () => {
    const root = repo({}, { "tests/a.spec.ts": SETUP_BROKEN });
    const record = await checkTestStrength({
      sandbox,
      root,
      testGate: unit,
      tests: ["tests/a.spec.ts"],
      change: "feature",
      origin: "card",
    });
    expect(record.verdict.stopReason).toBe("tests_not_red_for_reason");
  });

  it("records smells and a surviving stand-in in external tests as test gaps for a person, never a stop", async () => {
    const root = repo(
      {},
      {
        "tests/a.spec.ts": `import { expect, it } from "vitest";
import { listOpen } from "../src/board.js";
it("lists nothing", () => { expect(listOpen([])).toEqual([]); });
it("constants", () => { expect(listOpen).toBeDefined(); expect(1).toBe(1); });
`,
      },
    );
    const record = await checkTestStrength({
      sandbox,
      root,
      testGate: unit,
      tests: ["tests/a.spec.ts"],
      change: "feature",
      origin: "external",
    });
    expect(record.verdict.stopReason).toBeUndefined();
    expect(record.smells.map((s) => s.smell)).toContain("constant_assertion");
    expect(record.testGaps.join("\n")).toMatch(/smell/);
  });
});

// Lead ruling (B4.0b review): who wrote a test is decided per file. A test is
// the card's when its sha256 matches a Planner, test-author or PM carry-over
// `test/staged` record, or when the card's own diff wrote it; every other
// test — the frozen suite's, a person's, the repository's — is external.
describe("test origin per file (lead ruling)", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const A = `import { expect, it } from "vitest";\nit("a", () => { expect(1).toBe(2); });\n`;
  const B = `import { expect, it } from "vitest";\nit("b", () => { expect(2).toBe(3); });\n`;

  it("is card for a matching Planner, test-author or PM record or the card's own diff, external otherwise", () => {
    const root = repo({}, { "tests/a.spec.ts": A, "tests/b.spec.ts": B, "tests/c.spec.ts": A + B });
    const tests = ["tests/a.spec.ts", "tests/b.spec.ts", "tests/c.spec.ts"];
    expect(testOrigins({ root, tests, staged: [] })).toEqual({
      "tests/a.spec.ts": "external",
      "tests/b.spec.ts": "external",
      "tests/c.spec.ts": "external",
    });
    const origins = testOrigins({
      root,
      tests,
      staged: [
        { path: "tests/a.spec.ts", sha256: sha(A), author: "planner" },
        // A person's record, or a Planner's for other content, is not the card's.
        { path: "tests/b.spec.ts", sha256: sha(B), author: "person" },
        { path: "tests/c.spec.ts", sha256: sha("other"), author: "test-author" },
      ],
      cardDiff: [],
    });
    expect(origins).toEqual({
      "tests/a.spec.ts": "card",
      "tests/b.spec.ts": "external",
      "tests/c.spec.ts": "external",
    });
    expect(
      testOrigins({ root, tests: ["tests/b.spec.ts"], staged: [], cardDiff: ["tests/b.spec.ts"] }),
    ).toEqual({ "tests/b.spec.ts": "card" });
    expect(
      testOrigins({
        root,
        tests: ["tests/b.spec.ts"],
        staged: [{ path: "tests/b.spec.ts", sha256: sha(B), author: "pm" }],
      }),
    ).toEqual({ "tests/b.spec.ts": "card" });
    // Named explicitly (the frozen suite): every staged test is external, whatever the records say.
    expect(
      testOrigins({
        root,
        tests: ["tests/a.spec.ts"],
        staged: [{ path: "tests/a.spec.ts", sha256: sha(A), author: "planner" }],
        forced: "external",
      }),
    ).toEqual({ "tests/a.spec.ts": "external" });
  });

  it("stops only the card's own tests: an external file beside them is recorded, never a stop", async () => {
    const SETUP_BROKEN = `import { beforeEach, expect, it } from "vitest";
import { add } from "../src/math.js";
const spy = { calls: undefined as unknown as { clear(): void } };
beforeEach(() => { spy.calls.clear(); });
it("adds", () => { expect(add(2, 3)).toBe(5); });
`;
    const RED = `import { expect, it } from "vitest";
import { add } from "../src/math.js";
it("adds two", () => { expect(add(2, 3)).toBe(5); });
it("adds a negative", () => { expect(add(2, -7)).toBe(-5); });
`;
    const root = repo({}, { "tests/ext.spec.ts": SETUP_BROKEN, "tests/own.spec.ts": RED });
    const record = await checkTestStrength({
      sandbox,
      root,
      testGate: unit,
      tests: ["tests/ext.spec.ts", "tests/own.spec.ts"],
      change: "feature",
      origin: "external",
      origins: { "tests/ext.spec.ts": "external", "tests/own.spec.ts": "card" },
    });
    expect(record.verdict.stopReason).toBeUndefined();
    expect(record.origins).toEqual({
      "tests/ext.spec.ts": "external",
      "tests/own.spec.ts": "card",
    });
    expect(record.redForWrongReason.map((r) => r.test)).toEqual(["tests/ext.spec.ts > adds"]);
    // The same broken file written for the card stops it, naming it alone.
    const own = repo({}, { "tests/ext.spec.ts": RED, "tests/own.spec.ts": SETUP_BROKEN });
    const stopped = await checkTestStrength({
      sandbox,
      root: own,
      testGate: unit,
      tests: ["tests/ext.spec.ts", "tests/own.spec.ts"],
      change: "feature",
      origin: "external",
      origins: { "tests/ext.spec.ts": "external", "tests/own.spec.ts": "card" },
    });
    expect(stopped.verdict.stopReason).toBe("tests_not_red_for_reason");
    expect(stopped.verdict.detail).toContain("tests/own.spec.ts > adds");
    expect(stopped.verdict.detail).not.toContain("tests/ext.spec.ts");
  });
});

// The check has no side effects (B4.0b review): it runs as CI (no snapshot
// written), and the tree afterwards is exactly the tree before — what the
// tests created is removed, what they changed is restored, and the Worker's
// own files are never touched.
describe("the strength check leaves the tree as it found it", () => {
  const SNAP = `import { mkdirSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { add } from "../src/math.js";
it("adds", () => {
  mkdirSync("out", { recursive: true });
  writeFileSync("out/trace.txt", "ran");
  writeFileSync("src/keep.ts", "export const keep = 99;\\n");
  writeFileSync("src/wip.ts", "clobbered\\n");
  expect(add(2, 3)).toMatchSnapshot();
});
`;

  it("writes no snapshot, removes what the tests created and restores what they changed, never the Worker's files", async () => {
    const root = repo({ "src/keep.ts": "export const keep = 1;\n" }, { "tests/a.spec.ts": SNAP });
    // The Worker's own files before the check: a changed tracked file and a new one.
    writeFileSync(join(root, "src", "keep.ts"), "export const keep = 2;\n");
    writeFileSync(join(root, "src", "wip.ts"), "export const wip = 1;\n");
    const status = () => git(root, "status", "--porcelain", "--untracked-files=all");
    const before = status();
    const record = await checkTestStrength({
      sandbox,
      root,
      testGate: unit,
      tests: ["tests/a.spec.ts"],
      change: "feature",
      origin: "card",
    });
    expect(status()).toBe(before);
    expect(readFileSync(join(root, "src", "keep.ts"), "utf8")).toBe("export const keep = 2;\n");
    expect(readFileSync(join(root, "src", "wip.ts"), "utf8")).toBe("export const wip = 1;\n");
    expect(readFileSync(join(root, "tests", "a.spec.ts"), "utf8")).toBe(SNAP);
    // Run as CI, a stand-in cannot pass by writing its own snapshot.
    expect(record.stubKill.status).toBe("killed");
  });
});

describe("the strength check's own git is guarded in a card's worktree (security items 19–21)", () => {
  it("never runs a program the repository's config names while it snapshots and restores the tree", () => {
    const main = repo({ "src/keep.ts": "export const keep = 1;\n" });
    const worktree = join(main, ".sekhemet", "worktrees", "card-1");
    git(main, "worktree", "add", "-q", "-b", "sekhemet/card-1", worktree);
    // Config added after the worktree was made: an fsmonitor hook and a
    // smudge filter, each writing a marker if git ever runs it.
    const marker = join(main, "ran");
    const hook = join(main, "hook.sh");
    writeFileSync(hook, `#!/bin/sh\necho x >> ${marker}\ncat\n`);
    chmodSync(hook, 0o755);
    git(main, "config", "core.fsmonitor", hook);
    git(main, "config", "filter.evil.smudge", hook);
    writeFileSync(join(worktree, ".gitattributes"), "*.ts filter=evil\n");
    writeFileSync(join(worktree, "src", "keep.ts"), "changed\n");
    const restore = preserveTree(worktree);
    writeFileSync(join(worktree, "src", "made.ts"), "new\n");
    restore();
    expect(() => readFileSync(marker, "utf8")).toThrow();
  });

  it("still restores a card's worktree through the guarded git", () => {
    const main = repo({ "src/keep.ts": "export const keep = 1;\n" });
    const worktree = join(main, ".sekhemet", "worktrees", "card-2");
    git(main, "worktree", "add", "-q", "-b", "sekhemet/card-2", worktree);
    const restore = preserveTree(worktree);
    writeFileSync(join(worktree, "src", "keep.ts"), "changed\n");
    writeFileSync(join(worktree, "src", "made.ts"), "new\n");
    restore();
    expect(git(worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });
});
