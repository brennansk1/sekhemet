import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "./tokens.js";

/**
 * Evidence storage (Design §420, §430).
 *
 * Masking an observation is only a *deferral* if the full text remains
 * retrievable; otherwise it is silent data loss. Every masked observation and
 * every condensed command output therefore writes its full text here first and
 * carries the returned `EvidenceRef` in the compact pointer that replaces it.
 */

export interface EvidenceMeta {
  /** Tool or command that produced the text, e.g. `run_cmd` or `pnpm test`. */
  producer?: string;
  /** Card the evidence belongs to, when known. */
  cardId?: string;
  /** Turn index the evidence was produced on, when known. */
  turn?: number;
  /** Process exit code, when the producer was a command. */
  exitCode?: number;
}

export interface EvidenceRecord {
  ref: string;
  text: string;
  tokens: number;
  bytes: number;
  createdAt: string;
  meta: EvidenceMeta;
}

export interface EvidenceStore {
  /** Persists `text` and returns its stable `ev_<hash>` reference. */
  put(text: string, meta?: EvidenceMeta): string;
  /** Returns the full text for a reference, or `undefined` when unknown. */
  get(ref: string): string | undefined;
  /** Returns the stored record (text plus accounting) for a reference. */
  getRecord(ref: string): EvidenceRecord | undefined;
  has(ref: string): boolean;
  /** All known references, sorted, so listings are deterministic. */
  refs(): string[];
}

const REF_PREFIX = "ev_";
const REF_HASH_CHARS = 8;

/**
 * Content-addressed reference. Identical output produced twice (a re-run of the
 * same command, say) collapses onto the same ref, which keeps the prompt
 * byte-stable across retries.
 */
export function computeEvidenceRef(text: string): string {
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  return `${REF_PREFIX}${digest.slice(0, REF_HASH_CHARS)}`;
}

export function isEvidenceRef(value: string): boolean {
  return new RegExp(`^${REF_PREFIX}[0-9a-f]{${REF_HASH_CHARS}}$`).test(value);
}

function buildRecord(ref: string, text: string, meta: EvidenceMeta): EvidenceRecord {
  return {
    ref,
    text,
    tokens: estimateTokens(text),
    bytes: Buffer.byteLength(text, "utf8"),
    createdAt: new Date().toISOString(),
    meta,
  };
}

/**
 * Process-local store. Used by default so that `maskOlderObservations` never
 * produces a dangling reference even when the caller supplies no store.
 */
export class InMemoryEvidenceStore implements EvidenceStore {
  private records: Map<string, EvidenceRecord> = new Map();

  public put(text: string, meta: EvidenceMeta = {}): string {
    const ref = computeEvidenceRef(text);
    if (!this.records.has(ref)) {
      this.records.set(ref, buildRecord(ref, text, meta));
    }
    return ref;
  }

  public get(ref: string): string | undefined {
    return this.records.get(ref)?.text;
  }

  public getRecord(ref: string): EvidenceRecord | undefined {
    return this.records.get(ref);
  }

  public has(ref: string): boolean {
    return this.records.has(ref);
  }

  public refs(): string[] {
    return Array.from(this.records.keys()).sort();
  }

  public clear(): void {
    this.records.clear();
  }
}

/**
 * Where observations live under a repository. Not `.sekhemet/evidence`: that
 * directory holds the per-card evidence bundles (`ev_*.json`) that the
 * capability report and the dashboard parse, and an observation header there
 * would be read as a bundle.
 */
export const OBSERVATION_STORE_SUBDIR = join(".sekhemet", "observations");

/**
 * Durable store under `<repoRoot>/.sekhemet/observations` (C6). Full
 * observations stay on disk and remain retrievable by `recall` after the
 * process that masked them has exited.
 */
export class FileEvidenceStore implements EvidenceStore {
  private readonly dir: string;
  private cache: Map<string, EvidenceRecord> = new Map();

  constructor(repoRoot: string, subdir = OBSERVATION_STORE_SUBDIR) {
    this.dir = join(repoRoot, subdir);
  }

