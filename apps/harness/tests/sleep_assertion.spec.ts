import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { GOVERNANCE_EVENTS } from "../src/governance.js";
import { runOvernight } from "../src/overnight.js";
import { acquireRunnerLease } from "../src/runner_lease.js";
import {
  SLEEP_REPORT_THRESHOLD_MS,
  awakeReport,
  holdSleepAssertion,
  sleepAssertionCommand,
  sleptNote,
  startRunClock,
} from "../src/sleep_assertion.js";

// Runtime item 17b and 18, NEW-runtime-12 (RUN-65, RUN-66, RUN-67; FINDINGS
// REL-04): while a runner holds the lease the machine is kept awake with the
// operating system's own tool, released with the lease; a round whose wall
// clock ran ahead of its monotonic clock records that the machine slept, and
// only monotonic time is charged as energy. The clock and the spawner are
// injected for the unit parts; on macOS a real `caffeinate` is checked
// against a real lease holder, killed with SIGKILL too.

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sek-awake-"));
  dirs.push(d);
  return d;
}

/** The pids of live `caffeinate -i -w <pid>` processes (macOS). */
function caffeinatesFor(pid: number): number[] {
  try {
    return execFileSync("pgrep", ["-f", `caffeinate -i -w ${pid}$`], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

async function until(check: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

describe("the sleep assertion (RUN-65, RUN-66)", () => {
  it("is caffeinate -i -w <pid> on macOS and systemd-inhibit around tail --pid on Linux", () => {
    expect(sleepAssertionCommand("darwin", 4242, "queue")).toEqual({
      tool: "caffeinate",
      args: ["-i", "-w", "4242"],
    });
    expect(sleepAssertionCommand("linux", 4242, "queue TS-1")).toEqual({
      tool: "systemd-inhibit",
      args: [
        "--what=idle:sleep",
        "--who=Sekhemet",
        "--why=queue TS-1",
        "--mode=block",
        "tail",
        "--pid=4242",
        "-f",
        "/dev/null",
      ],
    });
    expect(sleepAssertionCommand("win32", 4242, "queue")).toBeUndefined();
  });

  it("spawns the tool for this process and kills it on release (an injected spawner)", () => {
    const spawned: { cmd: string; args: string[]; killed: boolean }[] = [];
    const awake = holdSleepAssertion({
      platform: "darwin",
      pid: 99,
      why: "run TS-1",
      findTool: () => "/usr/bin/caffeinate",
      spawn: (cmd, args) => {
        const s = { cmd, args, killed: false };
        spawned.push(s);
        return {
          kill: () => {
            s.killed = true;
          },
          on: () => {},
          unref: () => {},
        };
      },
    });
    expect(awake.held).toBe(true);
    expect(awake.tool).toBe("caffeinate");
    expect(spawned).toEqual([
      { cmd: "/usr/bin/caffeinate", args: ["-i", "-w", "99"], killed: false },
    ]);
    awake.release();
    awake.release();
    expect(spawned[0]?.killed).toBe(true);
  });

  // C4 review, proved in the Lima VM: in a headless session polkit refuses
  // `systemd-inhibit` ("Failed to inhibit: Access denied") and it exits at
  // once, yet the assertion stayed `held` and the report said "kept awake".
  // A real process that exits non-zero at once stands in for it here; the
  // real tool is run in the VM (runtime.md's row).
  it("RUN-66: a tool that exits at once — refused its inhibitor — is not held, and the report says so", async () => {
    const awake = holdSleepAssertion({
      platform: "linux",
      pid: 99,
      findTool: () => "/usr/bin/systemd-inhibit",
      spawn: () => {
        const c = spawn(
          process.execPath,
          ["-e", 'process.stderr.write("Failed to inhibit: Access denied\\n"); process.exit(1)'],
          { stdio: "ignore" },
        );
        children.push(c);
        return c;
      },
    });
    await awake.settled;
    expect(awake.held).toBe(false);
    expect(awake.note).toMatch(/systemd-inhibit ended at once \(exit 1\)/);
    expect(awakeReport(awake)).not.toMatch(/kept awake/);
    awake.release();
  });

  it("RUN-65: a tool still running after the settle is held, and its release does not unhold it as a failure", async () => {
    let child: ChildProcess | undefined;
    const awake = holdSleepAssertion({
      platform: "linux",
      pid: 99,
      findTool: () => "/usr/bin/systemd-inhibit",
      spawn: () => {
        child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        children.push(child);
        return child;
      },
    });
    await awake.settled;
    expect(awake.held).toBe(true);
    expect(awakeReport(awake)).toBe("kept awake by systemd-inhibit");
    awake.release();
    await new Promise((r) => child?.once("exit", r));
    expect(awake.note).toBeUndefined();
  });

  it("RUN-66: says, once, that no tool exists, and spawns nothing", () => {
    let spawned = 0;
    const awake = holdSleepAssertion({
      platform: "linux",
      pid: 99,
      findTool: () => undefined,
      spawn: () => {
        spawned++;
        throw new Error("not reached");
      },
    });
    expect(awake.held).toBe(false);
    expect(awake.note).toMatch(/systemd-inhibit is not installed/);
    expect(awake.note).toMatch(/may sleep/);
    expect(spawned).toBe(0);
    expect(() => awake.release()).not.toThrow();
  });

  it.runIf(process.platform === "darwin")(
    "RUN-65: a real lease holds caffeinate for its own pid, and releasing the lease ends it",
    async () => {
      const repo = tempDir();
      const got = acquireRunnerLease(repo, { kind: "queue" });
      if ("holder" in got) throw new Error("lease held");
      expect(got.awake.held).toBe(true);
      expect(await until(() => caffeinatesFor(process.pid).length === 1)).toBe(true);
      got.release();
      expect(await until(() => caffeinatesFor(process.pid).length === 0)).toBe(true);
    },
  );

  it.runIf(process.platform === "darwin")(
    "RUN-65: a lease holder killed with SIGKILL leaves no assertion behind",
    async () => {
      const repo = tempDir();
      const lease = resolve(import.meta.dirname, "../dist/runner_lease.js");
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const { acquireRunnerLease } = await import(${JSON.stringify(lease)});
           const got = acquireRunnerLease(${JSON.stringify(repo)}, { kind: "queue" });
           console.log(got.awake?.held ? "held" : "not held");
           setInterval(() => {}, 1000);`,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      children.push(child);
      const said = await new Promise<string>((ok) =>
        child.stdout?.once("data", (d) => ok(String(d))),
      );
      expect(said.trim()).toBe("held");
      const pid = child.pid as number;
      expect(await until(() => caffeinatesFor(pid).length === 1)).toBe(true);
      child.kill("SIGKILL");
      expect(await until(() => caffeinatesFor(pid).length === 0)).toBe(true);
    },
  );
});

describe("sleep is detected and never charged (RUN-67)", () => {
  it("a round whose wall clock ran more than 60 s ahead of its monotonic clock slept", () => {
    let wall = 1_000_000;
    let mono = 5_000_000_000n;
    const clock = startRunClock({ now: () => wall, hrtime: () => mono });
    wall += 30 * 60_000;
    mono += BigInt(5 * 60_000) * 1_000_000n;
    expect(clock.monotonicMs()).toBe(5 * 60_000);
    expect(clock.wallMs()).toBe(30 * 60_000);
    expect(clock.sleptMs()).toBe(25 * 60_000);
    expect(sleptNote(clock.sleptMs())).toBe("the machine slept 25 min");
    // Within the threshold: no note.
    expect(SLEEP_REPORT_THRESHOLD_MS).toBe(60_000);
    expect(sleptNote(59_000)).toBeUndefined();
  });

  it("overnight charges each round's monotonic time to the energy budget and says the machine slept", async () => {
    const repo = tempDir();
    const db = new DatabaseSync(join(repo, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const cardStore = new CardStore(db, log);
    await cardStore.createCard({ id: "card_night", tier: "task", title: "x", status: "ready" });
    let wall = Date.parse("2026-10-05T23:00:00");
    let mono = 1n;
    const said: string[] = [];
    await runOvernight({
      repoPath: repo,
      log,
      cardStore,
      hours: "none",
      limits: { kwhPerDay: 0, maxConsecutiveFailures: 3 },
      queueArgs: [],
      maxRounds: 1,
      skipMutation: true,
      say: (l) => said.push(l),
      now: () => new Date(wall),
      clock: { now: () => wall, hrtime: () => mono },
      // One round: 10 min of work, then the lid closed for 40 min.
      runQueue: async () => {
        wall += 50 * 60_000;
        mono += BigInt(10 * 60_000) * 1_000_000n;
        return 0;
      },
      vulnScan: async () => ({ passed: false, skipped: "test" }),
    });
    const usage = (await log.getEventsByTypes([GOVERNANCE_EVENTS.usage])).map(
      (e) => e.payload as { durationMs: number; sleptMs?: number },
    );
    expect(usage).toHaveLength(1);
    expect(usage[0]?.durationMs).toBe(10 * 60_000);
    expect(usage[0]?.sleptMs).toBe(40 * 60_000);
    expect(said.join("\n")).toMatch(
      /Round 1: the machine slept 40 min; only the 10 min of work counts toward today's energy/,
    );
    db.close();
  });
});
