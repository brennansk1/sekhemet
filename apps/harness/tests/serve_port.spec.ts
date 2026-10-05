import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { startDashboardServer } from "../src/server.js";

// MD-N17-3, runtime item 23 (FINDINGS REL-07): a second `serve` on a machine
// whose port is taken (another workspace's server, any program) takes the
// next free port and prints the address it bound, where before it failed raw
// with EADDRINUSE on 4040. A real listener holds the port; the server and the
// built CLI bind for real.

const BIN = resolve(import.meta.dirname, "../dist/index.js");
const dirs: string[] = [];
const blockers: Server[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
  for (const b of blockers.splice(0)) await new Promise<void>((r) => b.close(() => r()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A port held by a real listener on 127.0.0.1, with the next few ports probed free. */
async function blockedPort(): Promise<number> {
  for (;;) {
    const b = createServer();
    await new Promise<void>((r) => b.listen(0, "127.0.0.1", () => r()));
    const port = (b.address() as { port: number }).port;
    if (port < 65_000) {
      blockers.push(b);
      return port;
    }
    await new Promise<void>((r) => b.close(() => r()));
  }
}

describe("serve takes the next free port (MD-N17-3)", () => {
  it("startDashboardServer binds the next free port when its port is taken, and returns the bound address", async () => {
    const port = await blockedPort();
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    const cards = new CardStore(db, log);
    const repo = mkdtempSync(join(tmpdir(), "sek-serve-port-"));
    dirs.push(repo);
    const server = await startDashboardServer({
      db,
      log,
      cardStore: cards,
      boardService: new BoardServiceImpl(cards),
      repoPath: repo,
      port,
    });
    try {
      expect(server.port).toBeGreaterThan(port);
      expect(server.port).toBeLessThan(port + 20);
      expect(server.address).toBe(`http://127.0.0.1:${server.port}`);
      const r = await fetch(`${server.address}/api/board`);
      expect(r.status).toBe(200);
    } finally {
      await server.close();
      db.close();
    }
  });

  it("refuses, naming the ports it tried, when every port in its range is taken", async () => {
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    const cards = new CardStore(db, log);
    const repo = mkdtempSync(join(tmpdir(), "sek-serve-port-"));
    dirs.push(repo);
    // A run of taken ports as long as the range serve tries.
    let first = 0;
    for (let attempt = 0; attempt < 20 && first === 0; attempt++) {
      const start = 20_000 + Math.floor(Math.random() * 40_000);
      const held: Server[] = [];
      try {
        for (let p = start; p < start + 10; p++) {
          const b = createServer();
          await new Promise<void>((ok, bad) => {
            b.once("error", bad);
            b.listen(p, "127.0.0.1", () => ok());
          });
          held.push(b);
        }
        first = start;
        blockers.push(...held);
      } catch {
        for (const b of held) await new Promise<void>((r) => b.close(() => r()));
      }
    }
    expect(first).toBeGreaterThan(0);
    const err = await startDashboardServer({
      db,
      log,
      cardStore: cards,
      boardService: new BoardServiceImpl(cards),
      repoPath: repo,
      port: first,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(
      new RegExp(`ports ${first} to ${first + 9} are all in use`),
    );
    db.close();
  });

  it("from the command line: `serve` with its port taken prints the address it bound, which answers", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sek-serve-cli-")));
    dirs.push(root);
    const home = join(root, "home");
    const ws = join(root, "alpha");
    mkdirSync(home);
    mkdirSync(join(ws, "src"), { recursive: true });
    const git = (...a: string[]) => execFileSync("git", a, { cwd: ws, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Jane Doe");
    git("config", "user.email", "jane@example.com");
    writeFileSync(join(ws, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(ws, ".gitignore"), ".sekhemet/*\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    const { db, log } = openLocalLedger(ws);
    await new CardStore(db, log).ensureProject({ rootPath: ws, name: "Alpha" });
    db.close();
    const port = await blockedPort();
    const child = spawn(process.execPath, [BIN, "serve", "--port", String(port)], {
      cwd: ws,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        SEKHEMET_CONFIG_DIR: join(home, ".sekhemet"),
        SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml",
        SEKHEMET_KEYCHAIN: "off",
        SEKHEMET_MODEL_LOADS: "off",
        BROWSER: "false",
      },
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    const address = await new Promise<string>((ok, bad) => {
      const timer = setTimeout(() => bad(new Error(`no address: ${stdout}\n${stderr}`)), 30_000);
      child.stdout.on("data", (d) => {
        stdout += String(d);
        const m = /running at:\s+(http:\/\/127\.0\.0\.1:(\d+))/.exec(stdout);
        if (m) {
          clearTimeout(timer);
          ok(m[1] as string);
        }
      });
      child.once("exit", (code) => bad(new Error(`serve exited ${code}: ${stdout}\n${stderr}`)));
    });
    expect(stderr).not.toMatch(/EADDRINUSE/);
    expect(address).not.toBe(`http://127.0.0.1:${port}`);
    expect(Number(address.split(":").at(-1))).toBeGreaterThan(port);
    expect((await fetch(`${address}/api/board`)).status).toBe(200);
  }, 60_000);
});
