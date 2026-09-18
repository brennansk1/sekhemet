import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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

  it("keeps the network when granted and makes linked dependencies writable", () => {
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
    expect(binds.some((b) => b?.endsWith("node_modules"))).toBe(true);
  });
});
