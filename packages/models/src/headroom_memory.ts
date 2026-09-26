import {
  type GpuCeiling,
  HEADROOM_DEFAULTS,
  type HeadroomParams,
  type HeadroomProbe,
  type MemoryReading,
  type Transition,
  admitLoad,
  checkTransitions,
  gpuCeilingsFrom,
  measureHeadroom,
} from "./headroom.js";
import type { SwapMemorySource } from "./residency.js";

/**
 * The policy's memory read through the headroom probe (models rule 20g,
 * MD-N14-30–31a): `decide()`'s snapshot takes one reading, and from it
 *
 * - **each load's admission** (`admit`): the reading as it would be after
 *   the load's evictions — their footprints leave the GPU's in-use memory,
 *   the wired count and our servers' footprints — then `admitLoad` beside
 *   what stays, with the recorded GPU ceilings (else the seed);
 * - **every transition of a tour** (`tour`, cumulative feasibility): each
 *   unload and load checked in order against what our models may hold
 *   together at that reading (their footprints now plus the headroom), so a
 *   tour with any infeasible step is not chosen;
 * - **free memory for C10's prefetch** (`freeBytes`): the headroom itself,
 *   which already keeps the reserves.
 *
 * Nothing here is read inside `decide()`: the reading is the snapshot's.
 */
export function headroomSwapMemory(opts: {
  probe: HeadroomProbe;
  /** GPU ceilings recorded (configured and on the ledger); none: the seed. */
  ceilings: () => readonly GpuCeiling[];
  now: () => number;
  params?: HeadroomParams;
}): SwapMemorySource {
  const params = opts.params ?? HEADROOM_DEFAULTS;
  return {
    async read(view) {
      const reading = await opts.probe.read();
      const now = opts.now();
      const ceilings = gpuCeilingsFrom([...opts.ceilings()]);
      const fp = (w: string) => view.footprints[w];
      const room = measureHeadroom(reading, {}, params);
      const gone = (evict: readonly string[]) => evict.reduce((n, w) => n + (fp(w) ?? 0), 0);
      return {
        freeBytes: Math.max(0, room.bytes),
        admit: ({ load, evict, resident }) => {
          const verdict = admitLoad({
            reading: afterEvicting(reading, gone(evict)),
            candidate: { weights: load, footprintBytes: fp(load) },
            resident: resident
              .filter((w) => w !== load && !evict.includes(w))
              .map((w) => ({ weights: w, footprintBytes: fp(w) ?? 0 })),
            now,
            ceilings,
            params,
          });
          return verdict.verdict === "admit" ? { ok: true } : { ok: false, reason: verdict.reason };
        },
        tour: (steps, resident) => {
          const held = resident.reduce((n, w) => n + (fp(w) ?? 0), 0);
          const limitBytes = held + Math.max(0, room.bytes);
          const transitions: Transition[] = steps.flatMap((s) => [
            ...s.evict.map((id): Transition => ({ kind: "release", id })),
            {
              kind: "load",
              id: s.load,
              weights: fp(s.load) ?? Number.POSITIVE_INFINITY,
              kv: 0,
              engine: 0,
              promptCache: 0,
            } satisfies Transition,
          ]);
          const r = checkTransitions({
            limitBytes,
            resident: resident.map((id) => ({
              id,
              weights: fp(id) ?? 0,
              kv: 0,
              engine: 0,
              promptCache: 0,
            })),
            steps: transitions,
          });
          if (r.feasible) return { ok: true };
          const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;
          return {
            ok: false,
            reason: `the tour's transition ${(r.failedAt ?? 0) + 1} would hold ${gb(r.peakBytes)}, over the ${gb(limitBytes)} the headroom leaves our models`,
          };
        },
      };
    },
  };
}

/** The reading as it would be once `bytes` of our resident models have left. */
function afterEvicting(r: MemoryReading, bytes: number): MemoryReading {
  if (bytes <= 0) return r;
  const oursTotal = r.processes.filter((p) => p.ours).reduce((n, p) => n + p.footprintBytes, 0);
  const others = r.processes.filter((p) => !p.ours);
  const oursLeft = Math.max(0, oursTotal - bytes);
  return {
    ...r,
    metalInUseBytes: Math.max(0, r.metalInUseBytes - bytes),
    // Metal's buffers count as wired on Apple silicon; startLoad re-reads after the evictions.
    wiredBytes: Math.max(0, r.wiredBytes - bytes),
    processes:
      oursLeft > 0
        ? [...others, { pid: 0, name: "our servers", footprintBytes: oursLeft, ours: true }]
        : others,
  };
}
