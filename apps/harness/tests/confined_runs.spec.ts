import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type Server, createServer } from "node:net";
import { platform, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { validateToolProposal } from "@sekhemet/eval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPackageGates, validateInScratch } from "../src/wave2.js";

/** S3a: package gates and --validate-tools run worktree code through runConfined(). */
const darwin = platform() === "darwin";

const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

/** Every file under `root` except .git, hashed: the checkout byte for byte. */
function snapshot(root: string): string {
  const h = createHash("sha256");
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (e.name === ".git") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(relative(root, p)).update("\0").update(readFileSync(p)).update("\0");
    }
  };
  walk(root);
  return h.digest("hex");
}

let dirs: string[] = [];
beforeEach(() => {
  dirs = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

describe("SEC-17 / SEC-19: per-package gates", () => {
  function monorepo(gateScript: string): string {
    const root = tmp("pkg-gates-");
    write(root, "package.json", JSON.stringify({ name: "mono", workspaces: ["packages/*"] }));
    write(root, "packages/a/package.json", JSON.stringify({ name: "a" }));
    write(root, "packages/a/src/x.ts", "export const x = 1;\n");
    write(
      root,
      "packages/a/.sekhemet/gates.toml",
      `[[gates]]\nrung = "test"\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["-e", ${JSON.stringify(gateScript)}]\n`,
    );
    return root;
  }

  it.runIf(darwin)("a package gate that writes outside the worktree leaves no marker", async () => {
    const marker = join(tmp("pkg-out-"), "marker");
    const root = monorepo(
      `require("fs").writeFileSync("ran", "x"); require("fs").writeFileSync(${JSON.stringify(marker)}, "escaped")`,
    );
    const r = await runPackageGates(root, root, ["packages/a/src/x.ts"], () => undefined);
    expect(r).toHaveLength(1);
    // It ran in its package directory, inside the worktree, and failed to escape.
    expect(existsSync(join(root, "packages", "a", "ran"))).toBe(true);
    expect(r[0]?.passed).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it("SEC-19: under --restricted no package gate starts", async () => {
    const root = monorepo(`require("fs").writeFileSync("ran", "x")`);
    const r = await runPackageGates(root, root, ["packages/a/src/x.ts"], () => undefined, {
      restricted: true,
    });
    expect(r).toEqual([]);
    expect(existsSync(join(root, "packages", "a", "ran"))).toBe(false);
  });
});

describe.runIf(darwin)("SEC-17a: --validate-tools runs a mined command confined", () => {
  let server: Server;
  let port: number;
  let connections: number;
  beforeEach(async () => {
    connections = 0;
    server = createServer((s) => {
      connections++;
      s.end();
    });
    port = await new Promise((r) =>
      server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)),
    );
  });
  afterEach(() => {
    server.close();
  });

  function repoWith(files: Record<string, string>): string {
    const repo = tmp("validate-repo-");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    return repo;
  }

  const scratchDirs = () =>
    readdirSync(tmpdir())
      .filter((d) => d.startsWith("sekhemet-validate-"))
      .sort();

  it("marker absent, key unread, connection refused and recorded, scratch deleted, main checkout untouched", async () => {
    const home = tmp("validate-home-");
    writeFileSync(join(home, ".sekhemet-fake-key"), "home-canary-key");
    vi.stubEnv("HOME", home);
    vi.stubEnv("SEKHEMET_CANARY_API_KEY", "env-canary-key");
    const marker = join(tmp("validate-out-"), "marker");
    const probe = `const fs = require("fs"), os = require("os"), path = require("path"), net = require("net");
const out = [];
fs.writeFileSync("ran.txt", "x");
try { fs.writeFileSync(${JSON.stringify(marker)}, "escaped"); out.push("wrote") } catch (e) { out.push("write:" + e.code) }
out.push("env:" + (process.env.SEKHEMET_CANARY_API_KEY ?? "none"));
try { out.push("home:" + fs.readFileSync(path.join(os.homedir(), ".sekhemet-fake-key"), "utf8")) } catch (e) { out.push("home:" + e.code) }
try { out.push("abs:" + fs.readFileSync(${JSON.stringify(join(home, ".sekhemet-fake-key"))}, "utf8")) } catch (e) { out.push("abs:" + e.code) }
net.connect(${port}, "127.0.0.1")
  .on("connect", () => { console.log(out.join(" ") + " connected"); process.exit(0) })
  .on("error", (e) => { console.log(out.join(" ") + " connection refused: " + e.code); process.exit(3) });
`;
    const repo = repoWith({ "probe.cjs": probe });
    const before = snapshot(repo);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    const leftovers = scratchDirs();

    const command = `${process.execPath} probe.cjs`;
    const validated = await validateToolProposal(
      {
        name: "probe",
        template: command,
        params: [],
        examples: [command],
        cards: ["c1", "c2", "c3"],
        status: "candidate",
      },
      (cmd) => validateInScratch(repo, cmd),
    );

    expect(validated.status).toBe("failed");
    const recorded = validated.failures?.join("\n") ?? "";
    expect(recorded).toContain("connection refused");
    expect(recorded).toContain("write:EPERM");
    expect(recorded).toContain("env:none");
    // By path too: the real home is unreadable, not only renamed.
    expect(recorded).toContain("abs:EPERM");
    expect(recorded).not.toContain("canary-key");
    expect(connections).toBe(0);
    expect(existsSync(marker)).toBe(false);
    // The scratch worktree is gone, from disk and from git.
    expect(scratchDirs()).toEqual(leftovers);
    expect(
      execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" })
        .split("\n")
        .filter((l) => l.startsWith("worktree ")),
    ).toHaveLength(1);
    // The main checkout is byte-identical: the probe ran elsewhere.
    expect(snapshot(repo)).toBe(before);
    expect(existsSync(join(repo, "ran.txt"))).toBe(false);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })).toBe(
      status,
    );
  }, 60_000);

  it("a well-behaved command validates", async () => {
    const repo = repoWith({
      "ok.cjs": "process.exit(require('fs').existsSync('ok.cjs') ? 0 : 1)\n",
    });
    const r = await validateInScratch(repo, `${process.execPath} ok.cjs`);
    expect(r.exitCode).toBe(0);
  }, 60_000);
});
