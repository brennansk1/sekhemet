import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Content-addressed blobs under `.sekhemet/blobs/` (K26): context packs (the
 * exact prompt a model saw) and anything else an event should reference by
 * hash rather than carry inline. The id is the SHA-256 of the content, so an
 * event naming a blob pins its bytes: a changed blob no longer matches.
 */
export class BlobStore {
  public readonly dir: string;

  constructor(repoRoot: string) {
    this.dir = join(repoRoot, ".sekhemet", "blobs");
  }

  public static idOf(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
  }

  public path(id: string): string {
    return join(this.dir, id.slice(0, 2), `${id}.json`);
  }

  /** Store `content`; returns its id. Idempotent; written atomically. */
  public put(content: string): string {
    const id = BlobStore.idOf(content);
    const target = this.path(id);
    if (existsSync(target)) return id;
    mkdirSync(join(this.dir, id.slice(0, 2)), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, target);
    return id;
  }

  /** The blob's content, or undefined when missing or when its bytes no longer hash to `id`. */
  public get(id: string): string | undefined {
    if (!/^[0-9a-f]{64}$/.test(id)) return undefined;
    const target = this.path(id);
    if (!existsSync(target)) return undefined;
    const content = readFileSync(target, "utf8");
    return BlobStore.idOf(content) === id ? content : undefined;
  }

  public has(id: string): boolean {
    return /^[0-9a-f]{64}$/.test(id) && existsSync(this.path(id));
  }
}

/** The context pack as stored: exactly what one model request carried (K11). */
export interface ContextPack {
  cardId: string;
  attemptId?: string;
  step: number;
  modelId: string;
  systemPrompt: string;
  prompt: string;
  /** Tool schema names sent with the request. */
  tools: string[];
  /** Reasoning setting of the request. */
  reasoning?: string;
}

/** Serialise a pack canonically (stable key order), so equal packs share an id. */
export function serializeContextPack(pack: ContextPack): string {
  const ordered = Object.fromEntries(
    Object.entries(pack)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return JSON.stringify(ordered);
}
