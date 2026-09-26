import { createHash } from "node:crypto";
import {
  createReadStream,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { GGMLFileQuantizationType, gguf, parseGGUFQuantLabel } from "@huggingface/gguf";
import type {
  FoundModel,
  HashState,
  ModelCompanion,
  ModelFolder,
  ModelFolderSource,
  ModelFormat,
  ModelMetadata,
  ModelShape,
  SkippedFile,
} from "./library_types.js";

/**
 * The model library's scan (models rule 4a, NEW-models-12, NEW-models-13;
 * security SEC-N10-1–4). It walks the folders a person named, identifies
 * weights by their headers — never by loading them — and says why it
 * skipped every file it did not list. Each file is opened read-only, only
 * for a known model extension, and its header is parsed under a size limit;
 * nothing in a folder is written, executed or loaded. The SHA-256 is computed
 * afterwards (`hashModels`), so it never delays the listing (MD-N12-2).
 */

/** Subfolders are read to this depth (MD-N13-1). */
export const SCAN_DEPTH_LIMIT = 6;
/** At most this many files are read per scan (MD-N13-1). */
export const SCAN_FILE_LIMIT = 5000;
/** A GGUF header larger than this is skipped (SEC-N10-2). */
export const MAX_HEADER_BYTES = 16 * 1024 * 1024;

/** A folder to scan: where it was named and whether its subfolders are read. */
export interface ScanFolderInput {
  path: string;
  source: ModelFolderSource;
  includeSubfolders: boolean;
}

export interface ScanOptions {
  depth?: number;
  fileLimit?: number;
  maxHeaderBytes?: number;
  /** The formats an engine on this host serves; others read "no engine here serves this format". Default GGUF. */
  engines?: readonly ModelFormat[];
  /** Progress per folder (PM_CONTRACT: `{ kind: "scan", folder, found, done }`). */
  onFolder?: (p: { folder: string; found: number; done: boolean }) => void;
  now?: () => Date;
}

export interface ScanResult {
  folders: ModelFolder[];
  models: FoundModel[];
  skipped: SkippedFile[];
  /** The file-count limit stopped the scan. */
  truncated: boolean;
  depth: number;
  fileLimit: number;
  scannedAt: string;
}

export class HeaderError extends Error {
  constructor(
    public readonly reason: "unreadable" | "header_too_large",
    message: string,
  ) {
    super(message);
    this.name = "HeaderError";
  }
}

/** What a GGUF header gives, and the header's size. */
export interface GgufHeader {
  metadata: ModelMetadata;
  name?: string;
  headerBytes: number;
  /** The raw key/values, bigints as numbers. */
  raw: Record<string, unknown>;
}

const mb = (n: number) =>
  n >= 1024 * 1024 ? `${Math.round(n / (1024 * 1024))} MB` : `${Math.round(n / 1024)} KB`;

/**
 * A `fetch` that serves byte ranges of one local file, opened read-only,
 * and refuses any range that starts past the header limit: `@huggingface/gguf`
 * reads a header in 2 MB ranges, so no read goes beyond the limit plus one range.
 */
function localRangeFetch(path: string, size: number, limit: number): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("range") ?? "bytes=0-";
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(m?.[1] ?? 0);
    if (start >= limit) {
      throw new HeaderError(
        "header_too_large",
        `the header is larger than the ${mb(limit)} limit; the file was not read further`,
      );
    }
    const end = Math.min(size - 1, m?.[2] ? Number(m[2]) : size - 1);
    const length = Math.max(0, end - start + 1);
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, start);
      return new Response(buf, {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${size}` },
      });
    } finally {
      await fh.close();
    }
  }) as typeof fetch;
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
/** A per-layer array (some headers list KV heads per layer): its largest value. */
const numOrMax = (v: unknown): number | undefined => {
  if (Array.isArray(v)) {
    const xs = v.map(num).filter((x): x is number => x !== undefined);
    return xs.length ? Math.max(...xs) : undefined;
  }
  return num(v);
};

/** A family from the architecture: `qwen3moe` → `qwen`, `gemma3` → `gemma`, `llama` → `llama`. */
export function familyOfArchitecture(arch: string | undefined): string | undefined {
  if (!arch) return undefined;
  const f = arch
    .toLowerCase()
    .replace(/(moe|vl|nemo)$/g, "")
    .replace(/[\d._-]+.*$/, "");
  return f || undefined;
}

/** The quantisation label: the header's file type, else the file name's label. */
function quantisationOf(raw: Record<string, unknown>, file: string): string | undefined {
  const ft = num(raw["general.file_type"]);
  const name = ft !== undefined ? GGMLFileQuantizationType[ft] : undefined;
  if (name) return name.replace(/^MOSTLY_/, "");
  return parseGGUFQuantLabel(basename(file))?.toUpperCase();
}

/**
 * Read one GGUF header (SEC-N10-2): read-only, under the size limit, never
 * past the metadata and tensor table. Throws a `HeaderError` naming the
 * reason when the header is malformed or too large.
 */
export async function readGgufHeader(
  path: string,
  options: { maxHeaderBytes?: number } = {},
): Promise<GgufHeader> {
  const limit = options.maxHeaderBytes ?? MAX_HEADER_BYTES;
  let size: number;
  try {
    size = statSync(path).size;
  } catch (err) {
    throw new HeaderError("unreadable", err instanceof Error ? err.message : String(err));
  }
  let parsed: Awaited<ReturnType<typeof gguf>>;
  try {
    parsed = await gguf("http://sekhemet.local/header.gguf", {
      fetch: localRangeFetch(path, size, limit),
    });
  } catch (err) {
    if (err instanceof HeaderError) throw err;
    throw new HeaderError(
      "unreadable",
      `not a readable GGUF header: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const headerBytes = Number(parsed.tensorDataOffset);
  // The parser pads a short read with zeros: a header that runs past the
  // file's end is a truncated file, not a model.
  if (headerBytes > size) {
    throw new HeaderError(
      "unreadable",
      `the file is truncated: its header needs ${headerBytes} bytes and the file holds ${size}`,
    );
  }
  if (headerBytes > limit) {
    throw new HeaderError(
      "header_too_large",
      `the header is ${mb(headerBytes)}, over the ${mb(limit)} limit`,
    );
  }
  const raw: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.metadata as Record<string, unknown>)) {
    if (k === "tokenizer.ggml.tokens" || k === "tokenizer.ggml.scores") continue;
    if (k === "tokenizer.ggml.token_type" || k === "tokenizer.ggml.merges") continue;
    raw[k] = typeof v === "bigint" ? Number(v) : v;
  }
  const arch = str(raw["general.architecture"]);
  const a = (key: string) => (arch ? raw[`${arch}.${key}`] : undefined);
  let total = 0;
  let expert = 0;
  for (const t of parsed.tensorInfos) {
    const n = t.shape.reduce((acc, d) => acc * Number(d), 1);
    total += n;
    if (/_exps\b|\.ffn_(gate|up|down)_exps/.test(t.name)) expert += n;
  }
  const expertCount = num(a("expert_count"));
  const expertUsed = num(a("expert_used_count"));
  const active =
    total > 0 && expert > 0 && expertCount && expertUsed
      ? Math.round(total - expert + (expert * expertUsed) / expertCount)
      : undefined;
  const layers = num(a("block_count"));
  const heads = numOrMax(a("attention.head_count"));
  const kvHeads = numOrMax(a("attention.head_count_kv")) ?? heads;
  const embedding = num(a("embedding_length"));
  const headDim = embedding && heads ? embedding / heads : undefined;
  const keyLength = num(a("attention.key_length")) ?? headDim;
  const valueLength = num(a("attention.value_length")) ?? headDim;
  const shape: ModelShape | undefined =
    layers && kvHeads && keyLength && valueLength
      ? {
          layers,
          kvHeads,
          keyLength,
          valueLength,
          ...(embedding ? { embeddingLength: embedding } : {}),
          ...(expertCount ? { expertCount } : {}),
          ...(expertUsed ? { expertUsedCount: expertUsed } : {}),
        }
      : undefined;
  const quant = quantisationOf(raw, path);
  const family = familyOfArchitecture(arch);
  const metadata: ModelMetadata = {
    ...(arch ? { architecture: arch } : {}),
    ...(family ? { family } : {}),
    ...(str(raw["general.base_model.0.name"])
      ? { baseModel: str(raw["general.base_model.0.name"]) as string }
      : {}),
    ...(total > 0 ? { parametersTotal: total } : {}),
    ...(active ? { parametersActive: active } : {}),
    ...(quant ? { quantisation: quant } : {}),
    ...(num(a("context_length")) ? { contextLength: num(a("context_length")) as number } : {}),
    ...(str(raw["general.license"]) ? { license: str(raw["general.license"]) as string } : {}),
    ...(shape ? { shape } : {}),
  };
  const name = str(raw["general.name"]);
  return { metadata, headerBytes, raw, ...(name ? { name } : {}) };
}

