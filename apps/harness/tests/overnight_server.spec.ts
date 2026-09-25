import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { nightModelServer, runOvernight } from "../src/overnight.js";

// runtime item 17, RUN-18a: between overnight rounds the model server stays
// up — each round attaches to the one the night started, never reloading the
// weights. The "server" is a real process; the rounds are the queue seam.

const dirs: string[] = [];
const procs: ChildProcess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const alive = (p: ChildProcess | undefined) => !!p && p.exitCode === null && p.signalCode === null;

describe("RUN-18a: one model server for the whole night", () => {
  it("starts the server once, every round runs against it, and the night releases it at the end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "night-server-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".sekhemet"), { recursive: true });
    const db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const cards = new CardStore(db, log);
    for (const id of ["c1", "c2", "c3"]) {
      await cards.createCard({ id, tier: "task", title: id, status: "ready" });
    }

    let server: ChildProcess | undefined;
    let loads = 0;
    let unloads = 0;
    const modelServer = {
      ensureRunning: async () => {
        if (alive(server)) return; // attach: no reload
        loads++;
        server = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: "ignore",
        });
        procs.push(server);
      },
      unload: async () => {
        unloads++;
        server?.kill("SIGTERM");
        await new Promise((r) => server?.once("exit", r));
      },
    };
    const seen: (number | undefined)[] = [];
    let round = 0;
    const s = await runOvernight({
      repoPath: dir,
      log,
      cardStore: cards,
      hours: "none",
      limits: { kwhPerDay: 0, maxConsecutiveFailures: 3 },
      queueArgs: [],
      say: () => {},
      skipMutation: true,
      vulnScan: async () => ({ passed: true, skipped: "test" }),
      modelServer,
      runQueue: async () => {
        // The round finds the night's server up, as a queue child would adopt it.
        expect(alive(server)).toBe(true);
        seen.push(server?.pid);
        const id = `c${++round}`;
        for (const to of ["in_progress", "verify", "review"] as const) {
          await cards.updateCardStatus(id, to, "passed");
        }
        return 0;
      },
    });
    db.close();
    expect(s.rounds).toBe(3);
    expect(loads).toBe(1);
    expect(new Set(seen).size).toBe(1);
    expect(seen).toHaveLength(3);
    expect(unloads).toBe(1);
    expect(alive(server)).toBe(false);
  });
  it("holds a Worker that runs its own server, and none that does not", async () => {
    expect(nightModelServer({ generate: async () => ({}) })).toBeUndefined();
    const calls: string[] = [];
    const managed = {
      ensureRunning: async () => void calls.push("ensure"),
      unload: async () => void calls.push("unload"),
    };
    const held = nightModelServer(managed);
    await held?.ensureRunning();
    await held?.unload?.();
    expect(calls).toEqual(["ensure", "unload"]);
  });
});
