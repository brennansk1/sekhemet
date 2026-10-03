import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bubblewrapArgv } from "../src/bubblewrap.js";
import { ProcessSandbox, type SandboxEngine } from "../src/executor.js";
import { projectIsolationDenies, registerCardIsolation } from "../src/isolation.js";
import { generateSeatbeltProfile } from "../src/seatbelt.js";
import { srtFilesystem, srtUnavailableReason } from "../src/srt_engine.js";

// security item 10a, NEW-security-13 (DEC-57): a card sees only its own
// project. Under the real sandbox, a card of one project cannot read or write
// another project's root, another card's worktree, or the workspace's ledger,
// blobs and evidence, while its own worktree stays readable and writable and
// the rest of its own root stays readable (SEC-N13-1, SEC-N13-2).

const srtRuns = platform() === "darwin" || srtUnavailableReason() === undefined;
const ENGINES: SandboxEngine[] = srtRuns ? ["native", "srt"] : ["native"];
const VISIBLE_BASE = platform() === "linux" && existsSync("/var/tmp") ? "/var/tmp" : tmpdir();
const confined = new ProcessSandbox({ engine: "native" }).confinement !== "none";

interface Layout {
  base: string;
  /** The workspace folder, also project A's root (as every install before DEC-57). */
  ws: string;
  /** Project B's root, outside the workspace folder. */
  b: string;
  ownA: string;
  otherA: string;
  ownB: string;
  canaries: Record<string, string>;
}

function layout(): Layout {
  const base = realpathSync(mkdtempSync(join(VISIBLE_BASE, "sek-isolation-")));
  const ws = join(base, "alpha");
  const b = join(base, "beta");
  const state = join(ws, ".sekhemet");
  const ownA = join(state, "worktrees", "card-a");
  const otherA = join(state, "worktrees", "card-a2");
  const ownB = join(b, ".sekhemet", "worktrees", "card-b");
  for (const d of [
    join(ws, "src"),
    join(state, "blobs", "ab"),
    join(state, "evidence"),
    ownA,
    otherA,
    join(b, "src"),
    ownB,
  ]) {
    mkdirSync(d, { recursive: true });
  }
  const canaries: Record<string, string> = {
    ledger: join(state, "events.db"),
    ledgerWal: join(state, "events.db-wal"),
    blob: join(state, "blobs", "ab", "abc.json"),
    evidence: join(state, "evidence", "ev_1.json"),
    otherWorktree: join(otherA, "notes.txt"),
    projectB: join(b, "src", "secret.ts"),
    worktreeB: join(ownB, "b.txt"),
    projectA: join(ws, "src", "a.ts"),
  };
  for (const [name, path] of Object.entries(canaries)) writeFileSync(path, `CANARY-${name}`);
  return { base, ws, b, ownA, otherA, ownB, canaries };
}

const nodeRead = (path: string) => [
  "-e",
  `process.stdout.write(require('fs').readFileSync(${JSON.stringify(path)}, 'utf8'))`,
];
const nodeWrite = (path: string) => [
  "-e",
  `require('fs').writeFileSync(${JSON.stringify(path)}, 'CHANGED')`,
];

