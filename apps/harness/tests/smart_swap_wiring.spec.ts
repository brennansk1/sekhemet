import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { writeMeasurementMarker } from "@sekhemet/eval";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import {
  DEFAULT_SWAP_POLICY,
  FakeHeadroomProbe,
  type LocalInferenceAdapter,
  type MemoryReading,
  type UnloadableAdapter,
  type WatchdogLevel,
} from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { executeCard } from "../src/execute.js";
import { ModelAccess } from "../src/model_access.js";
import { answerQueued } from "../src/pm/service.js";
import { PmStore } from "../src/pm/store.js";
import { startDashboardServer } from "../src/server.js";
import {
  PRESENCE_EVENT,
  PresenceRecorder,
  QueuedCardWork,
  beginCalibrationNight,
  calibrationHostReading,
  cardOverlapTasks,
  headroomProbeFor,
  pageCacheWarmer,
  planFromBoard,
  presenceNow,
  queueSwapMode,
  quickAnswererFor,
  refreshPlan,
} from "../src/smart_swap.js";
import { identitySettings } from "../src/team/settings.js";

// Smart Swap reaches the product (models rules 20c–20k, MD-N14-13–40;
// measurement MS-NM14-3): the queue's and `run`'s step boundaries, C8's drain
// barrier, C9's overlap, C10's page-cache warmer, the snapshot's presence,
// watchdog level and plan, tours read through the headroom probe (off by
// default), the quick answerer and calibration nights. Real SQLite, real
// `executeCard`, the real `ModelAccess` and residency scheduler over fake
// adapters; no model is loaded.

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const MIN = 60_000;
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

