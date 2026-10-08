import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The pre-publication pass (DEC-54 c2, FINDINGS_C1 INS-06, W15), through its
 * door: `node scripts/prepublication.mjs` spawned over real git repositories.
 * `--check` refuses a tracked file holding a machine path (this host's home,
 * a mounted volume, an agent's scratch folder, a configured models folder)
 * or a tracked `.claude/launch.json`; a full run writes the report, scanning
 * every commit for secrets with the bundled rules and never rewriting history.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = join(ROOT, "scripts", "prepublication.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh repository holding `files`, committed by a named author. */
function repo(files: Record<string, string>): { dir: string; home: string } {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "sek-prepub-")));
  dirs.push(top);
  const dir = join(top, "repo");
  const home = join(top, "home", "ada");
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Ada");
  git("config", "user.email", "ada@example.org");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "seed");
  return { dir, home };
}

function run(args: string[], env: Record<string, string>, cwd = ROOT) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
    timeout: 300_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("the pre-publication pass, spawned (DEC-54 c2, INS-06)", () => {
  it("passes on this repository: no tracked machine path outside the named records, no tracked launch.json", () => {
    const r = run(["--check"], { HOME: process.env.HOME ?? homedir() });
    expect(r.out).toMatch(/no machine path in \d+ tracked files/);
    expect(r.status, r.out).toBe(0);
  });

  it("fails on a tracked file holding this host's home directory, naming the file and line but not the path", () => {
    const where = repo({ "src/ok.ts": "export const a = 1;\n" });
    writeFileSync(
      join(where.dir, "notes.md"),
      `# Notes\n\nThe models are in ${where.home}/models/w.gguf.\n`,
    );
    execFileSync("git", ["add", "notes.md"], { cwd: where.dir });
    const r = run(["--check", "--root", where.dir], { HOME: where.home });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/notes\.md:3 .*this host's home directory/);
    expect(r.out).not.toContain(where.home);
  });

  it("fails on an agent's scratch folder and on a configured models folder, wherever the host is", () => {
    // Assembled here, so this file holds no scratch path of its own.
    const scratch = ["/private/tmp", "claude-501", "demo"].join("/");
    const where = repo({
      ".claude/notes.json": `{ "repo": "${scratch}" }\n`,
      "scripts/run.mjs": 'const dir = "/srv/weights-7f3a/llm";\n',
    });
    const r = run(["--check", "--root", where.dir], {
      HOME: where.home,
      SEKHEMET_MODELS_DIR: "/srv/weights-7f3a",
    });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/\.claude\/notes\.json:1 .*an agent's scratch folder/);
    expect(r.out).toMatch(/scripts\/run\.mjs:1 .*the models folder \(SEKHEMET_MODELS_DIR\)/);
  });

  it("fails on a tracked .claude/launch.json even with no machine path in it", () => {
    const where = repo({ ".claude/launch.json": '{ "version": "0.0.1", "configurations": [] }\n' });
    const r = run(["--check", "--root", where.dir], { HOME: where.home });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/\.claude\/launch\.json is tracked/);
  });

  it("passes a placeholder path a test or a guide uses (/Users/someone, /Volumes/USB)", () => {
    const where = repo({
      "tests/a.spec.ts":
        'const p = "/Users/someone/models"; const q = "/Volumes/No Such Drive 9f3a/w";\n',
    });
    const r = run(["--check", "--root", where.dir], { HOME: where.home });
    expect(r.out).toMatch(/no machine path in 1 tracked files/);
    expect(r.status, r.out).toBe(0);
  });

  it("writes the report: a secret in an earlier commit is named by commit, path and rule, never shown, and history is not rewritten", () => {
    const where = repo({ "README.md": "# app\n" });
    const git = (...a: string[]) =>
      execFileSync("git", a, { cwd: where.dir, encoding: "utf8" }).trim();
    // An AWS access key id, assembled here so this file holds none.
    const key = ["AKIA", "QYLPMN5HHHFPZAM2"].join("");
    writeFileSync(join(where.dir, "config.js"), `export const awsKeyId = "${key}";\n`);
    git("add", "config.js");
    git("commit", "-q", "-m", "add config");
    const leaked = git("rev-parse", "HEAD");
    rmSync(join(where.dir, "config.js"));
    git("add", "-A");
    git("commit", "-q", "-m", "remove config");
    const before = git("rev-list", "--all");
    const out = join(where.dir, "..", "PREPUBLICATION.md");
    const r = run(["--root", where.dir, "--out", out, "--no-gitleaks"], { HOME: where.home });
    // Written, and exit 1: a finding nobody has read yet holds the release.
    expect(r.out).toMatch(/wrote .*PREPUBLICATION\.md/);
    expect(r.status, r.out).toBe(1);
    const report = readFileSync(out, "utf8");
    expect(report).toMatch(/Scanner: the bundled rules \(builtin\), 3 commits/);
    expect(report).toContain(
      `| \`${leaked.slice(0, 9)}\` | \`config.js\` | aws-access-token | not triaged`,
    );
    expect(report).not.toContain(key);
    expect(report).toMatch(/1 finding not triaged/);
    // Scanned with the bundled rules, not gitleaks: the item is partial, never "done" (C5 review).
    expect(report).toMatch(
      /\| The history scanned for secrets \| \*\*partial\*\*: the bundled rules only \(1 findings, 1 not triaged\); gitleaks was not used/,
    );
    // The author address is masked; the owner's acceptance is cited.
    expect(report).toContain("a…@example.org");
    expect(report).not.toContain("ada@example.org");
    expect(report).toMatch(/DEC-54/);
    // Nothing rewritten: the same commits, the same ids.
    expect(git("rev-list", "--all")).toBe(before);
    // The report holds no machine path of its own.
    expect(report).not.toContain(where.home);
    expect(report).not.toContain(where.dir);
  });

  it("ignores launch.json, the worktrees and CLAUDE.local.md, and CLAUDE.md imports the local file", () => {
    const ignored = (path: string) =>
      spawnSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: ROOT }).status === 0;
    expect(ignored(".claude/launch.json")).toBe(true);
    expect(ignored(".claude/worktrees/x/README.md")).toBe(true);
    expect(ignored("CLAUDE.local.md")).toBe(true);
    // Shared agent settings stay committable.
    expect(ignored(".claude/settings.json")).toBe(false);
    const tracked = execFileSync("git", ["ls-files", ".claude", "CLAUDE.local.md"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(tracked.split("\n").filter(Boolean)).not.toContain(".claude/launch.json");
    const claude = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
    expect(claude).toMatch(/^@CLAUDE\.local\.md$/m);
    expect(claude).toContain("docs/reference/DEVELOPING.md");
    expect(claude).not.toMatch(/My Passport|\/Volumes\/|24 GB host/);
    const developing = readFileSync(join(ROOT, "docs", "reference", "DEVELOPING.md"), "utf8");
    for (const v of ["$SEKHEMET_MODELS_DIR", "$LIMA_HOME", "memory_pressure", "ollama ps"])
      expect(developing).toContain(v);
  });

  it("injection_fixtures.mjs refuses to start without SEKHEMET_MODELS_DIR and says so", () => {
    const r = spawnSync(
      process.execPath,
      [join(ROOT, "scripts", "injection_fixtures.mjs"), "--worker", "cyber-tiel"],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: tmpdir() }, timeout: 60_000 },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/SEKHEMET_MODELS_DIR/);
    expect(r.stderr).toMatch(/DEVELOPING\.md/);
  });
});
