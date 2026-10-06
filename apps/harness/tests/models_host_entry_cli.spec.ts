import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { cli, g2Dirs } from "./support/g2_cli.js";
import { SCRIPTED_MODEL, scriptEnv } from "./support/g2_model.js";
import { type G2Project, g2Project } from "./support/g2_project.js";

/**
 * The host the models' rules read, reached the way a person and the product
 * reach them (C2d, FINDINGS_C1 TST-01; models.md rules 8, 19, 20;
 * NEW-models-1, -2, -3): the built command (`apps/harness/dist/index.js`)
 * spawned over a real repository and ledger — `run`, `queue` as the
 * overnight round starts it, `reserve`, and `serve` asked over HTTP — its
 * Worker a scripted model at the HTTP boundary (`g2_model.ts`: no model is
 * loaded, nothing leaves the machine). What the host reports is injected at
 * its boundary by `support/g5_host.mjs`: the kernel's memory-pressure level
 * and swap as `sysctl` or /proc give them, and the installed memory.
 */

const BIN = resolve(import.meta.dirname, "../dist/index.js");
const HOST = resolve(import.meta.dirname, "support/g5_host.mjs");
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      c.kill("SIGKILL");
      await new Promise((r) => c.once("close", r));
    }
  }
});

/** `sekhemet <args>` started with the scripted model and the host preloaded. */
function start(args: string[], p: G2Project, extra: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--import", p.preload, "--import", HOST, BIN, ...args], {
    cwd: p.repo,
    env: { ...p.env, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  child.stdout.on("data", (b) => {
    out += String(b);
  });
  child.stderr.on("data", (b) => {
    out += String(b);
  });
  const closed = new Promise<number | null>((r) => child.once("close", (code) => r(code)));
  return { child, out: () => out, closed };
}

/** Resolve once `test()` holds, polling every 50 ms; fail after `ms`. */
async function until(test: () => boolean, what: () => string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting: ${what()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Run to its queue report or exit; a language server may outlive the report. */
async function finish(run: ReturnType<typeof start>, ms = 150_000): Promise<string> {
  await until(
    () =>
      run.child.exitCode !== null ||
      /Report: \S+queue_report\.json|PASSED|FAILED|stopped/.test(run.out()),
    run.out,
    ms,
  );
  await Promise.race([run.closed, new Promise((r) => setTimeout(r, 3000))]);
  return run.out();
}

function read<T>(p: G2Project, sql: string): T[] {
  const db = new DatabaseSync(join(p.repo, ".sekhemet", "events.db"), { readOnly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

const workerRequests = (p: G2Project) =>
  existsSync(p.record)
    ? readFileSync(p.record, "utf8")
        .split("\n")
        .filter((l) => l.includes('"role":"worker"')).length
    : 0;

const card = (id: string, more: Record<string, unknown> = {}) => ({
  id,
  tier: "story" as const,
  title: `Write ${id}`,
  status: "ready" as const,
  scopeFiles: ["src/a.ts"],
  stepBudget: 4,
  spec: "Export a constant named a from src/a.ts",
  acceptanceCriteria: ["src/a.ts exports a"],
  ...more,
});

const turns = [
  [{ name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 1;\n" } }],
  [{ name: "finish_card" }],
];

describe("the memory watchdog over `sekhemet run` (MD-N2-2)", () => {
  it("MD-N2-2: `run` watches memory for the card's duration; at critical pressure it issues no new step until pressure falls, then the card finishes", async () => {
    const p = await g2Project(g2Dirs(), { cards: [card("c1")] });
    const pressure = join(p.home, "pressure.json");
    const hold = join(p.home, "release-step-1");
    writeFileSync(pressure, JSON.stringify({ kernel: 1, swapMb: 100 }));
    const run = start(["run", "c1", "--worker", SCRIPTED_MODEL], p, {
      ...scriptEnv(p.record, { worker: turns }),
      G5_PRESSURE: pressure,
      G5_HOLD_FILE: hold,
    });
    // The Worker's first step is answered and held: the card is mid-run.
    await until(() => workerRequests(p) === 1, run.out);
    // The kernel reports critical pressure for one sample.
    writeFileSync(pressure, JSON.stringify({ kernel: 4, swapMb: 100 }));
    await until(
      () => /memory watchdog: normal -> critical \(kernel critical\)/.test(run.out()),
      run.out,
      20_000,
    );
    writeFileSync(pressure, JSON.stringify({ kernel: 1, swapMb: 100 }));
    writeFileSync(hold, "");
    // Between steps the run waits out the pressure, issuing no new step meanwhile.
    await until(
      () => run.out().includes("memory watchdog: pausing new turns until pressure falls"),
      run.out,
      20_000,
    );
    expect(workerRequests(p)).toBe(1);
    await until(() => run.out().includes("memory watchdog: resuming"), run.out, 30_000);
    const out = await finish(run);
    expect(out.indexOf("memory watchdog: resuming")).toBeGreaterThan(
      out.indexOf("pausing new turns until pressure falls"),
    );
    expect(out).toMatch(/memory watchdog: critical -> normal/);
    expect(workerRequests(p)).toBe(2);
    const [c] = read<{ status: string }>(p, "SELECT status FROM cards WHERE id = 'c1'");
    expect(c?.status, out).toBe("review");
  }, 180_000);
});

describe("a reserved machine and the unattended round (MD-N3-1)", () => {
  it("MD-N3-1: reserved by `reserve` or inside `[machine] reserved_hours`, the overnight round's `queue` starts no routine card, only the urgent one; free, the routine card runs", async () => {
    const p = await g2Project(g2Dirs(), {
      cards: [card("routine", { priority: 3 }), card("urgent", { priority: 1 })],
    });
    // The person's own configuration (trusted): reserved hours as the test sets them.
    const userConfig = join(p.home, "config.toml");
    const hours = (spec: string) =>
      writeFileSync(userConfig, `[machine]\nreserved_hours = "${spec}"\n`);
    hours("none");
    const env = { ...p.env, SEKHEMET_USER_CONFIG: userConfig };
    const reserved = await cli(["reserve"], { cwd: p.repo, env });
    expect(reserved.status, reserved.stdout + reserved.stderr).toBe(0);
    expect(reserved.stdout).toMatch(/Reserved until you run `sekhemet dev reserve --release`/);
    // The overnight command's round: `queue` with SEKHEMET_OVERNIGHT_ROUND=1 (overnight.ts).
    const round = () =>
      finish(
        start(
          ["queue", "--worker", SCRIPTED_MODEL],
          { ...p, env },
          {
            ...scriptEnv(p.record, { worker: turns }),
            SEKHEMET_OVERNIGHT_ROUND: "1",
          },
        ),
      );
    const out = await round();
    expect(out).toContain(
      "--- routine not started: the machine is reserved and the issue is not urgent ---",
    );
    expect(out).toMatch(/=== urgent \(attempt 1\)/);
    expect(out).not.toMatch(/=== routine \(attempt/);
    const status = () =>
      Object.fromEntries(
        read<{ id: string; status: string }>(p, "SELECT id, status FROM cards").map((c) => [
          c.id,
          c.status,
        ]),
      );
    expect(status()).toMatchObject({ routine: "ready", urgent: "review" });
    // Released, but inside the reserved hours: still not started.
    const released = await cli(["reserve", "--release"], { cwd: p.repo, env });
    expect(released.stdout).toContain("Released: unattended work may use the machine again.");
    hours("00:00-23:59");
    const inHours = await round();
    expect(inHours).toContain(
      "--- routine not started: it is inside the reserved hours and the issue is not urgent ---",
    );
    expect(status().routine).toBe("ready");
    // Free: the next round runs the routine card.
    hours("none");
    const free = await round();
    expect(free).toMatch(/=== routine \(attempt 1\)/);
    expect(status().routine).toBe("review");
  }, 300_000);
});

describe("calibration keeps the window the Worker's prompts need (MD-N1-2)", () => {
  it("MD-N1-2: `calibrate --from` a repository whose runs recorded long prompts keeps the larger working context and says why; without it the tier's window stands", async () => {
    const p = await g2Project(g2Dirs(), { cards: [card("c1")] });
    // A run whose Worker prompts were 30,000 tokens, as the engine reported them.
    const ran = await finish(
      start(["queue", "--worker", SCRIPTED_MODEL], p, {
        ...scriptEnv(p.record, { worker: turns }),
        G5_PROMPT_TOKENS: "30000",
      }),
    );
    const sizes = read<{ n: number }>(
      p,
      "SELECT prompt_tokens AS n FROM steps WHERE prompt_tokens > 0",
    );
    expect(sizes.length, ran).toBeGreaterThan(0);
    expect(new Set(sizes.map((s) => s.n))).toEqual(new Set([30_000]));
    const calibrate = (from: string[]) =>
      finish(
        start(
          [
            "calibrate",
            "--models",
            `${SCRIPTED_MODEL}=worker`,
            "--buckets",
            "2048",
            "--force",
            ...from,
          ],
          p,
          { G5_TOTALMEM_GB: "24" },
        ),
      );
    const plain = await calibrate([]);
    const tierWindow = Number(/working context (\d+) tokens/.exec(plain)?.[1]);
    expect([16_384, 24_576], plain).toContain(tierWindow);
    expect(plain).not.toMatch(/kept \d+ tokens of working context/);
    const held = await calibrate(["--from", p.repo]);
    const m =
      /working context (\d+) tokens.*kept (\d+) tokens of working context rather than the tier's (\d+), because the p99 of the Worker's recorded prompts \(30000\) plus the answer \((\d+)\) and thinking \((\d+)\) caps needs it/.exec(
        held,
      );
    expect(m, held).not.toBeNull();
    const [, window, kept, tier, answer, thinking] = (m as RegExpExecArray).map(Number);
    expect(window).toBe(kept);
    expect(kept).toBe(30_000 + (answer as number) + (thinking as number));
    expect(tier).toBe(tierWindow);
    expect(kept).toBeGreaterThan(tier as number);
  }, 300_000);
});

describe("the machine's tier from its installed memory over HTTP (MD-N1-1)", () => {
  it("MD-N1-1: a machine with 24 GB installed is classified tier M by the dashboard's /api/machine; 16 GB is tier S", async () => {
    const p = await g2Project(g2Dirs(), { cards: [] });
    const tierAt = async (gb: number) => {
      const server = start(["serve", "--port", "0"], p, {
        SEKHEMET_MODEL_LOADS: "off",
        G5_TOTALMEM_GB: String(gb),
      });
      await until(() => /running at:\s+http:\/\/127\.0\.0\.1:\d+/.test(server.out()), server.out);
      const base = /running at:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(server.out())?.[1] as string;
      const machine = (await (await fetch(`${base}/api/machine`)).json()) as {
        tier: {
          tier?: string;
          source: string;
          budgetGb?: [number, number | null];
          installedBytes: number;
        };
      };
      server.child.kill("SIGKILL");
      await server.closed;
      return machine.tier;
    };
    // No calibration on this host yet: the installed memory decides.
    expect(await tierAt(24)).toEqual({
      tier: "M",
      source: "installed",
      budgetGb: [24, 48],
      installedBytes: 24 * 1024 ** 3,
    });
    expect((await tierAt(16)).tier).toBe("S");
  }, 120_000);
});
