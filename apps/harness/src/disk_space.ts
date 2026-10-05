import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync, statfsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Free space on the volumes Sekhemet writes to (runtime item 34c,
 * NEW-runtime-13: RUN-69, RUN-70, RUN-83). Before a card or a backup starts,
 * the volume of every folder it writes is read; below the floor nothing
 * starts, and the stop `disk_low` (worker-loop's table, NEW-worker-loop-11)
 * names the volume, its free space against the floor and the largest
 * consumers under `.sekhemet/`. `freeSpaceOf` is also `doctor`'s reader
 * (RUN-71).
 *
 * The floor is *policy*: 5 GB, or twice the largest worktree under any
 * checked root's `.sekhemet/worktrees` when that is larger (C4's design
 * call: computed at check time from the worktrees on disk, so no durable
 * state is kept outside the ledger).
 */

export const FREE_SPACE_FLOOR_BYTES = 5 * 1024 ** 3;

export interface VolumeSpace {
  /** The first path checked on this volume. */
  path: string;
  /** The volume's mount point. */
  mount: string;
  freeBytes: number;
  totalBytes: number;
}

export interface Consumer {
  path: string;
  bytes: number;
}

export type FreeSpaceCheck =
  | { ok: true; volumes: VolumeSpace[]; floorBytes: number }
  | {
      ok: false;
      volumes: VolumeSpace[];
      floorBytes: number;
      /** The volume below the floor (the first one, when several are). */
      short: VolumeSpace;
      /** The largest consumers under `.sekhemet/` of the roots on that volume, largest first. */
      consumers: Consumer[];
    };

/** The nearest existing folder at or above `path`. */
function existing(path: string): string {
  let p = resolve(path);
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  return realpathSync(p);
}

/** The mount point of the volume `path` is on: the highest ancestor on the same device. */
function mountOf(path: string): string {
  let p = path;
  const dev = statSync(p).dev;
  for (;;) {
    const up = dirname(p);
    if (up === p) return p;
    try {
      if (statSync(up).dev !== dev) return p;
    } catch {
      return p;
    }
    p = up;
  }
}

/** The free and total space of the volume `path` (or its nearest existing ancestor) is on. */
export function freeSpaceOf(path: string): VolumeSpace {
  const at = existing(path);
  const s = statfsSync(at);
  return {
    path: at,
    mount: mountOf(at),
    freeBytes: Number(s.bavail) * Number(s.bsize),
    totalBytes: Number(s.blocks) * Number(s.bsize),
  };
}

/** Bytes on disk under `path` (`du -sk`, a git worktree's `.git` being a pointer file). */
export function bytesUnder(path: string): number {
  try {
    const out = execFileSync("du", ["-sk", path], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return Number(out.trim().split(/\s+/)[0] ?? 0) * 1024;
  } catch (err) {
    // `du` reports what it could read and exits non-zero on an unreadable entry.
    const out = String((err as { stdout?: unknown }).stdout ?? "");
    return Number(out.trim().split(/\s+/)[0] ?? 0) * 1024;
  }
}

function worktreesOf(root: string): Consumer[] {
  const dir = join(root, ".sekhemet", "worktrees");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ path: join(dir, d.name), bytes: bytesUnder(join(dir, d.name)) }));
}

/**
 * The floor for a check over `roots`: `minBytes` (5 GB), or twice the
 * largest worktree under any root's `.sekhemet/worktrees` when larger.
 */
export function freeSpaceFloor(
  roots: readonly string[],
  minBytes = FREE_SPACE_FLOOR_BYTES,
): { floorBytes: number; largestWorktree?: Consumer } {
  let largest: Consumer | undefined;
  for (const root of new Set(roots)) {
    for (const w of worktreesOf(root)) if (!largest || w.bytes > largest.bytes) largest = w;
  }
  return {
    floorBytes: Math.max(minBytes, 2 * (largest?.bytes ?? 0)),
    ...(largest ? { largestWorktree: largest } : {}),
  };
}

/**
 * The largest consumers under the roots' `.sekhemet/` folders: each worktree
 * on its own, then every other top-level entry (blobs, evidence, the ledger,
 * logs), largest first.
 */
export function largestConsumers(roots: readonly string[], n = 3): Consumer[] {
  const all: Consumer[] = [];
  for (const root of new Set(roots)) {
    const state = join(root, ".sekhemet");
    if (!existsSync(state)) continue;
    all.push(...worktreesOf(root));
    for (const d of readdirSync(state, { withFileTypes: true })) {
      if (d.name === "worktrees") continue;
      all.push({ path: join(state, d.name), bytes: bytesUnder(join(state, d.name)) });
    }
  }
  return all
    .filter((c) => c.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, n);
}

/**
 * Read the free space of every volume the `paths` are on (each once) and
 * compare it with the floor (RUN-69, RUN-83). `floorBytes` overrides the
 * computed floor (`ExecutionContext.freeSpaceFloorBytes`).
 */
export function checkFreeSpace(
  paths: readonly string[],
  options: { floorBytes?: number } = {},
): FreeSpaceCheck {
  const volumes: VolumeSpace[] = [];
  const roots: string[] = [];
  for (const p of paths) {
    const v = freeSpaceOf(p);
    roots.push(v.path);
    if (!volumes.some((w) => w.mount === v.mount)) volumes.push(v);
  }
  const floorBytes = options.floorBytes ?? freeSpaceFloor(roots).floorBytes;
  const short = volumes.find((v) => v.freeBytes < floorBytes);
  if (!short) return { ok: true, volumes, floorBytes };
  const onShort = roots.filter((r) => mountOf(r) === short.mount);
  return {
    ok: false,
    volumes,
    floorBytes,
    short,
    consumers: largestConsumers(onShort),
  };
}

/** Bytes as a person reads them: `4.2 GB`, `310.0 MB`. */
export function formatBytes(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} bytes` : `${v.toFixed(1)} ${units[i]}`;
}

type ShortCheck = Extract<FreeSpaceCheck, { ok: false }>;

/** The sentence a `disk_low` stop says (worker-loop's next action, with the facts). */
export function describeDiskLow(check: ShortCheck, path?: string): string {
  const consumers = check.consumers.map((c) => `${c.path} (${formatBytes(c.bytes)})`);
  return [
    `The disk is nearly full: ${check.short.mount} has ${formatBytes(check.short.freeBytes)} free of a ${formatBytes(check.floorBytes)} floor`,
    path ? `; writing ${path} failed` : "",
    consumers.length > 0 ? `. Largest under .sekhemet/: ${consumers.join(", ")}` : "",
    ". Free some space, then resume.",
  ].join("");
}

/** The structural facts of a `disk_low` stop, for `stopDetail` and `machine/disk_low`. */
export function diskLowDetail(check: ShortCheck, path?: string): Record<string, unknown> {
  return {
    volume: check.short.mount,
    freeBytes: check.short.freeBytes,
    floorBytes: check.floorBytes,
    consumers: check.consumers,
    ...(path ? { path } : {}),
  };
}

/** No card starts: a volume it writes to is below the floor (RUN-69). */
export class DiskLowError extends Error {
  constructor(public readonly check: ShortCheck) {
    super(describeDiskLow(check));
    this.name = "DiskLowError";
  }
}
