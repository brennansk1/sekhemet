import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CardStore } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { runExitCode } from "../src/cli_commands.js";
import { openLocalLedger } from "../src/ledger_cmds.js";
import {
  BIN,
  SCRIPTED_WORKER,
  VERSION,
  cardInReview,
  sandboxDirs,
  scriptedWorkerProject,
  sekhemet,
} from "./cli_fixture.js";

/**
 * surface S10 — a command line scripts can trust. Tested by spawning the built
 * binary (`apps/harness/dist/index.js`), not by calling functions.
 */
describe("S10: a command line scripts can trust", () => {
  it("SUR-13: --version and -v print the version, write no file, start no server, exit 0", () => {
    for (const flag of ["--version", "-v"]) {
      const where = sandboxDirs();
      const r = sekhemet([flag], where);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(VERSION);
      expect(readdirSync(where.cwd)).toEqual([]);
      expect(readdirSync(where.home)).toEqual([]);
    }
  });

  it("SUR-14: an uncaught error is printed and exits 1", () => {
    const where = sandboxDirs();
    // A project whose ledger is no database: it cannot be opened. (A folder
    // that is no project is refused with exit 2 before anything opens,
    // FINDINGS_C1 CLI-05, so the error must come from a project.)
    const project = join(where.cwd, "project");
    mkdirSync(join(project, ".sekhemet"), { recursive: true });
    writeFileSync(join(project, ".sekhemet", "events.db"), "not a database\n");
    const r = sekhemet(["dev", "log", "--repo", project], where);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^sekhemet stopped: file is not a database/);
    // SUR-57: one plain line naming the report; the stack only in the report.
    const report = expectOneLineWithReport(r.stderr, where.home);
    expect(readFileSync(report, "utf8")).toMatch(/\n\s+at /);
    // `--debug` is not an unknown flag: it prints the details here too.
    const debug = sekhemet(["dev", "log", "--repo", project, "--debug"], where);
    expect(debug.status, debug.stderr).toBe(1);
    expect(debug.stderr).toMatch(/^sekhemet stopped: /);
    expect(debug.stderr).toMatch(/\n\s+at /);
  });

  it("SUR-15: an unknown flag is named and exits 2, writing nothing", () => {
    const where = sandboxDirs();
    const r = sekhemet(["doctor", "--no-such-flag"], where);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--no-such-flag");
    expect(readdirSync(where.cwd)).toEqual([]);
    const eq = sekhemet(["board", "--terminl=1"], where);
    expect(eq.status).toBe(2);
    expect(eq.stderr).toContain("--terminl");
  });

  it("SUR-16: run exits 1 when the card ends parked or failed, 0 in Review or Done", () => {
    expect(runExitCode("review")).toBe(0);
    expect(runExitCode("done")).toBe(0);
    expect(runExitCode("parked")).toBe(1);
    expect(runExitCode("ready")).toBe(1);
    expect(runExitCode("in_progress")).toBe(1);
  });

  it("SUR-16, spawned: a scripted Worker that finishes the card exits 0 in Review; one that does nothing exits 1", async () => {
    for (const mode of ["finish", "stall"] as const) {
      const where = sandboxDirs();
      const env = await scriptedWorkerProject(where);
      const r = spawnSync(
        process.execPath,
        ["--import", env.preload, BIN, "run", "c1", "--worker", SCRIPTED_WORKER],
        {
          cwd: where.cwd,
          encoding: "utf8",
          timeout: 120_000,
          env: { ...env.vars, SCRIPTED_WORKER_MODE: mode },
        },
      );
      const { db, log } = openLocalLedger(where.cwd);
      const status = (await new CardStore(db, log).getCard("c1"))?.status;
      db.close();
      if (mode === "finish") {
        expect(status, r.stdout + r.stderr).toBe("review");
        expect(r.stdout).toMatch(/turn: write_file, finish_card/);
        expect(r.status, r.stdout + r.stderr).toBe(0);
      } else {
        // The Worker was reached and ran out of turns; nothing refused it.
        expect(r.stdout).toMatch(/turn: \(no tool calls\)/);
        expect(r.stdout).toMatch(/Issue c1 stopped: /);
        expect(status).not.toBe("review");
        expect(status).not.toBe("done");
        expect(r.status, r.stdout + r.stderr).toBe(1);
      }
    }
  }, 300_000);

  it("RUN-9: `run` makes the supervisor's start-up pass under its lease, sweeping a crashed attempt back to Ready", async () => {
    const where = sandboxDirs();
    const env = await scriptedWorkerProject(where);
    {
      const { db, log } = openLocalLedger(where.cwd);
      const store = new CardStore(db, log);
      await store.createCard({
        id: "c2",
        tier: "story",
        title: "Crashed",
        scopeFiles: ["src/a.ts"],
      });
      await store.updateCardStatus("c2", "in_progress", "a runner was killed", "harness", {
        override: true,
      });
      await store.runs.startAttempt({ cardId: "c2", attemptNumber: 1, modelId: "m" });
      db.close();
    }
    const r = spawnSync(
      process.execPath,
      ["--import", env.preload, BIN, "run", "c1", "--worker", SCRIPTED_WORKER],
      {
        cwd: where.cwd,
        encoding: "utf8",
        timeout: 120_000,
        env: { ...env.vars, SCRIPTED_WORKER_MODE: "finish" },
      },
    );
    expect(r.stdout, r.stderr).toMatch(/Crashed attempt of c2 .* swept: back to Ready/);
    const { db, log } = openLocalLedger(where.cwd);
    try {
      expect((await new CardStore(db, log).getCard("c2"))?.status).toBe("ready");
    } finally {
      db.close();
    }
  }, 300_000);
});

