import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
});
