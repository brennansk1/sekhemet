import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGatesConfig } from "@sekhemet/gates";
import { describe, expect, it } from "vitest";
import { deriveGates, recommendRoster, runInit, toolchainChecks } from "../src/init.js";

const GB = 1024 ** 3;

describe("sekhemet init (H25)", () => {
  it("recommends a roster by memory: one at a time on 24 GB, all resident on 128 GB", () => {
    expect(recommendRoster(24 * GB)).toMatchObject({
      tier: "M",
      worker: "cyber-tiel",
      researcher: "apodex",
    });
    expect(recommendRoster(24 * GB).note).toMatch(/One large model at a time/);
    expect(recommendRoster(128 * GB)).toMatchObject({ tier: "XL" });
    expect(recommendRoster(128 * GB).note).toMatch(/All four roles stay resident/);
  });

  it("derives gates from the project's own scripts and tooling", () => {
    const repo = mkdtempSync(join(tmpdir(), "init-"));
    writeFileSync(join(repo, "pnpm-lock.yaml"), "");
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        scripts: { typecheck: "tsc -b", lint: "biome check .", test: "vitest run" },
        devDependencies: { vitest: "3", "@biomejs/biome": "2" },
      }),
    );
    const g = deriveGates(repo);
    expect(g.gates).toEqual([
      "typecheck: pnpm run typecheck",
      "lint: pnpm run lint",
      "unit: pnpm run test",
    ]);
    expect(g.toml).toMatch(
      /\[\[gate\]\]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "pnpm"\nargs = \["run", "test"\]\ntimeout_s = 600\nparser = "vitest"/,
    );
    const py = mkdtempSync(join(tmpdir(), "init-py-"));
    writeFileSync(join(py, "pyproject.toml"), "[tool.ruff]\n[tool.mypy]\n");
    expect(deriveGates(py).gates).toEqual([
      "typecheck: mypy .",
      "lint: ruff check .",
      "unit: pytest -q",
    ]);
  });

  it("checks the toolchain with a fix for each missing piece", () => {
    const checks = toolchainChecks((cmd) => (cmd === "git" ? "git version 2.50" : undefined));
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName.git?.ok).toBe(true);
    expect(byName["llama-server (llama.cpp)"]).toMatchObject({ ok: false, required: true });
    expect(byName["Docker (for private web search)"]).toMatchObject({ ok: false, required: false });
    expect(checks.every((c) => c.ok || c.fix)).toBe(true);
  });

  it("writes config, gates and .gitignore once, keeps them after, and reports readiness", () => {
    const repo = mkdtempSync(join(tmpdir(), "init-run-"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    writeFileSync(join(repo, ".gitignore"), "node_modules/");
    const lines: string[] = [];
    const run = (cmd: string) =>
      cmd === "llama-server" ? "version: 6500 (abc)" : cmd === "git" ? "git version 2" : undefined;
    const first = runInit(repo, { run, totalBytes: 24 * GB, say: (l) => lines.push(l) });
    expect(first.wrote).toEqual(["gates.toml", "config.toml", ".gitignore"]);
    expect(first.ready).toBe(true);
    expect(readFileSync(join(repo, ".sekhemet", "config.toml"), "utf8")).toMatch(
      /executor = "cyber-tiel"/,
    );
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toMatch(
      /^node_modules\/\n# Sekhemet\n\.sekhemet\/worktrees\//,
    );
    // The generated file loads through the real gates parser.
    const cfg = loadGatesConfig(repo);
    expect(cfg.gates.map((g) => g.id)).toEqual(["unit"]);
    expect(cfg.project.maxFiles).toBe(3);
    const second = runInit(repo, { run, totalBytes: 24 * GB, say: () => {} });
    expect(second.wrote).toEqual([]);
    expect(second.kept).toEqual(["gates.toml", "config.toml"]);
    expect(lines.at(-1)).toMatch(/Ready\. Next: `sekhemet calibrate`/);
  });

  it("RUN-35: the runner lease and the slot leases are ignored by git, so a running card never dirties the tree", () => {
    const repo = mkdtempSync(join(tmpdir(), "init-leases-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      const run = (cmd: string) =>
        cmd === "llama-server"
          ? "version: 6500 (abc)"
          : cmd === "git"
            ? "git version 2"
            : undefined;
      runInit(repo, { run, totalBytes: 24 * GB, say: () => {} });
      const ignore = readFileSync(join(repo, ".gitignore"), "utf8").split("\n");
      expect(ignore).toContain(".sekhemet/slots/");
      expect(ignore).toContain(".sekhemet/runner.lock");
      mkdirSync(join(repo, ".sekhemet", "slots"), { recursive: true });
      writeFileSync(join(repo, ".sekhemet", "slots", "0.lock"), "{}");
      writeFileSync(join(repo, ".sekhemet", "slots", "admit.lock"), "");
      writeFileSync(join(repo, ".sekhemet", "runner.lock"), "{}");
      const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: repo,
        encoding: "utf8",
      });
      expect(status).not.toMatch(/slots|runner\.lock/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