/**
 * The one line an unexpected error leaves on stderr (SUR-57): it starts with
 * `sekhemet stopped:`, holds no stack frame, no `undefined` and no secret,
 * and names a report under the user directory's `logs/`, readable only by
 * its owner. Returns the report's path.
 */
function expectOneLineWithReport(stderr: string, home: string): string {
  const lines = stderr.split("\n").filter((l) => l.trim() !== "");
  expect(lines, stderr).toHaveLength(1);
  const line = lines[0] as string;
  expect(line).toMatch(/^sekhemet stopped: /);
  expect(line).not.toMatch(/\bundefined\b|\bNaN\b/);
  expect(line).not.toContain(SECRET);
  const path = /details are in (\S+);/.exec(line)?.[1];
  expect(path, line).toBeDefined();
  expect(path?.startsWith(join(home, ".sekhemet", "logs"))).toBe(true);
  expect(statSync(path as string).mode & 0o777).toBe(0o600);
  expect(readFileSync(path as string, "utf8")).not.toContain(SECRET);
  return path as string;
}

/** A seeded fake GitHub token (the shape `redaction.spec.ts` seeds). */
const SECRET = `ghp_${"Z9y8X7w6V5u4T3s2R1q0".repeat(2).slice(0, 36)}`;

/**
 * A fault injected into the real binary with `node --import` (fault
 * injection, FINISH_LINE_PLAN C.6): once the entry has installed its
 * process-level handlers (or after 5 s, so an entry without them fails the
 * test rather than hanging it) — and, with FAULT_AFTER=listening, once a
 * server listens, or with FAULT_AFTER=gate, once the run's gate command runs
 * as a tracked process group — it fails as FAULT_MODE says: an unhandled
 * rejection, a rejection with no reason, or an uncaught exception. For the
 * gate it also records, as the process exits, whether the gate had exited.
 */
