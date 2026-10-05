import { type Hash, createHash } from "node:crypto";
import {
  constants,
  accessSync,
  createReadStream,
  createWriteStream,
  existsSync,
  linkSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { ModelSource } from "./registry.js";

/**
 * The one download (models rule 4, MD-N12-6, MD-N12-7; security item 47,
 * SEC-53; dashboard DB-N6-6/7): used by the Configuration page's
 * **Download…** and by `sekhemet models fetch`. It runs only when a person
 * asked, fetches only from the model's registered source, through the
 * network policy's `fetch` (so `offline` refuses it with the setting named),
 * into a folder the person named, and verifies the published SHA-256 before
 * the file is used: the bytes land in a `.part` file that is renamed only
 * when its hash matches, and deleted when it does not; an interrupted one is
 * kept and resumed (NEW-models-18, `downloadVerified`). Recording it on the
 * ledger (`model/downloaded`) is the caller's, with the person's principal.
 */

export type DownloadState = "running" | "verifying" | "done" | "failed";

export interface DownloadProgress {
  bytes: number;
  total: number;
  state: DownloadState;
}

export class DownloadRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadRefused";
  }
}

export class DownloadHashMismatch extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super("The file's hash didn't match the published one, so it was deleted.");
    this.name = "DownloadHashMismatch";
  }
}

export interface DownloadInput {
  /** The registry id, for messages. */
  model: string;
  source?: ModelSource | undefined;
  /**
   * A folder the person named: it must exist and be writable. It is never
   * created — a missing folder is an unmounted drive, not a place to write.
   */
  destDir: string;
  /**
   * The file's name in that folder, when the person gave another one (a
   * file of the source's name is already there); the source URL's by default.
   */
  fileName?: string;
  /** The network policy's fetch (`policyFetch`); it must stream the body. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Why the network policy refuses the source host, naming the setting; undefined when allowed. */
  refusal?: (host: string) => string | undefined;
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
}

export interface DownloadResult {
  path: string;
  sha256: string;
  bytes: number;
  verified: true;
}

const SHA = /^[0-9a-f]{64}$/;

/** A safe file name, with no directory in it. */
function safeName(raw: string): string {
  const name = basename(raw).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!name || name === "." || name === ".." || name.endsWith(".part"))
    throw new DownloadRefused("The download names no file.");
  return name;
}

/** The file name a download is written as: the one given, else the source URL's last segment. */
export function downloadFileName(url: string, given?: string): string {
  return given !== undefined ? safeName(given) : fileNameOf(url);
}

/** A file name from the source URL's last segment. */
function fileNameOf(url: string): string {
  return safeName(decodeURIComponent(new URL(url).pathname.split("/").pop() ?? ""));
}

/** The destination folder as it is now: there, a folder, and writable; never created. */
function checkFolder(dir: string): void {
  try {
    if (!statSync(dir).isDirectory()) throw new Error("not a folder");
    accessSync(dir, constants.W_OK);
  } catch {
    throw new DownloadRefused(
      `The folder ${dir} is not there or cannot be written (is its drive connected?); nothing was downloaded.`,
    );
  }
}

function refuseExisting(dir: string, name: string): void {
  if (existsSync(join(dir, name)))
    throw new DownloadRefused(
      `The folder already has a file named ${name}; it is not replaced. Give the download another name, or move that file first.`,
    );
}

/** A size as a person reads it: GB, MB or kB to one decimal (decimal units). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} kB`;
  return `${bytes} bytes`;
}

/** The bytes free to this user on the volume holding `dir` (statfs); undefined where it cannot be read. */
export function volumeFreeBytes(dir: string): number | undefined {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return undefined;
  }
}

/**
 * Refuse, before anything is fetched, a download the volume cannot hold
 * (MD-N18-2), naming both sizes.
 */
export function refuseWithoutSpace(dir: string, needBytes: number, what = "The download"): void {
  const free = volumeFreeBytes(dir);
  if (free !== undefined && needBytes > free)
    throw new DownloadRefused(
      `${what} needs ${formatBytes(needBytes)} but the volume holding ${dir} has ${formatBytes(free)} free; nothing was downloaded.`,
    );
}

/** A verified file to fetch: its URL and published SHA-256, and its size when known. */
export interface VerifiedSource {
  url: string;
  sha256: string;
  sizeBytes?: number;
}

/** Where it goes: a folder that exists and is writable, and the file's name in it. */
export interface DownloadDest {
  dir: string;
  /** The source URL's last segment by default. */
  fileName?: string;
}

export interface DownloadOptions {
  /** What is downloaded, for messages: a model's id, an engine release. */
  label: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  refusal?: (host: string) => string | undefined;
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
}

/** Feed a file's bytes to a hash. */
async function hashFile(path: string, hash: Hash): Promise<void> {
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
}

/** `Content-Range: bytes <start>-<end>/<total>`'s start. */
function rangeStart(res: Response): number | undefined {
  const m = /^bytes\s+(\d+)-/.exec(res.headers.get("content-range") ?? "");
  return m ? Number(m[1]) : undefined;
}

/**
 * Download one verified file (models rule 4e, NEW-models-18): the weights'
 * download and the engine's (rule 6b) are this one function. Refusals come
 * before any request: no source or hash, a host the network policy refuses,
 * a missing or unwritable folder, a file of that name already there, or too
 * little free space for what is still to fetch. The bytes land in
 * `<name>.part`, which an interruption keeps: the next run hashes the kept
 * bytes, asks for the rest with a Range request, and appends only a `206`
 * that starts at the kept length (a `200` or a `416` starts again from
 * nothing). The file is placed only when the whole file's SHA-256 matches;
 * when it does not, the `.part` is deleted.
 */
