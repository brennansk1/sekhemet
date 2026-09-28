import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MemoryWatchdog } from "@sekhemet/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureRepoProject } from "../src/execute.js";
import { initLocalKernel, main } from "../src/index.js";
import { runOvernight } from "../src/overnight.js";
import {
  MACHINE_EVENTS,
  mayStartCard,
  releaseMachine,
  reservationNow,
  reserveMachine,
} from "../src/reservation.js";

/**
 * The unattended hours keep their promises (runtime.md items 9, 17, 17a, 20,
 * 22): NEW-runtime-2's RUN-8, NEW-runtime-3's RUN-11, NEW-runtime-5 and
 * NEW-runtime-10. Real processes, real SQLite files.
 */
const DIST = resolve(import.meta.dirname, "../dist");
const SANDBOX_DIST = resolve(import.meta.dirname, "../../../packages/sandbox/dist/index.js");
const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
  for (const c of children.splice(0)) c.kill("SIGKILL");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(prefix = "night-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  mkdirSync(join(dir, ".sekhemet"), { recursive: true });
  return dir;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function pidFrom(path: string): Promise<number> {
  await waitFor(() => existsSync(path) && readFileSync(path, "utf8").trim() !== "");
  return Number(readFileSync(path, "utf8").trim());
}

function fileLedger(dir: string) {
  const db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  return { db, log, cards: new CardStore(db, log) };
}

describe("NEW-runtime-2: the harness cleans up before it exits", () => {
  it("RUN-8: SIGTERM while holding the lease releases it and kills the children first", async () => {
    const dir = scratch();
    const pidFile = join(dir, "cmd.pid");
    const ready = join(dir, "ready");
    const script = join(dir, "runner.mjs");
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";
       import { acquireRunnerLease } from ${JSON.stringify(join(DIST, "runner_lease.js"))};
       import { ProcessSandbox } from ${JSON.stringify(SANDBOX_DIST)};
       const got = acquireRunnerLease(${JSON.stringify(dir)}, { kind: "queue" });
       if ("holder" in got) process.exit(3);
       const s = new ProcessSandbox({ disableConfinement: true, requireConfinement: false });
       void s.execute("sh", ["-c", "echo $$ > ${pidFile}; sleep 60"], { cwd: ${JSON.stringify(dir)}, timeoutMs: 60000, allowedPaths: [], allowNetwork: false });
       writeFileSync(${JSON.stringify(ready)}, "");
       setInterval(() => {}, 1000);`,
    );
    const runner = spawn(process.execPath, [script], { stdio: "ignore" });
    children.push(runner);
    const cmd = await pidFrom(pidFile);
    await waitFor(() => existsSync(ready));
    expect(existsSync(join(dir, ".sekhemet", "runner.lock"))).toBe(true);
    runner.kill("SIGTERM");
    const code = await new Promise<number | null>((r) => runner.once("exit", (c) => r(c)));
    expect(code).toBe(143);
    expect(existsSync(join(dir, ".sekhemet", "runner.lock"))).toBe(false);
    await waitFor(() => !alive(cmd), 3_000);
  }, 30_000);
});

describe("NEW-runtime-3: bounded rounds", () => {
  it("RUN-11: a round past its wall-clock limit has its whole tree killed, counts one failure, and the night goes on", async () => {
    const dir = scratch();
    const { db, log, cards } = fileLedger(dir);
    await cards.createCard({ id: "c0", tier: "task", title: "a", status: "ready" });
    // A queue round that hangs, with a grandchild of its own.
    const fakeCli = join(dir, "fake-cli.mjs");
    const pids = join(dir, "pids");
    writeFileSync(
      fakeCli,
      `import { spawn } from "node:child_process";
       import { appendFileSync } from "node:fs";
       const g = spawn("sleep", ["60"], { stdio: "ignore" });
       appendFileSync(${JSON.stringify(pids)}, g.pid + "\\n");
       setInterval(() => {}, 1000);`,
    );
    const prior = process.env.SEKHEMET_CLI;
    process.env.SEKHEMET_CLI = fakeCli;
    const lines: string[] = [];
    try {
      const s = await runOvernight({
        repoPath: dir,
        log,
        cardStore: cards,
        hours: "none",
        limits: { kwhPerDay: 0, maxConsecutiveFailures: 2 },
        queueArgs: [],
        say: (l) => lines.push(l),
        roundLimitMs: 700,
        maxRounds: 3,
        skipMutation: true,
        vulnScan: async () => ({ passed: true, skipped: "test" }),
      });
      expect(s.rounds).toBe(2);
      expect(s.stoppedBecause).toMatch(/^failures breaker/);
    } finally {
      if (prior === undefined) {
        // biome-ignore lint/performance/noDelete: removing an env var is the point
        delete process.env.SEKHEMET_CLI;
      } else process.env.SEKHEMET_CLI = prior;
    }
    expect(lines.filter((l) => /exceeded its wall-clock limit/.test(l))).toHaveLength(2);
    const grandchildren = readFileSync(pids, "utf8").trim().split("\n").map(Number);
    expect(grandchildren).toHaveLength(2);
    await waitFor(() => grandchildren.every((p) => !alive(p)), 3_000);
    db.close();
  }, 30_000);
});

describe("NEW-runtime-5: the night does what it promises", () => {
  it("RUN-58: a reservation is a ledger event read after a restart; overnight starts nothing until it is released", async () => {
    const dir = scratch();
    const first = fileLedger(dir);
    const person = first.log.localPrincipal();
    expect(await reserveMachine(first.log, { principal: person })).toBe(true);
    // Already reserved: nothing appended.
    expect(await reserveMachine(first.log, { principal: person })).toBe(false);
    first.db.close();

    // A restart: a new process reads the reservation from the ledger alone.
    const { db, log, cards } = fileLedger(dir);
    expect((await reservationNow(log)).reserved).toBe(true);
    await cards.createCard({ id: "c0", tier: "task", title: "a", status: "ready" });
    const events: string[] = [];
    let waits = 0;
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
      sleep: async () => {
        waits++;
        if (waits === 2) {
          events.push("released");
          expect(await releaseMachine(log, { principal: person })).toBe(true);
        }
      },
      runQueue: async () => {
        events.push("queue");
        for (const to of ["in_progress", "verify", "review"] as const)
          await cards.updateCardStatus("c0", to, "passed");
        return 0;
      },
    });
    expect(events).toEqual(["released", "queue"]);
    expect(s.rounds).toBe(1);
    // Free already: a second release appends nothing.
    expect(await releaseMachine(log, { principal: person })).toBe(false);
    const recorded = await log.getEventsByTypes([MACHINE_EVENTS.reserved, MACHINE_EVENTS.released]);
    expect(recorded.map((e) => [e.type, (e.payload as { principal: string }).principal])).toEqual([
      [MACHINE_EVENTS.reserved, person],
      [MACHINE_EVENTS.released, person],
    ]);
    db.close();
  });

  it("RUN-58: a reservation with `until` ends at that time; `sekhemet dev reserve` records it", async () => {
    const dir = scratch();
    execFileSync("git", ["init", "-q"], { cwd: dir });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["dev", "reserve", "--until", "23:59", "--repo", dir]);
    vi.restoreAllMocks();
    const k = initLocalKernel(dir);
    const now = await reservationNow(k.log);
    expect(now.reserved).toBe(true);
    expect(now.until).toBeDefined();
    const later = new Date(Date.parse(now.until as string) + 1000);
    expect((await reservationNow(k.log, later)).reserved).toBe(false);
    k.db.close();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["dev", "reserve", "--release", "--repo", dir]);
    vi.restoreAllMocks();
    const again = initLocalKernel(dir);
    expect((await reservationNow(again.log)).reserved).toBe(false);
    again.db.close();
  });

  it("RUN-17: after its rounds an overnight run runs the offline vulnerability scan and records the result", async () => {
    const dir = scratch();
    const { db, log, cards } = fileLedger(dir);
    const s = await runOvernight({
      repoPath: dir,
      log,
      cardStore: cards,
      hours: "none",
      limits: { kwhPerDay: 0, maxConsecutiveFailures: 3 },
      queueArgs: [],
      say: () => {},
      skipMutation: true,
      runQueue: async () => 0,
    });
    expect(s.stoppedBecause).toBe("no Ready issues left");
    const [scan] = await log.getEventsByTypes(["security/vulnerability_scan"]);
    expect(scan?.actor).toBe("harness");
    // No lockfile here: the scan records that it had nothing to scan, never a pass.
    expect(scan?.payload).toMatchObject({ scanner: "osv-scanner", offline: true });
    expect((scan?.payload as { skipped?: string }).skipped).toMatch(/lockfile|not installed/);
    db.close();
  });

  it("RUN-18: while the watchdog requests stopNewWorktrees, no new card starts", async () => {
    const dir = scratch();
    const { db, cards } = fileLedger(dir);
    const card = await cards.createCard({ id: "c0", tier: "task", title: "a", status: "ready" });
    let swap = 0;
    const watchdog = new MemoryWatchdog({
      readSample: () => ({
        kernelLevel: 1,
        swapUsedBytes: swap,
        freeBytes: 8 * 1024 ** 3,
        totalBytes: 24 * 1024 ** 3,
      }),
    });
    watchdog.sample();
    expect(await mayStartCard({ cardStore: cards, watchdog }, card)).toBeUndefined();
    swap = 0.6 * 1024 ** 3;
    watchdog.sample();
    expect(watchdog.isActive("stopNewWorktrees")).toBe(true);
    expect(await mayStartCard({ cardStore: cards, watchdog }, card)).toMatch(/memory watchdog/);
    db.close();
  });
});

describe("NEW-runtime-10: pause a project", () => {
  it("RUN-48: a paused project starts no new card until resumed, and both are recorded with the person", async () => {
    const dir = scratch();
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const k = initLocalKernel(dir);
    const project = await ensureRepoProject(k.cardStore, dir);
    if (!project) throw new Error("no project");
    const card = await k.cardStore.createCard({
      id: "c0",
      tier: "task",
      title: "a",
      status: "ready",
    });
    const person = k.cardStore.localPrincipal();
    k.db.close();
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    await main(["dev", "pause", project.id, "--repo", dir]);
    vi.restoreAllMocks();
    expect(out.join("\n")).toContain("paused");

    const paused = initLocalKernel(dir);
    expect(await mayStartCard({ cardStore: paused.cardStore }, card)).toMatch(/is paused/);
    // The queue starts no card of it.
    const queued: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      queued.push(a.join(" "));
    });
    paused.db.close();
    await main(["queue", "--repo", dir]);
    vi.restoreAllMocks();
    expect(queued.join("\n")).toMatch(/is paused/);

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["dev", "resume", project.name, "--repo", dir]);
    vi.restoreAllMocks();
    const resumed = initLocalKernel(dir);
    expect(await mayStartCard({ cardStore: resumed.cardStore }, card)).toBeUndefined();
    const changes = (await resumed.log.getEventsByTypes(["project/updated"])).filter(
      (e) => (e.payload as { id: string }).id === project.id,
    );
    expect(
      changes.map((e) => [(e.payload as { status: string }).status, e.principal, e.actor]),
    ).toEqual([
      ["paused", person, "human"],
      ["active", person, "human"],
    ]);
    resumed.db.close();
  });
});
