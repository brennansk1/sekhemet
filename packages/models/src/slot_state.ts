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
}

/** The managed servers' `--slot-save-path`: `SEKHEMET_SLOT_CACHE`, else a directory in the temp dir. */
export function defaultSlotCacheDir(): string {
  return process.env.SEKHEMET_SLOT_CACHE ?? join(tmpdir(), "sekhemet-slots");
}

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

  /** Save a slot on the server under its keyed name, with its manifest. */
  public async save(s: {
    slot: number;
    kind: SlotKind;
    owner: string;
    key: SlotKey;
    sources?: string[];
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
    };
    this.writeManifest(manifest);
    return manifest;
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
    const manifest = { ...plan.manifest, restoreMs: ms };
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