const SPLIT = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;
const isMmproj = (name: string) => /mmproj/i.test(name);

/** A path-and-size key until the SHA-256 is known (PM_CONTRACT `FoundModel.id`). */
function provisionalId(path: string, size: number): string {
  return `file-${createHash("sha256").update(`${path}\0${size}`).digest("hex").slice(0, 16)}`;
}

function inside(root: string, real: string): boolean {
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** A safetensors or MLX directory: a `config.json` beside its weight files. */
function modelDirectory(
  dir: string,
): { format: ModelFormat; files: string[]; config: Record<string, unknown> } | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  if (!names.includes("config.json")) return undefined;
  const weights = names.filter((n) => n.endsWith(".safetensors")).sort();
  if (weights.length === 0) return undefined;
  let config: Record<string, unknown> = {};
  try {
    const text = readFileSync(join(dir, "config.json"), "utf8");
    if (text.length < 1_000_000) config = JSON.parse(text) as Record<string, unknown>;
  } catch {
    config = {};
  }
  const mlx = config.quantization !== undefined || /mlx/i.test(basename(dir));
  return { format: mlx ? "mlx" : "safetensors", files: weights, config };
}

interface Walk {
  root: string;
  rootReal: string;
  options: Required<Pick<ScanOptions, "depth" | "fileLimit" | "maxHeaderBytes">> & {
    engines: readonly ModelFormat[];
  };
  include: boolean;
  files: number;
  truncated: boolean;
  models: FoundModel[];
  skipped: SkippedFile[];
  seenDirs: Set<string>;
}

