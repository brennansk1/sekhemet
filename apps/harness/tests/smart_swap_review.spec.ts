import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import {
  FakeHeadroomProbe,
  type LocalInferenceAdapter,
  ManagedLlamaServerAdapter,
  type MemoryReading,
  type SlotStore,
  type UnloadableAdapter,
  type WatchdogLevel,
} from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelAccess } from "../src/model_access.js";
import { QueuedReviews } from "../src/queued_reviews.js";
import { calibrationHostReading } from "../src/smart_swap.js";
import { supervisorStart } from "../src/supervisor.js";

// Review fixes to Smart Swap's wiring (models rules 20c–20k, MD-N14-7..40),
// through the product's paths: the supervisor's start-up pass, `ModelAccess`
// over the real residency scheduler with fake adapters, real SQLite and a
// fake clock. No model is loaded.

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function reading(over: Partial<MemoryReading> = {}): MemoryReading {
  return {
    at: 0,
    gpuWiredLimitBytes: 20 * GiB,
    metalInUseBytes: 0.2 * GiB,
    totalBytes: 48 * GiB,
    wiredBytes: 2 * GiB,
    anonymousBytes: 3 * GiB,
    compressorBytes: 0.5 * GiB,
    swapUsedBytes: 0,
    processes: [],
    ...over,
  };
}

/** Fake adapters by name: each load, unload and request is an event; a delay per request. */
function fleet(
  events: string[],
  opts: {
    footprints?: Record<string, number>;
    files?: Record<string, string>;
    /** The weights file's bytes, by name (Smart Swap's load estimate). */
    bytes?: Record<string, number>;
    /** A fake latency per load, by name, on the scheduler's clock. */
    loadMs?: Record<string, number>;
    clock?: { t: number };
    reply?: Record<string, LocalInferenceAdapter["generate"]>;
  } = {},
) {
  const made = new Map<string, UnloadableAdapter>();
  const resolve = (name: string): UnloadableAdapter => {
    const existing = made.get(name);
    if (existing) return existing;
    const a: UnloadableAdapter = {
      modelId: name,
      supportedArms: ["arm_a_flat"],
      contextWindow: { contextTokens: 8192, maxTokens: 512 },
      load: async () => {
        events.push(`load ${name}`);
        if (opts.clock) opts.clock.t += opts.loadMs?.[name] ?? 0;
        return "loaded";
      },
      unload: async () => {
        events.push(`unload ${name}`);
      },
      confirmUnloaded: async () => true,
      footprintBytes: async () => opts.footprints?.[name] ?? 13 * GiB,
      ...(opts.files?.[name] || opts.bytes?.[name]
        ? {
            weightsSource: async () => ({
              path: opts.files?.[name] ?? `/models/${name}.gguf`,
              bytes: opts.bytes?.[name] ?? 1 * MiB,
            }),
          }
        : {}),
      generate:
        opts.reply?.[name] ??
        (async () => {
          events.push(`gen ${name}`);
          return { text: "ok", toolCalls: [], usage };
        }),
    };
    made.set(name, a);
    return a;
  };
  return { resolve, made };
}

