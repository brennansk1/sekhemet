import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ModelRegistry } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { cli, g2Dirs, g2Env, ledgerRows, until } from "./support/g2_cli.js";
import { type EngineTurn, startEngine, workerRequests } from "./support/g4_engine.js";
import { type Evidence, latestEvidence } from "./support/g4_gate.js";
import { queueProject, runQueueOn } from "./support/g4_queue.js";
import { alive, startCli } from "./support/g4_runtime.js";

/**
 * The runtime as a person meets it (runtime.md; FINISH_LINE_PLAN C2d,
 * FINDINGS_C1 TST-01): the built binary (`apps/harness/dist/index.js`)
 * spawned as `queue`, `daemon`, `overnight`, `reject`, `doctor` and `dev
 * airgap`, over real repositories, real SQLite ledgers and real processes it
 * signals or races (DEFINITION_OF_DONE §2A). The Worker is a scripted engine
 * in its own process (`support/g4_engine.ts`); no model is loaded.
 */

const SEED = `[[gate]]\nid = "unit"\nrung = "test"\ncommand = "sh"\nargs = ["-c", "exit 0"]\nparser = "generic"\n`;
const BASE = {
  "src/a.ts": "",
  "src/main.ts": 'import { a } from "./a.js";\nconsole.log(a);\n',
};
const card = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  tier: "story" as const,
  title: "Write a",
  scopeFiles: ["src/a.ts"],
  stepBudget: 6,
  spec: "Export a from src/a.ts",
  ...over,
});
const WRITE_A = {
  name: "write_file",
  arguments: { path: "src/a.ts", content: "export const a = 1;\n" },
};
const FINISH = { name: "finish_card" };
const lock = (repo: string) => join(repo, ".sekhemet", "runner.lock");
const wt = (repo: string) => join(repo, ".sekhemet", "worktrees", "c1");
const pidIn = (file: string) => Number(readFileSync(file, "utf8").trim());

/** A gate that writes its shell's pid into the worktree, then sleeps. */
const SLEEPING_GATE = (timeout = 120) =>
  `[[gate]]\nid = "unit"\nrung = "test"\ncommand = "sh"\nargs = ["-c", "mkdir -p .sekhemet && echo $$ > .sekhemet/gate.pid; sleep 60 & echo $! > .sekhemet/grandchild.pid; wait"]\nparser = "generic"\ntimeout_s = ${timeout}\n`;

describe("daemon (RUN-1, RUN-14)", () => {
  it("RUN-1: `daemon stop` with a recorded pid that now belongs to another process signals nothing, removes the file and says Not running", async () => {
    const where = g2Dirs();
    execFileSync("git", ["init", "-q"], { cwd: where.cwd });
    const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    try {
      mkdirSync(join(where.cwd, ".sekhemet"), { recursive: true });
      const file = join(where.cwd, ".sekhemet", "daemon.json");
      writeFileSync(
        file,
        JSON.stringify({
          pid: bystander.pid,
          port: 1,
          startedAt: new Date().toISOString(),
          // Not the bystander's start time: the pid was recycled.
          processStart: "Thu Jan  1 00:00:00 1970",
          log: join(where.cwd, ".sekhemet", "daemon.log"),
        }),
      );
      const r = await cli(["daemon", "stop"], { cwd: where.cwd, env: g2Env(where.home) });
      expect(r.stdout, r.stderr).toMatch(/Not running/);
      expect(existsSync(file)).toBe(false);
      await new Promise((ok) => setTimeout(ok, 300));
      expect(bystander.exitCode).toBeNull();
      expect(bystander.signalCode).toBeNull();
    } finally {
      bystander.kill("SIGKILL");
    }
  });

  it("RUN-14: `daemon start` rotates a daemon.log past its size limit and keeps at most the configured five rotated files", async () => {
    const where = g2Dirs();
    execFileSync("git", ["init", "-q"], { cwd: where.cwd });
    const dir = join(where.cwd, ".sekhemet");
    mkdirSync(dir, { recursive: true });
    // Over the 10 MB limit, and five older files already kept.
    writeFileSync(join(dir, "daemon.log"), Buffer.alloc(10 * 1024 * 1024 + 1, "x"));
    for (let i = 1; i <= 5; i++) writeFileSync(join(dir, `daemon.log.${i}`), `old ${i}\n`);
    const { freePort } = await import("./support/cli_spawn.js");
    const port = await freePort();
    const env = g2Env(where.home);
    const start = await cli(["daemon", "start", "--port", String(port)], {
      cwd: where.cwd,
      env,
      timeoutMs: 60_000,
    });
    try {
      expect(start.stdout, start.stderr).toMatch(/Started \(pid \d+\)/);
      const logs = readdirSync(dir)
        .filter((f) => f.startsWith("daemon.log"))
        .sort();
      expect(logs).toEqual([
        "daemon.log",
        "daemon.log.1",
        "daemon.log.2",
        "daemon.log.3",
        "daemon.log.4",
        "daemon.log.5",
      ]);
      expect(statSync(join(dir, "daemon.log.1")).size).toBe(10 * 1024 * 1024 + 1);
      // Each kept file moved down one; the oldest (old 5) is gone.
      for (let i = 2; i <= 5; i++)
        expect(readFileSync(join(dir, `daemon.log.${i}`), "utf8")).toBe(`old ${i - 1}\n`);
      expect(statSync(join(dir, "daemon.log")).size).toBeLessThan(10 * 1024 * 1024);
    } finally {
      const stop = await cli(["daemon", "stop"], { cwd: where.cwd, env });
      expect(stop.stdout, stop.stderr).toMatch(/Stopped pid \d+/);
    }
  }, 60_000);
});

