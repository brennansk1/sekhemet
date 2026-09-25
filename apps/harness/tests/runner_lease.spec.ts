import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonStop, processStartTime } from "../src/daemon.js";
import { initLocalKernel, main } from "../src/index.js";
import { acquireRunnerLease, holdRunnerLease, runnerLease } from "../src/runner_lease.js";
import { startDashboardServer } from "../src/server.js";

/**
 * NEW-runtime-1 (runtime.md items 3, 5, 6): one runner at a time, taken by
 * exclusive creation, recovered after a SIGKILL, and a daemon stop that never
 * signals a recycled pid. Real files, real processes.
 */
const DIST = resolve(import.meta.dirname, "../dist/runner_lease.js");
const dirs: string[] = [];
const children: ChildProcess[] = [];

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "lease-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      c.kill("SIGKILL");
    } catch {
      // gone
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A node process that tries to take the lease once `go` exists, then reports and holds. */
function contender(dir: string, go: string, out: string): ChildProcess {
  const script = join(dir, `c-${children.length}.mjs`);
  writeFileSync(
    script,
    `import { existsSync, writeFileSync } from "node:fs";
     import { acquireRunnerLease } from ${JSON.stringify(DIST)};
     while (!existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 2));
     const got = acquireRunnerLease(${JSON.stringify(dir)}, { kind: "queue" });
     writeFileSync(${JSON.stringify(out)}, "holder" in got ? "refused" : "granted");
     setTimeout(() => process.exit(0), 3000);`,
  );
  const child = spawn(process.execPath, [script], { stdio: "ignore" });
  children.push(child);
  return child;
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("NEW-runtime-1: an atomic runner lease", () => {
  it("RUN-2: of processes racing for the lease, exactly one gets it", async () => {
    const dir = repo();
    const go = join(dir, "go");
    const outs = Array.from({ length: 6 }, (_, i) => join(dir, `out-${i}`));
    for (const out of outs) contender(dir, go, out);
    await new Promise((r) => setTimeout(r, 400));
    writeFileSync(go, "");
    await waitFor(() => outs.every((o) => existsSync(o)));
    const verdicts = outs.map((o) => readFileSync(o, "utf8"));
    expect(verdicts.filter((v) => v === "granted")).toHaveLength(1);
    expect(verdicts.filter((v) => v === "refused")).toHaveLength(5);
  });

  it("RUN-5: a holder killed with SIGKILL leaves a lease the next runner takes", async () => {
    const dir = repo();
    const go = join(dir, "go");
    writeFileSync(go, "");
    const out = join(dir, "out");
    const holder = contender(dir, go, out);
    await waitFor(() => existsSync(out));
    expect(readFileSync(out, "utf8")).toBe("granted");
    expect(runnerLease(dir)?.pid).toBe(holder.pid);
    // While it lives, this process is refused and told who holds it.
    const refused = acquireRunnerLease(dir, { kind: "run" });
    expect("holder" in refused && refused.holder.pid).toBe(holder.pid);
    holder.kill("SIGKILL");
    await waitFor(() => holder.exitCode !== null || holder.signalCode !== null);
    expect(runnerLease(dir)).toBeUndefined();
    const taken = acquireRunnerLease(dir, { kind: "run" });
    expect("release" in taken).toBe(true);
    if ("release" in taken) {
      expect(runnerLease(dir)?.pid).toBe(process.pid);
      taken.release();
    }
    expect(existsSync(join(dir, ".sekhemet", "runner.lock"))).toBe(false);
  });

  it("item 3: a lease whose pid is alive with another start time is stale", () => {
    const dir = repo();
    mkdirSync(join(dir, ".sekhemet"), { recursive: true });
    // This test's own pid, but a start time it never had: a recycled pid.
    writeFileSync(
      join(dir, ".sekhemet", "runner.lock"),
      JSON.stringify({
        pid: process.pid,
        processStart: "Thu Jan  1 00:00:00 1970",
        token: "x",
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      }),
    );
    expect(runnerLease(dir)).toBeUndefined();
    const release = holdRunnerLease(dir);
    expect(runnerLease(dir)?.processStart).toBe(processStartTime(process.pid));
    release();
  });

  it("item 3: the lease carries pid, process start time and a random token", () => {
    const dir = repo();
    const got = acquireRunnerLease(dir, { kind: "run", cardId: "card_a" });
    if (!("release" in got)) throw new Error("expected the lease");
    const onDisk = JSON.parse(readFileSync(join(dir, ".sekhemet", "runner.lock"), "utf8"));
    expect(onDisk.pid).toBe(process.pid);
    expect(onDisk.processStart).toBe(processStartTime(process.pid));
    expect(onDisk.token).toMatch(/^[0-9a-f]{32}$/);
    expect(onDisk.kind).toBe("run");
    expect(onDisk.cardId).toBe("card_a");
    got.release();
  });
});

describe("NEW-runtime-1: daemon stop never signals a recycled pid", () => {
  it("RUN-1: a recorded pid with another start time is not signalled; the file goes", async () => {
    const dir = repo();
    // A live process that is not the daemon: its pid is in the file, but the
    // start time recorded is not its own.
    const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    children.push(bystander);
    await waitFor(() => processStartTime(bystander.pid ?? 0) !== undefined);
    mkdirSync(join(dir, ".sekhemet"), { recursive: true });
    const file = join(dir, ".sekhemet", "daemon.json");
    writeFileSync(
      file,
      JSON.stringify({
        pid: bystander.pid,
        port: 1,
        startedAt: new Date().toISOString(),
        processStart: "Thu Jan  1 00:00:00 1970",
        log: join(dir, ".sekhemet", "daemon.log"),
      }),
    );
    const message = await daemonStop(dir);
    expect(message).toMatch(/Not running/);
    expect(existsSync(file)).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(bystander.exitCode).toBeNull();
    expect(bystander.signalCode).toBeNull();
  });
});

describe("NEW-runtime-1: every runner takes the lease; detached runs keep a log", () => {
  it("RUN-3: `sekhemet run <card>` while another runner holds the lease exits 1 naming it, and runs nothing", async () => {
    const dir = repo();
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const { db, cardStore } = initLocalKernel(dir);
    const card = await cardStore.createCard({ tier: "task", title: "T", status: "ready" });
    db.close();
    const go = join(dir, "go");
    writeFileSync(go, "");
    const out = join(dir, "out");
    const holder = contender(dir, go, out);
    await waitFor(() => existsSync(out));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.join(" "));
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await main(["run", card.id, "--repo", dir]);
      expect(process.exitCode).toBe(1);
      expect(errors.join("\n")).toContain(`pid ${holder.pid}`);
    } finally {
      process.exitCode = 0;
      vi.restoreAllMocks();
    }
    const after = initLocalKernel(dir);
    expect(after.cardStore.runs.listAttempts(card.id)).toEqual([]);
    expect((await after.cardStore.getCard(card.id))?.status).toBe("ready");
    after.db.close();
  });

  it("RUN-4: the dashboard's run launches detached with its output in .sekhemet/logs, and answers 409 while a runner holds the lease", async () => {
    const dir = repo();
    const fakeCli = join(dir, "fake-cli.mjs");
    writeFileSync(fakeCli, 'console.log("hello from run", process.argv.slice(2).join(" "));\n');
    const prior = process.env.SEKHEMET_CLI;
    process.env.SEKHEMET_CLI = fakeCli;
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    const cards = new CardStore(db, log);
    await cards.createCard({ id: "card_r", tier: "story", title: "R", status: "ready" });
    const server = await startDashboardServer({
      db,
      log,
      cardStore: cards,
      boardService: new BoardServiceImpl(cards),
      repoPath: dir,
      port: 0,
    });
    const post = () =>
      fetch(`http://127.0.0.1:${server.port}/api/cards/card_r/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sekhemet-Action": "1" },
        body: "{}",
      });
    try {
      const started = await post();
      expect(started.status).toBe(202);
      const body = (await started.json()) as { started: boolean; pid: number; cardId: string };
      expect(body).toMatchObject({ started: true, cardId: "card_r" });
      const logs = join(dir, ".sekhemet", "logs");
      await waitFor(
        () =>
          existsSync(logs) &&
          readdirSync(logs).some((f) =>
            readFileSync(join(logs, f), "utf8").includes("hello from run run card_r"),
          ),
      );
      // A runner holds the lease: 409 naming its pid, nothing launched.
      const go = join(dir, "go");
      writeFileSync(go, "");
      const out = join(dir, "out");
      const holder = contender(dir, go, out);
      await waitFor(() => existsSync(out));
      const before = readdirSync(logs).length;
      const refused = await post();
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: string }).error).toContain(`pid ${holder.pid}`);
      expect(readdirSync(logs).length).toBe(before);
    } finally {
      await server.close();
      if (prior === undefined) {
        // biome-ignore lint/performance/noDelete: removing an env var is the point
        delete process.env.SEKHEMET_CLI;
      } else process.env.SEKHEMET_CLI = prior;
    }
  });
});
