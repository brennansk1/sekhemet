import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { confinedSandbox } from "@sekhemet/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { runGatePipeline } from "../src/pipeline.js";
import { DeterministicGateRunner } from "../src/runner.js";
import { workspacePlan, workspaceStage } from "../src/workspace.js";

// NEW-gates-7 GT-BF-4 (gates rule 34a) and review-git NEW-review-git-3
// RG-N3-1: in a workspace, a card's changed packages and their dependents run
// their own gates first, in build order, with the build step as a gate when
// the change crosses a package boundary; a card touching two packages runs
// both gate sets. A real pnpm workspace, real pnpm, real confined processes.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A script that appends `<pkg>:<step>` to the root's .log/order and exits `code`. */
const step = (pkg: string, name: string, code = 0) =>
  `node -e "require('fs').mkdirSync('../../.log',{recursive:true});require('fs').appendFileSync('../../.log/order','${pkg}:${name}\\n');process.exit(${code})"`;

function workspace(opts: { bTestCode?: number } = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workspace-")));
  dirs.push(root);
  const pkg = (name: string, deps: Record<string, string>, scripts: Record<string, string>) =>
    `${JSON.stringify({ name, version: "1.0.0", dependencies: deps, scripts }, null, 2)}\n`;
  const files: Record<string, string> = {
    "package.json": '{ "name": "root", "private": true }\n',
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    ".gitignore": ".log/\nnode_modules/\n",
    // `a` is a library; `b` depends on it; `c` is independent.
    "packages/a/package.json": pkg(
      "@x/a",
      {},
      { build: step("a", "build"), test: step("a", "test") },
    ),
    "packages/a/src/index.ts": "export const a = 1;\n",
    "packages/b/package.json": pkg(
      "@x/b",
      { "@x/a": "workspace:*" },
      { build: step("b", "build"), test: step("b", "test", opts.bTestCode ?? 0) },
    ),
    "packages/b/src/index.ts": "export const b = 2;\n",
    "packages/c/package.json": pkg("@x/c", {}, { test: step("c", "test") }),
    "packages/c/src/index.ts": "export const c = 3;\n",
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

const order = (root: string): string[] => {
  try {
    return readFileSync(join(root, ".log", "order"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
};

const runner = () =>
  new DeterministicGateRunner(confinedSandbox(false), {
    maxFailuresReported: Number.POSITIVE_INFINITY,
  });

describe("the workspace plan (GT-BF-4, rule 34a)", () => {
  it("orders the changed package and its dependents in build order", () => {
    const root = workspace();
    const plan = workspacePlan(root, ["packages/a/src/index.ts"]);
    expect(plan?.tool).toBe("pnpm");
    expect(plan?.touched).toEqual(["@x/a"]);
    expect(plan?.order.map((p) => p.name)).toEqual(["@x/a", "@x/b"]);
    expect(plan?.crossesBoundary).toBe(true);
    const leaf = workspacePlan(root, ["packages/c/src/index.ts"]);
    expect(leaf?.order.map((p) => p.name)).toEqual(["@x/c"]);
    expect(leaf?.crossesBoundary).toBe(false);
    // A root file belongs to no package; a single-package repository is no workspace.
    expect(workspacePlan(root, ["README.md"])?.order).toEqual([]);
  });

  it("is undefined outside a workspace, never a parent directory's", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "single-")));
    dirs.push(root);
    writeFileSync(join(root, "package.json"), '{ "name": "one" }\n');
    expect(workspacePlan(root, ["src/x.ts"])).toBeUndefined();
  });
});

describe("the workspace stage (GT-BF-4, RG-N3-1)", () => {
  it("builds the changed library before its dependent's tests, and runs nothing else", async () => {
    const root = workspace();
    const r = await runGatePipeline(
      [workspaceStage({ root, changed: ["packages/a/src/index.ts"], runner: runner() })],
      { cwd: root },
    );
    expect(r.passed).toBe(true);
    expect(order(root)).toEqual(["a:build", "a:test", "b:build", "b:test"]);
    expect(r.rungResults.map((o) => o.gate)).toEqual([
      "@x/a:build",
      "@x/a:test",
      "@x/b:build",
      "@x/b:test",
    ]);
  });

  it("a card touching two packages runs both gate sets, and passes only when both pass", async () => {
    const root = workspace({ bTestCode: 1 });
    const r = await runGatePipeline(
      [
        workspaceStage({
          root,
          changed: ["packages/b/src/index.ts", "packages/c/src/index.ts"],
          runner: runner(),
        }),
      ],
      { cwd: root },
    );
    expect(order(root)).toEqual(["b:build", "b:test", "c:test"]);
    expect(r.passed).toBe(false);
    expect(r.allFailures.map((f) => f.gate)).toEqual(["@x/b:test"]);
    expect(r.rungResults.find((o) => o.gate === "@x/c:test")?.passed).toBe(true);
  });

  it("stops the dependents' tests when a build fails, saying why", async () => {
    const root = workspace();
    const pj = join(root, "packages/a/package.json");
    writeFileSync(pj, readFileSync(pj, "utf8").replace("process.exit(0)", "process.exit(2)"));
    const r = await runGatePipeline(
      [workspaceStage({ root, changed: ["packages/a/src/index.ts"], runner: runner() })],
      { cwd: root },
    );
    expect(r.passed).toBe(false);
    expect(order(root)).toEqual(["a:build"]);
    const skipped = r.rungResults.filter((o) => o.skipped);
    expect(skipped.map((o) => o.gate)).toEqual(["@x/a:test", "@x/b:build", "@x/b:test"]);
    expect(skipped[0]?.reason).toMatch(/@x\/a:build failed/);
  });
});

// The lead's efficiency decision: when the declared suite builds the
// workspace, that gate is the build step — run once, first — and no
// package's own build script runs.
describe("the declared build stands for the package builds (efficiency)", () => {
  it("runs the declared build once, first, and no package build", async () => {
    const root = workspace();
    writeFileSync(
      join(root, "build.mjs"),
      "import { appendFileSync, mkdirSync } from 'node:fs';\nmkdirSync('.log', { recursive: true });\nappendFileSync('.log/order', 'declared:build\\n');\n",
    );
    mkdirSync(join(root, ".sekhemet"), { recursive: true });
    writeFileSync(
      join(root, ".sekhemet", "gates.toml"),
      '[[gate]]\nid = "build"\nrung = "typecheck"\ncommand = "node"\nargs = ["build.mjs", "build"]\nparser = "generic"\n\n[[gate]]\nid = "unit"\nrung = "test"\ncommand = "node"\nargs = ["-e", "0"]\nparser = "generic"\n',
    );
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "declared gates"], { cwd: root });
    writeFileSync(join(root, "packages/a/src/index.ts"), "export const a = 2;\n");
    const r = await new DeterministicGateRunner(confinedSandbox(false), {
      repoRoot: root,
      maxFailuresReported: Number.POSITIVE_INFINITY,
    }).runGates(["typecheck", "test"], root, {
      workspace: { base: "main", changed: ["packages/a/src/index.ts"] },
    });
    expect(r.passed).toBe(true);
    expect(order(root)).toEqual(["declared:build", "a:test", "b:test"]);
    expect(r.rungResults?.filter((o) => o.gate === "build")).toHaveLength(1);
    expect(r.workspace?.packages).toEqual(["@x/a", "@x/b"]);
  });
});
