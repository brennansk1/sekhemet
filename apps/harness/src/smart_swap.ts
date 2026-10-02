import { buildRankedRepoMap } from "@sekhemet/context";
import { readMeasurementMarker } from "@sekhemet/eval";
import type { CardRecord, CardStore, EventLog } from "@sekhemet/kernel";
import { dataContracts } from "@sekhemet/loop";
import {
  type CalibrationProbe,
  DEFAULT_SWAP_POLICY,
  type HeadroomProbe,
  LOAD_PROBE_PROMPT,
  type LoadModeAbPayload,
  type ModelHold,
  type ResidencyScheduler,
  type RunnerHolder,
  type SwapPresence,
  UNLOAD_CONFIRM_MS,
  createDarwinHeadroomProbe,
  dec42HostCheck,
  runCalibrationNight,
  runLoadModeAb,
} from "@sekhemet/models";
import type { ModelAccess } from "./model_access.js";
import { isResearchCard } from "./research/cards.js";
import { reservationNow } from "./reservation.js";
import { isReserved, parseHours } from "./scheduler.js";

export { pageCacheWarmer } from "@sekhemet/models";

/**
 * Smart Swap in the product (models rules 20c–20k, NEW-models-14): what the
 * residency scheduler's `decide()` reads from the harness, and the providers
 * it calls.
 *
 * - **Presence** (C6): a person's dashboard request is recorded on the ledger
 *   as `session/active`, at most once per 5 minutes each (`PresenceRecorder`,
 *   in the dashboard server); a person is present inside the reserved hours,
 *   during a reserve-now, or with a dashboard session active in the last 10
 *   minutes (D) (`presenceNow`, `presenceTracker`).
 * - **The plan** (C2, Belady, C10): the board's next roles from each card's
 *   state — verify → the Reviewer (else Seshat), blocked (parked or held) →
 *   the Planner and Seshat, a research card → the Researcher, the queue's
 *   Ready cards → the Worker (`planFromBoard`, `refreshPlan`).
 * - **C9's overlap**: queued cards' CPU-side work — the ranked repo map and
 *   the context the session assembles — run while a model loads
 *   (`QueuedCardWork`, `cardOverlapTasks`).
 * - **The headroom probe** (rule 20g) is off until a calibration night sets
 *   its reserves: `[models] headroom_probe` turns it on (`headroomProbeFor`).
 * - **The quick answerer** (rule 20f b): a Planner-role setting, `[models]
 *   quick_answerer`, used only when the measured headroom admits it beside
 *   the Worker, evicting nothing (`quickAnswererFor`).
 * - **Calibration nights and measurement runs** (measurement rule 16d,
 *   MS-NM14-3): `queueSwapMode` and `beginCalibrationNight`.
 */

const MIN = 60_000;

/** The ledger event a person's dashboard request records (C6's presence). */
export const PRESENCE_EVENT = "session/active";

/** How a request reached the dashboard (teams §2.3); a token is automation, not a person. */
export type PresenceVia = "solo" | "session" | "proxy" | "token";

/**
 * Records a person's dashboard requests as presence on the ledger, the one
 * durable channel (the spine), at most once per `everyMs` (5 minutes) each,
 * so the queue in another process — and the replay simulator — read it.
 */
export class PresenceRecorder {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly log: Pick<EventLog, "appendNow">,
    private readonly opts: { now?: () => number; everyMs?: number } = {},
  ) {}

  public seen(who: { principal?: string | undefined; via: PresenceVia }): void {
    if (who.via === "token") return;
    const t = (this.opts.now ?? Date.now)();
    const key = who.principal ?? "solo";
    const prev = this.last.get(key);
    if (prev !== undefined && t - prev < (this.opts.everyMs ?? 5 * MIN)) return;
    this.last.set(key, t);
    try {
      this.log.appendNow({
        actor: "human",
        type: PRESENCE_EVENT,
        payload: { via: who.via },
        ...(who.principal ? { principal: who.principal } : {}),
      });
    } catch {
      // Presence is a hint to the scheduler; a request never fails for it.
    }
  }
}