const FAULT = `
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const mode = process.env.FAULT_MODE;
const after = process.env.FAULT_AFTER ?? "handlers";
const message = process.env.FAULT_MESSAGE ?? "an injected fault";
const started = Date.now();
function gatePid() {
  let names = [];
  try { names = readdirSync(join(process.cwd(), ".sekhemet", "processes")); } catch { return undefined; }
  for (const name of names) {
    const pid = Number(name.replace(/\\.json$/, ""));
    try {
      const cmd = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
      if (cmd.includes("FAULT_GATE")) return pid;
    } catch {}
  }
  return undefined;
}
let found;
// Registered before the harness's own exit handlers: it sees the gate as the
// SIGTERM and its grace left it, before the exit's SIGKILL.
process.on("exit", () => {
  if (found === undefined) return;
  let stat = "";
  try { stat = execFileSync("ps", ["-o", "stat=", "-p", String(found)], { encoding: "utf8" }).trim(); } catch {}
  writeFileSync(join(process.env.HOME, "gate.at-exit"), stat || "gone");
});
function ready() {
  if (process.listenerCount("unhandledRejection") === 0 && Date.now() - started < 5000) return false;
  if (after === "listening") return process.getActiveResourcesInfo().includes("TCPServerWrap");
  if (after === "gate") {
    const pid = gatePid();
    if (pid === undefined) return false;
    found = pid;
    writeFileSync(join(process.env.HOME, "gate.pid"), String(pid));
    return true;
  }
  return true;
}
const tick = setInterval(() => {
  if (!ready()) return;
  clearInterval(tick);
  if (mode === "reject") Promise.reject(new Error(message));
  else if (mode === "reject-nothing") Promise.reject(undefined);
  else setTimeout(() => { throw new Error(message); }, 0);
}, 20);
`;

function faultPreload(home: string): string {
  const path = join(home, "fault.mjs");
  writeFileSync(path, FAULT);
  return path;
}

