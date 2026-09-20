import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import {
  GOVERNANCE_EVENTS,
  energyToday,
  mayRun,
  recordUsage,
  thermalState,
} from "../src/governance.js";
import { runOvernight } from "../src/overnight.js";
import {
  idleSeconds,
  isReserved,
  mayUseMachine,
  minutesUntilFree,
  parseHours,
} from "../src/scheduler.js";

const at = (iso: string) => new Date(iso);

describe("scheduler (H21)", () => {
  it("parses reserved hours, day ranges, lists and midnight-crossing windows", () => {
    const w = parseHours("08:00-18:00 Mon-Fri");
    expect(isReserved(w, at("2026-09-21T09:30:00"))).toBe(true); // Monday
    expect(isReserved(w, at("2026-09-21T18:00:00"))).toBe(false);
    expect(isReserved(w, at("2026-09-20T10:00:00"))).toBe(false); // Sunday
    const night = parseHours("22:00-06:00");
    expect(isReserved(night, at("2026-09-21T23:00:00"))).toBe(true);
    expect(isReserved(night, at("2026-09-22T05:59:00"))).toBe(true);
    expect(isReserved(night, at("2026-09-22T06:00:00"))).toBe(false);
    const list = parseHours("09:00-12:00 Mon,Wed; 13:00-14:00 Sat");
    expect(isReserved(list, at("2026-09-23T10:00:00"))).toBe(true); // Wednesday
    expect(isReserved(list, at("2026-09-22T10:00:00"))).toBe(false); // Tuesday
    expect(isReserved(list, at("2026-09-26T13:30:00"))).toBe(true);
    expect(parseHours("none")).toEqual([]);
    expect(() => parseHours("mornings")).toThrow(/08:00-18:00/);
    expect(minutesUntilFree(w, at("2026-09-21T17:30:00"))).toBe(30);
  });

  it("runs outside reserved hours, inside them only when the user is away", () => {
    const w = parseHours("08:00-18:00 Mon-Fri");
    expect(mayUseMachine(w, { now: at("2026-09-21T23:00:00") }).run).toBe(true);
    const busy = mayUseMachine(w, { now: at("2026-09-21T10:00:00"), idle: () => 60 });
    expect(busy.run).toBe(false);
    expect(busy.waitMinutes).toBe(10);
    expect(mayUseMachine(w, { now: at("2026-09-21T10:00:00"), idle: () => 1500 }).run).toBe(true);
    expect(mayUseMachine(w, { now: at("2026-09-21T10:00:00"), idle: () => undefined }).run).toBe(
      false,
    );
  });

  it("reads macOS HIDIdleTime in nanoseconds", () => {
    const read = () => '| |   "HIDIdleTime" = 125000000000\n';
    if (process.platform === "darwin") expect(idleSeconds(read)).toBe(125);
  });
});

describe("compute governance (H23)", () => {
  const ledger = () => {
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    return new EventLog(db);
  };

  it("adds up today's energy from the ledger and trips the energy breaker at the budget", async () => {
    const log = ledger();
    await recordUsage(log, 3_600_000, {}, 400); // 0.4 kWh
    expect((await energyToday(log)).kwh).toBe(0.4);
    const ok = await mayRun(
      log,
      { kwhPerDay: 1, maxConsecutiveFailures: 3 },
      { consecutiveFailures: 0 },
      { thermal: () => "nominal" },
    );
    expect(ok.ok).toBe(true);
    await recordUsage(log, 2 * 3_600_000, {}, 400);
    const spent = await mayRun(
      log,
      { kwhPerDay: 1, maxConsecutiveFailures: 3 },
      { consecutiveFailures: 0 },
      { thermal: () => "nominal" },
    );
    expect(spent).toMatchObject({ ok: false, breaker: "energy" });
    expect((await log.getEventsByTypes([GOVERNANCE_EVENTS.tripped])).length).toBe(1);
  });

  it("trips on failures in a row and on thermal throttling; reads pmset", async () => {
    const log = ledger();
    expect(
      await mayRun(
        log,
        { kwhPerDay: 0, maxConsecutiveFailures: 3 },
        { consecutiveFailures: 3 },
        { thermal: () => "nominal" },
      ),
    ).toMatchObject({ breaker: "failures" });
    expect(
      await mayRun(
        log,
        { kwhPerDay: 0, maxConsecutiveFailures: 3 },
        { consecutiveFailures: 0 },
        { thermal: () => "throttled" },
      ),
    ).toMatchObject({ breaker: "thermal" });
    if (process.platform === "darwin") {
      expect(thermalState(() => "Note: No thermal warning level has been recorded")).toBe(
        "nominal",
      );
      expect(thermalState(() => "CPU_Speed_Limit = 70")).toBe("throttled");
    }
  });
});