function noEngine(format: ModelFormat, engines: readonly ModelFormat[]): string | undefined {
  return engines.includes(format) ? undefined : "no engine here serves this format";
}

function directoryModel(
  w: Walk,
  dir: string,
  found: NonNullable<ReturnType<typeof modelDirectory>>,
) {
  const size = found.files.reduce((n, f) => n + statSync(join(dir, f)).size, 0);
  const c = found.config;
  const arch = str(c.model_type);
  const ctx = num(c.max_position_embeddings) ?? 0;
  const q = c.quantization as { bits?: number } | undefined;
  const quant = q?.bits ? `${q.bits}BIT` : (str(c.torch_dtype)?.toUpperCase() ?? "unknown");
  const family = familyOfArchitecture(arch);
  const why = noEngine(found.format, w.options.engines);
  w.models.push({
    id: provisionalId(dir, size),
    name: basename(dir),
    file: relative(w.root, dir),
    folder: w.root,
    ...(family ? { family } : {}),
    sizeBytes: size,
    quantisation: quant,
    contextLength: ctx,
    fits: {},
    fitReason: {},
    path: dir,
    format: found.format,
    parts: found.files.map((f) => relative(w.root, join(dir, f))),
    hash: "pending",
    metadata: {
      ...(arch ? { architecture: arch } : {}),
      ...(family ? { family } : {}),
      ...(ctx ? { contextLength: ctx } : {}),
      quantisation: quant,
    },
    ...(why ? { noEngine: why } : {}),
  });
}

