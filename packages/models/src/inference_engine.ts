import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { arch as osArch, platform as osPlatform } from "node:os";
import { delimiter, join, posix } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  type DownloadProgress,
  DownloadRefused,
  downloadVerified,
  formatBytes,
} from "./model_download.js";
import { sekhemetConfigDir } from "./models_dir.js";

/**
 * The inference engine, found and fetched (models rules 6a, 6b;
 * NEW-models-16, NEW-models-19; DEC-53 c7). llama.cpp's llama-server is
 * resolved in one order — `SEKHEMET_LLAMA_SERVER`, else the newer of the
 * downloaded engine and PATH's that meets the floor — and its build is read
 * from `--version`. A person who cannot use a terminal gets the one pinned
 * release on their yes: the asset for this platform from llama.cpp's own
 * release, through the network policy with every redirect hop checked,
 * hash-verified before it is unpacked, unpacked with no path leaving its
 * folder, into `<user dir>/engines/llama.cpp-b<build>/`. Recording
 * `engine/downloaded` is the caller's, with the person's principal.
 */

/** The shipped set's engine floor: the highest `minLlamaBuild` (`SHIPPED_ENGINE_FLOOR`; a test keeps them equal). */
export const ENGINE_FLOOR = 10809;

export type EngineBackend = "metal" | "cpu" | "vulkan" | "cuda" | "rocm";

export interface EnginePlatform {
  os: string;
  arch: string;
  backend: EngineBackend;
}

export interface EngineAsset {
  os: "darwin" | "linux";
  arch: "arm64" | "x64";
  backend: EngineBackend;
  file: string;
  sha256: string;
  sizeBytes: number;
}

export interface EnginePin {
  /** The release tag, `b<build>`. */
  release: string;
  build: number;
  repo: string;
  license: string;
  /** The hosts a download may reach, every redirect hop included. */
  hosts: readonly string[];
  /** Where the release's assets are; llama.cpp's GitHub release by default. */
  baseUrl?: string;
  assets: readonly EngineAsset[];
}

/**
 * The one pinned release (rule 6b): the build the shipped set qualified on,
 * installed and tested on the reference host (`llama-server --version`:
 * build 10809). Each asset's SHA-256 and size are the digests GitHub's
 * release API publishes for that tag (read 2026-10-04, C3), repeated in
 * PROVENANCE. A later engine is a new pin in a new release.
 */
export const ENGINE_PIN: EnginePin = {
  release: "b10809",
  build: 10809,
  repo: "ggml-org/llama.cpp",
  license: "MIT",
  // github.com answers with a redirect to its release-asset host.
  hosts: ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"],
  assets: [
    {
      os: "darwin",
      arch: "arm64",
      backend: "metal",
      file: "llama-b10809-bin-macos-arm64.tar.gz",
      sha256: "7d692df9e1e386e62f1c12b843903218041e6cd74c9415aa39a7ed3176f9eaa2",
      sizeBytes: 11_123_196,
    },
    {
      os: "linux",
      arch: "x64",
      backend: "cpu",
      file: "llama-b10809-bin-ubuntu-x64.tar.gz",
      sha256: "5e34434ddc6d03cd1584f403201aff0d4bd1a5793a72ff7e286532dfd1e4b941",
      sizeBytes: 16_734_586,
    },
    {
      os: "linux",
      arch: "x64",
      backend: "vulkan",
      file: "llama-b10809-bin-ubuntu-vulkan-x64.tar.gz",
      sha256: "07f029cef440c82c3cff5310641eb6347e5cbcd865a5d88990215058aa049e93",
      sizeBytes: 33_799_345,
    },
  ],
};

/** Where an asset is downloaded from. */
export function engineAssetUrl(pin: EnginePin, asset: EngineAsset): string {
  const base = pin.baseUrl ?? `https://github.com/${pin.repo}/releases/download/${pin.release}`;
  return `${base}/${asset.file}`;
}

/** The pinned asset for this platform and backend; undefined where none is pinned (MD-N19-3). */
export function pinnedAsset(pin: EnginePin, p: EnginePlatform): EngineAsset | undefined {
  return pin.assets.find((a) => a.os === p.os && a.arch === p.arch && a.backend === p.backend);
}

/**
 * This machine's platform and GPU backend: Metal on macOS; on Linux CUDA
 * when NVIDIA's driver is loaded, ROCm when AMD's compute device is there,
 * Vulkan when a Vulkan driver is installed, else the CPU.
 */