describe("sekhemet overnight", () => {
  function setup() {
    const repo = mkdtempSync(join(tmpdir(), "overnight-"));
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    return { repo, log, cards: new CardStore(db, log) };
  }
  const report = (repo: string, startedAt: string, passed: boolean[]) =>
    writeFileSync(
      join(repo, ".sekhemet", "queue_report.json"),
      JSON.stringify({
        startedAt,
        entries: passed.map((p, i) => ({ cardId: `c${i}`, passed: p })),
      }),
    );

  it("runs rounds until no Ready cards remain, recording energy per round", async () => {
    const { repo, log, cards } = setup();
    await cards.createCard({ id: "c0", tier: "task", title: "a", status: "ready" });
    let rounds = 0;
    const s = await runOvernight({
      repoPath: repo,
      log,
      cardStore: cards,
      hours: "none",
      limits: { kwhPerDay: 0, maxConsecutiveFailures: 3 },
      queueArgs: ["--profile", "full"],
      say: () => {},
      runQueue: async (args) => {
        expect(args).toEqual(["--profile", "full"]);
        rounds++;
        report(repo, `r${rounds}`, [true]);
        await cards.updateCardStatus("c0", "review", "passed");
        return 0;
      },
    });
    expect(s).toMatchObject({
      rounds: 1,
      cardsRun: 1,
      passed: 1,
      stoppedBecause: "no Ready cards left",
    });
    expect((await log.getEventsByTypes([GOVERNANCE_EVENTS.usage])).length).toBe(1);
  });

  it("stops on the failure breaker across rounds, and when a round leaves no report", async () => {
    const { repo, log, cards } = setup();
    await cards.createCard({ id: "c0", tier: "task", title: "a", status: "ready" });
    let n = 0;
    const s = await runOvernight({
      repoPath: repo,
      log,
      cardStore: cards,
      hours: "none",
      limits: { kwhPerDay: 0, maxConsecutiveFailures: 3 },
      queueArgs: [],
      say: () => {},
      runQueue: async () => {
        n++;
        if (n > 1) report(repo, `r${n}`, [false, false]);
        return 1;
      },
    });
    expect(s.stoppedBecause).toMatch(/^failures breaker/);
    expect(n).toBe(2); // one reportless round (1 failure) + one round of 2 failures = 3
  });

  it("waits through reserved hours instead of running", async () => {
    const { repo, log, cards } = setup();
    await cards.createCard({ id: "c0", tier: "task", title: "a", status: "ready" });
    let clock = at("2026-09-21T17:55:00").getTime();
    const waits: number[] = [];
    const s = await runOvernight({
      repoPath: repo,
      log,
      cardStore: cards,
      hours: "08:00-18:00 Mon-Fri",
      limits: { kwhPerDay: 0, maxConsecutiveFailures: 3 },
      queueArgs: [],
      say: () => {},
      idleMinutes: 10_000,
      now: () => new Date(clock),
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      runQueue: async () => {
        report(repo, "r1", [true]);
        await cards.updateCardStatus("c0", "review", "x");
        return 0;
      },
    });
    expect(waits).toEqual([5 * 60_000]);
    expect(s.rounds).toBe(1);
  });
});
