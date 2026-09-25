import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MergeConflictError, NodeGitSyncAdapter } from "../src/git_adapter.js";

/**
 * review-git S5 on real repositories (DEFINITION_OF_DONE §2A): Accept merges
 * with plumbing, never in the person's working copy; a conflict writes no
 * commit; a moved integration branch is never overwritten; a revert is a
 * commit of its own; the review diff never writes to the repository.
 */
let repo: string;
let adapter: NodeGitSyncAdapter;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const cp = (cardId: string, step: number) =>
  adapter.commitCheckpoint({
    cardId,
    step,
    gateStatus: "pass",
    agentModel: "nail",
    agentHarness: "sekhemet",
    agentRole: "implementer",
  });

/** Every byte of the person's checkout that Accept must not touch. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  out[".git/HEAD"] = readFileSync(join(repo, ".git", "HEAD"), "utf8");
  out[".git/index"] = readFileSync(join(repo, ".git", "index")).toString("base64");
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === ".sekhemet") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(repo, path)] = readFileSync(path).toString("base64");
    }
  };
  walk(repo);
  return out;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "sek-accept-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "T");
  git("config", "user.email", "t@x");
  write(repo, "src/a.ts", "export const a = 1;\n");
  write(repo, "src/shared.ts", "export const shared = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  adapter = new NodeGitSyncAdapter(repo, "proj");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

async function cardWith(cardId: string, files: Record<string, string>): Promise<string> {
  const wt = await adapter.createWorktree(cardId, "main", "Title");
  for (const [f, t] of Object.entries(files)) write(wt, f, t);
  await cp(cardId, 1);
  return wt;
}

describe("RG-S5-1/2: Accept never touches the person's checkout", () => {
  it("RG-S5-1: squashes onto main with HEAD, index and files byte-identical", async () => {
    await cardWith("c1", { "src/b.ts": "export const b = 2;\n" });
    const before = snapshot();
    const old = git("rev-parse", "main");
    const sha = await adapter.squashAndMerge("c1", "main", "feat(c1): Title", {}, "Title");
    expect(snapshot()).toEqual(before);
    expect(git("rev-parse", "main")).toBe(sha);
    expect(git("rev-parse", `${sha}^`)).toBe(old);
    expect(git("show", `${sha}:src/b.ts`)).toBe("export const b = 2;");
    expect(existsSync(join(repo, "src", "b.ts"))).toBe(false);
  });

  it("RG-S5-2: accepts while the checkout is dirty and on another branch, untouched", async () => {
    await cardWith("c2", { "src/b.ts": "export const b = 2;\n" });
    git("checkout", "-q", "-b", "mine");
    write(repo, "src/a.ts", "export const a = 99; // my unsaved work\n");
    write(repo, "scratch.txt", "notes\n");
    git("add", "scratch.txt");
    const before = snapshot();
    const sha = await adapter.squashAndMerge("c2", "main", "feat(c2): Title", {}, "Title");
    expect(snapshot()).toEqual(before);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("mine");
    expect(git("rev-parse", "main")).toBe(sha);
  });
});

describe("RG-S5-4: a conflicting squash writes nothing", () => {
  it("names the conflicting files, leaves main and the checkout as they were, no markers", async () => {
    await cardWith("c3", { "src/shared.ts": "export const shared = 2;\n" });
    write(repo, "src/shared.ts", "export const shared = 3;\n");
    git("commit", "-q", "-am", "main moved");
    const moved = git("rev-parse", "main");
    const before = snapshot();
    const err = await adapter
      .squashAndMerge("c3", "main", "feat(c3): Title", {}, "Title")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MergeConflictError);
    expect((err as MergeConflictError).files).toEqual(["src/shared.ts"]);
    expect(git("rev-parse", "main")).toBe(moved);
    expect(snapshot()).toEqual(before);
    expect(readFileSync(join(repo, "src", "shared.ts"), "utf8")).not.toContain("<<<<<<<");
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git("status", "--porcelain")).toBe("");
  });
});

describe("RG-S5-5: two accepts never lose an update", () => {
  it("refuses a squash whose integration branch moved after the preview (compare-and-set)", async () => {
    await cardWith("c4", { "src/b.ts": "export const b = 2;\n" });
    const preview = git("rev-parse", "main");
    write(repo, "src/other.ts", "x\n");
    git("add", "-A");
    git("commit", "-q", "-m", "another accept landed");
    const landed = git("rev-parse", "main");
    await expect(
      adapter.squashAndMerge("c4", "main", "feat(c4): Title", {}, "Title", {
        expectedOld: preview,
      }),
    ).rejects.toThrow(/moved/);
    expect(git("rev-parse", "main")).toBe(landed);
  });

  it("holds one accept lock per repository: a second accept is refused while the first runs", async () => {
    await cardWith("c5", { "src/b.ts": "export const b = 2;\n" });
    await cardWith("c6", { "src/c.ts": "export const c = 3;\n" });
    const order: string[] = [];
    await adapter.withAcceptLock(async () => {
      order.push("first");
      await expect(adapter.withAcceptLock(async () => order.push("second"))).rejects.toThrow(
        /another accept/i,
      );
      await adapter.squashAndMerge("c5", "main", "feat(c5): Title", {}, "Title");
    });
    // Released: the next accept proceeds, and main holds both changes.
    await adapter.withAcceptLock(() =>
      adapter.squashAndMerge("c6", "main", "feat(c6): Title", {}, "Title"),
    );
    expect(order).toEqual(["first"]);
    expect(git("show", "main:src/b.ts")).toBe("export const b = 2;");
    expect(git("show", "main:src/c.ts")).toBe("export const c = 3;");
  });

  it("takes over a lock left by a process that no longer exists", async () => {
    const lock = join(repo, ".git", "sekhemet-accept.lock");
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 7, at: new Date().toISOString() }));
    await expect(adapter.withAcceptLock(async () => "ran")).resolves.toBe("ran");
    expect(existsSync(lock)).toBe(false);
  });

  it("takes a stale lock over only under the takeover lock, so two takers cannot both remove it", async () => {
    const lock = join(repo, ".git", "sekhemet-accept.lock");
    const stale = JSON.stringify({ pid: 2 ** 22 + 7, at: new Date().toISOString() });
    writeFileSync(lock, stale);
    // Another process is taking the stale lock over right now.
    writeFileSync(`${lock}.takeover`, "");
    await expect(adapter.withAcceptLock(async () => "ran")).rejects.toThrow(/another accept/i);
    expect(readFileSync(lock, "utf8")).toBe(stale);
    // A takeover lock left by a process killed mid-takeover is itself stale after 10 s.
    const old = new Date(Date.now() - 20_000);
    utimesSync(`${lock}.takeover`, old, old);
    await expect(adapter.withAcceptLock(async () => "ran")).resolves.toBe("ran");
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.takeover`)).toBe(false);
  });
});

describe("RG-S5-3: a refused transition restores the integration branch", () => {
  it("moves the ref back only when it still holds the squash", async () => {
    await cardWith("c7", { "src/b.ts": "export const b = 2;\n" });
    const old = git("rev-parse", "main");
    const sha = await adapter.squashAndMerge("c7", "main", "feat(c7): Title", {}, "Title");
    await adapter.restoreRef("main", old, sha);
    expect(git("rev-parse", "main")).toBe(old);
    await expect(adapter.restoreRef("main", sha, "0".repeat(40))).rejects.toThrow();
    expect(git("rev-parse", "main")).toBe(old);
  });
});

describe("RG-S5-10: revert accept is a commit of its own", () => {
  it("adds a revert commit of the squash to main without touching the checkout", async () => {
    await cardWith("c8", { "src/b.ts": "export const b = 2;\n" });
    const sha = await adapter.squashAndMerge("c8", "main", "feat(c8): Title", {}, "Title");
    write(repo, "notes.txt", "local\n");
    const before = snapshot();
    const revert = await adapter.revertSquash("main", sha, {
      Card: "c8",
      "Agent-Harness": "sekhemet",
    });
    expect(snapshot()).toEqual(before);
    expect(git("rev-parse", "main")).toBe(revert);
    expect(git("rev-parse", `${revert}^`)).toBe(sha);
    expect(git("ls-tree", "--name-only", "-r", "main")).not.toContain("src/b.ts");
    const msg = git("log", "-1", "--format=%B", revert);
    expect(msg).toContain(`This reverts commit ${sha}.`);
    expect(msg).toContain("Card: c8");
  });
});

describe("RG-S5-14: the integration branch is configurable", () => {
  it("branches from and merges into develop", async () => {
    git("branch", "develop");
    git("checkout", "-q", "develop");
    write(repo, "src/dev.ts", "export const dev = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "develop only");
    git("checkout", "-q", "main");
    const wt = await adapter.createWorktree("c9", "develop", "Title");
    expect(existsSync(join(wt, "src", "dev.ts"))).toBe(true);
    write(wt, "src/b.ts", "export const b = 2;\n");
    await cp("c9", 1);
    const mainBefore = git("rev-parse", "main");
    const sha = await adapter.squashAndMerge("c9", "develop", "feat(c9): Title", {}, "Title");
    expect(git("rev-parse", "develop")).toBe(sha);
    expect(git("rev-parse", "main")).toBe(mainBefore);
  });
});

describe("RG-S5-19: the review diff of a card whose worktree is gone writes nothing", () => {
  it("reads both sides from refs, leaving the checkout byte-identical", async () => {
    await cardWith("d1", { "src/b.ts": "export const b = 2;\n" });
    await adapter.removeWorktree("d1");
    write(repo, "src/a.ts", "export const a = 7; // dirty\n");
    const before = snapshot();
    const d = await adapter.structuralDiff("d1", "main", { programs: {} });
    expect(snapshot()).toEqual(before);
    expect(d.groups.source).toEqual(["src/b.ts"]);
    expect(d.text).toContain("export const b = 2;");
    expect(d.text).not.toContain("a = 7");
  });
});

describe("NEW-review-git-2 prelude: restacking a child with no worktree never checks out in the person's copy", () => {
  it("rebases the child branch in a scratch checkout", async () => {
    const pw = await adapter.createWorktree("parent", "main", "Parent");
    write(pw, "src/p.ts", "export const p = 1;\n");
    await cp("parent", 1);
    await adapter.createWorktree("child", "main", "Child", "parent");
    const cw = join(repo, ".sekhemet", "worktrees", "child");
    write(cw, "src/c.ts", "export const c = 1;\n");
    await cp("child", 1);
    await adapter.removeWorktree("child");
    write(repo, "src/a.ts", "export const a = 8; // dirty\n");
    const before = snapshot();
    await adapter.squashAndMerge("parent", "main", "feat(parent): Parent", {}, "Parent");
    const res = await adapter.restackChildren("parent", "main");
    expect(res).toEqual([{ cardBranch: "sekhemet/proj/child-child", ok: true }]);
    expect(snapshot()).toEqual(before);
    expect(git("diff", "--name-only", "main...sekhemet/proj/child-child")).toBe("src/c.ts");
  });
});