export function detectEnginePlatform(
  opts: { platform?: string; arch?: string; probe?: { exists(path: string): boolean } } = {},
): EnginePlatform {
  const os = opts.platform ?? osPlatform();
  const arch = opts.arch ?? osArch();
  if (os === "darwin") return { os, arch, backend: "metal" };
  const has = opts.probe?.exists ?? existsSync;
  const backend: EngineBackend = has("/proc/driver/nvidia")
    ? "cuda"
    : has("/dev/kfd")
      ? "rocm"
      : has("/usr/share/vulkan/icd.d") || has("/etc/vulkan/icd.d")
        ? "vulkan"
        : "cpu";
  return { os, arch, backend };
}

/** The user guide's section on installing the engine by hand (MD-N16-2; a test checks it exists). */
export const ENGINE_GUIDE = "docs/reference/INSTALL.md, section *The inference engine*";

const BACKEND_WORDS: Record<EngineBackend, string> = {
  metal: "Metal",
  cpu: "the CPU",
  vulkan: "Vulkan",
  cuda: "CUDA",
  rocm: "ROCm",
};

/** Why nothing is offered for this platform (MD-N19-3). */
export function noAssetReason(p: EnginePlatform, pin: EnginePin = ENGINE_PIN): string {
  return `No pinned llama.cpp ${pin.release} build fits this machine (${p.os} ${p.arch}, ${BACKEND_WORDS[p.backend]}), so nothing is offered to download. Build llama.cpp for it: ${ENGINE_GUIDE}.`;
}

/**
 * This platform's fixes when llama-server is missing or too old (rule 6a,
 * MD-N16-2): *Get the inference engine* where a pinned asset exists, then
 * Homebrew on macOS, or the guide's build instructions on Linux.
 */
export function engineFixes(p: EnginePlatform, pin: EnginePin = ENGINE_PIN): string[] {
  const fixes: string[] = [];
  if (pinnedAsset(pin, p))
    fixes.push("Get the inference engine on Configuration › Models, or run `sekhemet engine get`");
  if (p.os === "darwin") fixes.push("`brew install llama.cpp`");
  else fixes.push(`build llama.cpp with CUDA, Vulkan or ROCm, or for the CPU: ${ENGINE_GUIDE}`);
  return fixes;
}

// ── finding the engine ────────────────────────────────────────────────────

/** llama.cpp's build number from a build_info (`b10828-abc`), an engine string or a version line. */
export function llamaBuildNumber(text: string): number | undefined {
  const m = /\bb(\d{3,})\b/.exec(text) ?? /\b(?:version:|build)\s*(\d{3,})\b/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

/** The build a llama-server reports with `--version` (it prints to stderr); undefined when it does not run. */
export function readLlamaBuild(binary: string): number | undefined {
  const r = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 8000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error) return undefined;
  return llamaBuildNumber(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
}

export type EngineOrigin = "setting" | "downloaded" | "path";

export interface EngineFound {
  path: string;
  origin: EngineOrigin;
  build?: number;
}

export interface EngineResolution {
  /** The engine the harness uses; undefined when none was found. */
  engine?: EngineFound;
  floor: number;
  /** The engine's build is known and at or above the floor. */
  meetsFloor: boolean;
  /** Every llama-server found, in the order looked at. */
  candidates: EngineFound[];
}

/** Where downloaded engines live: `<user dir>/engines/`. */
export function enginesDir(userDir: string = sekhemetConfigDir()): string {
  return join(userDir, "engines");
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** A llama-server inside an engine folder: at its top or one folder down (the release's own folder). */
function serverIn(dir: string): string | undefined {
  const top = join(dir, "llama-server");
  if (isFile(top)) return top;
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return undefined;
  }
  for (const n of names) {
    const p = join(dir, n, "llama-server");
    if (isFile(p)) return p;
  }
  return undefined;
}

/** The downloaded engines: `engines/llama.cpp-b<build>/`, newest first. */
export function downloadedEngines(userDir: string = sekhemetConfigDir()): EngineFound[] {
  const root = enginesDir(userDir);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .map((n) => ({ n, build: /^llama\.cpp-b(\d+)$/.exec(n)?.[1] }))
    .filter((x): x is { n: string; build: string } => x.build !== undefined)
    .sort((a, b) => Number(b.build) - Number(a.build))
    .flatMap(({ n }) => {
      const path = serverIn(join(root, n));
      return path ? [{ path, origin: "downloaded" as const }] : [];
    });
}

/** `llama-server` on PATH, as a shell would find it. */
function onPath(env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, "llama-server");
    if (isFile(p)) return p;
  }
  return undefined;
}

