import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { m0PendingCheck } from "../src/doctor.js";
import { M0_PENDING, pendingM0, recordM0Pending } from "../src/m0_path.js";
import { runOvernight } from "../src/overnight.js";
import { runWave2Command } from "../src/wave2.js";

// Measurement MS-M9-6 and the lead's ruling: adopting or re-qualifying a
// Worker leaves M0 pending; the overnight run does it first, inside its
// window, stopping and resuming cleanly; qualify --check and doctor say so;
// a person's `sekhemet m0` clears it.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function kernel() {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-m0p-"));
  dirs.push(repoPath);
  mkdirSync(join(repoPath, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(repoPath, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  return { repoPath, log, cardStore: new CardStore(db, log) };
}

describe("M0 pending after a Worker is adopted or re-qualified (MS-M9-6)", () => {
  it("is pending per Worker until an M0 result for that Worker is recorded", async () => {
    const k = kernel();
    await recordM0Pending(k.log, {
      worker: "cyber-tiel",
      combination: "llama.cpp b10809 / IQ3_XXS",
      reason: "qualified",
    });
    await recordM0Pending(k.log, {
      worker: "nail",
      combination: "ollama / Q4",
      reason: "qualified",
    });
    expect((await pendingM0(k.log)).map((p) => p.worker)).toEqual(["cyber-tiel", "nail"]);
    await k.log.append({ actor: "harness", type: "measure/m0", payload: { worker: "cyber-tiel" } });
    expect((await pendingM0(k.log)).map((p) => p.worker)).toEqual(["nail"]);
    // Re-qualifying afterwards makes it pending again.
    await recordM0Pending(k.log, {
      worker: "cyber-tiel",
      combination: "new build",
      reason: "re-qualified",
    });
    expect((await pendingM0(k.log)).map((p) => p.worker)).toEqual(["nail", "cyber-tiel"]);
    const [event] = await k.log.getEventsByTypes([M0_PENDING]);
    expect(event?.payload).toMatchObject({
      worker: "cyber-tiel",
      combination: "llama.cpp b10809 / IQ3_XXS",
    });
  });

  it("qualify --check and doctor show it", async () => {
    const k = kernel();
    await recordM0Pending(k.log, { worker: "silent", combination: "mock", reason: "qualified" });
    process.env.SEKHEMET_MODEL_REGISTRY = join(k.repoPath, "models.json");
    const out: string[] = [];
    try {
      await runWave2Command("qualify", ["--models", "silent", "--check"], k, {
        print: (l) => out.push(l),
        model: (n) => new MockInferenceAdapter(n, [], { exhaustion: "default" }),
      });
    } finally {
      Reflect.deleteProperty(process.env, "SEKHEMET_MODEL_REGISTRY");
    }
    expect(out.join("\n")).toMatch(
      /M0 pending for silent \(mock\): sekhemet overnight runs it, or run sekhemet m0 --worker silent/,
    );
    const check = m0PendingCheck(k.repoPath);
    expect(check).toMatchObject({ name: "M0", status: "warn" });
    expect(check.detail).toMatch(/M0 pending: silent/);
    expect(m0PendingCheck(kernel().repoPath).status).toBe("pass");
  });
});

describe("the overnight run does pending M0 first, inside its window (MS-M9-6)", () => {
  const base = (k: ReturnType<typeof kernel>) => ({
    repoPath: k.repoPath,
    log: k.log,
    cardStore: k.cardStore,
    hours: "none",
    limits: { kwhPerDay: 0, maxConsecutiveFailures: 3 },
    queueArgs: [],
    say: () => {},
    skipMutation: true,
  });

  it("runs it before the queue rounds, and goes on to them when it completes", async () => {
    const k = kernel();
    await recordM0Pending(k.log, { worker: "cyber-tiel", combination: "c", reason: "qualified" });
    await k.cardStore.createCard({ id: "c0", tier: "task", title: "a", status: "ready" });
    const order: string[] = [];
    await runOvernight({
      ...base(k),
      maxRounds: 1,
      runM0: async (worker) => {
        order.push(`m0 ${worker}`);
        await k.log.append({ actor: "harness", type: "measure/m0", payload: { worker } });
        return "done";
      },
      runQueue: async () => {
        order.push("queue");
        return 0;
      },
    });
    expect(order).toEqual(["m0 cyber-tiel", "queue"]);
    expect(await pendingM0(k.log)).toEqual([]);
  });

  it("stops at the window's end with M0 still pending, and resumes it the next night", async () => {
    const k = kernel();
    await recordM0Pending(k.log, { worker: "cyber-tiel", combination: "c", reason: "qualified" });
    await k.cardStore.createCard({ id: "c0", tier: "task", title: "a", status: "ready" });
    let clock = new Date("2026-09-25T23:00:00");
    const stops: boolean[] = [];
    const first = await runOvernight({
      ...base(k),
      until: "06:00",
      now: () => clock,
      runM0: async (_w, shouldStop) => {
        clock = new Date("2026-09-26T06:30:00");
        stops.push(shouldStop());
        return "stopped";
      },
      runQueue: async () => {
        throw new Error("the queue does not run while M0 is unfinished");
      },
    });
    expect(stops).toEqual([true]);
    expect(first.stoppedBecause).toMatch(
      /M0 for cyber-tiel paused at the window's end; it resumes next overnight/,
    );
    expect((await pendingM0(k.log)).map((p) => p.worker)).toEqual(["cyber-tiel"]);
  });
});