describe("one runner at a time (RUN-2, RUN-5, RUN-8)", () => {
  it("RUN-2: two `queue` processes started at the same moment: exactly one takes the lease, the other is refused naming it", async () => {
    const p = await queueProject({ files: BASE, cards: [card()] });
    const release = join(p.home, "release");
    const engine = await startEngine(p.home, [{ waitFor: release, calls: [WRITE_A, FINISH] }]);
    const env = { ...p.env, ...engine.env };
    const a = startCli(["queue", "--worker", "scripted-worker:latest"], {
      cwd: p.repo,
      env,
      preload: engine.preload,
    });
    const b = startCli(["queue", "--worker", "scripted-worker:latest"], {
      cwd: p.repo,
      env,
      preload: engine.preload,
    });
    // One of them reaches the Worker; the other has exited refused.
    await until(() => workerRequests(engine).length > 0, 60_000);
    const loser = await Promise.race([a.exited.then(() => a), b.exited.then(() => b)]);
    const winner = loser === a ? b : a;
    expect(loser.out()).toMatch(
      new RegExp(`Another runner holds the lease here \\(pid ${winner.pid}`),
    );
    expect(await loser.exited).toBe(1);
    writeFileSync(release, "");
    expect(await winner.exited).toBe(0);
    expect(winner.out()).toMatch(/PASSED \(gate_passed\)/);
    expect(ledgerRows(p.repo).filter((e) => e.type === "attempt/started")).toHaveLength(1);
  }, 120_000);

  it("RUN-5: after the lease holder is killed with SIGKILL, the next `queue` takes the lease with no manual cleanup", async () => {
    const p = await queueProject({ files: BASE, cards: [card()] });
    const never = join(p.home, "never");
    const held = await startEngine(p.home, [{ waitFor: never }]);
    const first = startCli(["queue", "--worker", "scripted-worker:latest"], {
      cwd: p.repo,
      env: { ...p.env, ...held.env },
      preload: held.preload,
    });
    await until(() => workerRequests(held).length > 0, 60_000);
    expect(JSON.parse(readFileSync(lock(p.repo), "utf8")).pid).toBe(first.pid);
    first.child.kill("SIGKILL");
    expect(await first.exited).toBe("SIGKILL");
    // The lease file is left behind by the dead holder.
    expect(existsSync(lock(p.repo))).toBe(true);
    held.stop();
    const next = await startEngine(p.home, [
      { calls: [WRITE_A, FINISH] },
      { calls: [WRITE_A, FINISH] },
    ]);
    const r = await runQueueOn(p, next);
    expect(`${r.stdout}\n${r.stderr}`).not.toMatch(/Another runner holds the lease/);
    expect(r.stdout).toMatch(/=== c1/);
    expect(workerRequests(next).length).toBeGreaterThan(0);
    expect(existsSync(lock(p.repo))).toBe(false);
  }, 120_000);

  it("RUN-8: SIGTERM to a `queue` holding the lease releases the lease and kills its children before it exits", async () => {
    const p = await queueProject({
      files: { ...BASE, ".sekhemet/gates.toml": SLEEPING_GATE() },
      cards: [card()],
    });
    const engine = await startEngine(p.home, [{ calls: [WRITE_A, FINISH] }]);
    const q = startCli(["queue", "--worker", "scripted-worker:latest"], {
      cwd: p.repo,
      env: { ...p.env, ...engine.env },
      preload: engine.preload,
    });
    const gatePid = join(wt(p.repo), ".sekhemet", "gate.pid");
    const childPid = join(wt(p.repo), ".sekhemet", "grandchild.pid");
    await until(() => existsSync(childPid) && readFileSync(childPid, "utf8").trim() !== "", 60_000);
    const [gate, grandchild] = [pidIn(gatePid), pidIn(childPid)];
    expect(alive(gate) && alive(grandchild)).toBe(true);
    expect(existsSync(lock(p.repo))).toBe(true);
    q.child.kill("SIGTERM");
    const code = await q.exited;
    expect(code === 143 || code === "SIGTERM", String(code)).toBe(true);
    expect(existsSync(lock(p.repo))).toBe(false);
    await until(() => !alive(gate) && !alive(grandchild), 3_000);
  }, 120_000);
});

