import { execFileSync } from "node:child_process";
import {
  appendFileSync,
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { declaredStage, runGatePipeline } from "../src/pipeline.js";
import {
  DeterministicGateRunner,
  IMPACTED_TESTS_NO_INDEX,
  quarantinedTests,
  setQuarantinePolicy,
} from "../src/runner.js";
import type { QuarantinePolicy } from "../src/types.js";

// NEW-gates-3 (gates rules 33, 34): a verdict cached by tree and gate
// definition (GT-N3-1), the full suite with "no source index" said until T2
// (GT-N3-2), static gates before functional ones (GT-N3-3), and a flaky test
// re-run once and quarantined for the card (GT-N3-4). Real git, real
// processes, real Vitest.

const REPO = join(import.meta.dirname, "..", "..", "..");
const VITEST = join(REPO, "node_modules", "vitest", "vitest.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repo(files: Record<string, string>, gatesToml: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "economics-")));
  dirs.push(root);
  const all: Record<string, string> = {
    "package.json": '{ "name": "e", "type": "module", "private": true }\n',
    // The harness's state and the runner's cache are not the tree the gates judge.
    ".gitignore": ".sekhemet/\nnode_modules/\n.log/\n",
    ".sekhemet/gates.toml": gatesToml,
    ...files,
  };
  for (const [p, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@t.t");
  git(root, "config", "user.name", "T");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed");
  return root;
}

/** A gate that appends its id to `.log/starts` (ignored, inside the tree) and exits `code`. */
const logging = (id: string, rung: string, code = 0, timeout = 60) => `
[[gate]]
id = "${id}"
rung = "${rung}"
command = "sh"
args = ["-c", "mkdir -p .log && echo ${id} >> .log/starts; exit ${code}"]
parser = "generic"
timeout_s = ${timeout}
`;

const starts = (root: string): string[] => {
  try {
    return readFileSync(join(root, ".log", "starts"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
};

const runner = (root: string) =>
  new DeterministicGateRunner(new ProcessSandbox(), {
    repoRoot: root,
    maxFailuresReported: Number.POSITIVE_INFINITY,
  });

describe("the verdict cache (GT-N3-1)", () => {
  it("returns the cached verdict for an identical tree and gate without starting the process", async () => {
    const root = repo({ "src/a.ts": "export const a = 1;\n" }, logging("lint", "lint", 1));
    const r = runner(root);
    const first = await r.runGates(["lint"], root);
    const second = await r.runGates(["lint"], root);
    expect(starts(root)).toEqual(["lint"]);
    expect(second.passed).toBe(first.passed);
    expect(second.failures.map((f) => f.errorExcerpt)).toEqual(
      first.failures.map((f) => f.errorExcerpt),
    );
    expect(second.rungResults?.[0]?.cached).toBe(true);
    expect(first.rungResults?.[0]?.cached).toBeUndefined();
  });

  it("runs again when a tracked or an untracked file changes, and keys each gate by its definition", async () => {
    const root = repo({ "src/a.ts": "export const a = 1;\n" }, logging("lint", "lint"));
    const r = runner(root);
    await r.runGates(["lint"], root);
    writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n");
    await r.runGates(["lint"], root);
    writeFileSync(join(root, "src", "new.ts"), "export const n = 1;\n");
    await r.runGates(["lint"], root);
    expect(starts(root)).toEqual(["lint", "lint", "lint"]);
    // Two gates with one command are two verdicts: the key is the definition, not the command.
    writeFileSync(
      join(root, ".sekhemet", "gates.toml"),
      logging("lint", "lint") +
        logging("lint", "lint", 0, 61).replace('id = "lint"', 'id = "lint-b"'),
    );
    const fresh = runner(root);
    await fresh.runGates(["lint"], root);
    await fresh.runGates(["lint"], root);
    expect(starts(root)).toEqual(["lint", "lint", "lint", "lint", "lint"]);
  });

  it("keys a verdict by the tool's version and the environment the tree hash cannot see", async () => {
    const bin = realpathSync(mkdtempSync(join(tmpdir(), "economics-tool-")));
    dirs.push(bin);
    const tool = join(bin, "tool.sh");
    writeFileSync(tool, "#!/bin/sh\nmkdir -p .log && echo tool >> .log/starts\nexit 0\n");
    chmodSync(tool, 0o755);
    const root = repo(
      {},
      `[[gate]]\nid = "lint"\nrung = "lint"\ncommand = ${JSON.stringify(tool)}\nargs = []\nparser = "generic"\n`,
    );
    const r = runner(root);
    await r.runGates(["lint"], root);
    await r.runGates(["lint"], root);
    expect(starts(root)).toHaveLength(1);
    // A new version of the tool, outside the tree: a new verdict.
    writeFileSync(tool, "#!/bin/sh\nmkdir -p .log && echo tool >> .log/starts\nexit 0 # v2\n");
    await r.runGates(["lint"], root);
    expect(starts(root)).toHaveLength(2);
    // An environment the tools read (NODE_OPTIONS): a new verdict.
    vi.stubEnv("NODE_OPTIONS", "--no-warnings");
    try {
      await r.runGates(["lint"], root);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(starts(root)).toHaveLength(3);
  });

  it("hashes the tree without writing the untracked files into the repository's object store", async () => {
    const root = repo({}, logging("lint", "lint"));
    writeFileSync(join(root, "untracked.txt"), `only here ${Date.now()}\n`);
    const blob = git(root, "hash-object", "untracked.txt");
    await runner(root).runGates(["lint"], root);
    expect(() => git(root, "cat-file", "-e", blob)).toThrow();
  });

  it("never caches a gate that could not run", async () => {
    const root = repo(
      {},
      `[[gate]]
id = "lint"
rung = "lint"
command = "no-such-program-sekhemet"
args = []
parser = "generic"
`,
    );
    const r = runner(root);
    const first = await r.runGates(["lint"], root);
    const second = await r.runGates(["lint"], root);
    expect(first.failures[0]?.notRun).toBe(true);
    expect(second.rungResults?.[0]?.cached).toBeUndefined();
  });

  it("does not cache outside a git repository, where the tree has no hash", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "economics-nogit-")));
    dirs.push(root);
    mkdirSync(join(root, ".sekhemet"), { recursive: true });
    writeFileSync(join(root, ".sekhemet", "gates.toml"), logging("lint", "lint"));
    const r = runner(root);
    await r.runGates(["lint"], root);
    await r.runGates(["lint"], root);
    expect(starts(root)).toEqual(["lint", "lint"]);
  });
});

describe("cost order and the functional gate (GT-N3-2, GT-N3-3)", () => {
  it("runs every static gate before any functional gate, whatever the file's order", async () => {
    const root = repo(
      {},
      logging("unit", "test") + logging("lint", "lint") + logging("typecheck", "typecheck"),
    );
    await runner(root).runGates(["test", "lint", "typecheck"], root);
    const order = starts(root);
    expect(order.indexOf("unit")).toBeGreaterThan(order.indexOf("lint"));
    expect(order.indexOf("unit")).toBeGreaterThan(order.indexOf("typecheck"));
  });

  it("runs the full suite and says so while there is no source index", async () => {
    const root = repo({}, logging("unit", "test"));
    const r = await runner(root).runGates(["test"], root);
    expect(r.rungResults?.[0]?.note).toBe(IMPACTED_TESTS_NO_INDEX);
    expect(IMPACTED_TESTS_NO_INDEX).toBe("impacted tests first: no source index");
  });
});

describe("flaky tests (GT-N3-4)", () => {
  const vitestGate = (timeout = 120, extra = "") => `
[[gate]]
id = "unit"
rung = "test"
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(VITEST)}, "run"${extra}]
parser = "vitest"
timeout_s = ${timeout}
`;
  /**
   * Controlled by `.log/mode` (ignored, inside the tree): `fail-once` fails
   * and turns to `pass`; `fail` always fails; anything else passes.
   */
  const FLAKY = `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
it("is flaky", () => {
  const mode = existsSync(".log/mode") ? readFileSync(".log/mode", "utf8").trim() : "pass";
  if (mode === "fail-once") writeFileSync(".log/mode", "pass");
  expect(mode).toBe("pass");
});
`;
  const mode = (root: string, m: string) => {
    mkdirSync(join(root, ".log"), { recursive: true });
    writeFileSync(join(root, ".log", "mode"), m);
  };
  const BROKEN = `import { expect, it } from "vitest";
it("is broken", () => { expect(1 + 1).toBe(3); });
`;
  /** The card's first verification: the only time a quarantine may begin (rule 34). */
  const firstVerification = (root: string, policy: Partial<QuarantinePolicy> = {}) =>
    new DeterministicGateRunner(new ProcessSandbox(), {
      repoRoot: root,
      maxFailuresReported: Number.POSITIVE_INFINITY,
      quarantine: { open: true, ...policy },
    });

  it("re-runs a failing test once and quarantines it on positive JUnit evidence, with both runs attached", async () => {
    const root = repo({ "tests/flaky.spec.ts": FLAKY }, vitestGate());
    mode(root, "fail-once");
    const r = firstVerification(root);
    const result = await r.runGates(["test"], root);
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    const outcome = result.rungResults?.[0];
    expect(outcome?.passed).toBe(true);
    expect(outcome?.quarantined).toHaveLength(1);
    expect(outcome?.quarantined?.[0]?.test).toContain("is flaky");
    expect(outcome?.quarantined?.[0]?.firstRun).toContain("is flaky");
    expect(outcome?.quarantined?.[0]?.rerun).toMatch(/passed/);
    // Every quarantine is recorded for the card's evidence.
    expect(quarantinedTests(root).map((q) => q.test)).toEqual([outcome?.quarantined?.[0]?.test]);
    // The quarantine holds only until the tree changes: then it fails again.
    mode(root, "fail");
    appendFileSync(join(root, "tests", "flaky.spec.ts"), "\n");
    const again = await r.runGates(["test"], root);
    expect(again.passed).toBe(false);
    expect(again.rungResults?.[0]?.quarantined ?? []).toEqual([]);
    // Another card's runner has not seen it flake: there it is a failure.
    const other = await firstVerification(root).runGates(["test"], root);
    expect(other.passed).toBe(false);
  });

  it("quarantines nothing unless the card's first verification opened it (never at red-first)", async () => {
    const root = repo({ "tests/flaky.spec.ts": FLAKY }, vitestGate());
    mode(root, "fail-once");
    const result = await runner(root).runGates(["test"], root);
    expect(result.passed).toBe(false);
    expect(result.rungResults?.[0]?.quarantined ?? []).toEqual([]);
    // The card runner's policy for the worktree opens it, and closes it again.
    mode(root, "fail-once");
    setQuarantinePolicy(root, { open: true });
    try {
      const opened = await runner(root).runGates(["test"], root);
      expect(opened.passed).toBe(true);
      setQuarantinePolicy(root, { open: false });
      mode(root, "fail-once");
      appendFileSync(join(root, "tests", "flaky.spec.ts"), "\n");
      const closed = await runner(root).runGates(["test"], root);
      expect(closed.passed).toBe(false);
    } finally {
      setQuarantinePolicy(root, undefined);
    }
  });

  it("never quarantines the card's acceptance tests or a test the card's diff changed or added", async () => {
    const root = repo({ "tests/flaky.spec.ts": FLAKY }, vitestGate());
    mode(root, "fail-once");
    const own = await firstVerification(root, { never: ["tests/flaky.spec.ts"] }).runGates(
      ["test"],
      root,
    );
    expect(own.passed).toBe(false);
    expect(own.rungResults?.[0]?.quarantined ?? []).toEqual([]);
    // Added on the card's branch, committed or not: the card's own test.
    git(root, "checkout", "-q", "-b", "card");
    writeFileSync(join(root, "tests", "added.spec.ts"), FLAKY.replace("is flaky", "is added"));
    mode(root, "fail-once");
    rmSync(join(root, "tests", "flaky.spec.ts"));
    const added = await firstVerification(root, { base: "main" }).runGates(["test"], root);
    expect(added.passed).toBe(false);
    expect(added.rungResults?.[0]?.quarantined ?? []).toEqual([]);
  });

  it("counts a re-run without per-test pass evidence as not re-run: no JUnit path, no tests found, a timeout", async () => {
    // A generic gate has no per-test result: its second pass is no evidence.
    const flakyGeneric = `
[[gate]]
id = "unit"
rung = "test"
command = "sh"
args = ["-c", "if [ -f .log/once ]; then exit 0; fi; mkdir -p .log; touch .log/once; exit 1"]
parser = "generic"
timeout_s = 60
`;
    const generic = repo({}, flakyGeneric);
    const g = await firstVerification(generic).runGates(["test"], generic);
    expect(g.passed).toBe(false);
    expect(g.rungResults?.[0]?.quarantined ?? []).toEqual([]);
    // The re-run finds no test (passWithNoTests): nothing passed, the failure stands.
    const VANISHING = `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
const mode = existsSync(".log/mode") ? readFileSync(".log/mode", "utf8").trim() : "pass";
if (mode === "fail-once") {
  it("vanishes", () => {
    writeFileSync(".log/mode", "gone");
    expect(mode).toBe("pass");
  });
}
`;
    const empty = repo(
      { "tests/vanish.spec.ts": VANISHING },
      vitestGate(120, ', "--passWithNoTests"'),
    );
    mode(empty, "fail-once");
    const e = await firstVerification(empty).runGates(["test"], empty);
    expect(e.passed).toBe(false);
    expect(e.rungResults?.[0]?.quarantined ?? []).toEqual([]);
    // The re-run times out: not re-run, the failure stands.
    const HANGS = `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
it("hangs on the re-run", async () => {
  const mode = existsSync(".log/mode") ? readFileSync(".log/mode", "utf8").trim() : "pass";
  if (mode === "hang") await new Promise((r) => setTimeout(r, 60_000));
  if (mode === "fail-once") writeFileSync(".log/mode", "hang");
  expect(mode).not.toBe("fail-once");
}, 120_000);
`;
    const slow = repo({ "tests/hangs.spec.ts": HANGS }, vitestGate(10));
    mode(slow, "fail-once");
    const t = await firstVerification(slow).runGates(["test"], slow);
    expect(t.passed).toBe(false);
    expect(t.rungResults?.[0]?.quarantined ?? []).toEqual([]);
  }, 60_000);

  it("keeps a test that fails twice as a failure", async () => {
    const root = repo({ "tests/broken.spec.ts": BROKEN }, vitestGate());
    const result = await firstVerification(root).runGates(["test"], root);
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.rungResults?.[0]?.quarantined ?? []).toEqual([]);
  });

  it("reports a quarantined test to the person as an advisory, never as a failure", async () => {
    const root = repo({ "tests/flaky.spec.ts": FLAKY }, vitestGate());
    mode(root, "fail-once");
    const pipeline = await runGatePipeline(
      [declaredStage(firstVerification(root), ["test"], root)],
      { cwd: root },
    );
    expect(pipeline.passed).toBe(true);
    expect(pipeline.failures).toEqual([]);
    expect(pipeline.advisories.join("\n")).toMatch(/flaky.*is flaky/i);
  });
});

describe("fail-fast (rule 33)", () => {
  it("lists the gates it skipped in cost order, each once, never one that already ran", async () => {
    const root = repo(
      {},
      logging("unit", "test", 1) + logging("typecheck", "typecheck") + logging("lint", "lint"),
    );
    const r = new DeterministicGateRunner(new ProcessSandbox(), {
      repoRoot: root,
      failFast: true,
      maxFailuresReported: Number.POSITIVE_INFINITY,
    });
    const result = await r.runGates(["test", "typecheck", "lint"], root);
    const gates = (result.rungResults ?? []).map((o) => `${o.gate}${o.skipped ? ":skipped" : ""}`);
    expect(gates).toEqual(["typecheck", "lint", "unit"]);
    const failFirst = repo(
      {},
      logging("unit", "test") + logging("typecheck", "typecheck", 1) + logging("lint", "lint"),
    );
    const f = await new DeterministicGateRunner(new ProcessSandbox(), {
      repoRoot: failFirst,
      failFast: true,
    }).runGates(["test", "typecheck", "lint"], failFirst);
    const shown = (f.rungResults ?? []).map((o) => `${o.gate}${o.skipped ? ":skipped" : ""}`);
    expect(shown).toEqual(["typecheck", "lint:skipped", "unit:skipped"]);
  });
});
