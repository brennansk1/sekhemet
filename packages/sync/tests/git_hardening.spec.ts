import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hardenedGitEnv } from "../src/git_hardening.js";

/**
 * Defence in depth for Phase A security finding S1: the harness runs git
 * outside the sandbox in worktrees the Worker has written to. Repository
 * configuration that runs a program — core.fsmonitor, hooks — must not be
 * honoured by the harness's own git calls, whatever the config says.
 */
describe("the harness's git calls ignore config that runs programs", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const repoWithMonitor = (): { repo: string; marker: string } => {
    const repo = mkdtempSync(join(tmpdir(), "git-harden-"));
    dirs.push(repo);
    const marker = join(repo, "monitor-ran");
    const script = join(repo, "monitor.sh");
    writeFileSync(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    chmodSync(script, 0o755);
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "core.fsmonitor", script);
    return { repo, marker };
  };

  it("does not run core.fsmonitor from repository config", () => {
    const { repo, marker } = repoWithMonitor();
    execFileSync("git", ["status", "--porcelain"], {
      cwd: repo,
      stdio: "ignore",
      env: hardenedGitEnv(),
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("control: without hardening, the same config would run", () => {
    // Proves the test above is not vacuous on this git.
    const { repo, marker } = repoWithMonitor();
    execFileSync("git", ["status", "--porcelain"], { cwd: repo, stdio: "ignore" });
    expect(existsSync(marker)).toBe(true);
  });

  it("does not enter a bare repository nested in the worktree", () => {
    // The nested-bare-repository route (Copilot CLI, CVE-2026-45033): git
    // run inside it would read config the worktree's author wrote.
    const outer = mkdtempSync(join(tmpdir(), "git-bare-"));
    dirs.push(outer);
    execFileSync("git", ["init", "-q", "--bare", join(outer, "nested")], { stdio: "ignore" });
    const inBare = () =>
      execFileSync("git", ["rev-parse", "--git-dir"], {
        cwd: join(outer, "nested"),
        stdio: ["ignore", "pipe", "pipe"],
        env: hardenedGitEnv(),
      });
    expect(inBare).toThrow();
  });

  it("disables hooks and keeps variables the caller already set", () => {
    const env = hardenedGitEnv({
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "T",
    });
    const keys = Object.entries(env)
      .filter(([k]) => k.startsWith("GIT_CONFIG_KEY_"))
      .map(([, v]) => v);
    expect(keys).toEqual(
      expect.arrayContaining([
        "user.name",
        "core.fsmonitor",
        "core.hooksPath",
        "safe.bareRepository",
        "log.showSignature",
      ]),
    );
    expect(env.GIT_CONFIG_COUNT).toBe(String(keys.length));
  });
});

/**
 * W1 finding: the identity directory was built straight from
 * SEKHEMET_CONFIG_DIR, so a user directory inside a repository — refused
 * everywhere else because it holds tokens and trust records — was written to,
 * and a relative one named a different directory from each working directory.
 * The one resolver (sekhemetConfigDir) decides it here too.
 */
describe("the identity directory comes from the one user-directory resolver", () => {
  const saved = process.env.SEKHEMET_CONFIG_DIR;
  const dirs: string[] = [];
  afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
    else process.env.SEKHEMET_CONFIG_DIR = saved;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("refuses a user directory inside a repository and writes nothing there", () => {
    const repo = mkdtempSync(join(tmpdir(), "git-ident-repo-"));
    dirs.push(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, stdio: "ignore" });
    process.env.SEKHEMET_CONFIG_DIR = join(repo, "user");
    expect(() => hardenedGitEnv({})).toThrow(/inside the repository/);
    expect(existsSync(join(repo, "user", "git"))).toBe(false);
  });

  it("resolves a relative user directory to an absolute identity file", () => {
    const base = mkdtempSync(join(tmpdir(), "git-ident-rel-"));
    dirs.push(base);
    process.env.SEKHEMET_CONFIG_DIR = relative(process.cwd(), join(base, "user"));
    const env = hardenedGitEnv({});
    expect(isAbsolute(env.GIT_CONFIG_GLOBAL ?? "")).toBe(true);
    expect(env.GIT_CONFIG_GLOBAL?.startsWith(join(base, "user", "git"))).toBe(true);
  });
});