describe("process trees (RUN-6, RUN-7)", () => {
  it("RUN-6: a gate that started a grandchild and exceeded its timeout leaves no process of its tree running 1 s after the kill", async () => {
    const p = await queueProject({
      files: { ...BASE, ".sekhemet/gates.toml": SLEEPING_GATE(1) },
      cards: [card({ stepBudget: 1 })],
    });
    const engine = await startEngine(p.home, [{ calls: [WRITE_A, FINISH] }]);
    const q = startCli(["queue", "--worker", "scripted-worker:latest"], {
      cwd: p.repo,
      env: { ...p.env, ...engine.env },
      preload: engine.preload,
    });
    const childPid = join(wt(p.repo), ".sekhemet", "grandchild.pid");
    await until(() => existsSync(childPid) && readFileSync(childPid, "utf8").trim() !== "", 60_000);
    const [gate, grandchild] = [pidIn(join(wt(p.repo), ".sekhemet", "gate.pid")), pidIn(childPid)];
    // The gate's limit is 1 s; within 1 s more, its whole tree is gone.
    await until(() => !alive(gate) && !alive(grandchild), 2_500);
    await q.exited;
    const unit = (latestEvidence(p.repo, "c1") as Evidence).rungResults.find(
      (o) => o.gate === "unit",
    );
    expect(unit?.passed).toBe(false);
  }, 120_000);

  it("RUN-7: a card that ends with a background process which forked a child leaves no process of that tree running", async () => {
    const p = await queueProject({ files: BASE, cards: [card()] });
    const engine = await startEngine(p.home, [
      {
        calls: [
          {
            name: "start_process",
            arguments: {
              name: "bg",
              command:
                "sh -c 'mkdir -p .sekhemet; echo $$ > .sekhemet/bg.pid; sleep 60 & echo $! > .sekhemet/bg-child.pid; wait'",
            },
          },
        ],
      },
      { calls: [WRITE_A, FINISH] },
    ] satisfies EngineTurn[]);
    const r = await runQueueOn(p, engine);
    expect(r.stdout, r.stderr).toMatch(/PASSED \(gate_passed\)/);
    const files = [
      join(wt(p.repo), ".sekhemet", "bg.pid"),
      join(wt(p.repo), ".sekhemet", "bg-child.pid"),
    ];
    for (const f of files) expect(existsSync(f), f).toBe(true);
    const pids = files.map(pidIn);
    await until(() => pids.every((x) => !alive(x)), 3_000);
  }, 120_000);
});

describe("worktrees of closed cards (RUN-16)", () => {
  it("RUN-16: `reject` of a parked card removes its worktree and keeps its branch", async () => {
    const p = await queueProject({ files: BASE, cards: [card({ stepBudget: 1 })] });
    const engine = await startEngine(p.home, [{ calls: [WRITE_A] }]);
    await runQueueOn(p, engine);
    expect(existsSync(wt(p.repo))).toBe(true);
    const parked = await cli(["park", "c1", "waiting for the API"], { cwd: p.repo, env: p.env });
    expect(parked.status, `${parked.stdout}\n${parked.stderr}`).toBe(0);
    const closed = await cli(["reject", "c1", "no longer needed"], { cwd: p.repo, env: p.env });
    expect(closed.status, `${closed.stdout}\n${closed.stderr}`).toBe(0);
    await until(() => !existsSync(wt(p.repo)), 15_000);
    const branches = execFileSync("git", ["branch", "--list", "sekhemet/*"], {
      cwd: p.repo,
      encoding: "utf8",
    });
    expect(branches).toContain("c1");
  }, 120_000);
});

