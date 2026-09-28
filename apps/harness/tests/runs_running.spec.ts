import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRuns } from "../src/dashboard_api.js";
import { QUEUE_STARTED, recordQueueReport, recordQueueStarted } from "../src/execute.js";

// Dashboard DB-N2-11: a run in progress has its row on Runs — *Running ·
// 2 of 6 issues · 4m* — from `queue/started` and the attempts finished since,
// over a real ledger; a run whose process is gone is not called running.

let dir: string;
let db: DatabaseSync;
let log: EventLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sek-runs-running-"));
  db = new DatabaseSync(join(dir, "events.db"));
  initSchema(db);
  log = new EventLog(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const cards = ["card_a", "card_b", "card_c", "card_d", "card_e", "card_f"];
const startedAt = "2026-09-27T10:00:00.000Z";

async function finish(cardId: string) {
  await log.append({ actor: "harness", type: "attempt/finished", cardId, payload: { cardId } });
}

describe("a run in progress (DB-N2-11)", () => {
  it("records queue/started with its issues, model and process", async () => {
    await recordQueueStarted(log, { startedAt, cards, model: "cyber-tiel", pid: 4242 });
    const [e] = await log.getEventsByTypes([QUEUE_STARTED]);
    expect(e?.payload).toEqual({ startedAt, cards, model: "cyber-tiel", pid: 4242 });
  });

  it("lists it first as running, counting the run's issues finished since it started", async () => {
    await finish("card_a"); // before the run: not counted
    await recordQueueStarted(log, { startedAt, cards, model: "cyber-tiel", pid: 4242 });
    await finish("card_a");
    await finish("card_b");
    await finish("card_b"); // a retry of the same issue counts once
    await finish("card_other"); // not this run's
    const { runs } = await listRuns(dir, log, { alive: (pid) => pid === 4242 });
    expect(runs[0]).toMatchObject({
      id: "2026-09-27T10-00-00-000Z",
      startedAt,
      model: "cyber-tiel",
      running: { finished: 2, total: 6 },
    });
  });

  it("is a finished run once its report is recorded, and is not running when its process is gone", async () => {
    await recordQueueStarted(log, { startedAt, cards, model: "cyber-tiel", pid: 4242 });
    expect((await listRuns(dir, log, { alive: () => false })).runs).toEqual([]);
    await recordQueueReport(log, dir, {
      startedAt,
      model: "cyber-tiel",
      entries: [],
      passAt1: 0,
      totalDurationMs: 1000,
    } as never);
    const { runs } = await listRuns(dir, log, { alive: () => true });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.running).toBeUndefined();
  });
});
