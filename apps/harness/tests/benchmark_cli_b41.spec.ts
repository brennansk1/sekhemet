import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// B4.1 wiring through the spawned binary (measurement NEW-measurement-5,
// models MD-N12-6): `sekhemet dev benchmark` and `sekhemet dev models fetch`
// reach their commands. Nothing here loads or downloads a model: the quick
// tier is not started, the overnight tier is only queued, and the fetch is
// refused by the network policy before any request.

const BIN = resolve(import.meta.dirname, "../dist/index.js");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project() {
  const root = mkdtempSync(join(tmpdir(), "sek-bench-cli-"));
  dirs.push(root);
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(repo);
  mkdirSync(home);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jane Doe");
  git("config", "user.email", "jane@example.com");
  writeFileSync(join(repo, ".gitignore"), ".sekhemet/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  const user = join(root, "user.toml");
  writeFileSync(user, '[network]\nmode = "offline"\n');
  const configDir = join(home, ".sekhemet");
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    SEKHEMET_CONFIG_DIR: configDir,
    SEKHEMET_MODEL_REGISTRY: join(configDir, "models.json"),
    SEKHEMET_MACHINE_PROFILE: join(configDir, "machine.json"),
    SEKHEMET_USER_CONFIG: user,
    BROWSER: "false",
  };
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, ...args, "--repo", repo], {
      cwd: repo,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  return { repo, root, run };
}

describe("sekhemet dev benchmark (NEW-measurement-5)", () => {
  it("shows the overnight estimate and queues nothing without --yes; with it, queues the run, which status lists", () => {
    const { run } = project();
    const shown = run("dev", "benchmark", "overnight", "--combination", "worker=a,planner=b");
    expect(shown.out).toMatch(/Nothing has been queued/);
    expect(shown.code).toBe(0);
    const queued = run(
      "dev",
      "benchmark",
      "overnight",
      "--combination",
      "worker=a,planner=b",
      "--first",
      "--yes",
    );
    expect(queued.out).toMatch(/Overnight benchmark \S+ queued/);
    expect(queued.code).toBe(0);
    const status = run("dev", "benchmark", "status");
    expect(status.out).toMatch(/overnight queued/);
    expect(status.code).toBe(0);
  }, 120_000);
});

describe("sekhemet dev models fetch (MD-N12-6)", () => {
  it("reaches the verified download, which the offline policy refuses before any request, naming the setting", () => {
    const { run, root } = project();
    const r = run("dev", "models", "fetch", "cyber-tiel", "--folder", join(root, "models"));
    expect(r.out).toMatch(/\[network\] mode/);
    expect(r.out).not.toMatch(/Usage: sekhemet models assign/);
    expect(r.code).toBe(1);
  }, 60_000);
});