/**
 * Which llama-server the harness uses (rule 6b, MD-N19-5):
 * `SEKHEMET_LLAMA_SERVER` when set, otherwise the newer of the downloaded
 * engine and PATH's among those that meet the floor; with none meeting it,
 * the newest found, so `doctor` and first run can name its build.
 */
export function resolveLlamaServer(
  opts: {
    env?: NodeJS.ProcessEnv;
    userDir?: string;
    floor?: number;
    readBuild?: (binary: string) => number | undefined;
  } = {},
): EngineResolution {
  const env = opts.env ?? process.env;
  const floor = opts.floor ?? ENGINE_FLOOR;
  const read = opts.readBuild ?? readLlamaBuild;
  const meets = (c: EngineFound | undefined) => (c?.build ?? 0) >= floor;
  const setting = env.SEKHEMET_LLAMA_SERVER?.trim();
  if (setting) {
    const build = read(setting);
    const engine: EngineFound = {
      path: setting,
      origin: "setting",
      ...(build !== undefined ? { build } : {}),
    };
    return { engine, floor, meetsFloor: meets(engine), candidates: [engine] };
  }
  const found: EngineFound[] = [
    ...downloadedEngines(opts.userDir ?? sekhemetConfigDir(env)),
    ...(() => {
      const p = onPath(env);
      return p ? [{ path: p, origin: "path" as const }] : [];
    })(),
  ].map((c) => {
    const build = read(c.path);
    return build !== undefined ? { ...c, build } : c;
  });
  const newest = (list: EngineFound[]) =>
    [...list].sort((a, b) => (b.build ?? -1) - (a.build ?? -1))[0];
  const engine = newest(found.filter(meets)) ?? newest(found);
  return { ...(engine ? { engine } : {}), floor, meetsFloor: meets(engine), candidates: found };
}

/** The llama-server to start: the resolved one, else the bare name for the OS to find. */
export function llamaServerBinary(): string {
  return resolveLlamaServer().engine?.path ?? "llama-server";
}

// ── the archive ───────────────────────────────────────────────────────────

export class EngineRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineRefused";
  }
}

export interface TarEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "hardlink";
  mode: number;
  data?: Buffer;
  link?: string;
}

const unpackRefusal = (why: string) =>
  new EngineRefused(`The engine archive was not unpacked: ${why}. Nothing was installed.`);

/** An archive path made safe: relative, no `..`, no backslash; undefined for the archive's root. */
function safePath(raw: string): string | undefined {
  if (raw.includes("\\") || raw.includes("\0")) throw unpackRefusal(`it names ${raw}`);
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw))
    throw unpackRefusal(`it names an absolute path, ${raw}`);
  const norm = posix.normalize(raw).replace(/\/+$/, "");
  if (norm === "." || norm === "") return undefined;
  if (norm === ".." || norm.startsWith("../") || norm.split("/").includes(".."))
    throw unpackRefusal(`it names a path outside its folder, ${raw}`);
  return norm;
}

const cString = (b: Buffer) => {
  const end = b.indexOf(0);
  return b.subarray(0, end === -1 ? b.length : end).toString("utf8");
};
const octal = (b: Buffer, what: string): number => {
  if ((b[0] ?? 0) & 0x80) throw unpackRefusal(`an entry's ${what} is too large`);
  const s = cString(b).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw unpackRefusal(`an entry's ${what} is not a number`);
  return Number.parseInt(s, 8);
};

/** A pax header's records (`<len> key=value\n`). */
function paxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) break;
    const len = Number.parseInt(data.subarray(at, space).toString("ascii"), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = data.subarray(space + 1, at + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    at += len;
  }
  return out;
}

/**
 * The entries of a tar archive (ustar, pax and GNU long names), each path
 * checked before anything is written: an absolute path, a `..`, a link
 * whose target leaves the archive's folder, or an entry of any other kind
 * refuses the whole archive (zip-slip).
 */
