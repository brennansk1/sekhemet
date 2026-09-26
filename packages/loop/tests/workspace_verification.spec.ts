import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GateResult, GateRung, GateRunner } from "@sekhemet/gates";
import { afterEach, describe, expect, it } from "vitest";
import { verifyCardTree } from "../src/verification.js";

// review-git NEW-review-git-3 RG-N3-1 and gates GT-BF-4: the per-package
// gates run inside the card's verification — the one pipeline the card run
// and `sekhemet gate <card>` share — first, before the declared gates. A
// real pnpm workspace, real git, real confined processes.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace(bTest: number): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ws-verify-")));
  dirs.push(root);
  const pkg = (name: string, deps: Record<string, string>, code = 0) =>
    JSON.stringify({
      name,
      version: "1.0.0",
      dependencies: deps,
      scripts: { test: `node -e "process.exit(${code})"` },
    });
  const files: Record<string, string> = {
    "package.json": '{ "name": "root", "private": true }\n',
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "packages/a/package.json": pkg("@x/a", {}),
    "packages/a/src/index.ts": "export const a = 1;\n",
    "packages/b/package.json": pkg("@x/b", { "@x/a": "workspace:*" }, bTest),
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
  writeFileSync(join(root, "packages/a/src/index.ts"), "export const a = 2;\n");
  return root;
}

const passing: GateRunner = {
  runGates: async (_rungs: GateRung[]): Promise<GateResult> => ({
    passed: true,
    failures: [],
    durationMs: 0,
    rungResults: [],
  }),
};

describe("per-package gates in the card's verification (RG-N3-1, GT-BF-4)", () => {
  it("runs the changed package's and its dependent's gates first, and fails the card on either", async () => {
    const root = workspace(1);
    const r = await verifyCardTree({
      root,
      base: "main",
      rungs: ["test"],
      runner: passing,
      staged: [],
      integrity: false,
    });
    expect(r.rungResults.map((o) => o.gate).slice(0, 2)).toEqual(["@x/a:test", "@x/b:test"]);
    expect(r.passed).toBe(false);
    expect(r.allFailures.map((f) => f.gate)).toEqual(["@x/b:test"]);
  });

  it("passes when every package gate passes, and runs none in a read-only audit", async () => {
    const root = workspace(0);
    const ok = await verifyCardTree({
      root,
      base: "main",
      rungs: ["test"],
      runner: passing,
      staged: [],
      integrity: false,
    });
    expect(ok.passed).toBe(true);
    const audit = await verifyCardTree({
      root,
      base: "main",
      rungs: ["test"],
      runner: passing,
      staged: [],
      integrity: false,
      restricted: true,
    });
    expect(audit.rungResults.some((o) => o.gate.startsWith("@x/"))).toBe(false);
  });
});
