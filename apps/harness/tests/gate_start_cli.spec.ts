import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CardStore } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";

// SUR-12 through the spawned binary: a derived test gate whose script is
// missing from package.json stops `run` and `queue` before any model loads,
// naming the file to edit, and the card is not run (so not charged).

const BIN = resolve(import.meta.dirname, "../dist/index.js");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function project() {
  const root = mkdtempSync(join(tmpdir(), "sek-gate-cli-"));
  dirs.push(root);
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(repo);
  mkdirSync(home);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jane Doe");
  git("config", "user.email", "jane@example.com");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "x", scripts: { build: "tsc" } }),
  );
  mkdirSync(join(repo, ".sekhemet"));
  writeFileSync(
    join(repo, ".sekhemet", "gates.toml"),
    '[[gate]]\nid = "test"\nrung = "test"\ncommand = "npm"\nargs = ["run", "test"]\n',
  );
  writeFileSync(join(repo, ".gitignore"), ".sekhemet/*\n!.sekhemet/gates.toml\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  const { db, log } = openLocalLedger(repo);
  await new CardStore(db, log).createCard({
    id: "c1",
    tier: "story",
    title: "Write a",
    status: "ready",
    scopeFiles: ["src/a.ts"],
    stepBudget: 3,
    spec: "Export a constant named a from src/a.ts",
  });
  db.close();
  const configDir = join(home, ".sekhemet");
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    SEKHEMET_CONFIG_DIR: configDir,
    SEKHEMET_MODEL_REGISTRY: join(configDir, "models.json"),
    SEKHEMET_MACHINE_PROFILE: join(configDir, "machine.json"),
    SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml",
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
  return { run };
}

describe("SUR-12: a derived test gate that cannot start stops the run", () => {
  it("stops `run` before the card starts, naming package.json", async () => {
    const { run } = await project();
    const r = run("dev", "run", "c1");
    expect(r.out).toMatch(/The test gate cannot start: package\.json has no "test" script/);
    expect(r.out).toMatch(/Edit package\.json/);
    expect(r.out).not.toMatch(/Executing card c1/);
    expect(r.code).toBe(1);
  }, 60_000);

  it("stops `queue` before any card, naming package.json", async () => {
    const { run } = await project();
    const r = run("dev", "queue");
    expect(r.out).toMatch(/The test gate cannot start: package\.json has no "test" script/);
    expect(r.out).toMatch(/Edit package\.json/);
    expect(r.code).toBe(1);
  }, 60_000);
});