describe("SUR-57, RUN-8b: an error nothing handled stops the process plainly", () => {
  function faulted(
    args: string[],
    where: { cwd: string; home: string },
    fault: Record<string, string>,
  ) {
    return spawnSync(process.execPath, ["--import", faultPreload(where.home), BIN, ...args], {
      cwd: where.cwd,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: where.home,
        SEKHEMET_CONFIG_DIR: join(where.home, ".sekhemet"),
        SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml",
        BROWSER: "false",
        FAULT_MESSAGE: `the vault answered with ${SECRET}`,
        ...fault,
      },
    });
  }

  it("an unhandled rejection in a command: one plain line, a redacted report, exit 1", () => {
    const where = sandboxDirs();
    const r = faulted(["help"], where, { FAULT_MODE: "reject" });
    expect(r.status, r.stderr).toBe(1);
    const report = expectOneLineWithReport(r.stderr, where.home);
    expect(r.stderr).toContain("the vault answered with");
    const text = readFileSync(report, "utf8");
    expect(text).toContain("the vault answered with");
    expect(text).toMatch(/\n\s+at /);
    expect(text).toMatch(/unhandled promise rejection/);
  });

  it("W1 review G4: with a user directory that cannot be used, the one line still prints", () => {
    // SEKHEMET_CONFIG_DIR inside a repository is refused (models_dir.ts), so
    // the report has nowhere to go; the person must still read what stopped.
    const where = sandboxDirs();
    mkdirSync(join(where.cwd, ".git"));
    for (const mode of ["reject", "throw"]) {
      const r = spawnSync(process.execPath, ["--import", faultPreload(where.home), BIN, "help"], {
        cwd: where.cwd,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: where.home,
          SEKHEMET_CONFIG_DIR: join(where.cwd, "cfg"),
          SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml",
          BROWSER: "false",
          FAULT_MESSAGE: `the vault answered with ${SECRET}`,
          FAULT_MODE: mode,
        },
      });
      expect(r.status, `${mode}: ${r.stderr}`).toBe(1);
      const lines = r.stderr.split("\n").filter((l) => l.trim() !== "");
      expect(lines.length, r.stderr).toBeGreaterThanOrEqual(1);
      const line = lines.at(-1) as string;
      expect(line).toMatch(/^sekhemet stopped: /);
      expect(r.stderr).not.toContain(SECRET);
      // No report was written into the refused directory.
      expect(existsSync(join(where.cwd, "cfg", "logs"))).toBe(false);
    }
  });

  it("--debug prints the redacted details on the terminal as well", () => {
    const where = sandboxDirs();
    const r = faulted(["help", "--debug"], where, { FAULT_MODE: "reject" });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(/^sekhemet stopped: /);
    expect(r.stderr).toMatch(/\n\s+at /);
    expect(r.stderr).not.toContain(SECRET);
  });

  it("an uncaught exception, and a rejection with no reason, each exit 1 with one plain line", () => {
    for (const mode of ["throw", "reject-nothing"]) {
      const where = sandboxDirs();
      const r = faulted(["help"], where, { FAULT_MODE: mode });
      expect(r.status, `${mode}: ${r.stderr}`).toBe(1);
      expectOneLineWithReport(r.stderr, where.home);
    }
  });

  it("the dashboard server stops with one plain line and exit 1", () => {
    const where = sandboxDirs();
    const r = faulted(["serve", "--port", "0", "--repo", where.cwd], where, {
      FAULT_MODE: "reject",
      FAULT_AFTER: "listening",
    });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/Dashboard running at/);
    expectOneLineWithReport(r.stderr, where.home);
  });

  it("RUN-8b: a run's gate gets SIGTERM, is gone after, and the lease is released", async () => {
    const where = sandboxDirs();
    // A gate that runs until it is stopped, and stops at once on SIGTERM.
    const gate = `process.on('SIGTERM', () => process.exit(0)); void 'FAULT_GATE'; setInterval(() => {}, 1000);`;
    const env = await scriptedWorkerProject(where, ["-e", gate]);
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        env.preload,
        "--import",
        faultPreload(where.home),
        BIN,
        "run",
        "c1",
        "--worker",
        SCRIPTED_WORKER,
      ],
      {
        cwd: where.cwd,
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...env.vars,
          SCRIPTED_WORKER_MODE: "finish",
          FAULT_MODE: "reject",
          FAULT_AFTER: "gate",
          FAULT_MESSAGE: `the vault answered with ${SECRET}`,
        },
      },
    );
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expectOneLineWithReport(r.stderr, where.home);
    const pid = Number(readFileSync(join(where.home, "gate.pid"), "utf8"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 40 && alive(); i++) await new Promise((res) => setTimeout(res, 50));
    expect(alive()).toBe(false);
    // It was asked to stop before it was killed: when the exit handlers began
    // (which SIGKILL what is left), it had already exited on SIGTERM.
    expect(readFileSync(join(where.home, "gate.at-exit"), "utf8")).toMatch(/^(Z|gone)/);
    expect(existsSync(join(where.cwd, ".sekhemet", "runner.lock"))).toBe(false);
    expect(existsSync(join(where.cwd, ".sekhemet", "processes", `${pid}.json`))).toBe(false);
  }, 180_000);
});

describe("NEW-surface-5: one recorded run profile, from the command line", () => {
  it("SUR-44, SUR-45: a queue whose flags cannot resolve to one profile does not start, exit 2", () => {
    const where = sandboxDirs();
    spawnSync("git", ["init", "-q"], { cwd: where.cwd });
    const r = sekhemet(["queue", "--repo", where.cwd, "--profile", "full"], where);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--profile/);
    expect(r.stdout).not.toMatch(/Profile full/);
  });
});

describe("SUR-53: who may accept, from the command line", () => {
  it("with exactly one Accept-holder, accepts that person's own delegated card and exits 0", async () => {
    const where = sandboxDirs();
    await cardInReview(where, "c1");
    const r = sekhemet(["accept", "c1"], where);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Accepted c1/);
    const { db, log } = openLocalLedger(where.cwd);
    try {
      const store = new CardStore(db, log);
      expect((await store.getCard("c1"))?.status).toBe("done");
      const [accepted] = await store.cardEvents("c1", ["card/accepted"]);
      expect(accepted?.payload).toMatchObject({ independent: false });
    } finally {
      db.close();
    }
  });
});