describe("the overnight run (RUN-11, RUN-17)", () => {
  it("RUN-11, RUN-17: a round past its wall-clock limit has its tree killed and counts one failure, the night goes on to the next round, and after the rounds the offline vulnerability scan is recorded", async () => {
    // Two Ready issues: the round that is killed leaves its issue behind, and the night goes on to the other.
    const p = await queueProject({
      files: { ...BASE, ".sekhemet/gates.toml": SLEEPING_GATE() },
      cards: [card(), card({ id: "c2", title: "Write a again" })],
    });
    // The Worker's quantisation registered, and its injection-fixture pass (SEC-37b).
    new ModelRegistry(p.env.SEKHEMET_MODEL_REGISTRY).upsert("scripted-worker:latest", {
      quant: "Q4_K_M",
    });
    mkdirSync(join(p.home, ".sekhemet"), { recursive: true });
    writeFileSync(
      join(p.home, ".sekhemet", "injection_fixtures.json"),
      JSON.stringify([
        { modelId: "scripted-worker:latest", quant: "Q4_K_M", passedAt: new Date().toISOString() },
      ]),
    );
    const engine = await startEngine(p.home, [
      { calls: [WRITE_A, FINISH] },
      { calls: [FINISH] },
      { calls: [FINISH] },
    ]);
    // No reserved hours: the machine is the night's (a person's user configuration).
    const userConfig = join(p.home, "user-config.toml");
    writeFileSync(userConfig, '[machine]\nreserved_hours = "none"\n');
    // Each round's queue is a child of the night: the engine reaches it through NODE_OPTIONS.
    const r = await cli(
      [
        "overnight",
        "--worker",
        "scripted-worker:latest",
        "--round-limit-min",
        "0.25",
        "--max-failures",
        "2",
        "--idle-min",
        "0",
      ],
      {
        cwd: p.repo,
        env: {
          ...p.env,
          ...engine.env,
          SEKHEMET_USER_CONFIG: userConfig,
          NODE_OPTIONS: `--import=${engine.preload}`,
        },
        timeoutMs: 170_000,
      },
    );
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out.match(/Round \d+ exceeded its wall-clock limit/g), out).toHaveLength(2);
    expect(out).toMatch(/Round 2: /);
    expect(out).toMatch(/failures breaker/);
    // No gate process of either round is left.
    const grandchildren = ["c1", "c2"]
      .map((id) => join(p.repo, ".sekhemet", "worktrees", id, ".sekhemet", "grandchild.pid"))
      .filter((f) => existsSync(f))
      .map(pidIn);
    expect(grandchildren.length).toBeGreaterThan(0);
    await until(() => grandchildren.every((x) => !alive(x)), 3_000);
    const [scan] = ledgerRows(p.repo).filter((e) => e.type === "security/vulnerability_scan");
    expect(scan?.payload).toMatchObject({ scanner: "osv-scanner", offline: true });
    expect(String(scan?.payload.skipped)).toMatch(/lockfile|not installed/);
  }, 180_000);
});

