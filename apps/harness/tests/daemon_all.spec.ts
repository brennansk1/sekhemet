import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server as HttpServer, createServer as createHttpServer } from "node:http";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tryModelLease } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { daemonStart, daemonStatusAll, readDaemon } from "../src/daemon.js";

// MD-N17-3 (FINDINGS REL-07): `daemon start` takes the next free port when
// its own is taken, and `daemon status --all` lists every workspace's server
// and port from workspaces.json, whether each answers, and who holds the
// machine's model lease. Real listeners and real HTTP servers throughout.

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sek-daemon-all-"));
  dirs.push(d);
  return d;
};

async function listener(): Promise<number> {
  const s: Server = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  closers.push(() => new Promise<void>((r) => s.close(() => r())));
  return (s.address() as { port: number }).port;
}

async function board(): Promise<number> {
  const s: HttpServer = createHttpServer((_req, res) => res.end("{}"));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  closers.push(() => new Promise<void>((r) => s.close(() => r())));
  return (s.address() as { port: number }).port;
}

describe("daemon start with its port taken (MD-N17-3)", () => {
  it("starts the server on the next free port, and records and prints that port", async () => {
    const repo = tmp();
    const taken = await listener();
    const launched: string[][] = [];
    const r = await daemonStart(repo, taken, {
      launch: (args: string[]) => {
        launched.push(args);
        return process.pid;
      },
      fetch: (async () => new Response("{}")) as typeof fetch,
      waitMs: 500,
    });
    const chosen = Number(launched[0]?.at(-1));
    expect(chosen).toBeGreaterThan(taken);
    expect(r.started).toBe(true);
    expect(readDaemon(repo)?.port).toBe(chosen);
    expect(r.message).toMatch(
      new RegExp(`port ${taken} was in use.*http://127\\.0\\.0\\.1:${chosen}`),
    );
  });
});

describe("daemon status --all (MD-N17-3)", () => {
  it("lists each workspace's server and port, whether it answers, and the model lease's holder", async () => {
    const dir = tmp();
    const a = await board();
    const b = await board();
    const gone = await listener();
    // A port that answers nothing: a listener closed again.
    await closers.pop()?.();
    const workspaces = join(dir, "workspaces.json");
    writeFileSync(
      workspaces,
      JSON.stringify({
        workspaces: [
          {
            id: "ws_aaaaaaaaaaaa",
            name: "Alpha",
            address: `http://127.0.0.1:${a}`,
            folder: "/work/alpha",
            projectRoots: ["/work/alpha", "/work/alpha-api"],
            lastOpened: "2026-10-05T00:00:00.000Z",
          },
          {
            id: "ws_bbbbbbbbbbbb",
            name: "Beta",
            address: `http://127.0.0.1:${b}`,
            folder: "/work/beta",
            lastOpened: "2026-10-04T00:00:00.000Z",
          },
          {
            id: "ws_cccccccccccc",
            name: "Gamma",
            address: `http://127.0.0.1:${gone}`,
            folder: "/work/gamma",
            lastOpened: "2026-10-03T00:00:00.000Z",
          },
        ],
      }),
    );
    const lock = join(dir, "model.lock");
    const free = await daemonStatusAll({ workspacesPath: workspaces, modelLeasePath: lock });
    expect(free).toMatch(
      new RegExp(
        `Alpha\\s+http://127\\.0\\.0\\.1:${a}\\s+answering\\s+/work/alpha \\(2 projects\\)`,
      ),
    );
    expect(free).toMatch(
      new RegExp(`Beta\\s+http://127\\.0\\.0\\.1:${b}\\s+answering\\s+/work/beta`),
    );
    expect(free).toMatch(new RegExp(`Gamma\\s+http://127\\.0\\.0\\.1:${gone}\\s+not answering`));
    expect(free).toMatch(/Model lease: free/);
    const held = tryModelLease({ model: "coder-a", port: 8098 }, lock);
    try {
      const out = await daemonStatusAll({ workspacesPath: workspaces, modelLeasePath: lock });
      expect(out).toMatch(/Model lease: project .* holds coder-a on port 8098 \(pid \d+/);
    } finally {
      if ("release" in held) held.release();
    }
    expect(
      await daemonStatusAll({ workspacesPath: join(dir, "none.json"), modelLeasePath: lock }),
    ).toMatch(/No workspace has been served on this machine yet/);
  });
});

describe("`sekhemet daemon status --all`, the built CLI (MD-N17-3)", () => {
  it("prints every workspace of the user directory and the model lease, from any folder", async () => {
    const home = tmp();
    const configDir = join(home, ".sekhemet");
    mkdirSync(configDir);
    const a = await board();
    writeFileSync(
      join(configDir, "workspaces.json"),
      JSON.stringify({
        workspaces: [
          {
            id: "ws_aaaaaaaaaaaa",
            name: "Alpha",
            address: `http://127.0.0.1:${a}`,
            folder: "/work/alpha",
            lastOpened: "2026-10-05T00:00:00.000Z",
          },
        ],
      }),
    );
    const held = tryModelLease({ model: "coder-a", port: 8098 }, join(configDir, "model.lock"));
    try {
      // Spawned without blocking: the boards answer from this process.
      const child = spawn(
        process.execPath,
        [resolve(import.meta.dirname, "../dist/index.js"), "daemon", "status", "--all"],
        {
          cwd: home,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: home,
            SEKHEMET_CONFIG_DIR: configDir,
            SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml",
            SEKHEMET_MODEL_LOADS: "off",
            BROWSER: "false",
          },
        },
      );
      const r = { stdout: "", stderr: "", status: null as number | null };
      child.stdout.on("data", (d) => {
        r.stdout += String(d);
      });
      child.stderr.on("data", (d) => {
        r.stderr += String(d);
      });
      r.status = await new Promise<number | null>((ok) => child.once("close", ok));
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(
        new RegExp(`Alpha\\s+http://127\\.0\\.0\\.1:${a}\\s+answering\\s+/work/alpha`),
      );
      expect(r.stdout).toMatch(/Model lease: project .* holds coder-a on port 8098 \(pid \d+/);
      // A read: it wrote no daemon file and no ledger in the folder it ran in.
      expect(spawnSync("ls", ["-A", home], { encoding: "utf8" }).stdout.trim()).toBe(".sekhemet");
    } finally {
      if ("release" in held) held.release();
    }
  });
});