/** The next start of the reserved hours after `t` (local time), within a week. */
export function nextReservedStart(hours: string, t: number): number | undefined {
  const windows = parseHours(hours);
  let best: number | undefined;
  const day0 = new Date(t);
  for (let d = 0; d <= 7; d++) {
    const date = new Date(day0.getFullYear(), day0.getMonth(), day0.getDate() + d);
    for (const w of windows) {
      if (!w.days.has(date.getDay())) continue;
      const start = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        Math.floor(w.start / 60),
        w.start % 60,
      ).getTime();
      if (start > t && (best === undefined || start < best)) best = start;
    }
  }
  return best;
}

/**
 * Whether a person is present now (rule 20e, C6): inside the reserved hours,
 * during a reserve-now, or with a dashboard session active in the last
 * `windowMs` (10 minutes, D); outside the reserved hours, when they next start.
 */
export async function presenceNow(
  log: EventLog,
  opts: { hours?: string; now?: number; windowMs?: number } = {},
): Promise<SwapPresence> {
  const t = opts.now ?? Date.now();
  const hours = opts.hours ?? "";
  const starts = nextReservedStart(hours, t);
  const absent: SwapPresence = {
    present: false,
    ...(starts !== undefined ? { reservedStartsAt: starts } : {}),
  };
  if (isReserved(parseHours(hours), new Date(t))) return { present: true };
  if ((await reservationNow(log, new Date(t))).reserved) return { present: true };
  const seen = await log.getEventsByTypes([PRESENCE_EVENT, "session/started"]);
  const window = opts.windowMs ?? DEFAULT_SWAP_POLICY.presenceWindowMs;
  const recent = seen.some((e) => {
    const age = t - Date.parse(e.createdAt);
    return age >= 0 && age <= window;
  });
  return recent ? { present: true } : absent;
}

/**
 * Presence as the scheduler reads it at each decision (synchronously): the
 * last `presenceNow`, refreshed every `everyMs` and on `refresh()`.
 */
export function presenceTracker(
  log: EventLog,
  opts: { hours: () => string; everyMs?: number },
): { current: () => SwapPresence; refresh: () => Promise<void>; stop: () => void } {
  let value: SwapPresence = { present: false };
  const refresh = async () => {
    value = await presenceNow(log, { hours: opts.hours() }).catch(() => value);
  };
  void refresh();
  const timer = setInterval(() => void refresh(), opts.everyMs ?? 30_000);
  timer.unref?.();
  return { current: () => value, refresh, stop: () => clearInterval(timer) };
}

/** A card that waits on a person or a plan: parked, or held on the board. */
function blocked(card: CardRecord): boolean {
  return card.status === "parked" || (card as { hold?: unknown }).hold !== undefined;
}

/**
 * The board's next roles, in the order of their next use (rule 20e, C2):
 * the running cards (the Worker, or the Researcher for a research card),
 * then cards in verify (the Reviewer, else Seshat), then blocked cards (the
 * Planner and Seshat), then the Ready queue in board order. Queues this run
 * has no model for are left out.
 */
export function planFromBoard(
  cards: readonly CardRecord[],
  has: (queue: string) => boolean,
): string[] {
  const rank = (c: CardRecord) =>
    c.status === "in_progress" && !blocked(c)
      ? 0
      : c.status === "verify"
        ? 1
        : blocked(c)
          ? 2
          : c.status === "ready"
            ? 3
            : undefined;
  const queueOf = (c: CardRecord): string | undefined => {
    if (c.status === "verify") return has("reviewer") ? "reviewer" : "manager";
    if (blocked(c)) return "manager";
    return isResearchCard(c) ? "researcher" : "worker";
  };
  const ordered = cards
    .map((c, i) => ({ c, i, r: rank(c) }))
    .filter((x): x is { c: CardRecord; i: number; r: number } => x.r !== undefined)
    .sort((a, b) => a.r - b.r || a.i - b.i);
  const plan: string[] = [];
  for (const { c } of ordered) {
    const q = queueOf(c);
    if (q !== undefined && has(q) && !plan.includes(q)) plan.push(q);
  }
  return plan;
}