export function parseTar(gz: Buffer): TarEntry[] {
  let buf: Buffer;
  try {
    buf = gunzipSync(gz, { maxOutputLength: 1024 ** 3 });
  } catch (err) {
    throw unpackRefusal(`it is not a gzip archive (${(err as Error).message})`);
  }
  const entries: TarEntry[] = [];
  let at = 0;
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax: Record<string, string> = {};
  while (at + 512 <= buf.length) {
    const h = buf.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (h[i] as number);
    if (sum !== octal(h.subarray(148, 156), "checksum"))
      throw unpackRefusal("a header's checksum does not match");
    const size = octal(h.subarray(124, 136), "size");
    const flag = String.fromCharCode(h[156] ?? 0);
    const data = buf.subarray(at + 512, at + 512 + size);
    if (data.length < size) throw unpackRefusal("it ends inside an entry");
    at += 512 + Math.ceil(size / 512) * 512;
    if (flag === "L") {
      longName = cString(data);
      continue;
    }
    if (flag === "K") {
      longLink = cString(data);
      continue;
    }
    if (flag === "x") {
      pax = paxRecords(data);
      continue;
    }
    if (flag === "g") continue;
    const prefix = cString(h.subarray(345, 500));
    const plain = cString(h.subarray(0, 100));
    const rawName = pax.path ?? longName ?? (prefix ? `${prefix}/${plain}` : plain);
    const rawLink = pax.linkpath ?? longLink ?? cString(h.subarray(157, 257));
    longName = undefined;
    longLink = undefined;
    pax = {};
    const mode = octal(h.subarray(100, 108), "mode");
    const name = safePath(rawName);
    if (name === undefined) continue;
    if (flag === "0" || flag === "\0" || flag === "7") {
      entries.push({ name, type: "file", mode, data: Buffer.from(data) });
    } else if (flag === "5") {
      entries.push({ name, type: "dir", mode });
    } else if (flag === "2") {
      if (rawLink.startsWith("/")) throw unpackRefusal(`${rawName} links to ${rawLink}`);
      const target = posix.normalize(posix.join(posix.dirname(name), rawLink));
      if (target === ".." || target.startsWith("../"))
        throw unpackRefusal(`${rawName} links outside its folder, to ${rawLink}`);
      entries.push({ name, type: "symlink", mode, link: rawLink });
    } else if (flag === "1") {
      const target = safePath(rawLink);
      if (!target) throw unpackRefusal(`${rawName} links to the archive's root`);
      entries.push({ name, type: "hardlink", mode, link: target });
    } else {
      throw unpackRefusal(`${rawName} is not a file, folder or link`);
    }
  }
  return entries;
}

/**
 * Write checked entries under `root`, which must be new and empty: folders
 * and files first (never over an existing one), links last, so no write
 * goes through a link the archive made.
 */
function writeEntries(root: string, entries: readonly TarEntry[]): void {
  const files = new Map<string, Buffer>();
  for (const e of entries) {
    const at = join(root, e.name);
    if (e.type === "dir") mkdirSync(at, { recursive: true, mode: 0o755 });
    else if (e.type === "file") {
      mkdirSync(join(at, ".."), { recursive: true, mode: 0o755 });
      writeFileSync(at, e.data ?? Buffer.alloc(0), { flag: "wx", mode: e.mode & 0o755 || 0o644 });
      files.set(e.name, e.data ?? Buffer.alloc(0));
    }
  }
  for (const e of entries) {
    const at = join(root, e.name);
    if (e.type === "hardlink") {
      const data = files.get(e.link as string);
      if (!data) throw unpackRefusal(`${e.name} links to ${e.link}, which it does not hold`);
      mkdirSync(join(at, ".."), { recursive: true, mode: 0o755 });
      writeFileSync(at, data, { flag: "wx", mode: e.mode & 0o755 || 0o644 });
    } else if (e.type === "symlink") {
      if (existsSync(at)) throw unpackRefusal(`${e.name} is named twice`);
      mkdirSync(join(at, ".."), { recursive: true, mode: 0o755 });
      symlinkSync(e.link as string, at);
    }
  }
}

