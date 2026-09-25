import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProcessSandbox } from "../../sandbox/src/executor.js";
import { NodeGitSyncAdapter } from "../src/git_adapter.js";

/** S2: the shared dependency tree is never writable from a card (item 24; SEC-7, SEC-8, SEC-8a). */
let repo: string;
let adapter: NodeGitSyncAdapter;

function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = join(d, e.name);
      h.update(p.slice(dir.length));
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) h.update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

const sandbox = new ProcessSandbox();
const run = (cwd: string, script: string) =>
  sandbox.execute("sh", ["-c", script], {
    cwd,
    allowedPaths: [cwd],
    allowNetwork: false,
    timeoutMs: 10_000,
  });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "sek-deps-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "T");
  git("config", "user.email", "t@x");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  mkdirSync(join(repo, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  mkdirSync(join(repo, ".venv", "lib"), { recursive: true });
  writeFileSync(join(repo, ".venv", "lib", "site.py"), "x = 1\n");
  adapter = new NodeGitSyncAdapter(repo, "proj");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("dependency trees (S2)", () => {
  it("gives each worktree its own node_modules, with links to the packages and its own caches", async () => {
    const wt = await adapter.createWorktree("c1", "main", "Deps");
    expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(wt, "node_modules", "left-pad")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(wt, "node_modules", "left-pad", "index.js"), "utf8")).toContain(
      "module.exports",
    );
    for (const cache of [".vite", ".vite-temp", ".cache", ".tmp"]) {
      expect(lstatSync(join(wt, "node_modules", cache)).isDirectory()).toBe(true);
    }
  });

  it("links the package managers' dot-entries but not a tool's cache from the user's own runs", async () => {
    mkdirSync(join(repo, "node_modules", ".bin"), { recursive: true });
    mkdirSync(join(repo, "node_modules", ".vitest"), { recursive: true });
    const wt = await adapter.createWorktree("c4", "main", "Dots");
    expect(lstatSync(join(wt, "node_modules", ".bin")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(wt, "node_modules", ".vitest"))).toBe(false);
  });

  it("keeps linking when one entry is a dangling link left from before", async () => {
    mkdirSync(join(repo, "node_modules", "right-pad"), { recursive: true });
    const wt = await adapter.createWorktree("c5", "main", "Dangling");
    rmSync(join(wt, "node_modules", "left-pad"));
    symlinkSync(join(repo, "gone"), join(wt, "node_modules", "left-pad"));
    rmSync(join(wt, "node_modules", "right-pad"));
    rmSync(join(wt, "node_modules", ".vite"), { recursive: true });
    await adapter.createWorktree("c5", "main", "Dangling");
    expect(lstatSync(join(wt, "node_modules", "right-pad")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(wt, "node_modules", ".vite")).isDirectory()).toBe(true);
  });

  it("writes a bundler cache inside the worktree and leaves the main node_modules byte-identical (SEC-7)", async () => {
    const wt = await adapter.createWorktree("c2", "main", "Vite");
    const before = treeHash(join(repo, "node_modules"));
    const r = await run(
      wt,
      "mkdir -p node_modules/.vite/deps && echo x > node_modules/.vite/deps/chunk.js",
    );
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(wt, "node_modules", ".vite", "deps", "chunk.js"))).toBe(true);
    const tamper = await run(wt, "echo evil >> node_modules/left-pad/index.js");
    expect(tamper.exitCode).not.toBe(0);
    expect(treeHash(join(repo, "node_modules"))).toBe(before);
  });

  it("gives neither of two cards write access to the other's caches (SEC-8)", async () => {
    const a = await adapter.createWorktree("ca", "main", "A");
    const b = await adapter.createWorktree("cb", "main", "B");
    const r = await run(
      a,
      `echo x > ${JSON.stringify(join(b, "node_modules", ".vite", "stolen"))}`,
    );
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(join(b, "node_modules", ".vite", "stolen"))).toBe(false);
  });

  it("refuses writes into the linked .venv and leaves the main one byte-identical (SEC-8a)", async () => {
    const wt = await adapter.createWorktree("c3", "main", "Venv");
    const before = treeHash(join(repo, ".venv"));
    const r = await run(wt, "echo evil > .venv/lib/injected.py");
    expect(r.exitCode).not.toBe(0);
    expect(treeHash(join(repo, ".venv"))).toBe(before);
  });
});