/** Read the board and set the scheduler's plan (`setPlan`). */
export async function refreshPlan(
  access: Pick<ModelAccess, "setPlan" | "has">,
  cardStore: Pick<CardStore, "listCards">,
): Promise<void> {
  const cards = (await cardStore.listCards()) as CardRecord[];
  access.setPlan(planFromBoard(cards, (q) => access.has(q)));
}

/** One piece of a queued card's CPU-side work (C9). */
export interface OverlapTask {
  kind: "repo_map" | "context" | "gate" | "tests";
  run: () => Promise<void>;
}

/**
 * The CPU-side work of queued cards, run while a model loads (rule 20e, C9;
 * MD-N14-25): each task once per card, the next `limit` cards in queue
 * order; a load that starts while it runs joins the same pass.
 */
export class QueuedCardWork {
  public readonly completed: { cardId: string; kind: OverlapTask["kind"]; during: string }[] = [];
  private readonly done = new Set<string>();
  private running: Promise<void> | undefined;

  constructor(
    private readonly opts: {
      next: () => Promise<readonly CardRecord[]> | readonly CardRecord[];
      tasks: (card: CardRecord) => OverlapTask[];
      limit?: number;
      log?: (line: string) => void;
    },
  ) {}

  public run(loading: string): Promise<void> {
    this.running ??= this.pass(loading).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async pass(loading: string): Promise<void> {
    const cards = (await this.opts.next()).slice(0, this.opts.limit ?? 3);
    for (const card of cards) {
      for (const task of this.opts.tasks(card)) {
        const key = `${card.id}:${task.kind}`;
        if (this.done.has(key)) continue;
        this.done.add(key);
        try {
          await task.run();
          this.completed.push({ cardId: card.id, kind: task.kind, during: loading });
        } catch (err) {
          this.opts.log?.(
            `overlap: ${task.kind} for ${card.id} failed while ${loading} loaded: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }
}

/**
 * A queued card's CPU-side work (C9): the ranked repo map its first step
 * builds, and the data contracts its context assembly reads — run on the
 * repository while a model loads, so the files are parsed and in the page
 * cache when the card starts.
 */
export function cardOverlapTasks(repoPath: string, card: CardRecord): OverlapTask[] {
  const scope = card.scopeFiles ?? [];
  return [
    {
      kind: "repo_map",
      run: async () => {
        buildRankedRepoMap(repoPath, {
          scopeFiles: scope,
          budgetTokens: 1200,
          ...(card.spec ? { specText: card.spec } : {}),
        });
      },
    },
    {
      kind: "context",
      run: async () => {
        dataContracts(repoPath, scope);
      },
    },
  ];
}

/**
 * The headroom probe (rule 20g), only when the setting turns it on: it stays
 * off until a calibration night sets its reserves on this host (models §4).
 * The default probe is the macOS one, watching the Worker's managed port and
 * a person's own server on 8080 (MD-N14-32); elsewhere there is none.
 */
export function headroomProbeFor(
  enabled: boolean,
  create: () => HeadroomProbe | undefined = defaultHeadroomProbe,
): HeadroomProbe | undefined {
  return enabled ? create() : undefined;
}

function defaultHeadroomProbe(): HeadroomProbe | undefined {
  if (process.platform !== "darwin") return undefined;
  return createDarwinHeadroomProbe({
    watch: [
      { port: 8098, name: "llama-server (Coding model)", ours: true },
      { port: 8080, name: "Hermes", ours: false },
    ],
    ollamaUrl: "http://127.0.0.1:11434",
  });
}

/**
 * The quick answerer (rule 20f b), a setting of the Planner role: its own
 * queue on the Planner's role, admitted only by the measured headroom beside
 * what is resident and never evicting anything. `undefined` when none is named.
 */
export function quickAnswererFor(
  access: Pick<ModelAccess, "ensureQueue" | "admits" | "holdBeside">,
  name: string,
):
  | { name: string; admitted: () => Promise<boolean>; acquire: () => Promise<ModelHold> }
  | undefined {
  const model = name.trim();
  if (!model) return undefined;
  access.ensureQueue({ queue: "quick", role: "planner", name: model });
  return {
    name: model,
    admitted: async () => (await access.admits("quick")).ok,
    acquire: () => access.holdBeside("quick"),
  };
}

/** How the queue treats Smart Swap this run (measurement rule 16d, rule 20b). */
export function queueSwapMode(
  repoPath: string,
  argv: readonly string[],
): { mode: "live" | "measurement" | "calibration" } | { refused: string } {
  const marker = readMeasurementMarker(repoPath);
  const night = argv.includes("--calibration-night");
  if (night && marker)
    return {
      refused: `A calibration night never runs during a measurement run: this repository is marked for the ${marker.purpose}.`,
    };
  if (night && !argv.includes("--permit-loads"))
    return {
      refused:
        "A calibration night loads models as the policy chooses: the owner permits it with --permit-loads (the host limits are still checked before each load).",
    };
  if (night) return { mode: "calibration" };
  if (marker) return { mode: "measurement" };
  return { mode: "live" };
}

/**
 * The DEC-42 host reading before a calibration night's load: swap in use and
 * the share of memory free, the page cache C10 warmed counted as free (it is
 * reclaimable, never used memory).
 */
export function calibrationHostReading(r: {
  swapUsedBytes: number;
  freeBytes: number;
  totalBytes: number;
  warmedBytes?: number;
}): { swapUsedBytes: number; freeRatio: number } {
  const free = Math.min(r.totalBytes, r.freeBytes + (r.warmedBytes ?? 0));
  return { swapUsedBytes: r.swapUsedBytes, freeRatio: r.totalBytes > 0 ? free / r.totalBytes : 0 };
}

/**
 * A calibration night's load-mode A/B (models rule 20h, MD-N14-34; live-test
 * F13): for each llama.cpp model, with nothing resident, the modes alternate
 * on its weights, `perMode` loads each (at least three), every load checked
 * against DEC-42's host limits first. Each load, its first token (streamed),
 * its unload (timed alone) and the adapter's own unload check are recorded
 * through the scheduler's swap-cost tracker, then the A/B with the cache
 * state it compared (`runLoadModeAb`). A refusal or failure ends that
 * model's A/B, unloads it, and is returned; the night goes on.
 */
export async function calibrationLoadModeAbs(
  scheduler: Pick<ResidencyScheduler, "releaseAll" | "calibrationAdapter" | "swapCost">,
  deps: {
    models: string[];
    host: () =>
      | { swapUsedBytes: number; freeRatio: number }
      | Promise<{ swapUsedBytes: number; freeRatio: number }>;
    record: (event: { type: string; payload: object }) => void | Promise<void>;
    now?: () => number;
    perMode?: number;
  },
): Promise<{ abs: LoadModeAbPayload[]; skipped: { model: string; reason: string }[] }> {
  const now = deps.now ?? Date.now;
  const abs: LoadModeAbPayload[] = [];
  const skipped: { model: string; reason: string }[] = [];
  const tracker = scheduler.swapCost;
  await tracker.ready();
  await scheduler.releaseAll();
  for (const model of deps.models) {
    const cal = scheduler.calibrationAdapter(model);
    const adapter = cal?.adapter;
    if (!cal || !adapter?.load || !adapter.unload || adapter.engine !== "llama.cpp") {
      skipped.push({ model, reason: "not a llama.cpp model Sekhemet loads" });
      continue;
    }
    const source = await adapter.weightsSource?.().catch(() => undefined);
    if (!source) {
      skipped.push({ model, reason: "its weights file is unknown" });
      continue;
    }
    const volume = tracker.volumeOf(source.path);
    // Only a server this A/B started is ever stopped here.
    let ours = false;
    try {
      abs.push(
        await runLoadModeAb({
          model,
          roles: [cal.role],
          volume,
          engine: "llama.cpp",
          bytes: source.bytes,
          coldBytesPerSecond: tracker.book.readRate(volume).bytesPerSecond,
          tracker,
          now,
          ...(deps.perMode !== undefined ? { perMode: deps.perMode } : {}),
          load: async (mode) => {
            const verdict = dec42HostCheck(await deps.host());
            if (!verdict.ok) throw new Error(`Not loading ${model}: ${verdict.reason}`);
            const outcome = await adapter.load?.(undefined, { loadMode: mode });
            ours = outcome === "loaded";
            // A server already running is adopted, not loaded: nothing to time.
            if (outcome === "adopted")
              throw new Error(
                `${model}'s server was already running; the A/B times only its own loads`,
              );
          },
          firstToken: async () => {
            const asked = now();
            let first: number | undefined;
            await cal.generate({
              prompt: LOAD_PROBE_PROMPT,
              toolArm: "arm_a_flat",
              reasoning: "off",
              maxTokens: 1,
              onToken: () => {
                first ??= now() - asked;
              },
            });
            return first;
          },
          unload: async () => {
            await adapter.unload?.();
            ours = false;
          },
          confirmUnloaded: async () =>
            (await adapter.confirmUnloaded?.(UNLOAD_CONFIRM_MS)) ?? false,
          record: deps.record,
        }),
      );
    } catch (err) {
      skipped.push({ model, reason: err instanceof Error ? err.message : String(err) });
      if (ours) {
        await adapter.unload().catch(() => undefined);
        await adapter.confirmUnloaded?.(UNLOAD_CONFIRM_MS).catch(() => false);
      }
    }
  }
  return { abs, skipped };
}