export async function downloadVerified(
  source: VerifiedSource | undefined,
  dest: DownloadDest,
  options: DownloadOptions,
): Promise<DownloadResult> {
  const src = source;
  if (!src || !src.url || !src.sha256 || !SHA.test(src.sha256)) {
    throw new DownloadRefused(
      `${options.label} has no registered source and hash, so Sekhemet offers no download for it.`,
    );
  }
  const host = new URL(src.url).hostname;
  const refused = options.refusal?.(host);
  if (refused) throw new DownloadRefused(`The download from ${host} is refused: ${refused}.`);
  const name = downloadFileName(src.url, dest.fileName);
  checkFolder(dest.dir);
  refuseExisting(dest.dir, name);
  const final = join(dest.dir, name);
  const part = `${final}.part`;
  const total = src.sizeBytes ?? 0;
  let kept = existsSync(part) ? statSync(part).size : 0;
  if (total && kept > total) {
    rmSync(part, { force: true });
    kept = 0;
  }
  if (total) refuseWithoutSpace(dest.dir, total - kept);
  if (options.signal?.aborted) throw new Error("The download was cancelled.");
  options.onProgress?.({ bytes: kept, total, state: "running" });
  let hash = createHash("sha256");
  let bytes = kept;
  const keptNote = () =>
    bytes > 0
      ? ` The ${formatBytes(bytes)} received are kept in ${basename(part)}; run the download again to resume it.`
      : "";
  try {
    // MD-N18-1: the kept bytes are hashed first, so the whole file is verified.
    if (kept > 0) await hashFile(part, hash);
    if (!(total && kept === total)) {
      const signal = options.signal ? { signal: options.signal } : {};
      let res = await options.fetch(
        src.url,
        kept > 0 ? { ...signal, headers: { Range: `bytes=${kept}-` } } : signal,
      );
      let append = kept > 0 && res.status === 206 && rangeStart(res) === kept;
      if (kept > 0 && !append) {
        // A 200, or a 206 from elsewhere in the file, is the file from its
        // start; a 416 (or any other) is asked for again without a range.
        const fromStart = res.status === 200 || (res.status === 206 && rangeStart(res) === 0);
        if (!fromStart) {
          await res.body?.cancel();
          res = await options.fetch(src.url, signal);
        }
        hash = createHash("sha256");
        bytes = 0;
        kept = 0;
        append = false;
      }
      if (!(res.ok || res.status === 206) || !res.body)
        throw new Error(`the source answered ${res.status}`);
      const out = createWriteStream(part, { flags: append ? "a" : "w" });
      const done = new Promise<void>((resolve, reject) => {
        out.on("finish", () => resolve());
        out.on("error", reject);
      });
      try {
        const reader = res.body.getReader();
        let last = bytes;
        for (;;) {
          if (options.signal?.aborted) throw new Error("The download was cancelled.");
          const { value, done: end } = await reader.read();
          if (end) break;
          hash.update(value);
          bytes += value.length;
          if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
          if (bytes - last >= 8 * 1024 * 1024) {
            last = bytes;
            options.onProgress?.({ bytes, total: total || bytes, state: "running" });
          }
        }
      } finally {
        out.end();
        await done;
      }
      // A connection closed early, with no error, is an interruption too.
      if (total && bytes < total)
        throw new Error(
          `the connection closed after ${formatBytes(bytes)} of ${formatBytes(total)}`,
        );
    }
  } catch (err) {
    options.onProgress?.({ bytes, total, state: "failed" });
    if (options.signal?.aborted) throw new Error(`The download was cancelled.${keptNote()}`);
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`${options.label}'s download stopped: ${why}.${keptNote()}`);
  }
  options.onProgress?.({ bytes, total: total || bytes, state: "verifying" });
  const sha = hash.digest("hex");
  const cleanup = () => rmSync(part, { force: true });
  if (sha !== src.sha256) {
    cleanup();
    options.onProgress?.({ bytes, total: total || bytes, state: "failed" });
    throw new DownloadHashMismatch(src.sha256, sha);
  }
  // Never over another file: a link fails when the name was taken meanwhile;
  // a drive without hard links (exFAT) is checked again, then renamed.
  try {
    try {
      linkSync(part, final);
      cleanup();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw err;
      refuseExisting(dest.dir, name);
      renameSync(part, final);
    }
  } catch {
    cleanup();
    options.onProgress?.({ bytes, total: total || bytes, state: "failed" });
    refuseExisting(dest.dir, name);
    throw new DownloadRefused(`The verified file could not be placed as ${name}.`);
  }
  options.onProgress?.({ bytes, total: total || bytes, state: "done" });
  return { path: final, sha256: sha, bytes, verified: true };
}

/** A registry model's download (MD-N12-6): `downloadVerified` with the model's source. */
export async function downloadModel(input: DownloadInput): Promise<DownloadResult> {
  return downloadVerified(
    input.source,
    { dir: input.destDir, ...(input.fileName !== undefined ? { fileName: input.fileName } : {}) },
    {
      label: input.model,
      fetch: input.fetch,
      ...(input.refusal ? { refusal: input.refusal } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
}
