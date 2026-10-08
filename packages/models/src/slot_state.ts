import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * KV slots and prefix state: the first latency lever (models rule 20i,
 * NEW-models-14, MD-N14-36, MD-N14-37).
 *
 * Live sessions (Seshat's thread, a card mid-attempt, all N slots) and each
 * role's stable prefix are saved through llama-server's slot save and
 * restore (`--slot-save-path`; `POST /slots/<id>?action=save|restore`) when
 * their weights leave, and restored on return when K (restore) < R
 * (re-prefill). They are **caches, never evidence**:
 *
 * - each file is keyed by (weights hash, engine build, context, KV type,
 *   template), and one whose key differs is never restored;
 * - no decision reads them: `decide()` (rule 20e) never imports this module;
 * - a slot whose prompt text a `ledger/erased` event covers is deleted. Each
 *   slot's manifest names the ledger events and blobs its prompt was built
 *   from (ids only, never text); a slot whose sources are unknown is deleted
 *   on any erasure newer than the last sweep.
 * - a card's live slot mid-attempt is re-prefilled, not restored, until an
 *   equivalence check has passed on a calibration night (measurement rules
 *   16a and 16d).
 */

export interface SlotKey {
  /** SHA-256 of the weights (or a fingerprint of them where no hash is recorded). */
  weightsHash: string;
  /** The engine's build (`/props` `build_info`). */
  engineBuild: string;
  contextTokens: number;
  kvType: string;
  /** SHA-256 of the chat template. */
  template: string;
}

/** Sixteen hex characters naming a key; files of another key are never restored. */
export function slotKeyId(key: SlotKey): string {
  const canonical = JSON.stringify([
    key.weightsHash,
    key.engineBuild,
    key.contextTokens,
    key.kvType,
    key.template,
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** A card's live session, a person's thread, or a role's stable prefix. */
export type SlotKind = "live_card" | "thread" | "prefix";

export interface SlotManifest {
  /** The slot file's name inside the slot directory. */
  file: string;
  keyId: string;
  key: SlotKey;
  kind: SlotKind;
  /** The card, thread or role the slot belongs to. */
  owner: string;
  slot: number;
  /** Ledger event and blob ids the prompt was built from; absent: unknown. */
  sources?: string[];
  savedAt: number;
  bytes: number;
  saveMs: number;
  /** The last measured restore (K). */
  restoreMs?: number;
  /**
   * The process that saved this slot for its engine's return (MD-N14-37a):
   * while it is alive the cap never deletes the slot; released on restore.
   */
  heldBy?: number;
}

export type RestoreOutcome =
  | { action: "restored"; ms: number; manifest: SlotManifest }
  | {
      action: "reprefill";
      reason:
        | "no_file"
        | "key_mismatch"
        | "live_card_unverified"
        | "slower_than_prefill"
        | "failed";
    };

export interface SlotStoreOptions {
  /** The server's `--slot-save-path`. */
  dir: string;
  /** The llama-server the slots live in. */
  serverUrl: string;
  now?: () => number;
  /** The slot directory's volume read rate, for K before a slot's first restore. */
  readBytesPerSecond: number;
  /** The directory's cap; every save prunes to it (MD-N14-37a). Unset: no cap. */
  maxBytes?: number;
}

/** The managed servers' `--slot-save-path`: `SEKHEMET_SLOT_CACHE`, else a directory in the temp dir. */
export function defaultSlotCacheDir(): string {
  return process.env.SEKHEMET_SLOT_CACHE ?? join(tmpdir(), "sekhemet-slots");
}

/** The slot directory's cap (MD-N14-37a): `SEKHEMET_SLOT_CACHE_MAX_GB`, else 8 GiB. */
export function slotCacheMaxBytes(): number {
  const gb = Number(process.env.SEKHEMET_SLOT_CACHE_MAX_GB);
  return Number.isFinite(gb) && gb > 0 ? Math.round(gb * 1024 ** 3) : 8 * 1024 ** 3;
}

/**
 * Prune a slot directory to its cap without a server (the supervisor's
 * start-up pass, MD-N14-37a): the files deleted.
 */
export function pruneSlotCache(dir: string, maxBytes = slotCacheMaxBytes()): string[] {
  if (!existsSync(dir)) return [];
  return new SlotStore({ dir, serverUrl: "", readBytesPerSecond: 1 }).prune(maxBytes);
}

/** A slot file with no manifest younger than this may be a save still being written. */
const WRITING_MS = 10 * 60_000;

const alive = (pid: number): boolean => {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, owned by someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Sweep a slot directory by the ledger's erasures without a server (the
 * supervisor's start-up pass, MD-N14-37): the files deleted.
 */
export function sweepErasedSlots(dir: string, index: ErasureView): string[] {
  if (!existsSync(dir)) return [];
  return new SlotStore({ dir, serverUrl: "", readBytesPerSecond: 1 }).sweepErased(index);
}

/** What `sweepErased` reads: the ledger's erasure index (`EventLog.erasureIndex()`). */
export interface ErasureView {
  byEvent: ReadonlyMap<string, unknown>;
  byBlob: ReadonlyMap<string, unknown>;
}

const WATERMARK = "erasures.seen";

const safe = (s: string) => s.replace(/[^\w.-]/g, "_");

export class SlotStore {
  constructor(private readonly options: SlotStoreOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private manifests(): SlotManifest[] {
    if (!existsSync(this.options.dir)) return [];
    return readdirSync(this.options.dir)
      .filter((f) => f.endsWith(".bin.json"))
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(this.options.dir, f), "utf8")) as SlotManifest];
        } catch {
          return [];
        }
      });
  }

  /** Every slot this store has saved. */
  public list(): SlotManifest[] {
    return this.manifests();
  }

  private latest(owner: string, kind: SlotKind): SlotManifest | undefined {
    return this.manifests()
      .filter((m) => m.owner === owner && m.kind === kind)
      .sort((a, b) => a.savedAt - b.savedAt)
      .at(-1);
  }

  private writeManifest(m: SlotManifest): void {
    writeFileSync(join(this.options.dir, `${m.file}.json`), JSON.stringify(m));
  }

  /**
   * K: the last measured restore of this owner's slot, else its size at the
   * volume's read rate; before a slot's first save, `estimatedBytes` at that
   * rate (MD-N14-36).
   */
  public estimateRestoreMs(s: { owner: string; kind: SlotKind; estimatedBytes?: number }): number {
    const m = this.latest(s.owner, s.kind);
    if (m?.restoreMs !== undefined) return m.restoreMs;
    const bytes = m?.bytes ?? s.estimatedBytes ?? 0;
    return Math.round((bytes / this.options.readBytesPerSecond) * 1000);
  }

  private async post(slot: number, action: "save" | "restore", filename: string) {
    const res = await fetch(`${this.options.serverUrl}/slots/${slot}?action=${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`slot ${action} answered ${res.status}`);
    return (await res.json()) as { n_written?: number; n_read?: number };
  }

  /**
   * Save a slot on the server under its keyed name, with its manifest; `hold`
   * keeps it from the cap while this process lives (its engine restores it on
   * return, MD-N14-37a). Then prune the directory to its cap, this file kept.
   */
  public async save(s: {
    slot: number;
    kind: SlotKind;
    owner: string;
    key: SlotKey;
    sources?: string[];
    hold?: boolean;
  }): Promise<SlotManifest | undefined> {
    mkdirSync(this.options.dir, { recursive: true });
    const keyId = slotKeyId(s.key);
    const file = `${safe(s.owner)}.${s.kind}.${keyId}.bin`;
    const start = this.now();
    const body = await this.post(s.slot, "save", file);
    const saveMs = this.now() - start;
    const path = join(this.options.dir, file);
    const bytes = body.n_written ?? (existsSync(path) ? statSync(path).size : 0);
    // A newer save of the same owner and kind replaces an older one of another key.
    for (const old of this.manifests().filter(
      (m) => m.owner === s.owner && m.kind === s.kind && m.file !== file,
    ))
      this.remove(old);
    const manifest: SlotManifest = {
      file,
      keyId,
      key: s.key,
      kind: s.kind,
      owner: s.owner,
      slot: s.slot,
      ...(s.sources ? { sources: [...s.sources] } : {}),
      savedAt: this.now(),
      bytes,
      saveMs,
      ...(s.hold ? { heldBy: process.pid } : {}),
    };
    this.writeManifest(manifest);
    if (this.options.maxBytes !== undefined) this.prune(this.options.maxBytes, file);
    return manifest;
  }

  /**
   * Delete slot files oldest-saved first until the directory's slot files
   * fit `maxBytes` (MD-N14-37a). Never a manifest-less file younger than ten
   * minutes (a save still being written) or `keep`. A slot whose `heldBy`
   * process is alive is passed over while the others can make room; when
   * they cannot — one long-lived process (`serve`, `queue`, an overnight
   * run) saved more cards' slots for their return than the cap holds — the
   * held ones go too, oldest first, so the cap holds for as long as a
   * process lives (F31): a card whose slot went re-prefills on return.
   * Returns the files deleted.
   */
  public prune(maxBytes: number, keep?: string): string[] {
    const dir = this.options.dir;
    if (!existsSync(dir)) return [];
    const size = (f: string) => {
      try {
        return statSync(join(dir, f)).size;
      } catch {
        return 0;
      }
    };
    const manifests = this.manifests();
    const named = new Set(manifests.map((m) => m.file));
    type Entry = { file: string; at: number; bytes: number; manifest?: SlotManifest };
    const entries: Entry[] = [
      ...manifests.map((m) => ({ file: m.file, at: m.savedAt, bytes: size(m.file), manifest: m })),
      ...readdirSync(dir)
        .filter((f) => f.endsWith(".bin") && !named.has(f))
        .map((f) => {
          let at = 0;
          try {
            at = statSync(join(dir, f)).mtimeMs;
          } catch {
            // Gone meanwhile.
          }
          return { file: f, at, bytes: size(f) };
        }),
    ];
    let total = entries.reduce((n, e) => n + e.bytes, 0);
    const deleted: string[] = [];
    // A file's age is read against the wall clock: its mtime is the file system's.
    const wall = Date.now();
    const oldestFirst = entries.sort((a, b) => a.at - b.at);
    const held = (e: Entry) => e.manifest?.heldBy !== undefined && alive(e.manifest.heldBy);
    for (const pass of ["unheld", "held"] as const) {
      for (const e of oldestFirst) {
        if (total <= maxBytes) break;
        if (e.file === keep || deleted.includes(e.file)) continue;
        if (pass === "unheld" && held(e)) continue;
        if (!e.manifest && wall - e.at < WRITING_MS) continue;
        rmSync(join(dir, e.file), { force: true });
        rmSync(join(dir, `${e.file}.json`), { force: true });
        total -= e.bytes;
        deleted.push(e.file);
      }
    }
    return deleted;
  }

  /** Save only when restoring would beat re-prefilling: K < R (MD-N14-36). */
  public async saveIfWorth(s: {
    slot: number;
    kind: SlotKind;
    owner: string;
    key: SlotKey;
    sources?: string[];
    estimatedBytes: number;
    reprefillMs: number;
  }): Promise<SlotManifest | undefined> {
    const k = this.estimateRestoreMs(s);
    if (k >= s.reprefillMs) return undefined;
    return this.save(s);
  }

  /** Whether a return restores or re-prefills, reading only the manifest. */
  public planRestore(s: {
    owner: string;
    kind: SlotKind;
    key: SlotKey;
    reprefillMs: number;
    equivalencePassed?: boolean;
  }):
    | { action: "restore"; manifest: SlotManifest }
    | { action: "reprefill"; reason: Exclude<RestoreOutcome, { action: "restored" }>["reason"] } {
    const m = this.latest(s.owner, s.kind);
    if (!m || !existsSync(join(this.options.dir, m.file)))
      return { action: "reprefill", reason: "no_file" };
    if (m.keyId !== slotKeyId(s.key)) return { action: "reprefill", reason: "key_mismatch" };
    if (s.kind === "live_card" && s.equivalencePassed !== true)
      return { action: "reprefill", reason: "live_card_unverified" };
    if (this.estimateRestoreMs(s) >= s.reprefillMs)
      return { action: "reprefill", reason: "slower_than_prefill" };
    return { action: "restore", manifest: m };
  }

  /** Restore a slot when its key matches and K < R; otherwise the caller re-prefills. */
  public async restore(s: {
    slot: number;
    kind: SlotKind;
    owner: string;
    key: SlotKey;
    reprefillMs: number;
    equivalencePassed?: boolean;
  }): Promise<RestoreOutcome> {
    const plan = this.planRestore(s);
    if (plan.action === "reprefill") return plan;
    const start = this.now();
    try {
      await this.post(s.slot, "restore", plan.manifest.file);
    } catch {
      return { action: "reprefill", reason: "failed" };
    }
    const ms = this.now() - start;
    // Restored: the engine holds it in memory now, so the file is released.
    const { heldBy: _released, ...rest } = plan.manifest;
    const manifest = { ...rest, restoreMs: ms };
    this.writeManifest(manifest);
    return { action: "restored", ms, manifest };
  }

  private remove(m: SlotManifest): void {
    rmSync(join(this.options.dir, m.file), { force: true });
    rmSync(join(this.options.dir, `${m.file}.json`), { force: true });
  }

  /**
   * Delete every slot whose prompt text an erasure covers (MD-N14-37): a
   * source among the erased events or blobs, or unknown sources when an
   * erasure is newer than the last sweep. Returns the files deleted.
   */
  public sweepErased(index: ErasureView): string[] {
    const seqOf = (v: unknown): number =>
      typeof v === "number"
        ? v
        : typeof v === "object" &&
            v !== null &&
            typeof (v as { erasedBySeq?: unknown }).erasedBySeq === "number"
          ? ((v as { erasedBySeq: number }).erasedBySeq as number)
          : 0;
    const newest = Math.max(0, ...[...index.byEvent.values(), ...index.byBlob.values()].map(seqOf));
    const markPath = join(this.options.dir, WATERMARK);
    const seen = existsSync(markPath) ? Number(readFileSync(markPath, "utf8")) || 0 : 0;
    const deleted: string[] = [];
    for (const m of this.manifests()) {
      const covered =
        m.sources === undefined
          ? newest > seen
          : m.sources.some((id) => index.byEvent.has(id) || index.byBlob.has(id));
      if (!covered) continue;
      this.remove(m);
      deleted.push(m.file);
    }
    if (newest > seen && existsSync(this.options.dir)) writeFileSync(markPath, String(newest));
    return deleted;
  }
}
