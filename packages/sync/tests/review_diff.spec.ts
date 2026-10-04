import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeGitSyncAdapter } from "../src/git_adapter.js";
import {
  REVIEW_PROGRAM_ALLOWLIST,
  difftasticDiff,
  resolveReviewProgram,
} from "../src/review_diff.js";

/**
 * SEC-19a (item 20b): a program other than git that the harness runs over
 * worktree content is resolved by absolute path from a fixed allowlist and
 * runs with no network and time and memory limits; anything else is refused.
 */
const darwin = platform() === "darwin";
let dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  dirs = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A stand-in difft: an executable script at an absolute path. */
function fakeDifft(body: string): string {
  const dir = tmp("fake-difft-");
  const path = join(dir, "difft");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("SEC-19a: programs over worktree content outside a card's sandbox", () => {
  it("resolves only allowlisted absolute paths and refuses every other program", () => {
    const fake = fakeDifft('echo "$1"');
    expect(resolveReviewProgram("difft", { difft: [fake] })).toBe(fake);
    // Not on the allowlist: refused, whatever exists.
    expect(resolveReviewProgram("sh", { difft: [fake] })).toBeUndefined();
    expect(resolveReviewProgram("rm")).toBeUndefined();
    expect(resolveReviewProgram("constructor")).toBeUndefined();
    // A relative entry is never resolved against PATH or the cwd.
    expect(resolveReviewProgram("difft", { difft: ["difft"] })).toBeUndefined();
    // The fixed list names absolute paths only.
    for (const p of Object.values(REVIEW_PROGRAM_ALLOWLIST).flat())
      expect(p.startsWith("/")).toBe(true);
  });

  it("a difft first on PATH but not on the allowlist is never run", async () => {
    const marker = join(tmp("difft-out-"), "marker");
    const hijack = fakeDifft(`echo pwned > ${JSON.stringify(marker)}`);
    vi.stubEnv("PATH", `${dirname(hijack)}:${process.env.PATH ?? ""}`);
    const repo = tmp("difft-repo-");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    const adapter = new NodeGitSyncAdapter(repo);
    const wt = await adapter.createWorktree("d1", "main", "D1");
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "b.ts"), "export const b = 2;\n");
    const d = await adapter.structuralDiff("d1", "main", {
      programs: { difft: ["/nonexistent/difft"] },
    });
    expect(d.engine).toBe("git");
    expect(d.text).toContain("b.ts");
    expect(existsSync(marker)).toBe(false);
  });

  it.runIf(darwin)(
    "an allowlisted difft runs with no network and cannot write outside",
    async () => {
      let connections = 0;
      const server: Server = createServer((s) => {
        connections++;
        s.end();
      });
      const port: number = await new Promise((r) =>
        server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)),
      );
      const marker = join(tmp("difft-out-"), "marker");
      const difft = fakeDifft(
        [
          `echo escaped > ${JSON.stringify(marker)} 2>/dev/null`,
          `${JSON.stringify(process.execPath)} -e 'require("net").connect(${port}, "127.0.0.1").on("error", () => process.exit(0)).on("connect", () => process.exit(0))'`,
          'echo "structural diff of $1"',
        ].join("\n"),
      );
      try {
        const text = await difftasticDiff(difft, [
          { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
        ]);
        expect(text).toContain("structural diff of src/a.ts");
        expect(existsSync(marker)).toBe(false);
        expect(connections).toBe(0);
      } finally {
        server.close();
      }
    },
  );

  it.runIf(darwin)("a difft past its time limit is stopped and the review falls back", async () => {
    const difft = fakeDifft("sleep 30");
    const started = Date.now();
    const text = await difftasticDiff(difft, [{ path: "a.ts", before: "1", after: "2" }], {
      timeoutMs: 300,
    });
    expect(text).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("a diff over the file limit is git's whole, never difftastic with files dropped", async () => {
    const runs = join(tmp("difft-runs-"), "count");
    const difft = fakeDifft(`echo x >> ${JSON.stringify(runs)}; echo "difft $1"`);
    const sides = Array.from({ length: 201 }, (_, i) => ({
      path: `src/f${i}.ts`,
      before: "a",
      after: "b",
    }));
    expect(await difftasticDiff(difft, sides)).toBeUndefined();
    expect(existsSync(runs)).toBe(false);

    const repo = tmp("difft-many-");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    writeFileSync(join(repo, "seed.ts"), "\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    const adapter = new NodeGitSyncAdapter(repo);
    const wt = await adapter.createWorktree("m1", "main", "M1");
    mkdirSync(join(wt, "src"), { recursive: true });
    for (let i = 0; i < 201; i++)
      writeFileSync(join(wt, "src", `f${i}.ts`), `export const f${i} = ${i};\n`);
    const d = await adapter.structuralDiff("m1", "main", { programs: { difft: [difft] } });
    expect(d.engine).toBe("git");
    expect(d.text).toContain("src/f200.ts");
    expect(existsSync(runs)).toBe(false);
  }, 60_000);
});

describe("FINDINGS_C1 CLI-08: the review diff is the change being accepted", () => {
  it("with the worktree live, diffs against where the branch started, not the integration branch's head", async () => {
    const repo = tmp("merge-base-repo-");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    const adapter = new NodeGitSyncAdapter(repo);
    const wt = await adapter.createWorktree("m1", "main", "M1");
    writeFileSync(join(wt, "b.ts"), "export const b = 2;\n");
    // Later work on main, after the branch was cut.
    writeFileSync(join(repo, "brief.md"), "# The brief\n");
    git("add", "brief.md");
    git("commit", "-q", "-m", "brief");
    const d = await adapter.structuralDiff("m1", "main", { programs: { difft: [] } });
    expect(d.text).toContain("b.ts");
    expect(d.text).not.toContain("brief.md");
    expect(Object.values(d.groups).flat()).toEqual(["b.ts"]);
  });
});
