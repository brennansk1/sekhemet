import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listBackupSets } from "../src/backup_sets.js";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { automaticBackup, describeSupervisorStart, supervisorStart } from "../src/supervisor.js";

// Runtime item 35a, RUN-59 (NEW-runtime-11): the automatic backup's
// triggers — the supervisor's start of a `queue` or `overnight`, the end of
// an `overnight`, and `serve`'s start — each writing a set the first time in
// a calendar day. Real ledgers, a real CLI process for `serve`.

const BIN = resolve(import.meta.dirname, "../dist/index.js");
const dirs: string[] = [];
const children: ChildProcess[] = [];
let home: string;
const saved = process.env.SEKHEMET_CONFIG_DIR;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "sek-trig-home-")));
  dirs.push(home);
  process.env.SEKHEMET_CONFIG_DIR = join(home, ".sekhemet");
});
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
  if (saved === undefined) Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
  else process.env.SEKHEMET_CONFIG_DIR = saved;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "sek-trig-ws-")));
  dirs.push(ws);
  mkdirSync(join(ws, "src"));
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
  return ws;
}

describe("RUN-59: the automatic backup's triggers", () => {
  it("the supervisor's start writes the day's first set, and says so; the second start that day does not", async () => {
    const ws = await workspace();
    const { db, log } = openLocalLedger(ws);
    const cardStore = new CardStore(db, log);
    const boardService = new BoardServiceImpl(cardStore);
    const ctx = { repoPath: ws, cardStore, log, boardService };
    const first = await supervisorStart(ctx, { backup: { db } });
    expect(first.backup).toMatch(/^Backed up to /);
    expect(describeSupervisorStart(first)).toContain(first.backup);
    const id = log.workspaceId() as string;
    expect(listBackupSets(id)).toHaveLength(1);
    const second = await supervisorStart(ctx, { backup: { db } });
    expect(second.backup).toBeUndefined();
    expect(listBackupSets(id)).toHaveLength(1);
    // The end of an overnight always writes one.
    const end = await automaticBackup({ workspaceFolder: ws, db, log, kind: "overnight" });
    expect(end).toMatch(/^Backed up to /);
    // Retention keeps one set a day (RUN-60): the newest, the night's.
    expect(listBackupSets(id).map((s) => `Backed up to ${s.path}`)).toEqual([
      expect.stringMatching(new RegExp(`^${(end as string).split(" (entry")[0]}$`)),
    ]);
    db.close();
  });

  it("serve's start writes the day's set and prints the address it bound", async () => {
    const ws = await workspace();
    const child = spawn(process.execPath, [BIN, "serve", "--port", "0"], {
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
    const address = await new Promise<string>((ok, bad) => {
      const timer = setTimeout(() => bad(new Error(`no address: ${stdout}`)), 30_000);
      child.stdout?.on("data", (d) => {
        stdout += String(d);
        const m = /running at:\s+(http:\/\/127\.0\.0\.1:(\d+))/.exec(stdout);
        if (m && /Backed up to |Backup not written/.test(stdout)) {
          clearTimeout(timer);
          ok(m[1] as string);
        }
      });
      child.once("exit", (code) => bad(new Error(`serve exited ${code}: ${stdout}`)));
    });
    expect(Number(address.split(":").at(-1))).toBeGreaterThan(0);
    expect(stdout).toMatch(/Backed up to /);
    const backups = join(home, ".sekhemet", "backups");
    expect(existsSync(backups)).toBe(true);
    const [wsId] = readdirSync(backups).filter((n) => n.startsWith("ws_"));
    expect(
      readdirSync(join(backups, wsId as string)).some((n) => /^\d{4}-\d{2}-\d{2}/.test(n)),
    ).toBe(true);
  }, 60_000);
});