// ── getting the engine ────────────────────────────────────────────────────

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * A fetch that follows redirects itself, so every hop is checked before it
 * is asked: its host must be one the pin names, the network policy must
 * allow it (`refusal`, given the hop's index), and https is never left for
 * http. Each hop is a request of its own through the caller's fetch — the
 * network policy's, which records each one.
 */
export function hopCheckedFetch(
  inner: (url: string, init?: RequestInit) => Promise<Response>,
  opts: {
    hosts: readonly string[];
    refusal?: ((host: string, hop: number) => string | undefined) | undefined;
    maxHops?: number;
  },
): (url: string, init?: RequestInit) => Promise<Response> {
  const max = opts.maxHops ?? 5;
  return async (url, init) => {
    let current = new URL(url);
    for (let hop = 0; hop <= max; hop++) {
      const host = current.hostname;
      if (!opts.hosts.includes(host))
        throw new EngineRefused(
          `The download was sent on to ${host}, which is not llama.cpp's release host; nothing was installed.`,
        );
      const why = opts.refusal?.(host, hop);
      if (why) throw new EngineRefused(`The download from ${host} is refused: ${why}.`);
      const res = await inner(current.toString(), { ...init, redirect: "manual" });
      if (!REDIRECTS.has(res.status)) return res;
      const to = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!to) throw new Error(`${host} answered ${res.status} with nowhere to go`);
      const next = new URL(to, current);
      if (current.protocol === "https:" && next.protocol !== "https:")
        throw new EngineRefused(
          `The download was sent on without https (${next.host}); nothing was installed.`,
        );
      current = next;
    }
    throw new Error(`the download was redirected more than ${max} times`);
  };
}

export interface GetEngineOptions {
  /** The network policy's fetch (`policyFetch`, streaming). */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Why the network policy refuses a host (naming the setting); `hop` is 0 for the first request. */
  refusal?: (host: string, hop: number) => string | undefined;
  userDir?: string;
  platform?: EnginePlatform;
  pin?: EnginePin;
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
}

export interface EngineInstalled {
  release: string;
  /** The asset's file name. */
  asset: string;
  sha256: string;
  bytes: number;
  /** `<user dir>/engines/llama.cpp-b<build>/`. */
  dir: string;
  /** Its llama-server. */
  binary: string;
  /** The build the unpacked llama-server reports. */
  build: number;
}

/**
 * Get the inference engine (MD-N19-1..4): only the pinned asset for this
 * platform, downloaded through `downloadVerified` (resume, free space and
 * the hash as for weights), every hop checked; the archive's hash checked
 * again before it is unpacked; unpacked into a fresh folder under
 * `<user dir>/engines/` and moved into place only when its llama-server
 * reports the pinned build. Nothing outside the user directory changes.
 */
