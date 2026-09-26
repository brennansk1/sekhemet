import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Graded, NumberGrade } from "./library_types.js";
import { sha256File } from "./model_scan.js";
import type { Volume } from "./swap_cost.js";

/**
 * Placement (models rule 20k, MD-N14-41; dashboard DB-NM14-7, DB-NM14-8):
 * where the weights sit decides how long a swap takes. A copy to internal
 * storage is valued at swaps per day × (L_external − L_internal) and costs
 * its size, so the copies are chosen as a 0/1 knapsack over the internal
 * space above the 20 GB kept free for swap files and worktrees — ranked, as
 * the page shows, by the time saved per GB. Only a person's click copies
 * (`copyToInternal`); the copy is verified by SHA-256 before the registry
 * points to it, a copy whose hash differs is deleted, and the original is
 * never touched. An internal copy with the same hash that already exists is
 * recognised and preferred rather than copied again.
 */

/** Internal space kept free for swap files and worktrees (MD-N14-41). */
export const KEEP_FREE_BYTES = 20e9;
/** The knapsack's unit: 0.1 GB. */
const UNIT = 1e8;

export interface PlacementCandidate {
  model: string;
  name: string;
  sizeBytes: number;
  path: string;
  volume: Volume;
  sha256?: string;
  /** Swaps of this model per day: from the replay of the person's cards (rule 20j). */
  swapsPerDay: Graded;
  /** Cold load time from where it sits, and predicted from internal storage. */
  loadExternalMs: Graded;
  loadInternalMs: Graded;
  /** A found internal file with the same hash (the registry prefers it). */
  internalCopy?: string;
}

export interface PlacementRow {
  model: string;
  name: string;
  sizeBytes: number;
  /** The loading time a copy saves per day. */
  savedPerDayMs: Graded;
  /** The ranking the page shows: milliseconds saved per day per GB. */
  savedPerGbMs: number;
  suggested: boolean;
  reason: string;
  internalCopy?: string;
}

export interface PlacementAdvice {
  rows: PlacementRow[];
  suggested: string[];
  internalFreeBytes: Graded;
  keepFreeBytes: number;
  /** Internal space free after the suggested copies. */
  freeAfterBytes: number;
}

const combine = (...g: NumberGrade[]): NumberGrade =>
  g.every((x) => x === "measured")
    ? "measured"
    : g.every((x) => x === "design")
      ? "design"
      : "estimated";

const minutes = (ms: number) => Math.round(ms / 60_000);

/** The copies to suggest (MD-N14-41, DB-NM14-7). Pure. */
export function advisePlacement(input: {
  candidates: readonly PlacementCandidate[];
  internalFreeBytes: Graded;
  keepFreeBytes?: number;
}): PlacementAdvice {
  const keep = input.keepFreeBytes ?? KEEP_FREE_BYTES;
  const budget = Math.max(0, input.internalFreeBytes.value - keep);
  const rows: PlacementRow[] = [];
  const items: { i: number; w: number; v: number }[] = [];
  for (const c of input.candidates) {
    if (c.volume === "internal") continue;
    const perSwap = Math.max(0, c.loadExternalMs.value - c.loadInternalMs.value);
    const saved = c.swapsPerDay.value * perSwap;
    const row: PlacementRow = {
      model: c.model,
      name: c.name,
      sizeBytes: c.sizeBytes,
      savedPerDayMs: {
        value: saved,
        grade: combine(c.swapsPerDay.grade, c.loadExternalMs.grade, c.loadInternalMs.grade),
      },
      savedPerGbMs: c.sizeBytes > 0 ? saved / (c.sizeBytes / 1e9) : 0,
      suggested: false,
      reason: "",
    };
    if (c.internalCopy) {
      row.internalCopy = c.internalCopy;
      row.reason =
        "An internal copy with the same hash already exists: use it and loads come from internal storage, with nothing copied.";
    } else if (saved <= 0) {
      row.reason = "It is not swapped in on a typical day, so a copy would save no loading time.";
    } else if (c.sizeBytes > budget) {
      row.reason = `Not suggested: copying it would leave less than 20 GB free on internal storage (${(input.internalFreeBytes.value / 1e9).toFixed(1)} GB free now).`;
    } else {
      items.push({ i: rows.length, w: Math.ceil(c.sizeBytes / UNIT), v: saved });
    }
    rows.push(row);
  }
  // 0/1 knapsack over the space above the 20 GB kept free.
  const cap = Math.floor(budget / UNIT);
  const best = new Float64Array(cap + 1);
  const keepTable: Uint8Array[] = items.map(() => new Uint8Array(cap + 1));
  items.forEach((it, k) => {
    for (let c = cap; c >= it.w; c--) {
      const withIt = (best[c - it.w] as number) + it.v;
      if (withIt > (best[c] as number)) {
        best[c] = withIt;
        (keepTable[k] as Uint8Array)[c] = 1;
      }
    }
  });
  const chosen = new Set<number>();
  let c = cap;
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k] as { i: number; w: number };
    if ((keepTable[k] as Uint8Array)[c]) {
      chosen.add(it.i);
      c -= it.w;
    }
  }
  let used = 0;
  for (const it of items) {
    const row = rows[it.i] as PlacementRow;
    const swaps = input.candidates.find((x) => x.model === row.model)?.swapsPerDay.value ?? 0;
    if (chosen.has(it.i)) {
      row.suggested = true;
      used += row.sizeBytes;
      row.reason = `Copy to internal storage: saves about ${Math.round(swaps)} swaps' worth of loading, ${minutes(row.savedPerDayMs.value)} minutes a day.`;
    } else {
      row.reason =
        "Not suggested: the other copies save more loading time per GB within the space above the 20 GB kept free.";
    }
  }
  rows.sort((a, b) => b.savedPerGbMs - a.savedPerGbMs);
  return {
    rows,
    suggested: rows.filter((r) => r.suggested).map((r) => r.model),
    internalFreeBytes: input.internalFreeBytes,
    keepFreeBytes: keep,
    freeAfterBytes: input.internalFreeBytes.value - used,
  };
}