describe("free space before a card starts (RUN-83)", () => {
  it.runIf(process.platform === "darwin")(
    "RUN-83: a card about to start on a volume below the free-space floor does not start, and the volume is named",
    async () => {
      const where = g2Dirs();
      const image = join(where.root, "vol.dmg");
      execFileSync("hdiutil", ["create", "-size", "48m", "-fs", "HFS+", "-volname", "sek", image], {
        stdio: "ignore",
      });
      const mnt = join(where.root, "mnt");
      mkdirSync(mnt);
      execFileSync("hdiutil", ["attach", "-nobrowse", "-mountpoint", mnt, image], {
        stdio: "ignore",
      });
      try {
        const vol = realpathSync(mnt);
        const repo = join(vol, "repo");
        mkdirSync(repo);
        const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
        git("init", "-q", "-b", "main");
        git("config", "user.name", "Jane Doe");
        git("config", "user.email", "jane@example.com");
        mkdirSync(join(repo, "src"));
        mkdirSync(join(repo, ".sekhemet"));
        writeFileSync(join(repo, "src", "a.ts"), "");
        writeFileSync(join(repo, ".sekhemet", "gates.toml"), SEED);
        writeFileSync(join(repo, ".gitignore"), ".sekhemet/\n");
        git("add", "-A");
        git("commit", "-q", "-m", "seed");
        // The project, its ledger and its card, on the small volume.
        const p = await queueProject({ files: BASE, cards: [card()] });
        const { openLocalLedger } = await import("../src/ledger_cmds.js");
        const { CardStore } = await import("@sekhemet/kernel");
        const { db, log } = openLocalLedger(repo);
        await new CardStore(db, log).createCard(card());
        db.close();
        const engine = await startEngine(p.home, [{ calls: [WRITE_A, FINISH] }]);
        const r = await cli(["queue", "--worker", "scripted-worker:latest"], {
          cwd: repo,
          preload: engine.preload,
          env: { ...p.env, ...engine.env },
          timeoutMs: 120_000,
        });
        const out = `${r.stdout}\n${r.stderr}`;
        expect(out).toContain(vol);
        expect(out).toMatch(/free of a 5\.0 GB floor/);
        expect(workerRequests(engine)).toHaveLength(0);
        expect(existsSync(join(repo, ".sekhemet", "worktrees", "c1"))).toBe(false);
      } finally {
        execFileSync("hdiutil", ["detach", "-force", mnt], { stdio: "ignore" });
      }
    },
    120_000,
  );
});

describe("records that cannot be written (RUN-89, RUN-90)", () => {
  /** Every append of `type` fails inside SQLite, as a failing disk would. */
  const failAppendsOf = (repo: string, type: string) => {
    const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    db.exec(
      `CREATE TRIGGER fail_${type.replace(/\W/g, "_")} BEFORE INSERT ON events WHEN NEW.type = '${type}' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`,
    );
    db.close();
  };
  const lostRecords = (home: string): { kind: string; error: string; cardId?: string }[] => {
    const logs = join(home, ".sekhemet", "logs");
    if (!existsSync(logs)) return [];
    return readdirSync(logs)
      .map((ws) => join(logs, ws, "lost-records.ndjson"))
      .filter((f) => existsSync(f))
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l)),
      );
  };

  it("RUN-89, RUN-90: an air-gap self-test whose record cannot be appended exits 1 with one warn line naming it, the loss is logged, and `doctor` counts it", async () => {
    const p = await queueProject({ files: BASE, cards: [card()] });
    failAppendsOf(p.repo, "airgap/selftest");
    const r = await cli(["dev", "airgap", "selftest"], {
      cwd: p.repo,
      env: p.env,
      timeoutMs: 60_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(1);
    const warns = out
      .split("\n")
      .filter((l) => l.includes("airgap/selftest") && /disk I\/O error/.test(l));
    expect(warns, out).toHaveLength(1);
    expect(lostRecords(p.home)).toEqual([
      expect.objectContaining({
        kind: "airgap/selftest",
        error: expect.stringContaining("disk I/O error"),
      }),
    ]);
    const doctor = await cli(["doctor"], { cwd: p.repo, env: p.env, timeoutMs: 60_000 });
    expect(`${doctor.stdout}\n${doctor.stderr}`).toMatch(/1 record could not be written/);
  }, 90_000);

  it("RUN-90: a card whose egress allowlist warning cannot be appended stops before its next step with error naming the lost record", async () => {
    const p = await queueProject({
      files: {
        ...BASE,
        ".sekhemet/gates.toml": `[project]\nnetwork_allow = ["*.example.com"]\n\n${SEED}`,
      },
      cards: [card()],
    });
    const userConfig = join(p.home, "user-config.toml");
    writeFileSync(userConfig, '[network]\nmode = "open"\n');
    failAppendsOf(p.repo, "card/egress_warning");
    const engine = await startEngine(p.home, [{ calls: [WRITE_A, FINISH] }, { calls: [FINISH] }]);
    const r = await runQueueOn(p, engine, { SEKHEMET_USER_CONFIG: userConfig });
    expect(r.stdout, r.stderr).toMatch(/\(error\)/);
    const e = latestEvidence(p.repo, "c1") as Evidence & { stopDetail?: Record<string, unknown> };
    expect(e.stopReason).toBe("error");
    expect(e.stopDetail).toMatchObject({ lostRecord: "card/egress_warning" });
    expect(lostRecords(p.home).map((x) => x.kind)).toContain("card/egress_warning");
  }, 90_000);
});