/** Fake adapters by name: each load, unload and request is an event; a gate holds a load open. */
function fleet(
  events: string[],
  opts: {
    footprints?: Record<string, number>;
    gates?: Record<string, Promise<void>>;
    files?: Record<string, string>;
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
        await opts.gates?.[name];
        events.push(`loaded ${name}`);
        return "loaded";
      },
      unload: async () => {
        events.push(`unload ${name}`);
      },
      confirmUnloaded: async () => true,
      footprintBytes: async () => opts.footprints?.[name] ?? 13 * GiB,
      ...(opts.files?.[name]
        ? {
            weightsSource: async () => ({
              path: opts.files?.[name] as string,
              bytes: 1 * MiB,
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

describe("Smart Swap in the product", () => {
  let dir: string;
  let db: DatabaseSync;
  let log: EventLog;
  let cardStore: CardStore;
  /** The scheduler's fake clock: decisions never read the wall clock. */
  const clock = { t: Date.parse("2026-09-26T22:00:00Z") };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "smart-swap-wiring-"));
    db = new DatabaseSync(join(dir, "ledger.db"));
    initSchema(db);
    log = new EventLog(db);
    cardStore = new CardStore(db, log);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

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
    const f = fleet(events, opts);
    return {
      f,
      access: ModelAccess.forQueues(
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
          ...(opts.headroom ? { headroom: opts.headroom } : {}),
        },
      ),
    };
  };

  describe("1. step boundaries: the runner and session call beginStep (C8, RUN-35)", () => {
    it("executeCard's card runner calls beginStep before every step and ends it after", async () => {
      const repo = join(dir, "repo");
      mkdirSync(join(repo, "src"), { recursive: true });
      mkdirSync(join(repo, ".sekhemet"));
      const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
      git("init", "-q", "-b", "main");
      git("config", "user.email", "t@t.t");
      git("config", "user.name", "T");
      writeFileSync(join(repo, "src", "a.ts"), "");
      writeFileSync(
        join(repo, ".sekhemet", "gates.toml"),
        `[project]\nmax_files = 3\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 30\nparser = "generic"\n`,
      );
      writeFileSync(
        join(repo, ".gitignore"),
        ".sekhemet/events.db*\n.sekhemet/worktrees\n.sekhemet/evidence\n.sekhemet/transcripts\n",
      );
      git("add", "-A");
      git("commit", "-q", "-m", "seed");
      const rdb = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
      initSchema(rdb);
      const rlog = new EventLog(rdb);
      const store = new CardStore(rdb, rlog);
      const card = await store.createCard({
        id: "card_a",
        tier: "story",
        title: "Write a",
        scopeFiles: ["src/a.ts"],
        stepBudget: 4,
        spec: "Write src/a.ts",
      });
      let inStep = 0;
      let begun = 0;
      let ended = 0;
      const stepsSeenInside: number[] = [];
      const model: LocalInferenceAdapter = {
        modelId: "w",
        supportedArms: ["arm_a_flat"],
        contextWindow: { contextTokens: 32768, maxTokens: 2048 },
        generate: async () => {
          stepsSeenInside.push(inStep);
          return {
            text: "",
            toolCalls: [
              {
                id: "1",
                name: "write_file",
                arguments: { path: "src/a.ts", content: "export const a = 1;\n" },
              },
              { id: "2", name: "finish_card", arguments: {} },
            ],
            usage,
          };
        },
      };
      const result = await executeCard(
        {
          repoPath: repo,
          restrictedMode: false,
          cardStore: store,
          boardService: new BoardServiceImpl(store),
          log: () => {},
          headroomCheck: false,
        },
        card,
        model,
        undefined,
        {
          beginStep: async () => {
            begun++;
            inStep++;
            return () => {
              ended++;
              inStep--;
            };
          },
        },
      );
      rdb.close();
      expect(result.turns.length).toBeGreaterThan(0);
      expect(begun).toBe(result.turns.length);
      expect(ended).toBe(begun);
      // Every model request ran inside a step the scheduler admitted.
      expect(stepsSeenInside.length).toBeGreaterThan(0);
      expect(stepsSeenInside.every((n) => n === 1)).toBe(true);
    }, 60_000);

    it("MD-N14-24: a swap decided while two slots run waits at the drain barrier; no step starts until the Worker is back", async () => {
      const events: string[] = [];
      const { access: a } = access(events);
      await a.measure();
      await a.use("worker");
      const endA = await a.beginStep("worker");
      const endB = await a.beginStep("worker");
      const manager = a.hold("manager");
      await tick();
      expect(events).not.toContain("unload w");
      endA();
      await tick();
      // Slot B is mid-step: nothing preempts it.
      expect(events).not.toContain("unload w");
      let cStarted = false;
      const c = a.beginStep("worker").then((end) => {
        cStarted = true;
        return end;
      });
      await tick();
      expect(cStarted).toBe(false);
      endB();
      const hold = await manager;
      expect(events.indexOf("unload w")).toBeGreaterThan(-1);
      expect(events.indexOf("loaded m")).toBeGreaterThan(events.indexOf("unload w"));
      await tick();
      // The manager is held: the next Worker step waits for the Worker, never runs on an unloaded one.
      expect(cStarted).toBe(false);
      hold.release();
      const endC = await c;
      expect(a.isResident("worker")).toBe(true);
      expect(events.lastIndexOf("loaded w")).toBeGreaterThan(events.indexOf("loaded m"));
      endC();
      await a.releaseAll();
    });
  });

  describe("2. C9: queued cards' CPU-side work runs while a model loads", () => {
    it("MD-N14-25: a queued card's repo map and context run inside a scripted load, once each", async () => {
      const repo = join(dir, "overlap");
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(
        join(repo, "src", "ledger.ts"),
        "export function balance(): number {\n  return 0;\n}\n",
      );
      const queued = await cardStore.createCard({
        tier: "task",
        title: "Ledger balance",
        status: "ready",
        scopeFiles: ["src/ledger.ts"],
        spec: "balance returns the sum",
      });
      let open!: () => void;
      const events: string[] = [];
      const loadGate = new Promise<void>((r) => {
        open = r;
      });
      const { access: a } = access(events, { gates: { m: loadGate } });
      const ran: string[] = [];
      const work = new QueuedCardWork({
        next: async () => [queued],
        tasks: (card) =>
          cardOverlapTasks(repo, card).map((t) => ({
            ...t,
            run: async () => {
              await t.run();
              ran.push(
                `${card.id} ${t.kind} (${events.includes("loaded m") ? "after" : "during"} the load)`,
              );
            },
          })),
      });
      a.setSwapInputs({ overlap: (w) => work.run(w) });
      await a.measure();
      await a.use("worker");
      const loading = a.use("manager");
      await tick(200);
      expect(ran).toEqual([
        `${queued.id} repo_map (during the load)`,
        `${queued.id} context (during the load)`,
      ]);
      expect(work.completed.map((c) => c.kind)).toEqual(["repo_map", "context"]);
      open();
      await loading;
      // Done once per card: the next load does not repeat it.
      await a.use("worker");
      await tick(50);
      expect(ran).toHaveLength(2);
      await a.releaseAll();
    });
  });

  describe("3. C10: the page-cache warmer", () => {
    it("MD-N14-26: warms only from free memory beyond the 2 GB margin, never above normal, and is excluded from the used ratio", async () => {
      const file = join(dir, "m.gguf");
      writeFileSync(file, Buffer.alloc(4 * MiB));
      let level: WatchdogLevel = "normal";
      const probe = new FakeHeadroomProbe(reading());
      const warmer = pageCacheWarmer({
        probe,
        watchdogLevel: () => level,
        source: async () => ({ path: file, bytes: 4 * MiB }),
        marginBytes: DEFAULT_SWAP_POLICY.prefetchMarginBytes,
      });
      await warmer.warm("m");
      expect(warmer.warmedBytes()).toBe(4 * MiB);
      // Tight: the headroom does not exceed the margin plus the file.
      probe.set(reading({ metalInUseBytes: 17.5 * GiB }));
      await expect(warmer.warm("m2")).rejects.toThrow(/free memory/);
      probe.set(reading());
      level = "elevated";
      await expect(warmer.warm("m3")).rejects.toThrow(/watchdog/);
      expect(warmer.warmedBytes()).toBe(4 * MiB);
      // The warmed cache counts as free in the DEC-42 host reading.
      const host = calibrationHostReading({
        swapUsedBytes: 0,
        freeBytes: 10 * GiB,
        totalBytes: 20 * GiB,
        warmedBytes: 4 * GiB,
      });
      expect(host.freeRatio).toBeCloseTo(0.7);
    });

    it("the scheduler warms the plan's successor only when the headroom probe is on", async () => {
      const file = join(dir, "succ.gguf");
      writeFileSync(file, Buffer.alloc(1 * MiB));
      const run = async (probe: FakeHeadroomProbe | undefined) => {
        const events: string[] = [];
        const { access: a } = access(events, {
          files: { w: file, m: file },
          ...(probe ? { headroom: probe } : {}),
        });
        await a.measure();
        await a.use("worker");
        a.setPlan(["worker", "manager"]);
        await tick(200);
        const warmed = a.warmedBytes();
        await a.releaseAll();
        return warmed;
      };
      expect(await run(undefined)).toBe(0);
      expect(await run(new FakeHeadroomProbe(reading()))).toBe(1 * MiB);
    });
  });

  describe("4. the snapshot's inputs: presence, the watchdog level and the plan", () => {
    it("presence: a dashboard session active within 10 minutes, recorded on the ledger at most every 5 minutes", async () => {
      let t = Date.parse("2026-09-26T21:00:00Z");
      const recorder = new PresenceRecorder(log, { now: () => t });
      recorder.seen({ principal: "p_one", via: "session" });
      recorder.seen({ principal: "p_one", via: "session" });
      const events = await log.getEventsByTypes([PRESENCE_EVENT]);
      expect(events).toHaveLength(1);
      const at = Date.parse(events[0]?.createdAt ?? "");
      expect((await presenceNow(log, { hours: "", now: at + 9 * MIN })).present).toBe(true);
      expect((await presenceNow(log, { hours: "", now: at + 11 * MIN })).present).toBe(false);
      // A token (automation) is not a person present.
      t += 6 * MIN;
      recorder.seen({ principal: "p_bot", via: "token" });
      expect(await log.getEventsByTypes([PRESENCE_EVENT])).toHaveLength(1);
      // Inside the reserved hours a person is present; outside, the next start is given.
      const reserved = await presenceNow(log, {
        hours: "08:00-18:00",
        now: new Date(2026, 8, 28, 10, 0).getTime(),
      });
      expect(reserved.present).toBe(true);
      const night = await presenceNow(log, {
        hours: "08:00-18:00",
        now: new Date(2026, 8, 28, 22, 0).getTime(),
      });
      expect(night.present).toBe(false);
      expect(night.reservedStartsAt).toBe(new Date(2026, 8, 29, 8, 0).getTime());
    });

    it("the dashboard records a person's requests as presence (Solo), once per 5 minutes", async () => {
      writeFileSync(join(dir, "common.txt"), "password\n");
      const server = await startDashboardServer({
        db,
        log,
        boardService: new BoardServiceImpl(cardStore),
        cardStore,
        repoPath: dir,
        port: 0,
        streamIntervalMs: 1000,
        setup: "solo",
        identity: {
          dir: join(dir, "identity"),
          passwordList: join(dir, "common.txt"),
          settings: identitySettings({ mode: "solo", workspace: "Solo" }),
        },
      });
      try {
        await fetch(`http://127.0.0.1:${server.port}/api/board`);
        await fetch(`http://127.0.0.1:${server.port}/api/board`);
      } finally {
        await server.close();
      }
      const seen = await log.getEventsByTypes([PRESENCE_EVENT]);
      expect(seen).toHaveLength(1);
      expect((await presenceNow(log, { hours: "" })).present).toBe(true);
    });

    it("the watchdog level reaches decide(): at elevated a visitor's idle hold ends and it is unloaded", async () => {
      const events: string[] = [];
      let level: WatchdogLevel = "normal";
      const { access: a } = access(events, {
        coResident: true,
        usableBytes: 40 * GiB,
        footprints: { w: 13 * GiB, m: 3 * GiB },
      });
      a.setSwapInputs({ watchdogLevel: () => level });
      await a.measure();
      await a.use("worker");
      await a.use("manager");
      a.boundary();
      await tick(50);
      expect(events).not.toContain("unload m");
      level = "elevated";
      a.boundary();
      await tick(50);
      expect(events).toContain("unload m");
      expect(events).not.toContain("unload w");
      await a.releaseAll();
    });

    it("the plan: the board's next roles from card states and the queue, through setPlan", async () => {
      const mk = (title: string, status: string, labels?: string[]) =>
        cardStore.createCard({
          tier: "task",
          title,
          status: status as "ready",
          ...(status === "parked" ? { blockedReason: "waits on a plan" } : {}),
          ...(labels ? { labels } : {}),
        });
      const running = await mk("Running", "in_progress");
      await cardStore.updateCardStatus(running.id, "verify");
      await mk("Parked", "parked");
      await mk("Research", "ready", ["research"]);
      await mk("Next", "ready");
      const human = await mk("Human review", "in_progress");
      await cardStore.updateCardStatus(human.id, "verify");
      await cardStore.updateCardStatus(human.id, "review");
      const cards = await cardStore.listCards();
      const all = () => true;
      expect(planFromBoard(cards, all)).toEqual(["reviewer", "manager", "researcher", "worker"]);
      // A missing Reviewer: Seshat reviews (the manager queue).
      expect(planFromBoard(cards, (q) => q !== "reviewer")).toEqual([
        "manager",
        "researcher",
        "worker",
      ]);
      const events: string[] = [];
      const { access: a } = access(events);
      await refreshPlan(a, cardStore);
      expect(a.plannedQueues()).toEqual(["manager", "worker"]);
    });
  });

  describe("5. tours read the headroom probe, off by default", () => {
    it("the probe is off unless the setting turns it on", () => {
      expect(DEFAULT_CONFIG.models.headroomProbe).toBe(false);
      const fake = new FakeHeadroomProbe(reading());
      expect(headroomProbeFor(false, () => fake)).toBeUndefined();
      expect(headroomProbeFor(true, () => fake)).toBe(fake);
    });

    it("MD-N14-31a: with the probe on, decide() refuses a visit the headroom cannot hold before evicting anything; off, the footprints decide", async () => {
      const hermes = {
        pid: 7,
        name: "Hermes",
        port: 8080,
        footprintBytes: 9e9,
        ours: false,
      };
      const run = async (on: boolean) => {
        const events: string[] = [];
        const probe = new FakeHeadroomProbe(reading());
        const { access: a } = access(events, on ? { headroom: probe } : {});
        await a.measure();
        await a.use("worker");
        probe.set(reading({ metalInUseBytes: 22.2 * GiB, processes: [hermes] }));
        let answered = false;
        void a.submit("manager", async () => {
          answered = true;
        });
        await tick(100);
        const out = { events: [...events], answered, reads: probe.reads };
        await a.releaseAll();
        return out;
      };
      const off = await run(false);
      expect(off.events).toContain("unload w");
      expect(off.events).toContain("loaded m");
      const on = await run(true);
      expect(on.answered).toBe(false);
      expect(on.events).not.toContain("unload w");
      expect(on.events).not.toContain("load m");
      expect(on.reads).toBeGreaterThan(1);
    });
  });

  describe("6. the quick answerer (rule 20f b)", () => {
    const quickQueues = [
      { queue: "worker", role: "worker" as const, name: "w" },
      { queue: "manager", role: "planner" as const, name: "m" },
    ];

    it("is none by default", () => {
      expect(DEFAULT_CONFIG.models.quickAnswerer).toBe("");
      const { access: a } = access([], { queues: quickQueues });
      expect(quickAnswererFor(a, "")).toBeUndefined();
    });

    it("MD-N14-28: named and admitted by the headroom it answers, labelled, and can create or change no card, plan, proposal or decision", async () => {
      const events: string[] = [];
      const probe = new FakeHeadroomProbe(reading());
      const { access: a } = access(events, {
        queues: quickQueues,
        coResident: true,
        usableBytes: 40 * GiB,
        headroom: probe,
        footprints: { w: 11 * GiB, q: 2 * GiB },
        reply: {
          q: async (req) => {
            events.push(`gen q tools=${req.tools?.length ?? 0}`);
            return {
              text: 'Split it. {"proposal":{"kind":"card","title":"Split the ledger"}} DECISION: approve',
              toolCalls: [
                { id: "1", name: "create_card", arguments: { title: "Split the ledger" } },
                { id: "2", name: "propose_plan", arguments: {} },
              ],
              usage,
            };
          },
        },
      });
      await a.measure();
      await a.use("worker");
      const quick = quickAnswererFor(a, "q");
      expect(quick).toBeDefined();
      expect(await quick?.admitted()).toBe(true);
      const pm = new PmStore(log);
      await cardStore.createCard({ tier: "task", title: "Ledger", status: "in_progress" });
      await pm.appendUserMessage("Should we split the ledger card?");
      const before = (await log.getEventsByTypes([])).length;
      const typesBefore = new Set(
        db
          .prepare("SELECT type FROM events")
          .all()
          .map((r) => (r as { type: string }).type),
      );
      await answerQueued({
        repoPath: dir,
        cardStore,
        pmStore: pm,
        pmModel: "m",
        acquire: async () => {
          throw new Error("the full answer loaded");
        },
        predictWait: async () => ({ waitMs: 9 * MIN, quickPath: true }),
        ...(quick ? { quick } : {}),
      });
      void before;
      const replies = (await pm.thread()).filter((m) => m.role === "pm");
      expect(replies.some((r) => /Quick answer \(q\)/.test(r.text))).toBe(true);
      expect(events).toContain("gen q tools=0");
      // The Worker stayed resident: the quick model sat beside it.
      expect(events).not.toContain("unload w");
      const newTypes = db
        .prepare("SELECT type FROM events")
        .all()
        .map((r) => (r as { type: string }).type)
        .filter((t) => !typesBefore.has(t));
      expect(
        newTypes.filter((t) => /^(card|board|plan|proposal|decision|pm\/proposal)/.test(t)),
      ).toEqual([]);
      expect((await cardStore.listCards()).map((c) => c.title)).toEqual(["Ledger"]);
      expect(cardStore.runs?.listDecisions() ?? []).toEqual([]);
      await a.releaseAll();
    });

    it("is not loaded when the headroom refuses it, nor when the probe is off", async () => {
      const refusing = new FakeHeadroomProbe(reading());
      const events: string[] = [];
      const { access: on } = access(events, {
        queues: quickQueues,
        coResident: true,
        usableBytes: 40 * GiB,
        headroom: refusing,
        footprints: { w: 11 * GiB, q: 2 * GiB },
      });
      await on.measure();
      await on.use("worker");
      refusing.set(reading({ metalInUseBytes: 18.5 * GiB }));
      expect(await quickAnswererFor(on, "q")?.admitted()).toBe(false);
      expect(events).not.toContain("load q");
      await on.releaseAll();
      const { access: off } = access([], {
        queues: quickQueues,
        coResident: true,
        usableBytes: 40 * GiB,
        footprints: { w: 11 * GiB, q: 2 * GiB },
      });
      await off.measure();
      expect(await quickAnswererFor(off, "q")?.admitted()).toBe(false);
    });
  });

  describe("7. calibration nights and measurement runs (MS-NM14-3)", () => {
    it("the queue's mode: a measurement run in a marked repository; a calibration night only with the owner's permission", () => {
      const repo = join(dir, "mode");
      mkdirSync(repo);
      expect(queueSwapMode(repo, [])).toEqual({ mode: "live" });
      expect(queueSwapMode(repo, ["--calibration-night"])).toMatchObject({
        refused: expect.stringMatching(/--permit-loads/),
      });
      expect(queueSwapMode(repo, ["--calibration-night", "--permit-loads"])).toEqual({
        mode: "calibration",
      });
      writeMeasurementMarker(repo, "frozen suite", "test");
      expect(queueSwapMode(repo, [])).toEqual({ mode: "measurement" });
      expect(queueSwapMode(repo, ["--calibration-night", "--permit-loads"])).toMatchObject({
        refused: expect.stringMatching(/measurement run/),
      });
    });

    it("a calibration night records its protocol before the first load, checks DEC-42 before each load and unloads everything at its end", async () => {
      const events: string[] = [];
      const { access: a } = access(events);
      await a.measure();
      let host = { swapUsedBytes: 5 * GiB, freeRatio: 0.7 };
      const night = await beginCalibrationNight(a, {
        record: (e) => log.appendNow({ actor: "harness", type: e.type, payload: e.payload }),
        runnerHolder: () => undefined,
        host: () => host,
        models: ["w", "m"],
      });
      expect("end" in night).toBe(true);
      const recorded = await log.getEventsByTypes(["measure/calibration"]);
      expect(recorded).toHaveLength(1);
      await expect(a.use("worker")).rejects.toThrow(/DEC-42/);
      expect(events).not.toContain("load w");
      host = { swapUsedBytes: 0, freeRatio: 0.7 };
      await a.use("worker");
      expect(events).toContain("loaded w");
      if ("end" in night) {
        const r = await night.end();
        expect(r.hostRefusals).toHaveLength(1);
      }
      expect(events).toContain("unload w");
      expect(a.residentRoles()).toEqual([]);
    });

    it("a calibration night never starts while a suite run holds the runner", async () => {
      const { access: a } = access([]);
      const night = await beginCalibrationNight(a, {
        record: () => undefined,
        runnerHolder: () => "suite",
        host: () => ({ swapUsedBytes: 0, freeRatio: 1 }),
        models: ["w"],
      });
      expect(night).toMatchObject({ refused: expect.stringMatching(/suite/) });
    });

    it("rule 20b: a measurement run bypasses C9 and C10 and unloads its models when it ends, even when it fails", async () => {
      const file = join(dir, "mw.gguf");
      writeFileSync(file, Buffer.alloc(1 * MiB));
      const events: string[] = [];
      const { access: a } = access(events, {
        files: { w: file, m: file },
        headroom: new FakeHeadroomProbe(reading()),
      });
      let overlapped = 0;
      a.setSwapInputs({
        overlap: async () => {
          overlapped++;
        },
      });
      await a.measure();
      await expect(
        a.measurementRun(async () => {
          await a.use("worker");
          a.setPlan(["worker", "manager"]);
          await a.use("manager");
          await tick(100);
          throw new Error("the suite card failed");
        }),
      ).rejects.toThrow(/suite card failed/);
      expect(overlapped).toBe(0);
      expect(a.warmedBytes()).toBe(0);
      expect(a.residentRoles()).toEqual([]);
      expect(events).toContain("unload m");
    });
  });
});
