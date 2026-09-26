import { createHash } from "node:crypto";
import {
  constants,
  accessSync,
  createWriteStream,
  existsSync,
  linkSync,
  renameSync,
  rmSync,
  statSync,
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
 * when its hash matches, and deleted when it does not. Recording it on the
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

export async function downloadModel(input: DownloadInput): Promise<DownloadResult> {
  const src = input.source;
  if (!src || !src.url || !src.sha256 || !SHA.test(src.sha256)) {
    throw new DownloadRefused(
      `${input.model} has no registered source and hash, so Sekhemet offers no download for it.`,
    );
  }
  const host = new URL(src.url).hostname;
  const refused = input.refusal?.(host);
  if (refused) throw new DownloadRefused(`The download from ${host} is refused: ${refused}.`);
  const name = downloadFileName(src.url, input.fileName);
  checkFolder(input.destDir);
  refuseExisting(input.destDir, name);
  const final = join(input.destDir, name);
  const part = `${final}.part`;
  const total = src.sizeBytes ?? 0;
  if (input.signal?.aborted) throw new Error("The download was cancelled.");
  input.onProgress?.({ bytes: 0, total, state: "running" });
  const hash = createHash("sha256");
  let bytes = 0;
  const cleanup = () => rmSync(part, { force: true });
  try {
    const res = await input.fetch(src.url, input.signal ? { signal: input.signal } : {});
    if (!res.ok || !res.body) throw new Error(`the source answered ${res.status}`);
    const out = createWriteStream(part, { flags: "w" });
    const done = new Promise<void>((resolve, reject) => {
      out.on("finish", () => resolve());
      out.on("error", reject);
    });
    const reader = res.body.getReader();
    let last = 0;
    for (;;) {
      if (input.signal?.aborted) throw new Error("The download was cancelled.");
      const { value, done: end } = await reader.read();
      if (end) break;
      hash.update(value);
      bytes += value.length;
      if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
      if (bytes - last >= 8 * 1024 * 1024) {
        last = bytes;
        input.onProgress?.({ bytes, total: total || bytes, state: "running" });
      }
    }
    out.end();
    await done;
  } catch (err) {
    cleanup();
    input.onProgress?.({ bytes, total, state: "failed" });
    if (input.signal?.aborted) throw new Error("The download was cancelled.");
    throw err;
  }
  input.onProgress?.({ bytes, total: total || bytes, state: "verifying" });
  const sha = hash.digest("hex");
  if (sha !== src.sha256) {
    cleanup();
    input.onProgress?.({ bytes, total: total || bytes, state: "failed" });
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
      refuseExisting(input.destDir, name);
      renameSync(part, final);
    }
  } catch {
    cleanup();
    input.onProgress?.({ bytes, total: total || bytes, state: "failed" });
    refuseExisting(input.destDir, name);
    throw new DownloadRefused(`The verified file could not be placed as ${name}.`);
  }
  input.onProgress?.({ bytes, total: total || bytes, state: "done" });
  return { path: final, sha256: sha, bytes, verified: true };
}
