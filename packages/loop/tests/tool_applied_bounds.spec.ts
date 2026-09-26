import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_PROJECT_CONFIG,
  type GateResult,
  type GateRung,
  type GateRunner,
  compileEvidence,
  loadGatesConfig,
} from "@sekhemet/gates";
import { afterEach, describe, expect, it } from "vitest";
import { verificationSessionOptions } from "../src/card_runner.js";
import { verifyCardTree } from "../src/verification.js";

// NEW-gates-7, GT-BF-3 and GT-BF-5 (gates rule 12): lines a declared
// mechanical tool applied (rename_symbol) are counted against their own
// bound, `max_tool_applied_lines` (default 500), never against
// `max_diff_lines`; a card with tool-applied lines runs the typecheck and the
// full suite; the evidence reports the value in force. Real git.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repo(files: Record<string, string>, gatesToml?: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tool-applied-")));
  dirs.push(root);
  const all: Record<string, string> = {
    ".gitignore": ".sekhemet/state/\n",
    ...(gatesToml ? { ".sekhemet/gates.toml": gatesToml } : {}),
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

/** A runner that records the rungs it was asked for and passes. */
function recording(): GateRunner & { asked: GateRung[][] } {
  const asked: GateRung[][] = [];
  return {
    asked,
    runGates: async (rungs: GateRung[]): Promise<GateResult> => {
      asked.push([...rungs]);
      return { passed: true, failures: [], durationMs: 0, rungResults: [] };
    },
  };
}

/** Forty uses of `oldName` per file, in `n` files: a rename touches all of them. */
function renamedRepo(n: number): { root: string; files: Record<string, number> } {
  const body = (name: string) =>
    Array.from({ length: 40 }, (_, i) => `export const v${i} = ${name};`).join("\n");
  const src: Record<string, string> = {};
  for (let i = 0; i < n; i++) src[`src/f${i}.ts`] = `${body("oldName")}\n`;
  const root = repo(src);
  const files: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    writeFileSync(join(root, `src/f${i}.ts`), `${body("newName")}\n`);
    files[`src/f${i}.ts`] = 40;
  }
  return { root, files };
}

describe("tool-applied lines under their own bound (GT-BF-3, GT-BF-5)", () => {
  it("defaults max_tool_applied_lines to 500 and reads it from gates.toml", () => {
    expect(DEFAULT_PROJECT_CONFIG.maxToolAppliedLines).toBe(500);
    const root = repo({}, "[project]\nmax_tool_applied_lines = 900\n");
    expect(loadGatesConfig(root).project.maxToolAppliedLines).toBe(900);
    const plain = repo({});
    expect(loadGatesConfig(plain).project.maxToolAppliedLines).toBe(500);
    expect(
      verificationSessionOptions(loadGatesConfig(root), { repoRoot: root, restricted: false })
        .bounds.maxToolAppliedLines,
    ).toBe(900);
  });

  it("a rename across five files passes bounds; the Worker's own lines still count", async () => {
    const { root, files } = renamedRepo(5);
    // The Worker's own edit: one more file, three lines.
    writeFileSync(
      join(root, "src/extra.ts"),
      "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
    );
    const runner = recording();
    const r = await verifyCardTree({
      root,
      base: "main",
      rungs: ["lint"],
      runner,
      staged: [],
      integrity: false,
      bounds: { maxFiles: 3, maxLines: 200, maxToolAppliedLines: 500 },
      toolApplied: { tool: "rename_symbol", files },
    });
    const bounds = r.rungResults.find((o) => o.gate === "bounds");
    expect(bounds?.passed).toBe(true);
    expect(bounds?.toolApplied).toMatchObject({ tool: "rename_symbol", lines: 400, limit: 500 });
    expect(bounds?.note).toMatch(/400 tool-applied lines by rename_symbol/);
    // A card with tool-applied lines must pass the typecheck and the full suite.
    expect(runner.asked[0]).toEqual(expect.arrayContaining(["lint", "typecheck", "test"]));
    const evidence = compileEvidence({
      cardId: "c",
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
    expect(evidence.toolApplied).toMatchObject({ tool: "rename_symbol", lines: 400, limit: 500 });

    // Without the record, the same lines are the Worker's and exceed the bounds.
    const plain = await verifyCardTree({
      root,
      base: "main",
      rungs: ["lint"],
      runner: recording(),
      staged: [],
      integrity: false,
      bounds: { maxFiles: 3, maxLines: 200, maxToolAppliedLines: 500 },
    });
    expect(plain.rungResults.find((o) => o.gate === "bounds")?.passed).toBe(false);
    expect(plain.rungResults.find((o) => o.gate === "bounds")?.toolApplied).toMatchObject({
      lines: 0,
      limit: 500,
    });
  });

  it("fails the bounds gate naming the tool and the count past max_tool_applied_lines", async () => {
    const { root, files } = renamedRepo(8);
    const r = await verifyCardTree({
      root,
      base: "main",
      rungs: ["lint"],
      runner: recording(),
      staged: [],
      integrity: false,
      bounds: { maxFiles: 3, maxLines: 200, maxToolAppliedLines: 500 },
      toolApplied: { tool: "rename_symbol", files },
    });
    expect(r.passed).toBe(false);
    const f = r.allFailures.find((x) => x.gate === "bounds");
    expect(f?.actual).toBe("rename_symbol applied 640 diff lines");
    expect(f?.expected).toBe("at most 500 tool-applied diff lines");
    expect(f?.suggestedAction).toMatch(/rename_symbol/);
  });
});
