import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIN_HISTORY_TASKS, bakeOffTaskPlan, mineHistoryTasks } from "../src/bakeoff_tasks.js";

// MD-N4-7: the bake-off's tasks come from the repository's own history: a
// fixing commit is kept only if reverting its fix makes its test fail.
// A real git repository; the tests are plain node scripts.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function repoWithHistory(): string {
  const repo = mkdtempSync(join(tmpdir(), "sek-history-"));
  dirs.push(repo);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  const write = (rel: string, text: string) => {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), text);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jane Doe");
  git("config", "user.email", "jane@example.com");
  write("src/sum.mjs", "export const sum = (a, b) => a - b;\n");
  write("src/max.mjs", "export const max = (a, b) => (a > b ? a : b);\n");
  write("README.md", "hello\n");
  git("add", "-A");
  git("commit", "-q", "-m", "start");
  // A real fix with its test: reverting the fix makes the test fail -> kept.
  write("src/sum.mjs", "export const sum = (a, b) => a + b;\n");
  write(
    "tests/sum.test.mjs",
    'import { sum } from "../src/sum.mjs";\nif (sum(1, 2) !== 3) process.exit(1);\n',
  );
  git("add", "-A");
  git("commit", "-q", "-m", "fix: sum adds (fixes #12)");
  // A fix with no test: not a task.
  write("README.md", "hello world\n");
  git("add", "-A");
  git("commit", "-q", "-m", "fix typo (fixes #13)");
  // A fix whose test passes with the fix reverted: its test proves nothing -> dropped.
  write("src/max.mjs", "export const max = (a, b) => Math.max(a, b);\n");
  write(
    "tests/max.test.mjs",
    'import { max } from "../src/max.mjs";\nif (max(1, 2) !== 2) process.exit(1);\n',
  );
  git("add", "-A");
  git("commit", "-q", "-m", "fix: max uses Math.max (closes #14)");
  // A recent ordinary commit: a reconstruction task.
  write("src/min.mjs", "export const min = (a, b) => (a < b ? a : b);\n");
  git("add", "-A");
  git("commit", "-q", "-m", "feat: min");
  return repo;
}

const nodeTests = async (dir: string, tests: string[]): Promise<boolean> =>
  tests.every((t) => spawnSync(process.execPath, [t], { cwd: dir }).status === 0);

describe("MD-N4-7: bake-off tasks from the repository's history", () => {
  it("keeps a fix only when reverting it fails its test, and turns recent commits into reconstruction tasks", async () => {
    const repo = repoWithHistory();
    const mined = await mineHistoryTasks(repo, { testsPass: nodeTests });
    expect(mined.fixes.map((t) => t.issue)).toEqual(["12"]);
    expect(mined.fixes[0]).toMatchObject({ tests: ["tests/sum.test.mjs"], files: ["src/sum.mjs"] });
    expect(mined.dropped.map((d) => d.issue).sort()).toEqual(["13", "14"]);
    expect(mined.dropped.find((d) => d.issue === "14")?.why).toMatch(
      /passes with the fix reverted/,
    );
    expect(mined.reconstructions.map((t) => t.subject)).toContain("feat: min");
  });

  it("says when too few exist and falls back to the fixture", async () => {
    const repo = repoWithHistory();
    const plan = await bakeOffTaskPlan(repo, "chronicle", { testsPass: nodeTests });
    expect(MIN_HISTORY_TASKS).toBeGreaterThan(2);
    expect(plan.source).toBe("fixture");
    expect(plan.fixture).toBe("chronicle");
    expect(plan.message).toMatch(
      /only 1 fix task and 1 reconstruction task .* fewer than 5; falling back to the chronicle fixture/,
    );
  });
});
