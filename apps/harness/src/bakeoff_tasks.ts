import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGatesConfig } from "@sekhemet/gates";
import { runConfined, runTrusted } from "@sekhemet/sandbox";

/**
 * The bake-off's tasks from the repository's own history (models rule 30,
 * MD-N4-7): closed issues with their fixing commits become fail-to-pass
 * tasks, kept only when reverting the fix makes its test fail; recent
 * ordinary commits become reconstruction tasks. Too few, and the bake-off
 * falls back to a fixture and says so.
 */

/** Below this many tasks the history is not a bake-off, and a fixture is used. */
export const MIN_HISTORY_TASKS = 5;
/** Commits read from the history, newest first. */
const HISTORY_DEPTH = 400;
/** Recent ordinary commits kept as reconstruction tasks. */
const RECONSTRUCTIONS = 10;

const FIX_REF = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#(\d+)/i;
const TEST_FILE =
  /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(py|go)$|^test_.*\.py$/;

export interface FixTask {
  commit: string;
  issue: string;
  subject: string;
  /** The fix's source files (what the candidate must change). */
  files: string[];
  /** The tests the fix added or changed (what must pass). */
  tests: string[];
}

export interface ReconstructionTask {
  commit: string;
  subject: string;
  files: string[];
}

export interface MinedTasks {
  fixes: FixTask[];
  reconstructions: ReconstructionTask[];
  /** Fixing commits not kept, and why. */
  dropped: { commit: string; issue: string; why: string }[];
}

/** Whether the given tests pass in a checkout; the product runs them confined. */
export type TestsPass = (dir: string, tests: string[]) => Promise<boolean>;

/**
 * The harness's own git on the project's history and a scratch worktree
 * (SEC-18: a trusted process through `runTrusted`, since this module also
 * runs worktree code confined); throws on a non-zero exit.
 */
async function git(repo: string, ...args: string[]): Promise<string> {
  const r = await runTrusted("git", args, { cwd: repo, maxBufferBytes: 64 * 1024 * 1024 });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${r.exitCode}: ${r.stderr.trim()}`);
  }
  return r.stdout;
}

/**
 * The project's test gate, confined to the checkout with no network (S3a):
 * the first gate on the `test` rung of `.sekhemet/gates.toml`, given the
 * test files. With no test gate nothing can be verified, so nothing passes.
 */
export const confinedTestsPass: TestsPass = async (dir, tests) => {
  const gate = loadGatesConfig(dir).gates.find((g) => g.rung === "test");
  if (!gate) return false;
  const r = await runConfined(gate.command, [...gate.args, ...tests], {
    root: dir,
    cwd: dir,
    timeoutMs: gate.timeoutMs,
  });
  return r.exitCode === 0 && !r.timedOut;
};

/** Run `check` in a detached worktree of `repo` at `commit`, then remove it. */
async function atCommit<T>(
  repo: string,
  commit: string,
  check: (dir: string) => Promise<T>,
): Promise<T> {
  const scratch = mkdtempSync(join(tmpdir(), "sekhemet-history-"));
  const dir = join(scratch, "wt");
  await git(repo, "worktree", "add", "--detach", "-q", dir, commit);
  try {
    return await check(dir);
  } finally {
    try {
      await git(repo, "worktree", "remove", "--force", dir);
    } catch {
      // Removed below with the scratch directory.
    }
    rmSync(scratch, { recursive: true, force: true });
    try {
      await git(repo, "worktree", "prune");
    } catch {
      // Nothing to prune.
    }
  }
}

export async function mineHistoryTasks(
  repo: string,
  options: { testsPass?: TestsPass; depth?: number } = {},
): Promise<MinedTasks> {
  const testsPass = options.testsPass ?? confinedTestsPass;
  const log = (
    await git(
      repo,
      "log",
      "--no-merges",
      `-n${options.depth ?? HISTORY_DEPTH}`,
      "--format=%H%x09%P%x09%s",
    )
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [commit = "", parents = "", subject = ""] = line.split("\t");
      return { commit, parent: parents.split(" ")[0] ?? "", subject };
    });
  const out: MinedTasks = { fixes: [], reconstructions: [], dropped: [] };
  for (const c of log) {
    if (!c.parent) continue;
    const changed = (await git(repo, "diff", "--name-only", c.parent, c.commit))
      .split("\n")
      .filter(Boolean);
    const tests = changed.filter((f) => TEST_FILE.test(f));
    const files = changed.filter((f) => !TEST_FILE.test(f) && !/\.(md|txt)$/i.test(f));
    const issue = FIX_REF.exec(c.subject)?.[1];
    if (issue) {
      if (tests.length === 0 || files.length === 0) {
        out.dropped.push({ commit: c.commit, issue, why: "no test and source change to replay" });
        continue;
      }
      // Fail-to-pass: the tests pass at the fix, and fail with the fix reverted.
      const kept = await atCommit(repo, c.commit, async (dir) => {
        if (!(await testsPass(dir, tests))) return "its tests fail at the fix itself";
        for (const f of files) {
          try {
            await git(dir, "checkout", c.parent, "--", f);
          } catch {
            await git(dir, "rm", "-q", "--", f);
          }
        }
        return (await testsPass(dir, tests)) ? "its test passes with the fix reverted" : undefined;
      });
      if (kept) out.dropped.push({ commit: c.commit, issue, why: kept });
      else out.fixes.push({ commit: c.commit, issue, subject: c.subject, files, tests });
      continue;
    }
    if (out.reconstructions.length < RECONSTRUCTIONS && files.length > 0 && files.length <= 3) {
      out.reconstructions.push({ commit: c.commit, subject: c.subject, files });
    }
  }
  return out;
}

export interface BakeOffTaskPlan {
  source: "history" | "fixture";
  fixture?: string;
  tasks?: MinedTasks;
  message: string;
}

/**
 * What a bake-off in this repository runs (MD-N4-7): its history when at
 * least `MIN_HISTORY_TASKS` tasks were mined, else the fixture, saying why.
 */
export async function bakeOffTaskPlan(
  repo: string,
  fixture: string,
  options: { testsPass?: TestsPass } = {},
): Promise<BakeOffTaskPlan> {
  let tasks: MinedTasks;
  try {
    tasks = await mineHistoryTasks(repo, options);
  } catch (err) {
    return {
      source: "fixture",
      fixture,
      message: `No history to mine (${err instanceof Error ? err.message : String(err)}); falling back to the ${fixture} fixture.`,
    };
  }
  const n = tasks.fixes.length + tasks.reconstructions.length;
  if (n < MIN_HISTORY_TASKS) {
    return {
      source: "fixture",
      fixture,
      tasks,
      message: `This repository's history gave only ${tasks.fixes.length} fix task${tasks.fixes.length === 1 ? "" : "s"} and ${tasks.reconstructions.length} reconstruction task${tasks.reconstructions.length === 1 ? "" : "s"} (${tasks.dropped.length} fixing commit(s) dropped), fewer than ${MIN_HISTORY_TASKS}; falling back to the ${fixture} fixture.`,
    };
  }
  return {
    source: "history",
    tasks,
    message: `${tasks.fixes.length} fix task(s) (each fails with its fix reverted) and ${tasks.reconstructions.length} reconstruction task(s) from this repository's history.`,
  };
}
