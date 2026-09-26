import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { matchesScope } from "@sekhemet/kernel";
import {
  LEASE_HEARTBEAT_MS,
  type Lease,
  isLive,
  newLease,
  readLeaseFile,
  removeStaleLease,
  sleepSync,
  startLeaseHeartbeat,
  tryWithLock,
} from "./runner_lease.js";

/**
 * Slot leases (runtime.md item 3, NEW-runtime-6, RUN-35). The qualified
 * engine's parallel capacity N gives N slot leases,
 * `.sekhemet/slots/<n>.lock` for n in 0..N-1, taken and kept as the runner
 * lease is: exclusive creation, the holder's pid, start time and a random
 * token, a heartbeat every 3 s, and stale takeover when the holder is gone.
 * Each running card holds one, with the scope files it declared; a card is
 * admitted under one short admission lock, so of two processes whose cards
 * share a file exactly one starts and the other is told why it waits.
 */

export interface SlotLease extends Lease {
  slot: number;
  cardId: string;
  /** The files the card declared (its scope): no other running card may write them. */
  scopeFiles: string[];
}

export interface SlotConflict {
  cardId: string;
  slot: number;
  files: string[];
}

export type SlotClaim =
  | { granted: true; slot: number; lease: SlotLease; release: () => void }
  | {
      granted: false;
      /** `full`: every slot runs a card; `overlap`: a running card declared the same files; `running`: the card already holds a slot. */
      reason: "full" | "overlap" | "running";
      holders: SlotLease[];
      conflicts: SlotConflict[];
      message: string;
    };

export interface SlotClaimOptions {
  /** N: the qualified parallel capacity (`qualifiedSlotCapacity`). */
  capacity: number;
  cardId: string;
  scopeFiles: readonly string[];
  heartbeatMs?: number;
}

export const slotDir = (repoPath: string) => join(repoPath, ".sekhemet", "slots");
export const slotLeasePath = (repoPath: string, slot: number) =>
  join(slotDir(repoPath), `${slot}.lock`);
const ageMs = (path: string): number => {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};
const admitLock = (repoPath: string) => join(slotDir(repoPath), "admit.lock");

/**
 * N for this install: the Worker's qualified parallel slots (`-np`, the
 * qualification's `parallelSlots`) on a team server; one on a single-user
 * install, where the runner lease already allows one card at a time.
 */
