import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeGitSyncAdapter } from "../src/git_adapter.js";
import {
  HARDENED_GIT_CONFIG,
  HARDENED_GIT_PINS,
  WORKTREE_GIT_CONFIG,
  hardenedGitEnv,
  isHardened,
} from "../src/git_hardening.js";
import { GitMetadataError, preflightWorktree, stagedGitlinks } from "../src/git_preflight.js";

/** S1: git run by the harness (security items 18–22; SEC-2 to SEC-6a). */
let repo: string;
let adapter: NodeGitSyncAdapter;
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const checkpoint = (cardId: string) =>
  adapter.commitCheckpoint({
    cardId,
    step: 1,
    gateStatus: "pass",
    agentModel: "m",
    agentHarness: "sekhemet",
    agentRole: "implementer",
  });

function markerScript(name: string): { script: string; marker: string } {
  const marker = join(repo, `${name}-ran`);
  const script = join(repo, `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\ncat\n`);
  chmodSync(script, 0o755);
  return { script, marker };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "sek-preflight-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "T");
  git(repo, "config", "user.email", "t@x");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  adapter = new NodeGitSyncAdapter(repo, "proj");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("the pinned git environment (items 19, 22)", () => {
  it("pins every key item 19 lists", () => {
    const keys = new Map(HARDENED_GIT_CONFIG.map(([k, v]) => [k, v]));
    for (const [k, v] of [
      ["core.fsmonitor", "false"],
      ["core.hooksPath", "/dev/null"],
      ["core.untrackedCache", "false"],
      ["core.sshCommand", "false"],
      ["credential.helper", ""],
      ["gpg.program", "false"],
      ["commit.gpgSign", "false"],
      ["log.showSignature", "false"],
      ["submodule.recurse", "false"],
      ["diff.ignoreSubmodules", "all"],
      ["safe.bareRepository", "explicit"],
    ] as const)
      expect(keys.get(k)).toBe(v);
    for (const v of [
      "GIT_CONFIG_NOSYSTEM",
      "GIT_TERMINAL_PROMPT",
      "GIT_NO_REPLACE_OBJECTS",
      "GIT_OPTIONAL_LOCKS",
      "GIT_EDITOR",
      "GIT_SEQUENCE_EDITOR",
      "GIT_PAGER",
      "GIT_ASKPASS",
      "SSH_ASKPASS",
    ])
      expect(Object.keys(HARDENED_GIT_PINS)).toContain(v);
    const env = hardenedGitEnv({});
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBeDefined();
    // Worktree-only pins never reach the user's own checkout (B1 review).
    const keys2 = Object.entries(env)
      .filter(([k]) => k.startsWith("GIT_CONFIG_KEY_"))
      .map(([, v]) => v);
    expect(keys2).not.toContain("core.symlinks");
    expect(keys2).not.toContain("protocol.file.allow");
    expect(WORKTREE_GIT_CONFIG.map(([k]) => k)).toEqual(["core.symlinks", "protocol.file.allow"]);
  });

  it("still prints a patch under the hardened environment (B1 review)", () => {
    writeFileSync(join(repo, "a.txt"), "two\n");
    const out = execFileSync("git", ["diff"], {
      cwd: repo,
      env: hardenedGitEnv(process.env),
      encoding: "utf8",
    });
    expect(out).toContain("+two");
  });

  it("keeps the user's name and email but no program-running global config", () => {
    const home = mkdtempSync(join(tmpdir(), "sek-home-"));
    const global = join(home, ".gitconfig");
    writeFileSync(
      global,
      "[user]\n\tname = Real Person\n\temail = real@example.com\n[core]\n\tpager = touch /tmp/never\n",
    );
    const env = hardenedGitEnv({ GIT_CONFIG_GLOBAL: global }, { identityDir: home });
    const file = env.GIT_CONFIG_GLOBAL as string;
    expect(file).not.toBe(global);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("Real Person");
    expect(text).toContain("real@example.com");
    expect(text).not.toContain("pager");
    rmSync(home, { recursive: true, force: true });
  });

  it("re-applies the keys when the flag is set but they are missing (SEC-5)", () => {
    expect(isHardened({ SEKHEMET_GIT_HARDENED: "1" })).toBe(false);
    expect(isHardened(hardenedGitEnv({}))).toBe(true);
  });
});

describe("the worktree preflight (item 21)", () => {
  it("refuses git in a worktree whose .git pointer names another gitdir (SEC-2)", async () => {
    const wt = await adapter.createWorktree("c1", "main", "Pointer");
    const other = mkdtempSync(join(tmpdir(), "sek-evil-git-"));
    git(other, "init", "-q");
    writeFileSync(join(wt, ".git"), `gitdir: ${join(other, ".git")}\n`);
    writeFileSync(join(wt, "a.txt"), "two\n");
    await expect(checkpoint("c1")).rejects.toThrow(GitMetadataError);
    await expect(checkpoint("c1")).rejects.toMatchObject({ reason: "git_metadata_tampered" });
    rmSync(other, { recursive: true, force: true });
  });

  it("refuses git when the repository config sets a program-running key, and names it (SEC-3)", async () => {
    const wt = await adapter.createWorktree("c2", "main", "Config");
    const { script, marker } = markerScript("filter");
    git(repo, "config", "filter.evil.clean", script);
    writeFileSync(join(wt, "a.txt"), "two\n");
    await expect(checkpoint("c2")).rejects.toThrow(/filter\.evil\.clean/);
    expect(existsSync(marker)).toBe(false);
  });

  it("never runs a clean filter or diff driver that .gitattributes selects (SEC-4)", () => {
    // A driver defined in the user's global config (as git-lfs is) and
    // selected by a .gitattributes the Worker wrote.
    const { script, marker } = markerScript("driver");
    const home = mkdtempSync(join(tmpdir(), "sek-home-"));
    const global = join(home, ".gitconfig");
    writeFileSync(
      global,
      `[filter "evil"]\n\tclean = ${script}\n\tsmudge = ${script}\n[diff "evil"]\n\tcommand = ${script}\n\ttextconv = ${script}\n`,
    );
    writeFileSync(join(repo, ".gitattributes"), "* filter=evil diff=evil\n");
    writeFileSync(join(repo, "a.txt"), "two\n");
    const env = hardenedGitEnv(
      { ...process.env, GIT_CONFIG_GLOBAL: global },
      { identityDir: home },
    );
    const run = (...a: string[]) =>
      execFileSync("git", a, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    run("status", "--porcelain");
    run("add", "-A");
    run("diff", "--staged", "--no-ext-diff", "--no-textconv");
    run("commit", "-q", "--no-verify", "-m", "x");
    expect(existsSync(marker)).toBe(false);
    // Control: without hardening, the same attributes run the driver.
    execFileSync("git", ["status", "--porcelain"], {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: global },
      stdio: "ignore",
    });
    writeFileSync(join(repo, "a.txt"), "three\n");
    execFileSync("git", ["add", "-A"], {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: global },
      stdio: "ignore",
    });
    expect(existsSync(marker)).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  it("fails the card when the staged diff adds a gitlink (SEC-6)", async () => {
    const wt = await adapter.createWorktree("c4", "main", "Gitlink");
    const head = git(repo, "rev-parse", "HEAD").trim();
    git(wt, "update-index", "--add", "--cacheinfo", `160000,${head},vendored`);
    const found = stagedGitlinks((args) => git(wt, ...args));
    expect(found.map((p) => p.detail)).toEqual(["the staged diff adds a gitlink at vendored"]);
    // Staged through a nested repository, the scan refuses it before git adds it.
    mkdirSync(join(wt, "nested"));
    git(join(wt, "nested"), "init", "-q");
    await expect(checkpoint("c4")).rejects.toThrow(/nested\/\.git/);
  });

  it("refuses an embedded bare repository, naming its path (SEC-6a)", async () => {
    const wt = await adapter.createWorktree("c5", "main", "Bare");
    mkdirSync(join(wt, "sub", "evil", "objects"), { recursive: true });
    writeFileSync(join(wt, "sub", "evil", "HEAD"), "ref: refs/heads/main\n");
    const problems = preflightWorktree(repo, wt);
    expect(problems.map((p) => p.detail).join("\n")).toMatch(/sub\/evil/);
    await expect(checkpoint("c5")).rejects.toThrow(/sub\/evil/);
  });

  it("refuses a .gitmodules with a carriage return (SEC-6a, CVE-2025-48384)", async () => {
    const wt = await adapter.createWorktree("c6", "main", "Modules");
    writeFileSync(join(wt, ".gitmodules"), '[submodule "x"]\r\n\tpath = x\r\n');
    await expect(checkpoint("c6")).rejects.toThrow(/\.gitmodules/);
  });

  it("refuses a .git file or symlink below the worktree root", async () => {
    const wt = await adapter.createWorktree("c7", "main", "Nested");
    mkdirSync(join(wt, "pkg"));
    writeFileSync(join(wt, "pkg", ".git"), "gitdir: /tmp/elsewhere\n");
    await expect(checkpoint("c7")).rejects.toThrow(/pkg\/\.git/);
  });

  it("refuses diff.external in the repository config", async () => {
    const wt = await adapter.createWorktree("c9", "main", "External");
    git(repo, "config", "diff.external", "/bin/true");
    writeFileSync(join(wt, "a.txt"), "two\n");
    await expect(checkpoint("c9")).rejects.toThrow(/diff\.external/);
  });

  it("accepts the repository's own Husky or LFS keys, refuses one added during the card (Q5)", async () => {
    git(repo, "config", "core.hooksPath", ".husky");
    git(repo, "config", "filter.lfs.clean", "git-lfs clean -- %f");
    const wt = await adapter.createWorktree("c10", "main", "Husky");
    writeFileSync(join(wt, "a.txt"), "two\n");
    await expect(checkpoint("c10")).resolves.toMatch(/^[0-9a-f]{40}$/);
    git(repo, "config", "core.hooksPath", "/tmp/evil-hooks");
    writeFileSync(join(wt, "a.txt"), "three\n");
    await expect(checkpoint("c10")).rejects.toThrow(/core\.hookspath/i);
  });

  it("refuses the per-turn fingerprint in a tampered worktree", async () => {
    const wt = await adapter.createWorktree("c11", "main", "Fingerprint");
    const other = mkdtempSync(join(tmpdir(), "sek-evil-git-"));
    git(other, "init", "-q");
    writeFileSync(join(wt, ".git"), `gitdir: ${join(other, ".git")}\n`);
    await expect(adapter.getRepoStateHash("c11")).rejects.toThrow(GitMetadataError);
    rmSync(other, { recursive: true, force: true });
  });

  it("scans a node_modules the Worker creates below the root", async () => {
    const wt = await adapter.createWorktree("c12", "main", "Hidden");
    mkdirSync(join(wt, "src", "node_modules", "x"), { recursive: true });
    writeFileSync(join(wt, "src", "node_modules", "x", ".git"), "gitdir: /tmp/elsewhere\n");
    expect(
      preflightWorktree(repo, wt)
        .map((p) => p.detail)
        .join(),
    ).toMatch(/src\/node_modules\/x\/\.git/);
  });

  it("passes a clean worktree", async () => {
    const wt = await adapter.createWorktree("c8", "main", "Clean");
    writeFileSync(join(wt, "a.txt"), "two\n");
    expect(preflightWorktree(repo, wt)).toEqual([]);
    await expect(checkpoint("c8")).resolves.toMatch(/^[0-9a-f]{40}$/);
  });
});