async function walkDir(w: Walk, dir: string, depth: number): Promise<void> {
  if (w.truncated) return;
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch (err) {
    w.skipped.push({
      path: dir,
      reason: "unreadable",
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  const ggufs: string[] = [];
  const subdirs: string[] = [];
  for (const name of entries) {
    if (w.truncated) break;
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      const l = lstatSync(full);
      if (l.isSymbolicLink()) {
        // SEC-N10-1: a link is followed only when its target stays in the folder.
        const real = realpathSync(full);
        if (!inside(w.rootReal, real)) {
          w.skipped.push({
            path: full,
            reason: "symlink_outside",
            detail: "a symbolic link to a place outside this folder",
          });
          continue;
        }
      }
      st = statSync(full);
    } catch (err) {
      w.skipped.push({
        path: full,
        reason: "unreadable",
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (st.isDirectory()) {
      subdirs.push(full);
      continue;
    }
    if (!st.isFile()) continue;
    w.files += 1;
    if (w.files > w.options.fileLimit) {
      w.truncated = true;
      w.skipped.push({
        path: full,
        reason: "file_limit",
        detail: `the scan stopped at the ${w.options.fileLimit}-file limit; this file and the rest were not read`,
      });
      break;
    }
    if (extname(name).toLowerCase() === ".gguf") ggufs.push(name);
    else if (!(name === "config.json" || name.endsWith(".safetensors")) || !modelDirectory(dir)) {
      w.skipped.push({ path: full, reason: "not_a_model", detail: "not a model file extension" });
    }
  }
  await readGgufGroup(w, dir, ggufs);
  for (const sub of subdirs) {
    if (w.truncated) return;
    let real: string;
    try {
      real = realpathSync(sub);
    } catch {
      continue;
    }
    if (w.seenDirs.has(real)) continue;
    const md = modelDirectory(sub);
    if (md) {
      w.seenDirs.add(real);
      directoryModel(w, sub, md);
      continue;
    }
    if (!w.include) continue;
    if (depth + 1 > w.options.depth) {
      w.skipped.push({
        path: sub,
        reason: "depth_limit",
        detail: `deeper than the ${w.options.depth}-folder limit`,
      });
      continue;
    }
    w.seenDirs.add(real);
    await walkDir(w, sub, depth + 1);
  }
}

async function readGgufGroup(w: Walk, dir: string, names: string[]): Promise<void> {
  const projectors = names.filter(isMmproj);
  const splits = new Map<string, string[]>();
  const singles: string[] = [];
  for (const n of names) {
    if (isMmproj(n)) continue;
    const m = SPLIT.exec(n);
    if (m) splits.set(m[1] as string, [...(splits.get(m[1] as string) ?? []), n]);
    else singles.push(n);
  }
  const heads: { first: string; parts?: string[] }[] = singles.map((first) => ({ first }));
  for (const parts of splits.values()) {
    const sorted = parts.sort();
    heads.push({ first: sorted[0] as string, ...(sorted.length > 1 ? { parts: sorted } : {}) });
  }
  heads.sort((a, b) => a.first.localeCompare(b.first));
  const added: FoundModel[] = [];
  for (const h of heads) {
    const path = join(dir, h.first);
    let header: GgufHeader;
    try {
      header = await readGgufHeader(path, { maxHeaderBytes: w.options.maxHeaderBytes });
    } catch (err) {
      w.skipped.push({
        path,
        reason: err instanceof HeaderError ? err.reason : "unreadable",
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const partPaths = (h.parts ?? [h.first]).map((p) => join(dir, p));
    const size = partPaths.reduce((n, p) => n + statSync(p).size, 0);
    const md = header.metadata;
    const bpw =
      md.parametersTotal && md.parametersTotal > 0 ? (size * 8) / md.parametersTotal : undefined;
    const model: FoundModel = {
      id: provisionalId(path, size),
      name: header.name ?? basename(h.first, ".gguf").replace(/-\d{5}-of-\d{5}$/i, ""),
      file: relative(w.root, path),
      folder: w.root,
      ...(md.family ? { family: md.family } : {}),
      sizeBytes: size,
      quantisation: md.quantisation ?? "unknown",
      contextLength: md.contextLength ?? 0,
      fits: {},
      fitReason: {},
      path,
      format: "gguf",
      ...(h.parts ? { parts: h.parts.map((p) => relative(w.root, join(dir, p))) } : {}),
      hash: "pending",
      metadata: { ...md, ...(bpw ? { bitsPerWeight: Math.round(bpw * 100) / 100 } : {}) },
    };
    const why = noEngine("gguf", w.options.engines);
    if (why) model.noEngine = why;
    added.push(model);
  }
  // A vision projector is a companion of its model (MD-N12-1), not a model.
  for (const p of projectors) {
    const path = join(dir, p);
    const stem = p
      .replace(/mmproj[-_.]?/i, "")
      .replace(/\.gguf$/i, "")
      .toLowerCase();
    const owner =
      added.find(
        (m) =>
          stem &&
          basename(m.path)
            .toLowerCase()
            .includes(stem.split(/[-_]/)[0] ?? ""),
      ) ?? added[0];
    if (!owner) {
      w.skipped.push({
        path,
        reason: "not_a_model",
        detail: "a vision projector with no model beside it",
      });
      continue;
    }
    const companion: ModelCompanion = { kind: "mmproj", path, sizeBytes: statSync(path).size };
    owner.companions = [...(owner.companions ?? []), companion];
  }
  w.models.push(...added);
}

/**
 * Scan the folders a person named (MD-N12-1, MD-N13-1): headers and sizes
 * only, to the depth and file-count limits, with every skipped file and its
 * reason. A folder that cannot be read says why and lists nothing.
 */
export async function scanModelFolders(
  folders: readonly ScanFolderInput[],
  options: ScanOptions = {},
): Promise<ScanResult> {
  const depth = options.depth ?? SCAN_DEPTH_LIMIT;
  const fileLimit = options.fileLimit ?? SCAN_FILE_LIMIT;
  const maxHeaderBytes = options.maxHeaderBytes ?? MAX_HEADER_BYTES;
  const engines = options.engines ?? ["gguf"];
  const out: ScanResult = {
    folders: [],
    models: [],
    skipped: [],
    truncated: false,
    depth,
    fileLimit,
    scannedAt: (options.now?.() ?? new Date()).toISOString(),
  };
  let files = 0;
  for (const f of folders) {
    let rootReal: string;
    try {
      rootReal = realpathSync(f.path);
      if (!statSync(rootReal).isDirectory()) throw new Error("it is not a folder");
      readdirSync(rootReal);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const error =
        code === "ENOENT"
          ? "The folder does not exist."
          : code === "EACCES" || code === "EPERM"
            ? "Sekhemet is not allowed to read this folder."
            : `It cannot be read: ${err instanceof Error ? err.message : String(err)}`;
      out.folders.push({ ...f, readable: false, error });
      options.onFolder?.({ folder: f.path, found: 0, done: true });
      continue;
    }
    const w: Walk = {
      root: f.path,
      rootReal,
      options: { depth, fileLimit: fileLimit - files, maxHeaderBytes, engines },
      include: f.includeSubfolders,
      files: 0,
      truncated: false,
      models: [],
      skipped: [],
      seenDirs: new Set([rootReal]),
    };
    if (w.options.fileLimit <= 0) {
      out.truncated = true;
      out.skipped.push({
        path: f.path,
        reason: "file_limit",
        detail: `the scan reached the ${fileLimit}-file limit before this folder`,
      });
      out.folders.push({ ...f, readable: true, modelCount: 0 });
      continue;
    }
    await walkDir(w, f.path, 0);
    files += w.files;
    out.truncated ||= w.truncated;
    out.models.push(...w.models);
    out.skipped.push(...w.skipped);
    out.folders.push({ ...f, readable: true, modelCount: w.models.length });
    options.onFolder?.({ folder: f.path, found: w.models.length, done: true });
  }
  return out;
}

/** The SHA-256 of a file, streamed; `onProgress` gets the bytes read so far. */
export function sha256File(
  path: string,
  options: { onProgress?: (bytes: number) => void; signal?: AbortSignal } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    let bytes = 0;
    const s = createReadStream(path, { flags: "r", highWaterMark: 4 * 1024 * 1024 });
    const abort = () => s.destroy(new Error("hashing was cancelled"));
    options.signal?.addEventListener("abort", abort, { once: true });
    s.on("data", (chunk) => {
      h.update(chunk);
      bytes += chunk.length;
      options.onProgress?.(bytes);
    });
    s.on("error", (err) => {
      options.signal?.removeEventListener("abort", abort);
      reject(err);
    });
    s.on("end", () => {
      options.signal?.removeEventListener("abort", abort);
      resolve(h.digest("hex"));
    });
  });
}

/** A registry's published hash for a found model, when it names one (MD-N12-2). */
export type PublishedHash = (
  model: FoundModel,
) => { registryId: string; sha256: string } | undefined;

/**
 * Hash each model in the background after the listing (MD-N12-2): a GGUF by
 * its file (a split GGUF by its first part), and grade it *Verified* when the
 * registry's published SHA-256 matches, *Hash differs* when it does not, and
 * *Not a registry model* otherwise. The id becomes the SHA-256.
 */
export async function hashModels(
  models: readonly FoundModel[],
  options: {
    published?: PublishedHash;
    onHashed?: (m: FoundModel) => void;
    signal?: AbortSignal;
    /** Already known hashes by path and size (so a re-scan does not re-read 13 GB). */
    known?: (path: string, sizeBytes: number) => string | undefined;
    /**
     * Awaited before each file is read (not for a known hash): the caller
     * holds the read back while other disk work has priority (a model load).
     */
    beforeRead?: () => Promise<void>;
  } = {},
): Promise<FoundModel[]> {
  const out: FoundModel[] = [];
  for (const m of models) {
    if (options.signal?.aborted) break;
    if (m.format !== "gguf") {
      const done = { ...m, hash: "not_registry" as HashState };
      out.push(done);
      options.onHashed?.(done);
      continue;
    }
    let sha: string | undefined = options.known?.(m.path, m.sizeBytes);
    try {
      if (sha === undefined) {
        await options.beforeRead?.();
        if (options.signal?.aborted) break;
        sha = await sha256File(m.path, options.signal ? { signal: options.signal } : {});
      }
    } catch {
      out.push(m);
      continue;
    }
    const pub = options.published?.(m);
    const hash: HashState = pub
      ? pub.sha256 === sha
        ? "verified"
        : "hash_differs"
      : "not_registry";
    const done: FoundModel = {
      ...m,
      id: sha,
      sha256: sha,
      hash,
      ...(pub ? { verified: hash === "verified", registryId: pub.registryId } : {}),
    };
    out.push(done);
    options.onHashed?.(done);
  }
  return out;
}

/** The folder a model file sits in, for companions and copies. */
export const modelDir = (m: FoundModel) => (m.format === "gguf" ? dirname(m.path) : m.path);