/**
 * Start a calibration night on the queue's scheduler (measurement rule 16d,
 * MS-NM14-3), through `runCalibrationNight`: it refuses while a suite or
 * measurement run holds the runner, records the protocol as
 * `measure/calibration` before the first load, checks DEC-42's host limits
 * before each load while the night runs, and at `end()` unloads everything.
 */
export async function beginCalibrationNight(
  access: Pick<ModelAccess, "residency">,
  deps: {
    record: (event: { type: string; payload: object }) => void | Promise<void>;
    runnerHolder: () => RunnerHolder | Promise<RunnerHolder>;
    host: () =>
      | { swapUsedBytes: number; freeRatio: number }
      | Promise<{ swapUsedBytes: number; freeRatio: number }>;
    /** The weights the night will load. */
    models: string[];
    volumes?: ("internal" | "external")[];
    probes?: CalibrationProbe[];
  },
): Promise<{ end: () => Promise<{ hostRefusals: string[] }> } | { refused: string }> {
  let finish!: () => void;
  const finished = new Promise<void>((r) => {
    finish = r;
  });
  let began!: () => void;
  const started = new Promise<"began">((r) => {
    began = () => r("began");
  });
  const modes = ["mmap", "no_mmap", "preread_mmap"] as const;
  const running = runCalibrationNight({
    protocol: {
      policy: DEFAULT_SWAP_POLICY,
      models: deps.models,
      volumes: deps.volumes ?? [],
      loadModes: [...modes],
      abOrder: [...modes],
      loadsPerMode: 3,
      probes: deps.probes ?? ["read_probe", "drive_check"],
      equivalenceCheck: false,
    },
    record: deps.record,
    runnerHolder: deps.runnerHolder,
    host: deps.host,
    scheduler: access.residency,
    night: async () => {
      // Live-test F13: the load-mode A/B first, with nothing else resident.
      const ab = await calibrationLoadModeAbs(access.residency, {
        models: deps.models,
        host: deps.host,
        record: deps.record,
      });
      for (const s of ab.skipped)
        if (!/^not a llama\.cpp|file is unknown/.test(s.reason))
          process.stderr.write(`[calibration] load-mode A/B of ${s.model} stopped: ${s.reason}\n`);
      began();
      await finished;
    },
  });
  const first = await Promise.race([started, running]);
  if (first !== "began") return { refused: first.refused ?? "the calibration night did not start" };
  return {
    end: async () => {
      finish();
      const r = await running;
      return { hostRefusals: r.hostRefusals };
    },
  };
}
