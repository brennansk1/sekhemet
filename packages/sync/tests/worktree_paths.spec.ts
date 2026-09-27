import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeGitSyncAdapter } from "../src/git_adapter.js";
import { preflightWorktree } from "../src/git_preflight.js";

/**
 * Live-test F18: `run_suite.mjs --work ../relative/path` stopped the first
 * card with "no recorded gitdir for this worktree" (git_metadata_tampered):
 * the worktree path was relative to the process, git resolved it against the
 * repository, and the record and the check compared different spellings.
 * Paths are resolved (realpath) before they are recorded and compared.
 */
let base: string;
let repo: string;
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "sek-wtpath-"));
  repo = join(base, "work", "chronicle");
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(base, "cwd"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "T");
  git(repo, "config", "user.email", "t@x");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

async function runCard(adapter: NodeGitSyncAdapter): Promise<string> {
  const wt = await adapter.createWorktree("c1");
  writeFileSync(join(wt, "b.txt"), "two\n");
  return adapter.commitCheckpoint({
    cardId: "c1",
    step: 1,
    gateStatus: "pass",
    agentModel: "m",
    agentHarness: "sekhemet",
    agentRole: "implementer",
  });
}

describe("worktree paths are resolved before they are recorded and compared (F18)", () => {
  it("runs a card in a repository named by a relative path", async () => {
    const was = process.cwd();
    process.chdir(join(base, "cwd"));
    try {
      const adapter = new NodeGitSyncAdapter("../work/chronicle", "proj");
      const sha = await runCard(adapter);
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      process.chdir(was);
    }
    // The worktree is where the repository's own record says, not nested inside it.
    expect(git(repo, "worktree", "list", "--porcelain")).toContain(
      realpathSync(join(repo, ".sekhemet", "worktrees", "c1")),
    );
  });

  it("runs a card in a repository named through a symlinked directory (/tmp on macOS)", async () => {
    const link = join(tmpdir(), `sek-wtlink-${basename(base)}`);
    symlinkSync(join(base, "work"), link);
    try {
      const sha = await runCard(new NodeGitSyncAdapter(join(link, "chronicle"), "proj"));
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(
        preflightWorktree(join(link, "chronicle"), join(repo, ".sekhemet", "worktrees", "c1")),
      ).toEqual([]);
    } finally {
      rmSync(link, { force: true });
    }
  });

  it("reads a relative gitdir record (worktree.useRelativePaths) against its own directory", async () => {
    git(repo, "config", "worktree.useRelativePaths", "true");
    const sha = await runCard(new NodeGitSyncAdapter(repo, "proj"));
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("a symlinked --repo keeps its branch names (F18 review, minor 2)", () => {
  it("names the project by the name the person gave, not the real directory's", async () => {
    const { mkdtempSync, mkdirSync, symlinkSync, realpathSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const { NodeGitSyncAdapter, rememberRepoAsGiven } = await import("../src/index.js");
    const base = realpathSync(mkdtempSync(join(tmpdir(), "sek-given-")));
    const actual = join(base, "actual");
    mkdirSync(actual);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: actual });
    const link = join(base, "proj-link");
    symlinkSync(actual, link);
    rememberRepoAsGiven(link);
    const adapter = new NodeGitSyncAdapter(realpathSync(link));
    expect((adapter as unknown as { projectName: string }).projectName).toBe("proj-link");
  });
});