export function qualifiedSlotCapacity(o: {
  mode: "solo" | "team";
  parallelSlots?: number;
}): number {
  if (o.mode !== "team") return 1;
  const n = Math.floor(o.parallelSlots ?? 1);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** Every slot lease file present, live or not, by slot number. */
function slotFiles(repoPath: string): { slot: number; lease: SlotLease | undefined }[] {
  let names: string[];
  try {
    names = readdirSync(slotDir(repoPath));
  } catch {
    return [];
  }
  return names
    .map((n) => /^(\d+)\.lock$/.exec(n)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b)
    .map((slot) => ({
      slot,
      lease: readLeaseFile<SlotLease>(slotLeasePath(repoPath, slot)),
    }));
}

/** The live slot leases, by slot number. */
export function liveSlotLeases(repoPath: string): SlotLease[] {
  return slotFiles(repoPath)
    .map((f) => f.lease)
    .filter((l): l is SlotLease => l !== undefined && isLive(l))
    .sort((a, b) => a.slot - b.slot);
}

const literalPrefix = (glob: string): string => glob.split(/[*?]/)[0] ?? "";
const isGlob = (p: string) => /[*?]/.test(p);

/**
 * The entries of `mine` that could name a file `theirs` names. A card that
 * declares no files may write any file, so it overlaps every card; two globs
 * overlap unless their literal prefixes diverge (conservative: a false
 * overlap costs a wait, a missed one two writers).
 */
export function scopesOverlap(mine: readonly string[], theirs: readonly string[]): string[] {
  if (mine.length === 0 || theirs.length === 0) return ["(any file)"];
  const norm = (p: string) => p.replace(/^\.\//, "");
  return mine.filter((raw) => {
    const f = norm(raw);
    return theirs.some((rawG) => {
      const g = norm(rawG);
      if (matchesScope(f, g) || matchesScope(g, f)) return true;
      if (isGlob(f) && isGlob(g)) {
        const a = literalPrefix(f);
        const b = literalPrefix(g);
        return a.startsWith(b) || b.startsWith(a);
      }
      return false;
    });
  });
}

function conflictsWith(scopeFiles: readonly string[], held: SlotLease[]): SlotConflict[] {
  return held
    .map((h) => ({
      cardId: h.cardId,
      slot: h.slot,
      files: scopesOverlap(scopeFiles, h.scopeFiles),
    }))
    .filter((c) => c.files.length > 0);
}

const overlapMessage = (c: SlotConflict[]): string =>
  `waits for ${c.map((x) => `${x.cardId} (slot ${x.slot}), which is editing ${x.files.join(", ")}`).join("; ")}`;

const fullMessage = (capacity: number, held: SlotLease[]): string =>
  `waits for a free slot: all ${capacity} slot${capacity === 1 ? " is" : "s are"} running (${held.map((h) => h.cardId).join(", ")})`;

/**
 * Why a card would wait now, or undefined when it could start: for the
 * queue standing (teams item 31).
 */
export function slotWaitReason(
  repoPath: string,
  card: { id: string; scopeFiles: readonly string[] },
  capacity: number,
): string | undefined {
  const held = liveSlotLeases(repoPath).filter((h) => h.cardId !== card.id);
  const conflicts = conflictsWith(card.scopeFiles, held);
  if (conflicts.length > 0) return overlapMessage(conflicts);
  if (held.length >= capacity) return fullMessage(capacity, held);
  return undefined;
}

/**
 * Claim a slot for a card, or say why it waits. The admission check (every
 * live slot, the card's files against theirs) and the slot's creation run
 * under one exclusive admission lock, so two processes never admit
 * overlapping cards; the slot file itself is still created with "wx".
 */
export function acquireSlotLease(repoPath: string, options: SlotClaimOptions): SlotClaim {
  mkdirSync(slotDir(repoPath), { recursive: true });
  const scopeFiles = [...options.scopeFiles];
  // Longer than a stale admission lock lives (10 s), so one left by a killed process is taken.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const attempt = tryWithLock(admitLock(repoPath), () => admit(repoPath, options, scopeFiles));
    if (attempt) return attempt.value;
  }
  throw new Error(`Could not take the slot admission lock at ${admitLock(repoPath)}`);
}

function admit(repoPath: string, options: SlotClaimOptions, scopeFiles: string[]): SlotClaim {
  // Stale slots (holder gone, or a recycled pid) are taken over first.
  for (const f of slotFiles(repoPath)) {
    const path = slotLeasePath(repoPath, f.slot);
    if (f.lease && !isLive(f.lease)) removeStaleLease(path, f.lease.token);
    // An empty file left by a holder killed between creating and writing it.
    else if (!f.lease && ageMs(path) > 10_000) rmSync(path, { force: true });
  }
  const held = liveSlotLeases(repoPath);
  const refuse = (
    reason: "full" | "overlap" | "running",
    conflicts: SlotConflict[],
    message: string,
  ) => ({ granted: false, reason, holders: held, conflicts, message }) as const;
  const same = held.find((h) => h.cardId === options.cardId);
  if (same) {
    return refuse("running", [], `is already running in slot ${same.slot} (pid ${same.pid})`);
  }
  const conflicts = conflictsWith(scopeFiles, held);
  if (conflicts.length > 0) return refuse("overlap", conflicts, overlapMessage(conflicts));
  // Slots above a lowered capacity still count: N bounds what runs, not what is numbered.
  if (held.length >= options.capacity) {
    return refuse("full", [], fullMessage(options.capacity, held));
  }
  const taken = new Set(held.map((h) => h.slot));
  for (let slot = 0; slot < options.capacity; slot++) {
    if (taken.has(slot)) continue;
    const path = slotLeasePath(repoPath, slot);
    const lease: SlotLease = { ...newLease(), slot, cardId: options.cardId, scopeFiles };
    const content = () => JSON.stringify({ ...lease, heartbeatAt: new Date().toISOString() });
    let fd: number;
    try {
      fd = openSync(path, "wx");
    } catch (err) {
      // A half-written or unreadable file in a free-looking slot: try the next.
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        sleepSync(1);
        continue;
      }
      throw err;
    }
    try {
      writeSync(fd, content());
    } finally {
      closeSync(fd);
    }
    const release = startLeaseHeartbeat(
      path,
      lease.token,
      content,
      options.heartbeatMs ?? LEASE_HEARTBEAT_MS,
    );
    return { granted: true, slot, lease, release };
  }
  return refuse("full", [], fullMessage(options.capacity, held));
}