/** Free bytes on the volume holding `dir` (its nearest existing ancestor). */
export function freeBytesAt(dir: string): number {
  let at = dir;
  while (!existsSync(at) && at !== "/") at = join(at, "..");
  const s = statfsSync(at);
  return Number(s.bavail) * Number(s.bsize);
}

export class CopyHashMismatch extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      "The copy's hash didn't match the original's, so the copy was deleted and the registry is unchanged.",
    );
    this.name = "CopyHashMismatch";
  }
}

export interface CopyProgress {
  bytes: number;
  total: number;
  state: "running" | "verifying" | "done" | "failed";
}

export interface CopyResult {
  path: string;
  sha256: string;
  bytes: number;
  freeAfterBytes: number;
  /** An internal copy with the same hash was already there. */
  existing?: boolean;
}

/**
 * Copy the weights to internal storage (DB-NM14-8) — called only when a
 * person pressed **Copy**. Refused when it would leave less than 20 GB free;
 * the copy lands in a `.part` file, is hashed as it is written and renamed
 * only when its SHA-256 equals `sha256` (the published or recorded one);
 * otherwise it is deleted. The source is only read.
 */
export async function copyToInternal(input: {
  source: string;
  destDir: string;
  sha256: string;
  freeBytes?: (dir: string) => number;
  keepFreeBytes?: number;
  onProgress?: (p: CopyProgress) => void;
  signal?: AbortSignal;
}): Promise<CopyResult> {
  const size = statSync(input.source).size;
  const keep = input.keepFreeBytes ?? KEEP_FREE_BYTES;
  const free = (input.freeBytes ?? freeBytesAt)(input.destDir);
  const dest = join(input.destDir, basename(input.source));
  if (existsSync(dest) && statSync(dest).size === size) {
    const existing = await sha256File(dest);
    if (existing === input.sha256) {
      input.onProgress?.({ bytes: size, total: size, state: "done" });
      return { path: dest, sha256: existing, bytes: size, freeAfterBytes: free, existing: true };
    }
  }
  if (free - size < keep) {
    throw new Error(
      `Not copied: it would leave ${((free - size) / 1e9).toFixed(1)} GB free, and at least 20 GB is kept free on internal storage.`,
    );
  }
  mkdirSync(input.destDir, { recursive: true });
  const part = `${dest}.part`;
  const hash = createHash("sha256");
  let bytes = 0;
  input.onProgress?.({ bytes: 0, total: size, state: "running" });
  try {
    await new Promise<void>((resolve, reject) => {
      const r = createReadStream(input.source, { flags: "r", highWaterMark: 8 * 1024 * 1024 });
      const w = createWriteStream(part, { flags: "w" });
      const abort = () => r.destroy(new Error("The copy was cancelled."));
      input.signal?.addEventListener("abort", abort, { once: true });
      let last = 0;
      r.on("data", (chunk) => {
        hash.update(chunk);
        bytes += chunk.length;
        if (bytes - last >= 64 * 1024 * 1024) {
          last = bytes;
          input.onProgress?.({ bytes, total: size, state: "running" });
        }
      });
      r.on("error", reject);
      w.on("error", reject);
      w.on("finish", () => resolve());
      r.pipe(w);
    });
  } catch (err) {
    rmSync(part, { force: true });
    input.onProgress?.({ bytes, total: size, state: "failed" });
    throw err;
  }
  input.onProgress?.({ bytes, total: size, state: "verifying" });
  // Verify what is on disk, not only what was read.
  const written = await sha256File(part);
  if (written !== input.sha256 || hash.digest("hex") !== input.sha256) {
    rmSync(part, { force: true });
    input.onProgress?.({ bytes, total: size, state: "failed" });
    throw new CopyHashMismatch(input.sha256, written);
  }
  renameSync(part, dest);
  input.onProgress?.({ bytes, total: size, state: "done" });
  return { path: dest, sha256: written, bytes, freeAfterBytes: free - size };
}
