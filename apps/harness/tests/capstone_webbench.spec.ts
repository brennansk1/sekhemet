import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error: a plain ESM script, run by hand and by the capstone runner, checked here.
import * as webbench from "../../../scripts/capstone/webbench.mjs";

/**
 * The capstone's second run (W2 G4, CAPSTONE_SELECTION "The second run"): one
 * Web-Bench project, reused unchanged. Its checkout lives outside this
 * repository, pinned at one commit; `scripts/capstone/webbench.mjs` refuses a
 * checkout at any other commit or with any file changed, added or removed, and
 * hands every arm task n's text byte for byte, hash-checked against the
 * frozen `fixtures/capstone/webbench/manifest.json`.
 */

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const SCRIPT = join(ROOT, "scripts", "capstone", "webbench.mjs");
const MANIFEST = join(ROOT, "fixtures", "capstone", "webbench", "manifest.json");
const REAL_SRC = process.env.SEKHEMET_WEBBENCH_SRC ?? join(homedir(), ".sekhemet", "webbench-src");

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function temp(prefix = "capstone-webbench-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
function run(args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function put(root: string, rel: string, text: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const TASKS_YML = [
  "- id: task-1",
  "  date: 2025-05-12",
  "  level: easy",
  "  description: |",
  "    1) Create home page with route '/'",
  "    2) Use ejs",
  "",
  "- id: task-2",
  "  date: 2025-05-12",
  "  level: challenging",
  "  description: |",
  "    1) First line",
  "",
  "    2) After a blank line: {'a': 1}",
  "    ",
].join("\n");

/** A small checkout shaped like Web-Bench's, committed with real git. */
function fakeCheckout(): { src: string; manifest: string } {
  const src = join(temp(), "webbench-src");
  put(src, "LICENSE.md", "  Apache License\n  Version 2.0, January 2004\n");
  put(src, "projects/fastify/tasks.yml", TASKS_YML);
  put(src, "projects/fastify/package.json", '{"name":"@web-bench/fastify"}\n');
  put(src, "projects/fastify/playwright.config.js", "module.exports = {}\n");
  put(src, "projects/fastify/src-init/index.ts", "console.log(1)\n");
  put(src, "projects/fastify/test/task-1.spec.js", "// one\n");
  put(src, "projects/fastify/test/task-2.spec.js", "// two\n");
  put(src, "libraries/test-util/test.sh", "npx playwright test $tasks\n");
  put(src, "libraries/shop-test-util/src/index.js", "module.exports = {}\n");
  put(src, "common/config/rush/pnpm-lock.yaml", "lockfileVersion: '6.0'\n");
  put(src, "projects/react/tasks.yml", "- id: task-1\n");
  git(src, "init", "-q", "-b", "main");
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "fixture");
  const manifest = join(temp(), "manifest.json");
  return { src, manifest };
}

describe("reading tasks.yml as Web-Bench's evaluator does", () => {
  it("gives each description as a YAML literal block: indentation removed, blank lines kept, one final newline", () => {
    const tasks = webbench.parseTasks(TASKS_YML);
    expect(tasks.map((t: { id: string }) => t.id)).toEqual(["task-1", "task-2"]);
    expect(tasks[0]).toEqual({
      id: "task-1",
      date: "2025-05-12",
      level: "easy",
      description: "1) Create home page with route '/'\n2) Use ejs\n",
    });
    expect(tasks[1].description).toBe("1) First line\n\n2) After a blank line: {'a': 1}\n");
  });

  it("refuses a file it cannot read exactly, rather than guessing", () => {
    expect(() => webbench.parseTasks("- id: task-1\n  description: >\n    folded\n")).toThrow();
    expect(() => webbench.parseTasks("- id: task-1\n  level: easy\n")).toThrow();
    expect(() => webbench.parseTasks("- id: task-2\n  description: |\n    x\n")).toThrow(/task-1/);
  });
});

describe("freezing and checking a checkout", () => {
  it("records the commit, the licence, every task's hash and every tracked file, and passes its own check", () => {
    const { src, manifest } = fakeCheckout();
    const w = run(["--write", "--src", src, "--manifest", manifest]);
    expect(w.status, w.stderr).toBe(0);
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    expect(m.commit).toBe(git(src, "rev-parse", "HEAD"));
    expect(m.project).toBe("projects/fastify");
    expect(m.tasks.map((t: { id: string }) => t.id)).toEqual(["task-1", "task-2"]);
    expect(m.tasks[1].level).toBe("challenging");
    expect(m.tests.count).toBe(2);
    expect(Object.keys(m.files)).toContain("projects/fastify/test/task-1.spec.js");
    expect(Object.keys(m.files)).toContain("LICENSE.md");
    expect(Object.keys(m.files)).toContain("common/config/rush/pnpm-lock.yaml");
    expect(Object.keys(m.files)).not.toContain("projects/react/tasks.yml");
    const c = run(["--check", "--src", src, "--manifest", manifest]);
    expect(c.status, c.stderr).toBe(0);
  });

  it("refuses a changed test, an added test, a removed file and another commit, naming each", () => {
    const { src, manifest } = fakeCheckout();
    expect(run(["--write", "--src", src, "--manifest", manifest]).status).toBe(0);

    put(src, "projects/fastify/test/task-2.spec.js", "// weakened\n");
    let c = run(["--check", "--src", src, "--manifest", manifest]);
    expect(c.status).toBe(1);
    expect(c.stderr).toContain("projects/fastify/test/task-2.spec.js");
    git(src, "checkout", "--", ".");

    put(src, "projects/fastify/test/task-3.spec.js", "// extra\n");
    c = run(["--check", "--src", src, "--manifest", manifest]);
    expect(c.status).toBe(1);
    expect(c.stderr).toContain("projects/fastify/test/task-3.spec.js");
    rmSync(join(src, "projects/fastify/test/task-3.spec.js"));

    rmSync(join(src, "libraries/test-util/test.sh"));
    c = run(["--check", "--src", src, "--manifest", manifest]);
    expect(c.status).toBe(1);
    expect(c.stderr).toContain("libraries/test-util/test.sh");
    git(src, "checkout", "--", ".");

    expect(run(["--check", "--src", src, "--manifest", manifest]).status).toBe(0);
    git(src, "commit", "-q", "--allow-empty", "-m", "moved");
    c = run(["--check", "--src", src, "--manifest", manifest]);
    expect(c.status).toBe(1);
    expect(c.stderr).toMatch(/commit/);
  });

  it("ignores installed packages and nothing else: a test run's leftovers are drift", () => {
    const { src, manifest } = fakeCheckout();
    expect(run(["--write", "--src", src, "--manifest", manifest]).status).toBe(0);
    put(src, "projects/fastify/node_modules/fastify/index.js", "x\n");
    put(src, "libraries/test-util/node_modules/x/index.js", "x\n");
    expect(run(["--check", "--src", src, "--manifest", manifest]).status).toBe(0);
    put(src, "projects/fastify/test-results/.last-run.json", "{}\n");
    expect(run(["--check", "--src", src, "--manifest", manifest]).status).toBe(1);
  });

  it("refuses a checkout inside this repository, where a contestant's harness could read it", () => {
    const r = run(["--check", "--src", join(ROOT, "fixtures"), "--manifest", MANIFEST]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/inside this repository/);
  });
});

describe("handing out a task", () => {
  it("prints task n's description byte for byte, and only after the checkout passes its check", () => {
    const { src, manifest } = fakeCheckout();
    expect(run(["--write", "--src", src, "--manifest", manifest]).status).toBe(0);
    const t = run(["--task", "2", "--src", src, "--manifest", manifest]);
    expect(t.status, t.stderr).toBe(0);
    expect(t.stdout).toBe("1) First line\n\n2) After a blank line: {'a': 1}\n");
    expect(run(["--task", "3", "--src", src, "--manifest", manifest]).status).toBe(2);
    expect(run(["--task", "0", "--src", src, "--manifest", manifest]).status).toBe(2);
    put(src, "projects/fastify/test/task-1.spec.js", "// changed\n");
    const refused = run(["--task", "1", "--src", src, "--manifest", manifest]);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
  });
});

describe("the frozen choice", () => {
  const m = () => JSON.parse(readFileSync(MANIFEST, "utf8"));

  it("pins one TypeScript project of 20 tasks, each with its own hidden Playwright test file", () => {
    const f = m();
    expect(f.repository).toBe("https://github.com/bytedance/web-bench");
    expect(f.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(f.project).toBe("projects/fastify");
    expect(f.licence.spdx).toBe("Apache-2.0");
    expect(f.files[f.licence.file]).toBe(f.licence.sha256);
    expect(f.tasks).toHaveLength(20);
    expect(f.tasks.map((t: { id: string }) => t.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `task-${i + 1}`),
    );
    expect(f.tests.count).toBe(20);
    for (let i = 1; i <= 20; i++) {
      expect(f.files[`projects/fastify/test/task-${i}.spec.js`], `task-${i}`).toMatch(
        /^[0-9a-f]{64}$/,
      );
    }
  });

  it("records only hashes: no test text and no reference solution enter this repository", () => {
    const raw = readFileSync(MANIFEST, "utf8");
    expect(raw).not.toMatch(/require\(|expect\(|page\.goto/);
    for (const v of Object.values(m().files)) expect(v).toMatch(/^[0-9a-f]{64}$/);
  });

  it.skipIf(!existsSync(join(REAL_SRC, ".git")))(
    "matches the pinned checkout on this machine",
    () => {
      const c = run(["--check", "--src", REAL_SRC]);
      expect(c.status, c.stderr).toBe(0);
    },
  );
});