  public get directory(): string {
    return this.dir;
  }

  public put(text: string, meta: EvidenceMeta = {}): string {
    const ref = computeEvidenceRef(text);
    const record = buildRecord(ref, text, meta);
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
    const bodyPath = join(this.dir, `${ref}.txt`);
    if (!existsSync(bodyPath)) {
      writeFileSync(bodyPath, text, "utf8");
      const { text: _omitted, ...header } = record;
      writeFileSync(join(this.dir, `${ref}.json`), `${JSON.stringify(header, null, 2)}\n`, "utf8");
    }
    this.cache.set(ref, record);
    return ref;
  }

  public get(ref: string): string | undefined {
    return this.getRecord(ref)?.text;
  }

  public getRecord(ref: string): EvidenceRecord | undefined {
    const cached = this.cache.get(ref);
    if (cached) return cached;
    if (!isEvidenceRef(ref)) return undefined;

    const bodyPath = join(this.dir, `${ref}.txt`);
    if (!existsSync(bodyPath)) return undefined;

    const text = readFileSync(bodyPath, "utf8");
    let meta: EvidenceMeta = {};
    let createdAt = new Date(0).toISOString();
    const headerPath = join(this.dir, `${ref}.json`);
    if (existsSync(headerPath)) {
      try {
        const parsed = JSON.parse(readFileSync(headerPath, "utf8")) as Partial<EvidenceRecord>;
        if (parsed.meta) meta = parsed.meta;
        if (parsed.createdAt) createdAt = parsed.createdAt;
      } catch {
        // A corrupt header never hides the body: the text is what matters.
      }
    }

    const record: EvidenceRecord = {
      ref,
      text,
      tokens: estimateTokens(text),
      bytes: Buffer.byteLength(text, "utf8"),
      createdAt,
      meta,
    };
    this.cache.set(ref, record);
    return record;
  }

  public has(ref: string): boolean {
    return this.cache.has(ref) || existsSync(join(this.dir, `${ref}.txt`));
  }

  public refs(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".txt"))
      .map((name) => name.slice(0, -4))
      .filter((ref) => isEvidenceRef(ref))
      .sort();
  }
}

/**
 * A store whose backing can be switched at run start (C6).
 *
 * Masking, compaction, condensing and `recall` all default to
 * `defaultEvidenceStore`. It starts in memory (tests, one-off calls); a real
 * run points it at disk once with `useFileEvidenceStore(repoRoot)`, and every
 * ref minted from then on survives a restart without threading a store
 * through each call site.
 */
export class SwitchableEvidenceStore implements EvidenceStore {
  constructor(private backing: EvidenceStore) {}

  /** Replace the backing store; returns the previous one. */
  public use(store: EvidenceStore): EvidenceStore {
    const previous = this.backing;
    this.backing = store;
    return previous;
  }

  public get current(): EvidenceStore {
    return this.backing;
  }

  public put(text: string, meta?: EvidenceMeta): string {
    return this.backing.put(text, meta);
  }
  public get(ref: string): string | undefined {
    return this.backing.get(ref);
  }
  public getRecord(ref: string): EvidenceRecord | undefined {
    return this.backing.getRecord(ref);
  }
  public has(ref: string): boolean {
    return this.backing.has(ref);
  }
  public refs(): string[] {
    return this.backing.refs();
  }
}

/**
 * Store used when a caller masks observations without supplying one. In
 * memory until `useFileEvidenceStore` points it at disk.
 */
export const defaultEvidenceStore = new SwitchableEvidenceStore(new InMemoryEvidenceStore());

/**
 * Persist every observation masked, compacted or condensed from now on under
 * `<repoRoot>/.sekhemet/observations`, so `recall(ref)` still works after a
 * restart (C6). Call once at run start with the main repository root (not a
 * card worktree, which is deleted). Returns the store.
 */
export function useFileEvidenceStore(repoRoot: string): FileEvidenceStore {
  const store = new FileEvidenceStore(repoRoot);
  defaultEvidenceStore.use(store);
  return store;
}
