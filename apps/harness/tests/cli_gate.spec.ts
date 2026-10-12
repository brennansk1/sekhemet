import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/index.js";

describe("sekhemet gate", () => {
  const dirs: string[] = [];
  afterEach(() => {
    process.exitCode = 0;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const repo = (script: string) => {
    const dir = mkdtempSync(join(tmpdir(), "cli-gate-"));
    dirs.push(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, ".sekhemet"));
    writeFileSync(
      join(dir, ".sekhemet", "gates.toml"),
      `[project]\nmax_files = 3\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "dynamic"\ncommand = "node"\nargs = ["-e", ${JSON.stringify(script)}]\ntimeout_s = 30\nparser = "generic"\n`,
    );
    return dir;
  };

  it("runs every declared gate and passes when they pass", async () => {
    const dir = repo("process.exit(0)");
    await main(["gate", "--repo", dir]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("fails with a non-zero exit code when a declared gate fails", async () => {
    const dir = repo("console.error('error: boom'); process.exit(3)");
    await main(["gate", "--repo", dir]);
    expect(process.exitCode).toBe(1);
  });

  it("writes the detected gate template with `gates init` (G27)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-gates-init-"));
    dirs.push(dir);
    writeFileSync(join(dir, "go.mod"), "module example.com/x\n");
    await main(["gates", "init", "--repo", dir]);
    expect(process.exitCode ?? 0).toBe(0);
    const toml = readFileSync(join(dir, ".sekhemet", "gates.toml"), "utf8");
    expect(toml).toContain('command = "go"');
    await main(["gates", "init", "--repo", dir]);
    expect(process.exitCode).toBe(1);
  });

  // S1B-B15 (wave 1): an error says the next step on its own line, "Do: …".
  const initErr = async (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "cli-gates-init-none-"));
    dirs.push(dir);
    for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
    const said: string[] = [];
    const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      said.push(a.join(" "));
    });
    try {
      await main(["gates", "init", "--repo", dir]);
    } finally {
      err.mockRestore();
    }
    return { dir, text: said.join("\n") };
  };

  it("S1B-B15: `gates init` with no manifest says which files it reads and the next step, writes no checks file, exit 1", async () => {
    const { dir, text } = await initErr({});
    expect(process.exitCode).toBe(1);
    expect(text).toMatch(
      /^sekhemet: no manifest to derive checks from \(package\.json, pyproject\.toml, requirements\.txt, Cargo\.toml, go\.mod\)/,
    );
    expect(text).toMatch(
      /\n {2}Do: run it in the project's root folder, or add its manifest, then run sekhemet gates init again\.$/,
    );
    expect(existsSync(join(dir, ".sekhemet", "gates.toml"))).toBe(false);
  });

  it('S1B-B15: `gates init` with a package.json that names no check says so (not "no manifest") and the next step', async () => {
    const { text } = await initErr({ "package.json": '{"name":"x"}' });
    expect(process.exitCode).toBe(1);
    expect(text).toMatch(/^sekhemet: package\.json names no check to run/);
    expect(text).toMatch(
      /\n {2}Do: add a "test" script to package\.json, then run sekhemet gates init again\.$/,
    );
  });
});