export async function getEngine(opts: GetEngineOptions): Promise<EngineInstalled> {
  const pin = opts.pin ?? ENGINE_PIN;
  const platform = opts.platform ?? detectEnginePlatform();
  const asset = pinnedAsset(pin, platform);
  if (!asset) throw new EngineRefused(noAssetReason(platform, pin));
  const userDir = opts.userDir ?? sekhemetConfigDir();
  const root = enginesDir(userDir);
  const dir = join(root, `llama.cpp-b${pin.build}`);
  if (serverIn(dir))
    throw new EngineRefused(
      `llama.cpp ${pin.release} is already installed in ${dir}; nothing was downloaded.`,
    );
  const downloads = join(root, ".downloads");
  mkdirSync(downloads, { recursive: true, mode: 0o700 });
  // A verified archive left by an install that stopped is fetched again.
  rmSync(join(downloads, asset.file), { force: true });
  const url = engineAssetUrl(pin, asset);
  const label = `llama.cpp ${pin.release}`;
  // A refusal on a later hop reaches downloadVerified as a failed request;
  // it is kept here so the person reads the refusal itself.
  let hopRefusal: EngineRefused | undefined;
  const checked = hopCheckedFetch(opts.fetch, { hosts: pin.hosts, refusal: opts.refusal });
  const refusal = opts.refusal;
  let done: Awaited<ReturnType<typeof downloadVerified>>;
  try {
    done = await downloadVerified(
      { url, sha256: asset.sha256, sizeBytes: asset.sizeBytes },
      { dir: downloads, fileName: asset.file },
      {
        label,
        fetch: async (u, init) => {
          try {
            return await checked(u, init);
          } catch (err) {
            if (err instanceof EngineRefused) hopRefusal = err;
            throw err;
          }
        },
        ...(refusal ? { refusal: (host: string) => refusal(host, 0) } : {}),
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
  } catch (err) {
    if (hopRefusal) throw hopRefusal;
    if (err instanceof DownloadRefused) throw new EngineRefused(err.message);
    throw err;
  }
  const staging = join(root, `.staging-${randomUUID().slice(0, 8)}`);
  try {
    const bytes = readFileSync(done.path);
    // The hash again, just before unpacking: the file is what was verified.
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
      throw unpackRefusal("its hash changed after it was verified");
    const entries = parseTar(bytes);
    mkdirSync(staging, { mode: 0o755 });
    writeEntries(staging, entries);
    const server = serverIn(staging);
    if (!server) throw unpackRefusal("it holds no llama-server");
    chmodSync(server, 0o755);
    const build = readLlamaBuild(server);
    if (build !== pin.build)
      throw new EngineRefused(
        build === undefined
          ? `The unpacked llama-server did not report its build (it may not run on this machine); it was removed. Build llama.cpp for this machine: ${ENGINE_GUIDE}.`
          : `The unpacked llama-server reports build ${build}, not the pinned ${pin.release}; it was removed.`,
      );
    renameSync(staging, dir);
    return {
      release: pin.release,
      asset: asset.file,
      sha256: done.sha256,
      bytes: done.bytes,
      dir,
      binary: join(dir, server.slice(staging.length + 1)),
      build,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(done.path, { force: true });
    // The download folder goes too, unless it keeps an interrupted `.part`.
    try {
      rmdirSync(downloads);
    } catch {
      // Not empty: kept for the next attempt to resume.
    }
  }
}

// ── the engine as a person reads it ───────────────────────────────────────

export interface EngineStatus {
  /** The engine in use: where it is, where it came from, its build. */
  engine?: EngineFound;
  floor: number;
  meetsFloor: boolean;
  platform: EnginePlatform;
  /** What *Get the inference engine* would download here; undefined where nothing is pinned. */
  offer?: { release: string; file: string; sizeBytes: number; sha256: string; license: string };
  /** Why nothing is offered (MD-N19-3). */
  noAsset?: string;
  /** The pinned build is already in the user directory. */
  installed: boolean;
  /** One sentence: which engine, where from, its build against the floor. */
  line: string;
  /** This platform's fixes when the engine is missing or below the floor (MD-N16-2). */
  fixes: string[];
}

const ORIGIN_WORDS: Record<EngineOrigin, string> = {
  setting: "named by SEKHEMET_LLAMA_SERVER",
  downloaded: "downloaded by Sekhemet",
  path: "on PATH",
};

/** The engine's state for `doctor`, first run, `sekhemet engine status` and the page. */
export function engineStatus(
  opts: {
    env?: NodeJS.ProcessEnv;
    userDir?: string;
    platform?: EnginePlatform;
    pin?: EnginePin;
    readBuild?: (binary: string) => number | undefined;
  } = {},
): EngineStatus {
  const pin = opts.pin ?? ENGINE_PIN;
  const platform = opts.platform ?? detectEnginePlatform();
  const userDir = opts.userDir ?? sekhemetConfigDir(opts.env ?? process.env);
  const r = resolveLlamaServer({
    ...(opts.env ? { env: opts.env } : {}),
    userDir,
    ...(opts.readBuild ? { readBuild: opts.readBuild } : {}),
  });
  const asset = pinnedAsset(pin, platform);
  const e = r.engine;
  const line = !e
    ? "llama-server not found."
    : e.build === undefined
      ? `llama-server at ${e.path} (${ORIGIN_WORDS[e.origin]}) did not report its build; b${r.floor} or later needed.`
      : r.meetsFloor
        ? `llama-server b${e.build} at ${e.path} (${ORIGIN_WORDS[e.origin]}); b${r.floor} or later needed.`
        : `llama-server b${e.build} found; b${r.floor} or later needed (${e.path}, ${ORIGIN_WORDS[e.origin]}).`;
  return {
    ...(e ? { engine: e } : {}),
    floor: r.floor,
    meetsFloor: r.meetsFloor,
    platform,
    ...(asset
      ? {
          offer: {
            release: pin.release,
            file: asset.file,
            sizeBytes: asset.sizeBytes,
            sha256: asset.sha256,
            license: pin.license,
          },
        }
      : { noAsset: noAssetReason(platform, pin) }),
    installed: serverIn(join(enginesDir(userDir), `llama.cpp-b${pin.build}`)) !== undefined,
    line,
    fixes: engineFixes(platform, pin),
  };
}

/** The offer as the person reads it before their yes (MD-N19-1). */
export function engineOfferText(s: EngineStatus): string | undefined {
  const o = s.offer;
  if (!o) return undefined;
  return `llama.cpp ${o.release}: ${o.file}, ${formatBytes(o.sizeBytes)}, licence ${o.license}, from llama.cpp's own release on GitHub, checked against its published SHA-256 before it is unpacked into your Sekhemet folder.`;
}
