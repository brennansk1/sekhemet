import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bubblewrapArgv } from "../src/bubblewrap.js";

describe("@sekhemet/sandbox bubblewrap (Linux)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("mounts the root read-only, then a private /tmp, then only the granted paths writable", () => {
    const work = mkdtempSync(join(tmpdir(), "bw-"));
    dirs.push(work);
    const argv = bubblewrapArgv(
      {
        allowedPaths: [work],
        allowNetwork: false,
        timeoutMs: 1000,
        cwd: work,
        scratchDir: join(work, "s"),
      },
      "pnpm",
      ["test"],
    );
    const ro = argv.indexOf("--ro-bind");
    const tmp = argv.indexOf("--tmpfs");
    const bind = argv.indexOf("--bind");
    expect(argv.slice(ro, ro + 3)).toEqual(["--ro-bind", "/", "/"]);
    expect(ro).toBeLessThan(tmp);
    expect(tmp).toBeLessThan(bind);
    expect(argv).toContain("--unshare-net");
    expect(argv).toContain("--die-with-parent");
    expect(argv.slice(-5)).toEqual(["--chdir", work, "--", "pnpm", "test"]);
  });

  it("keeps the network when granted; linked dependencies stay read-only, caches included (item 24)", () => {
    // Phase A security review, 2026-09-22: this test used to assert the whole
    // linked node_modules was writable — which let a card change dependencies
    // the user later runs unconfined. Only the cache directories are.
    const repo = mkdtempSync(join(tmpdir(), "bw-repo-"));
    const work = join(repo, "wt");
    dirs.push(repo);
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    mkdirSync(work);
    symlinkSync(join(repo, "node_modules"), join(work, "node_modules"));
    const argv = bubblewrapArgv(
      { allowedPaths: [work], allowNetwork: true, timeoutMs: 1, cwd: work },
      "node",
      [],
    );
    expect(argv).not.toContain("--unshare-net");
    const binds = argv.flatMap((a, i) => (a === "--bind" ? [argv[i + 1]] : []));
    expect(binds.some((b) => b?.endsWith("node_modules"))).toBe(false);
    expect(binds.some((b) => b?.endsWith(join("node_modules", ".vite-temp")))).toBe(false);
  });

  it("re-mounts a granted path's .git read-only after the writable binds", () => {
    const work = mkdtempSync(join(tmpdir(), "bw-git-"));
    dirs.push(work);
    mkdirSync(join(work, ".git"));
    const argv = bubblewrapArgv(
      { allowedPaths: [work], allowNetwork: false, timeoutMs: 1, cwd: work },
      "node",
      [],
    );
    const lastWritable = argv.lastIndexOf("--bind");
    const gitRo = argv.findIndex(
      (a, i) => a === "--ro-bind" && argv[i + 1]?.endsWith(".git") && i > lastWritable,
    );
    expect(gitRo).toBeGreaterThan(lastWritable);
  });

  // L12 under the native engine on Linux (C4): a worktree under the host's
  // /tmp is hidden by bubblewrap's private /tmp, so run_script could not
  // read it. A read-only path is bound back read-only — never writable —
  // after the private /tmp, and a ledger inside it stays masked.
  it("binds a read-only path back read-only after the private /tmp, never writable, its ledger still masked", () => {
    const repo = mkdtempSync(join(tmpdir(), "bw-ro-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".sekhemet"));
    writeFileSync(join(repo, ".sekhemet", "events.db"), "");
    const scratch = join(repo, "scratch");
    mkdirSync(scratch);
    const argv = bubblewrapArgv(
      {
        allowedPaths: [],
        readOnlyPaths: [repo],
        scratchDir: scratch,
        allowNetwork: false,
        timeoutMs: 1,
        cwd: scratch,
      },
      "node",
      [],
    );
    const pairs = (flag: string) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));
    const real = pairs("--ro-bind").find((p) => p?.endsWith(repo.split("/").at(-1) as string));
    expect(real).toBeDefined();
    expect(pairs("--bind")).not.toContain(real);
    const tmpAt = argv.indexOf("/tmp") - 1;
    expect(argv[tmpAt]).toBe("--tmpfs");
    expect(argv.lastIndexOf(real as string)).toBeGreaterThan(tmpAt);
    // The ledger inside it is masked after the bind.
    const ledger = argv.findIndex(
      (a, i) => a.endsWith(join(".sekhemet", "events.db")) && i > argv.indexOf(real as string),
    );
    expect(ledger).toBeGreaterThan(0);
  });
});