describe("item 10a: a card sees only its own project (NEW-security-13)", () => {
  let l: Layout;
  const releases: (() => void)[] = [];
  beforeEach(() => {
    l = layout();
  });
  afterEach(() => {
    for (const r of releases.splice(0)) r();
    rmSync(l.base, { recursive: true, force: true });
  });

  it("names the workspace's state one by one, the other cards' worktrees and the other roots, never the whole .sekhemet folder nor the card's own worktree", () => {
    const denies = projectIsolationDenies({
      workspaceFolder: l.ws,
      projectRoots: [l.ws, l.b],
      ownRoot: l.ws,
      ownWorktree: l.ownA,
    });
    for (const p of [
      l.canaries.ledger,
      l.canaries.ledgerWal,
      join(l.ws, ".sekhemet", "blobs"),
      join(l.ws, ".sekhemet", "evidence"),
      join(l.ws, ".sekhemet", "runner.lock"),
      join(l.ws, ".sekhemet", "daemon.json"),
      l.otherA,
      l.ownB,
      l.b,
    ]) {
      expect(denies).toContain(p);
    }
    expect(denies).not.toContain(join(l.ws, ".sekhemet"));
    expect(denies).not.toContain(l.ws);
    expect(denies.some((p) => l.ownA === p || l.ownA.startsWith(`${p}/`))).toBe(false);
  });

  it("every engine reads the one list: Seatbelt denies after the grants, bubblewrap masks after the binds, srt denies reads and writes", () => {
    const denies = projectIsolationDenies({
      workspaceFolder: l.ws,
      projectRoots: [l.ws, l.b],
      ownRoot: l.ws,
      ownWorktree: l.ownA,
    });
    const options = {
      allowedPaths: [l.ownA],
      allowNetwork: false,
      timeoutMs: 1000,
      cwd: l.ownA,
      denyPaths: denies,
    };
    const profile = generateSeatbeltProfile(options);
    const grant = profile.indexOf(`(allow file-write* (subpath "${l.ownA}"))`);
    const deny = profile.indexOf(`(deny file-read-data (subpath "${l.b}"))`);
    expect(grant).toBeGreaterThan(0);
    expect(deny).toBeGreaterThan(grant);
    expect(profile).toContain(`(deny file-write-create file-write-unlink (subpath "${l.otherA}"))`);
    const argv = bubblewrapArgv(options, "true", []);
    const bind = argv.findIndex((a, i) => a === "--bind" && argv[i + 1] === l.ownA);
    expect(bind).toBeGreaterThan(0);
    const mask = argv.indexOf(l.b);
    expect(argv[mask - 1]).toBe("--tmpfs");
    expect(mask).toBeGreaterThan(bind);
    expect(argv[argv.indexOf(l.canaries.ledger) - 1]).toBe("/dev/null");
    const fs = srtFilesystem(options);
    expect(fs?.denyRead).toEqual(expect.arrayContaining([l.b, l.otherA, l.canaries.ledger]));
    expect(fs?.denyWrite).toEqual(expect.arrayContaining([l.b, l.otherA, l.canaries.ledger]));
  });

  it.runIf(confined).each(ENGINES)(
    "SEC-N13-1, SEC-N13-2 (%s engine): a card of project A in the workspace folder reads and writes its own worktree and its root, and nothing of project B, the other worktree or the workspace's state",
    async (engine) => {
      const box = new ProcessSandbox({ engine });
      const run = (args: string[]) =>
        box.execute(process.execPath, args, {
          allowedPaths: [l.ownA],
          allowNetwork: false,
          timeoutMs: 20_000,
          cwd: l.ownA,
        });
      // Control: before the card's isolation is registered, project B is readable.
      expect((await run(nodeRead(l.canaries.projectB))).stdout).toBe("CANARY-projectB");
      releases.push(
        registerCardIsolation(
          l.ownA,
          projectIsolationDenies({
            workspaceFolder: l.ws,
            projectRoots: [l.ws, l.b],
            ownRoot: l.ws,
            ownWorktree: l.ownA,
          }),
        ),
      );
      for (const name of [
        "ledger",
        "ledgerWal",
        "blob",
        "evidence",
        "otherWorktree",
        "projectB",
        "worktreeB",
      ]) {
        const path = l.canaries[name] as string;
        const read = await run(nodeRead(path));
        expect(read.exitCode, `${name} read`).not.toBe(0);
        expect(read.stdout, name).not.toContain("CANARY");
        const write = await run(nodeWrite(path));
        expect(write.exitCode, `${name} write`).not.toBe(0);
        expect(readFileSync(path, "utf8")).toBe(`CANARY-${name}`);
      }
      // Its own worktree: written and read back.
      const own = join(l.ownA, "own.txt");
      expect((await run(nodeWrite(own))).exitCode).toBe(0);
      expect((await run(nodeRead(own))).stdout).toBe("CHANGED");
      // SEC-N13-2: the rest of its own root stays readable as before.
      expect((await run(nodeRead(l.canaries.projectA))).stdout).toBe("CANARY-projectA");
      // Item 10's toolchains: git still runs.
      const git = await box.execute("git", ["--version"], {
        allowedPaths: [l.ownA],
        allowNetwork: false,
        timeoutMs: 20_000,
        cwd: l.ownA,
      });
      expect(git.stdout).toMatch(/git version/);
    },
  );

  it.runIf(confined).each(ENGINES)(
    "SEC-N13-1 (%s engine): a card of project B cannot read the workspace folder's project, its ledger or its worktrees",
    async (engine) => {
      const box = new ProcessSandbox({ engine });
      releases.push(
        registerCardIsolation(
          l.ownB,
          projectIsolationDenies({
            workspaceFolder: l.ws,
            projectRoots: [l.ws, l.b],
            ownRoot: l.b,
            ownWorktree: l.ownB,
          }),
        ),
      );
      const run = (args: string[]) =>
        box.execute(process.execPath, args, {
          allowedPaths: [l.ownB],
          allowNetwork: false,
          timeoutMs: 20_000,
          cwd: l.ownB,
        });
      for (const name of ["ledger", "blob", "evidence", "otherWorktree", "projectA"]) {
        const read = await run(nodeRead(l.canaries[name] as string));
        expect(read.exitCode, name).not.toBe(0);
        expect(read.stdout, name).not.toContain("CANARY");
      }
      expect((await run(nodeRead(l.canaries.worktreeB))).stdout).toBe("CANARY-worktreeB");
      expect((await run(nodeRead(l.canaries.projectB))).stdout).toBe("CANARY-projectB");
      expect((await run(nodeWrite(join(l.ownB, "own.txt")))).exitCode).toBe(0);
    },
  );
});
