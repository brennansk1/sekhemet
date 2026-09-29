import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error: a plain ESM script, run by hand and by the capstone runner, checked here.
import * as seed from "../../../scripts/capstone/seed.mjs";

/**
 * The capstone's seed repository (W2 G2, CAPSTONE_SELECTION "Protocol"):
 * every arm starts from the same empty repository with a pinned toolchain,
 * materialised by `scripts/capstone/seed.mjs` as a fresh git repository whose
 * commit hash is the same every time and is recorded in `seed.json`.
 */

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const FIXTURE = join(ROOT, "fixtures", "capstone", "timesheet");
const SEED = join(FIXTURE, "seed");
const SCRIPT = join(ROOT, "scripts", "capstone", "seed.mjs");

const SEED_FILES = [
  ".gitignore",
  ".npmrc",
  ".nvmrc",
  "README.md",
  "package-lock.json",
  "package.json",
  "tsconfig.json",
];

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function temp(prefix = "capstone-seed-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
function copyOfFixture(): string {
  const dir = temp("capstone-seed-fixture-");
  cpSync(join(FIXTURE, "seed"), join(dir, "seed"), { recursive: true });
  cpSync(join(FIXTURE, "seed.json"), join(dir, "seed.json"));
  return dir;
}
function run(args: string[], env: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}
function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
const recorded = () => JSON.parse(readFileSync(join(FIXTURE, "seed.json"), "utf8"));
const pkg = () => JSON.parse(readFileSync(join(SEED, "package.json"), "utf8"));

describe("the seed repository", () => {
  it("holds only the toolchain and its README: no application code and no tests", () => {
    expect(seed.seedFiles(SEED)).toEqual(SEED_FILES);
    for (const name of SEED_FILES) expect(name).not.toMatch(/\.(ts|js|mjs|cjs|tsx|jsx)$/);
  });

  it("pins Node and every tool to an exact version, the same in every place it is stated", () => {
    const p = pkg();
    const exact = /^\d+\.\d+\.\d+$/;
    expect(p.engines.node).toMatch(exact);
    expect(readFileSync(join(SEED, ".nvmrc"), "utf8")).toBe(`${p.engines.node}\n`);
    expect(recorded().node).toBe(p.engines.node);
    expect(p.dependencies).toBeUndefined();
    expect(Object.keys(p.devDependencies).sort()).toEqual(["@types/node", "typescript"]);
    const lock = JSON.parse(readFileSync(join(SEED, "package-lock.json"), "utf8"));
    expect(lock.packages[""].devDependencies).toEqual(p.devDependencies);
    for (const [name, version] of Object.entries(p.devDependencies)) {
      expect(version, name).toMatch(exact);
      expect(lock.packages[`node_modules/${name}`].version, name).toBe(version);
    }
    for (const [path, entry] of Object.entries(lock.packages) as [
      string,
      { integrity?: string },
    ][]) {
      if (path !== "") expect(entry.integrity, path).toMatch(/^sha512-/);
    }
    expect(readFileSync(join(SEED, ".npmrc"), "utf8")).toBe(
      "engine-strict=true\nsave-exact=true\n",
    );
  });

  it("has the four commands the technical notes name, and a version that is valid SemVer", () => {
    const p = pkg();
    expect(Object.keys(p.scripts).sort()).toEqual(["build", "start", "test"]);
    expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
    const notes = readFileSync(join(FIXTURE, "contract.md"), "utf8");
    for (const command of ["`npm install`", "`npm run build`", "`npm start`", "`npm test`"]) {
      expect(notes).toContain(command);
      expect(readFileSync(join(SEED, "README.md"), "utf8")).toContain(command);
    }
  });

  it("its README states what the notes state about PORT and DATA_DIR, and nothing about the scoring", () => {
    const readme = readFileSync(join(SEED, "README.md"), "utf8");
    const notes = readFileSync(join(FIXTURE, "contract.md"), "utf8");
    for (const fact of ["`PORT` (default `3000`)", "`DATA_DIR` (default `./data`)"]) {
      expect(notes).toContain(fact);
      expect(readme).toContain(fact);
    }
    for (const name of SEED_FILES) {
      const text = readFileSync(join(SEED, name), "utf8");
      expect(text, name).not.toMatch(/hidden|capstone|sekhemet|acceptance|score/i);
    }
  });
});

describe("materialising a fresh repository", () => {
  it("gives one commit on main, tagged seed, with a clean tree and the recorded hash", () => {
    const dest = join(temp(), "run");
    const r = run([dest]);
    expect(r.status, r.stderr).toBe(0);
    const record = JSON.parse(r.stdout);
    expect(record.seedCommit).toBe(recorded().commit);
    expect(record.seedTree).toBe(recorded().tree);
    expect(record.node).toBe(process.version);
    expect(git(dest, "rev-parse", "HEAD")).toBe(recorded().commit);
    expect(git(dest, "rev-parse", "seed")).toBe(recorded().commit);
    expect(git(dest, "branch", "--show-current")).toBe("main");
    expect(git(dest, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(dest, "status", "--porcelain")).toBe("");
    expect(git(dest, "ls-files").split("\n").sort()).toEqual(SEED_FILES);
    const hooks = join(dest, ".git", "hooks");
    expect(existsSync(hooks) ? readdirSync(hooks) : []).toEqual([]);
  });

  it("gives the same commit whatever the person's own git configuration says", () => {
    const home = temp("capstone-seed-home-");
    const config = join(home, "gitconfig");
    const hooks = join(home, "hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeFileSync(
      config,
      `[user]\n\tname = Someone Else\n\temail = someone@example.com\n[init]\n\tdefaultBranch = trunk\n[commit]\n\tgpgsign = true\n[core]\n\thooksPath = ${hooks}\n\tautocrlf = true\n`,
    );
    const dest = join(temp(), "run");
    const r = run([dest], { GIT_CONFIG_GLOBAL: config, HOME: home, TZ: "Pacific/Auckland" });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).seedCommit).toBe(recorded().commit);
    expect(git(dest, "branch", "--show-current")).toBe("main");
  });

  it("writes the record to a file when asked", () => {
    const dir = temp();
    const out = join(dir, "record.json");
    const r = run([join(dir, "run"), "--record", out]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(JSON.parse(r.stdout));
  });

  it("accepts an existing empty directory, and refuses one that is not empty", () => {
    const empty = temp();
    expect(run([empty]).status).toBe(0);
    const full = temp();
    writeFileSync(join(full, "x"), "x");
    const r = run([full]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not empty/);
    expect(readdirSync(full)).toEqual(["x"]);
  });

  it("refuses a destination inside this repository, the hidden suite's directory or another git repository", () => {
    const inRepo = run([join(ROOT, "fixtures", "capstone", "run-here")]);
    expect(inRepo.status).toBe(1);
    expect(inRepo.stderr).toMatch(/inside the Sekhemet repository/);
    expect(existsSync(join(ROOT, "fixtures", "capstone", "run-here"))).toBe(false);

    const hidden = temp("capstone-seed-hidden-");
    const r = run([join(hidden, "run")], { SEKHEMET_CAPSTONE_HIDDEN: hidden });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/inside the hidden suite's directory/);
    expect(readdirSync(hidden)).toEqual([]);

    const outer = temp("capstone-seed-outer-");
    git(outer, "init", "--quiet");
    const nested = run([join(outer, "sub", "run")]);
    expect(nested.status).toBe(1);
    expect(nested.stderr).toMatch(/inside the git repository/);
    expect(existsSync(join(outer, "sub"))).toBe(false);
  });

  it("refuses when this Node is not the pinned one, before writing anything", () => {
    const fixture = copyOfFixture();
    writeFileSync(join(fixture, "seed", ".nvmrc"), "25.0.0\n");
    const dest = join(temp(), "run");
    const r = run([dest, "--fixture", fixture]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("25.0.0");
    expect(r.stderr).toContain(process.versions.node);
    expect(existsSync(dest)).toBe(false);
  });

  it("refuses, and leaves nothing behind, when the seed no longer gives the recorded commit", () => {
    const fixture = copyOfFixture();
    writeFileSync(join(fixture, "seed", "src.ts"), "export {};\n");
    const dest = join(temp(), "run");
    const r = run([dest, "--fixture", fixture]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not the recorded seed commit/);
    expect(existsSync(dest)).toBe(false);
  });
});

describe("the seed's frozen record", () => {
  it("--check passes on the committed fixture", () => {
    const r = run(["--check"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(recorded().commit);
  });

  it("records every file's SHA-256 and the listing's", () => {
    const rec = recorded();
    expect(Object.keys(rec.files).sort()).toEqual(SEED_FILES);
    for (const name of SEED_FILES) {
      expect(rec.files[name], name).toBe(seed.sha256(readFileSync(join(SEED, name), "utf8")));
    }
    expect(rec.listingSha256).toBe(seed.sha256(seed.renderListing(FIXTURE)));
    expect(seed.check(FIXTURE)).toEqual([]);
  });

  it("--check names a changed file, an added file and a missing one; --write re-freezes", () => {
    const fixture = copyOfFixture();
    writeFileSync(join(fixture, "seed", "README.md"), "changed\n");
    writeFileSync(join(fixture, "seed", "extra.txt"), "x\n");
    rmSync(join(fixture, "seed", ".gitignore"));
    const r = run(["--check", "--fixture", fixture]);
    expect(r.status).toBe(1);
    for (const name of ["README.md", "extra.txt", ".gitignore", "commit"]) {
      expect(r.stderr).toContain(name);
    }
    expect(run(["--write", "--fixture", fixture]).status).toBe(0);
    expect(seed.check(fixture)).toEqual([]);
  });

  it("renders the seed as text in the reply format, for an arm that cannot open a repository", () => {
    const listing = seed.renderListing(FIXTURE) as string;
    for (const name of SEED_FILES) {
      const body = readFileSync(join(SEED, name), "utf8");
      expect(listing).toContain(`### ${name}\n\n\`\`\`\n${body}\`\`\`\n`);
    }
    expect(listing.match(/^### /gm)?.length).toBe(SEED_FILES.length);
  });
});

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      s.close(() => ok(typeof address === "object" && address ? address.port : 0));
    });
  });
}

describe("the pinned toolchain, installed", () => {
  it(
    "installs from the lockfile, refuses to build with no code, then builds, tests and starts an app",
    { timeout: 180_000 },
    async (ctx) => {
      const dest = join(temp(), "run");
      expect(run([dest]).status).toBe(0);
      const npm = (...args: string[]) =>
        spawnSync("npm", args, {
          cwd: dest,
          encoding: "utf8",
          env: { ...process.env, npm_config_update_notifier: "false" },
        });
      const install = npm("ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund");
      if (install.status !== 0 && /ENOTCACHED|ETARGET/.test(install.stderr)) {
        ctx.skip("the pinned toolchain is not in this machine's npm cache, and tests stay offline");
      }
      expect(install.status, install.stderr).toBe(0);

      expect(npm("run", "build").status).not.toBe(0);

      mkdirSync(join(dest, "src"));
      writeFileSync(
        join(dest, "src", "add.ts"),
        "export const add = (a: number, b: number): number => a + b;\n",
      );
      writeFileSync(
        join(dest, "src", "add.test.ts"),
        'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./add.js";\n\ntest("adds", () => assert.equal(add(2, 3), 5));\n',
      );
      writeFileSync(
        join(dest, "src", "main.ts"),
        'import { createServer } from "node:http";\nimport { add } from "./add.js";\n\nconst port = Number(process.env.PORT ?? 3000);\ncreateServer((_req, res) => {\n  res.setHeader("content-type", "application/json");\n  res.end(JSON.stringify({ ok: true, sum: add(1, 1) }));\n}).listen(port, "127.0.0.1");\n',
      );
      const build = npm("run", "build");
      expect(build.status, build.stdout + build.stderr).toBe(0);
      const test = npm("test");
      expect(test.status, test.stdout + test.stderr).toBe(0);
      expect(test.stdout).toMatch(/pass 1/);

      const port = await freePort();
      const app = spawn("npm", ["start"], {
        cwd: dest,
        env: { ...process.env, PORT: String(port) },
        stdio: "ignore",
        detached: true,
      });
      try {
        let body: unknown = null;
        for (let i = 0; i < 100 && body === null; i++) {
          try {
            body = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
          } catch {
            await new Promise((r) => setTimeout(r, 100));
          }
        }
        expect(body).toEqual({ ok: true, sum: 2 });
      } finally {
        if (app.pid) process.kill(-app.pid, "SIGTERM");
      }
    },
  );
});