/** A fake llama-server: slot save writes the named file, restore reads it. */
async function fakeLlama(dir: string) {
  const seen: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as { filename?: string }) : {};
      const filename = body.filename ?? "";
      seen.push(`${req.method} ${req.url} ${filename}`);
      let json: unknown = {};
      let status = 200;
      if (req.url?.includes("action=save")) {
        writeFileSync(join(dir, filename), "the person's private question");
        json = { id_slot: 0, filename, n_written: 1024 };
      } else if (req.url?.includes("action=restore")) {
        if (!existsSync(join(dir, filename))) {
          status = 400;
          json = { error: "no file" };
        } else json = { id_slot: 0, filename, n_read: 1024 };
      } else if (req.url === "/props") {
        json = { build_info: "b1", chat_template: "{{ messages }}" };
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("Smart Swap review fixes, through the product", () => {
  let dir: string;
  let db: DatabaseSync;
  let log: EventLog;
  let cardStore: CardStore;
  const closers: (() => Promise<void>)[] = [];
  const env = process.env.SEKHEMET_SLOT_CACHE;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "smart-swap-review-"));
    db = new DatabaseSync(join(dir, "ledger.db"));
    initSchema(db);
    log = new EventLog(db);
    cardStore = new CardStore(db, log);
  });
  afterEach(async () => {
    while (closers.length) await closers.pop()?.();
    if (env === undefined) Reflect.deleteProperty(process.env, "SEKHEMET_SLOT_CACHE");
    else process.env.SEKHEMET_SLOT_CACHE = env;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const clock = { t: Date.parse("2026-09-26T22:00:00Z") };
  const access = (
    events: string[],
    opts: Parameters<typeof fleet>[1] & {
      headroom?: FakeHeadroomProbe;
      coResident?: boolean;
      usableBytes?: number;
      queues?: {
        queue: string;
        role: "worker" | "planner" | "reviewer" | "researcher";
        name: string;
      }[];
    } = {},
  ) => {
    const f = fleet(events, { clock, ...opts });
    return ModelAccess.forQueues(
      opts.queues ?? [
        { queue: "worker", role: "worker", name: "w" },
        { queue: "manager", role: "planner", name: "m" },
      ],
      {
        resolve: (name) => f.resolve(name),
        usableBytes: opts.usableBytes ?? 20 * GiB,
        coResident: opts.coResident ?? false,
        healthCheck: false,
        pressureLevel: () => 1,
        now: () => clock.t,
        ledger: log,
        // Every weights file on the external drive: loads cost minutes (rule 20c's estimate).
        volumeOf: () => "external",
        pollMs: 5,
        ...(opts.headroom ? { headroom: opts.headroom } : {}),
      },
    );
  };

  describe("1. erasure reaches the saved KV slots (rule 20i, MD-N14-37)", () => {
    it("the supervisor's start-up pass and every restore delete the slots an erasure covers; a restore then finds none", async () => {
      const slots = join(dir, "slots");
      process.env.SEKHEMET_SLOT_CACHE = slots;
      const srv = await fakeLlama(slots);
      closers.push(srv.close);
      // The product's one path to a model, over this ledger.
      const access = ModelAccess.forQueues([{ queue: "manager", role: "planner", name: "m" }], {
        resolve: () =>
          new ManagedLlamaServerAdapter({
            modelId: "m",
            modelPath: join(dir, "absent.gguf"),
            port: srv.port,
            contextTokens: 8192,
            slotCacheDir: slots,
          }),
        usableBytes: 20 * GiB,
        healthCheck: false,
        ledger: log,
      });
      const adapter = access.adapterFor("manager") as ManagedLlamaServerAdapter;
      const said = await log.append({
        actor: "human",
        type: "card/note",
        payload: {},
        private: { text: "my private question" },
      });
      const store = adapter.slotStore() as SlotStore;
      const key = await adapter.slotKey();
      await store.save({ slot: 1, kind: "thread", owner: "seshat", key, sources: [said.id] });
      expect(await adapter.slotAction("save")).toBe(true);
      expect(readdirSync(slots).filter((f) => f.endsWith(".bin"))).toHaveLength(2);

      await log.erase({ eventIds: [said.id], reason: "erasure", principal: log.localPrincipal() });
      const start = await supervisorStart({
        repoPath: dir,
        cardStore,
        log,
        boardService: new BoardServiceImpl(cardStore),
      });
      expect(start.slotsErased).toHaveLength(2);
      expect(readdirSync(slots).filter((f) => f.endsWith(".bin"))).toEqual([]);
      expect(await adapter.slotAction("restore")).toBe(false);

      // An erasure while the process runs: the restore itself sweeps first.
      expect(await adapter.slotAction("save")).toBe(true);
      const later = await log.append({
        actor: "human",
        type: "card/note",
        payload: {},
        private: { text: "another" },
      });
      await log.erase({ eventIds: [later.id], reason: "erasure", principal: log.localPrincipal() });
      expect(await adapter.slotAction("restore")).toBe(false);
      expect(readdirSync(slots).filter((f) => f.endsWith(".bin"))).toEqual([]);
      expect(srv.seen.filter((s) => s.includes("action=restore"))).toEqual([]);
    });
  });

  describe("6. C10's warmed bytes: not resident, each once, never stale", () => {
    it("the DEC-42 host reading cannot pass 60% free from warm bytes of weights loaded or unloaded since", async () => {
      const file = join(dir, "m.gguf");
      writeFileSync(file, Buffer.alloc(1 * MiB));
      const events: string[] = [];
      const a = access(events, {
        files: { w: file, m: file },
        headroom: new FakeHeadroomProbe(reading()),
      });
      await a.measure();
      await a.use("worker");
      a.setPlan(["worker", "manager"]);
      await tick(200);
      expect(a.warmedBytes()).toBe(1 * MiB);
      // The DEC-42 reading at 55% free plus the warmed bytes: over 60% only while they are warm.
      const host = () =>
        calibrationHostReading({
          swapUsedBytes: 0,
          freeBytes: 5.5 * MiB,
          totalBytes: 10 * MiB,
          warmedBytes: a.warmedBytes(),
        }).freeRatio;
      expect(host()).toBeGreaterThan(0.6);
      // The manager loads: its warm bytes are resident memory now, not free.
      await a.use("manager");
      expect(a.warmedBytes()).toBe(0);
      expect(host()).toBeLessThan(0.6);
      // Back to the Worker, the successor warmed again: counted once.
      await a.use("worker");
      a.setPlan(["worker", "manager"]);
      await tick(200);
      expect(a.warmedBytes()).toBe(1 * MiB);
      await a.releaseAll();
    });
  });

  describe("7. the quick answerer's admission reads the ceilings on the ledger (rule 20g)", () => {
    it("a Metal-timeout ceiling recorded on the ledger refuses a co-residence at or above it", async () => {
      const queues = [
        { queue: "worker", role: "worker" as const, name: "w" },
        { queue: "quick", role: "planner" as const, name: "q" },
      ];
      const opts = {
        queues,
        coResident: true,
        usableBytes: 40 * GiB,
        headroom: new FakeHeadroomProbe(reading()),
        footprints: { w: 11 * GiB, q: 2 * GiB },
      };
      const before = access([], opts);
      await before.measure();
      await before.use("worker");
      expect((await before.admits("quick")).ok).toBe(true);
      await before.releaseAll();
      log.appendNow({
        actor: "harness",
        type: "model/gpu_ceiling",
        payload: { basis: "metal_timeout", bytes: 12 * GiB, models: ["w", "q"] },
      });
      const after = access([], opts);
      await after.measure();
      await after.use("worker");
      expect((await after.admits("quick")).ok).toBe(false);
      await after.releaseAll();
    });
  });

  describe("3. the queue's reviews go through decide(): tours, aging and the storm cap", () => {
    it("in one queue run with fake latencies, reviews batch into a tour and C7 caps round trips", async () => {
      const MIN = 60_000;
      const events: string[] = [];
      const a = access(events, {
        queues: [
          { queue: "worker", role: "worker", name: "w" },
          { queue: "manager", role: "planner", name: "m" },
          { queue: "reviewer", role: "reviewer", name: "r" },
        ],
        bytes: { w: 13 * GiB, m: 12 * GiB, r: 12 * GiB },
        // Fake latencies: each load takes 3.5 minutes on the scheduler's clock,
        // so C_pair is about 7 minutes: a visit with five reviews keeps the
        // Worker's floor (C5), and the storm cap is ⌊720 s ÷ C_pair⌋ = 1.
        loadMs: { w: 3.5 * MIN, m: 3.5 * MIN, r: 3.5 * MIN },
      });
      await a.measure();
      const reviews = new QueuedReviews<string>({
        access: a,
        queue: "reviewer",
        review: async (model, card) => {
          events.push(`review ${card}`);
          await model.generate({ prompt: card, toolArm: "arm_a_flat" });
        },
      });
      // The queue run: eight cards of two 5-minute steps each on the Worker;
      // each passing card's review is queued as it passes.
      a.setHomeBacklog(true);
      for (let i = 1; i <= 8; i++) {
        await a.useQueued("worker");
        for (let step = 0; step < 2; step++) {
          const end = await a.beginStep("worker");
          clock.t += 5 * MIN;
          end();
          await tick();
        }
        reviews.add(`c${i}`);
        await tick();
      }
      a.setHomeBacklog(undefined);
      await tick(50);
      const loadsOfR = () => events.filter((e) => e === "load r").length;
      // One absence served every review due: c1 reached its 45-minute cap
      // during the sixth card, and c1–c5 were served in that one visit.
      const firstVisit = events.slice(
        events.indexOf("load r"),
        events.indexOf("load w", events.indexOf("load r")),
      );
      expect(firstVisit.filter((e) => e.startsWith("review "))).toEqual([
        "review c1",
        "review c2",
        "review c3",
        "review c4",
        "review c5",
      ]);
      // The storm cap (⌊720 s ÷ C_pair⌋ = 1 round trip an hour): the rest wait.
      expect(loadsOfR()).toBe(1);
      expect(reviews.queued).toBeGreaterThan(0);
      expect(events).not.toContain("review c6");
      const status = await a.swapStatus();
      expect(status.roundTrips).toBe(1);
      // An hour after the first round trip, the storm cap frees and the rest are served in one visit.
      clock.t += 45 * MIN;
      a.boundary();
      await reviews.drain();
      expect(loadsOfR()).toBe(2);
      expect(events.filter((e) => e.startsWith("review "))).toHaveLength(8);
      await a.releaseAll();
    });
  });

  describe("2, 4. the watchdog on the queue's paths (rules 19, 20e)", () => {
    const team = [
      { queue: "worker", role: "worker" as const, name: "w" },
      { queue: "manager", role: "planner" as const, name: "m" },
      { queue: "seshat", role: "planner" as const, name: "m" },
      { queue: "escalation", role: "planner" as const, name: "m" },
      { queue: "researcher", role: "researcher" as const, name: "x" },
    ];

    it("at emergency an escalated card's held 12 GB model with no running step is unloaded; mid-step it stays", async () => {
      const events: string[] = [];
      let level: WatchdogLevel = "normal";
      const a = access(events, { queues: team, footprints: { w: 13 * GiB, m: 12 * GiB } });
      a.setSwapInputs({ watchdogLevel: () => level });
      await a.measure();
      const hold = await a.submitHold("escalation", { yieldsToWatchdog: true });
      const end = await a.beginStep("escalation");
      level = "emergency";
      a.boundary();
      await tick();
      await a.releaseAll();
      expect(events).not.toContain("unload m");
      end();
      await tick();
      expect(events).toContain("unload m");
      expect(a.residentRoles()).toEqual([]);
      hold.release();
    });

    it("at critical no load starts for Seshat's answer, the beginStep reload, an escalation or research; each goes once the level falls", async () => {
      const paths: [string, (a: ModelAccess) => Promise<unknown>][] = [
        ["seshat", (a) => a.submitHold("seshat").then((h) => h.release())],
        ["escalation", (a) => a.submitHold("escalation", { yieldsToWatchdog: true })],
        ["research", (a) => a.queuedModel("researcher").model()],
        ["beginStep", (a) => a.beginStep("worker").then((end) => end())],
      ];
      for (const [name, run] of paths) {
        const events: string[] = [];
        let level: WatchdogLevel = "normal";
        const a = access(events, { queues: team });
        a.setSwapInputs({ watchdogLevel: () => level });
        await a.measure();
        // The Worker was resident and a visitor evicted it: the next step reloads it.
        await a.useQueued("worker");
        if (name === "beginStep") (await a.submitHold("manager")).release();
        await tick();
        const before = events.length;
        level = "critical";
        let done = false;
        const going = run(a).then(() => {
          done = true;
        });
        await tick(60);
        expect({ name, loads: events.slice(before).filter((e) => e.startsWith("load")) }).toEqual({
          name,
          loads: [],
        });
        expect(done).toBe(false);
        level = "normal";
        await going;
        expect(events.slice(before).some((e) => e.startsWith("load"))).toBe(true);
        await a.releaseAll();
      }
    });
  });

  describe("7. Seshat's swaps are interactive: not counted by the storm cap (C7)", () => {
    it("a person's answer on the seshat queue is an interactive swap; the manager's batch is not", async () => {
      const events: string[] = [];
      const a = access(events, {
        bytes: { w: 13 * GiB, m: 12 * GiB },
        queues: [
          { queue: "worker", role: "worker", name: "w" },
          { queue: "manager", role: "planner", name: "m" },
          { queue: "seshat", role: "planner", name: "m" },
        ],
      });
      await a.measure();
      await a.useQueued("worker");
      (await a.submitHold("seshat")).release();
      await a.useQueued("worker");
      expect((await a.swapStatus()).roundTrips).toBe(0);
      // The synchronous path takes the queue's class too.
      (await a.hold("seshat")).release();
      await a.useQueued("worker");
      expect((await a.swapStatus()).roundTrips).toBe(0);
      (await a.submitHold("manager")).release();
      expect((await a.swapStatus()).roundTrips).toBe(1);
      await a.releaseAll();
    });
  });
});
