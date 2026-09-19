import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { RegistryLookup } from "@sekhemet/gates";
import type { EventLog } from "@sekhemet/kernel";
import type { ModelRegistry } from "@sekhemet/models";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { type TextFetch, docRoot, sitemapUrls } from "./research/docs.js";
import { ResearchCache } from "./research/polite.js";

/**
 * The air-gap kit (X10-X14, design "Air-gap kit"): a machine with no
 * network installs, works cards, adds dependencies and reads docs.
 *
 *   X10 package mirrors: an allowlist from the lockfiles, the pnpm store
 *       filled by `pnpm fetch`, and a registry for the supply-chain gate
 *       that knows only mirrored packages;
 *   X11 a model manifest (sha256, quant, tier), verified before registering;
 *   X12 documentation bundles: docs prefetched into the research cache on a
 *       connected machine, exported, imported on the air-gapped one;
 *   X13 signed update bundles (ssh-keygen -Y sign / verify), applied with a
 *       ledger backup and a schema compatibility check;
 *   X14 the self-test, written to the audit log.
 */
export const AIRGAP_DIR = ".sekhemet/airgap";

type Run = (
  cmd: string,
  args: string[],
  cwd?: string,
) => { status: number; stdout: string; stderr: string };
const defaultRun: Run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 600_000 });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? String(r.error ?? ""),
  };
};

// ---------------------------------------------------------------- X10

export interface MirrorAllowlist {
  npm: Record<string, string[]>;
  pypi: Record<string, string[]>;
  crates: Record<string, string[]>;
  generatedAt: string;
}

function addVersion(map: Record<string, string[]>, name: string, version: string): void {
  const list = map[name] ?? [];
  if (!list.includes(version)) list.push(version);
  map[name] = list.sort();
}

/** Every package and version the project's lockfiles pin. */
export function allowlistFromLockfiles(repo: string): MirrorAllowlist {
  const out: MirrorAllowlist = {
    npm: {},
    pypi: {},
    crates: {},
    generatedAt: new Date().toISOString(),
  };
  const pnpm = join(repo, "pnpm-lock.yaml");
  if (existsSync(pnpm)) {
    // v9 keys: `  name@1.2.3:` / `  '@scope/name@1.2.3':` under packages:/snapshots:
    for (const m of readFileSync(pnpm, "utf8").matchAll(
      /^ {2}'?(@?[^@'\s][^@'\s]*)@(\d[^:'\s(]*)[^:]*'?:\s*$/gm,
    )) {
      addVersion(out.npm, m[1] as string, m[2] as string);
    }
  }
  const npmLock = join(repo, "package-lock.json");
  if (existsSync(npmLock)) {
    const lock = JSON.parse(readFileSync(npmLock, "utf8")) as {
      packages?: Record<string, { version?: string }>;
    };
    for (const [path, p] of Object.entries(lock.packages ?? {})) {
      const name = path.split("node_modules/").at(-1);
      if (name && p.version) addVersion(out.npm, name, p.version);
    }
  }
  const req = join(repo, "requirements.txt");
  if (existsSync(req)) {
    for (const m of readFileSync(req, "utf8").matchAll(/^([A-Za-z0-9_.-]+)==([^\s;#]+)/gm)) {
      addVersion(out.pypi, (m[1] as string).toLowerCase(), m[2] as string);
    }
  }
  const cargo = join(repo, "Cargo.lock");
  if (existsSync(cargo)) {
    for (const m of readFileSync(cargo, "utf8").matchAll(
      /\[\[package\]\]\s*\nname = "([^"]+)"\s*\nversion = "([^"]+)"/g,
    )) {
      addVersion(out.crates, m[1] as string, m[2] as string);
    }
  }
  return out;
}

/**
 * Seed the mirror on a connected machine: write the allowlist and fill the
 * pnpm store from the lockfile (`pnpm fetch`), so `pnpm install --offline`
 * works on the air-gapped one.
 */
export function buildMirror(
  repo: string,
  opts: { storeDir?: string; run?: Run } = {},
): { allowlist: MirrorAllowlist; packages: number; fetched: boolean; detail: string } {
  const dir = join(repo, AIRGAP_DIR);
  mkdirSync(dir, { recursive: true });
  const allowlist = allowlistFromLockfiles(repo);
  writeFileSync(join(dir, "allowlist.json"), `${JSON.stringify(allowlist, null, 2)}\n`);
  const packages =
    Object.keys(allowlist.npm).length +
    Object.keys(allowlist.pypi).length +
    Object.keys(allowlist.crates).length;
  let fetched = false;
  let detail = "no pnpm lockfile";
  if (existsSync(join(repo, "pnpm-lock.yaml"))) {
    const r = (opts.run ?? defaultRun)(
      "pnpm",
      ["fetch", ...(opts.storeDir ? ["--store-dir", opts.storeDir] : [])],
      repo,
    );
    fetched = r.status === 0;
    detail = fetched
      ? "pnpm store filled from the lockfile"
      : `pnpm fetch failed: ${r.stderr.slice(0, 300)}`;
  }
  return { allowlist, packages, fetched, detail };
}

/**
 * The supply-chain gate's registry in air-gap mode: a package exists only
 * if it is mirrored, so an unmirrored dependency cannot be added.
 */
export function mirrorRegistry(repo: string): RegistryLookup {
  const path = join(repo, AIRGAP_DIR, "allowlist.json");
  return async (name) => {
    if (!existsSync(path)) return { exists: false };
    const a = JSON.parse(readFileSync(path, "utf8")) as MirrorAllowlist;
    return { exists: Boolean(a.npm[name] ?? a.pypi[name.toLowerCase()] ?? a.crates[name]) };
  };
}

/** Air-gap mode: `SEKHEMET_AIRGAP=1` or `[network] mode = "offline"` in config.toml. */
export function isAirgapped(repo: string): boolean {
  if (process.env.SEKHEMET_AIRGAP === "1") return true;
  const cfg = join(repo, ".sekhemet", "config.toml");
  return existsSync(cfg) && /\[network\][^[]*mode\s*=\s*"offline"/.test(readFileSync(cfg, "utf8"));
}

// ---------------------------------------------------------------- X11

export interface ManifestModel {
  id: string;
  file: string;
  sha256: string;
  quant?: string;
  tier?: string;
  templateChecksum?: string;
  sizeBytes?: number;
}

export interface ModelManifest {
  version: 1;
  models: ManifestModel[];
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

/** Build a manifest from a directory of model files (on the connected machine). */
export async function buildModelManifest(dir: string): Promise<ModelManifest> {
  const models: ManifestModel[] = [];
  for (const f of readdirSync(dir)
    .filter((n) => /\.(gguf|safetensors|bin)$/.test(n))
    .sort()) {
    const path = join(dir, f);
    models.push({
      id: f.replace(/\.(gguf|safetensors|bin)$/, ""),
      file: f,
      sha256: await sha256File(path),
      sizeBytes: statSync(path).size,
      ...(/(IQ\d_[A-Z]+|Q\d_K_[A-Z]+|Q\d_\d|F16|BF16)/i.exec(f)
        ? {
            quant: /(IQ\d_[A-Z]+|Q\d_K_[A-Z]+|Q\d_\d|F16|BF16)/i
              .exec(f)?.[0]
              .toUpperCase() as string,
          }
        : {}),
    });
  }
  return { version: 1, models };
}

/**
 * Verify copied-in weights against the manifest; register the ones that
 * match (never the ones that do not). Weights are never downloaded.
 */
export async function verifyModels(
  manifest: ModelManifest,
  dir: string,
  registry?: ModelRegistry,
): Promise<{ id: string; ok: boolean; detail: string }[]> {
  const out: { id: string; ok: boolean; detail: string }[] = [];
  for (const m of manifest.models) {
    const path = join(dir, m.file);
    if (!existsSync(path)) {
      out.push({ id: m.id, ok: false, detail: `missing ${m.file}` });
      continue;
    }
    const sum = await sha256File(path);
    if (sum !== m.sha256) {
      out.push({
        id: m.id,
        ok: false,
        detail: `sha256 mismatch (${sum.slice(0, 12)} != ${m.sha256.slice(0, 12)})`,
      });
      continue;
    }
    registry?.upsert(m.id, {
      ...(m.quant ? { quant: m.quant } : {}),
      sizeBytes: statSync(path).size,
    });
    out.push({ id: m.id, ok: true, detail: "verified" });
  }
  return out;
}

// ---------------------------------------------------------------- X12

/**
 * Prefetch a library's documentation into the research cache (on a
 * connected machine): the sitemap enumerates the docs pages, each is
 * fetched once and stored.
 */
export async function prefetchDocs(
  entry: string,
  fetchText: TextFetch,
  cache: ResearchCache,
  limit = 200,
): Promise<{ root: string | undefined; pages: number }> {
  const root = docRoot(entry);
  const urls = (await sitemapUrls(entry, fetchText, limit)).slice(0, limit);
  let pages = 0;
  for (const url of urls.length ? urls : [entry]) {
    const body = await fetchText(url).catch(() => undefined);
    if (body === undefined) continue;
    cache.set(url, 200, "text/html", body);
    pages++;
  }
  return { root, pages };
}

export interface DocBundle {
  version: 1;
  createdAt: string;
  entries: { file: string; json: string }[];
  sha256: string;
}

/** Export the research cache as one bundle file (with its checksum). */
export function exportDocBundle(cacheDir: string, out: string): DocBundle {
  const entries = existsSync(cacheDir)
    ? readdirSync(cacheDir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => ({ file: f, json: readFileSync(join(cacheDir, f), "utf8") }))
    : [];
  const sha256 = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  const bundle: DocBundle = { version: 1, createdAt: new Date().toISOString(), entries, sha256 };
  writeFileSync(out, JSON.stringify(bundle));
  return bundle;
}

/**
 * Import a bundle into this machine's research cache. Entries are
 * re-stamped as fresh: on an air-gapped machine the bundle is the newest
 * copy there is.
 */
export function importDocBundle(file: string, cacheDir: string): number {
  const b = JSON.parse(readFileSync(file, "utf8")) as DocBundle;
  if (createHash("sha256").update(JSON.stringify(b.entries)).digest("hex") !== b.sha256) {
    throw new Error("Doc bundle checksum mismatch: refusing to import");
  }
  mkdirSync(cacheDir, { recursive: true });
  for (const e of b.entries) {
    const entry = JSON.parse(e.json) as { at: number };
    writeFileSync(join(cacheDir, basename(e.file)), JSON.stringify({ ...entry, at: Date.now() }));
  }
  return b.entries.length;
}

// ---------------------------------------------------------------- X13

export const UPDATE_NAMESPACE = "sekhemet-update";

/** Sign a bundle with an SSH key (`ssh-keygen -Y sign`); writes `<file>.sig`. */
export function signBundle(file: string, keyPath: string, run: Run = defaultRun): string {
  const r = run("ssh-keygen", ["-Y", "sign", "-f", keyPath, "-n", UPDATE_NAMESPACE, file]);
  if (r.status !== 0) throw new Error(`ssh-keygen sign failed: ${r.stderr.trim()}`);
  return `${file}.sig`;
}

/** Verify a bundle against an allowed-signers file (`ssh-keygen -Y verify`). */
export function verifyBundle(
  file: string,
  sig: string,
  allowedSigners: string,
  identity: string,
  run: Run = defaultRun,
): { ok: boolean; detail: string } {
  const r = spawnSync(
    "ssh-keygen",
    ["-Y", "verify", "-f", allowedSigners, "-I", identity, "-n", UPDATE_NAMESPACE, "-s", sig],
    { input: readFileSync(file), encoding: "utf8" },
  );
  void run;
  return { ok: r.status === 0, detail: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

export interface UpdateManifest {
  version: string;
  /** Event-log schema versions this update can run against. */
  compatibleSchema: number[];
  note: string;
}

/**
 * Apply a signed update bundle (a .tar.gz with `sekhemet-update.json`):
 * verify the signature, check schema compatibility, back up the ledger,
 * then extract into `target`. Never migrates the log without a backup.
 */
export function applyUpdate(
  bundle: string,
  opts: {
    sig: string;
    allowedSigners: string;
    identity: string;
    target: string;
    repo: string;
    schemaVersion: number;
  },
): { applied: boolean; backup?: string; detail: string } {
  const v = verifyBundle(bundle, opts.sig, opts.allowedSigners, opts.identity);
  if (!v.ok) return { applied: false, detail: `signature rejected: ${v.detail}` };
  const manifestText = execFileSync("tar", ["-xzOf", bundle, "sekhemet-update.json"], {
    encoding: "utf8",
  });
  const manifest = JSON.parse(manifestText) as UpdateManifest;
  if (!manifest.compatibleSchema.includes(opts.schemaVersion)) {
    return {
      applied: false,
      detail: `update ${manifest.version} does not support ledger schema ${opts.schemaVersion}: ${manifest.note}`,
    };
  }
  const db = join(opts.repo, ".sekhemet", "events.db");
  let backup: string | undefined;
  if (existsSync(db)) {
    backup = `${db}.bak-${Date.now()}`;
    copyFileSync(db, backup);
  }
  mkdirSync(opts.target, { recursive: true });
  execFileSync("tar", ["-xzf", bundle, "-C", opts.target]);
  return {
    applied: true,
    ...(backup ? { backup } : {}),
    detail: `applied ${manifest.version}: ${manifest.note}`,
  };
}

// ---------------------------------------------------------------- X14

export interface SelfTestCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * The air-gap self-test (X14): outbound connections are refused inside the
 * sandbox, every gate's command resolves locally, every manifest model
 * verifies, and the docs cache answers a known query. The result goes on
 * the ledger (the audit log).
 */
export async function airgapSelfTest(
  repo: string,
  opts: {
    log?: EventLog;
    gates?: { id: string; command: string }[];
    manifest?: ModelManifest;
    modelDir?: string;
    cacheDir?: string;
    knownQuery?: string;
    sandbox?: ProcessSandbox;
  } = {},
): Promise<{ ok: boolean; checks: SelfTestCheck[] }> {
  const checks: SelfTestCheck[] = [];
  const sandbox = opts.sandbox ?? new ProcessSandbox();
  const probe = await sandbox
    .execute(
      process.execPath,
      [
        "-e",
        "require('net').connect(443,'1.1.1.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(3));setTimeout(()=>process.exit(4),3000)",
      ],
      { allowedPaths: [repo], allowNetwork: false, timeoutMs: 8000, cwd: repo },
    )
    .catch((err: unknown) => ({ exitCode: 5, stdout: "", stderr: String(err) }));
  checks.push({
    name: "no outbound connections",
    ok: probe.exitCode !== 0,
    detail:
      probe.exitCode === 0
        ? "a connection to 1.1.1.1:443 succeeded from the sandbox"
        : "outbound connection refused in the sandbox",
  });
  for (const g of opts.gates ?? []) {
    const found =
      spawnSync("sh", ["-c", `command -v ${JSON.stringify(g.command)}`], { cwd: repo }).status ===
      0;
    checks.push({
      name: `gate ${g.id} runnable`,
      ok: found,
      detail: found ? `${g.command} is installed` : `${g.command} not found`,
    });
  }
  if (opts.manifest && opts.modelDir) {
    for (const r of await verifyModels(opts.manifest, opts.modelDir)) {
      checks.push({ name: `model ${r.id} loadable`, ok: r.ok, detail: r.detail });
    }
  }
  const cacheDir = opts.cacheDir ?? process.env.SEKHEMET_RESEARCH_CACHE;
  if (cacheDir) {
    const q = (opts.knownQuery ?? "").toLowerCase();
    const hit =
      existsSync(cacheDir) &&
      readdirSync(cacheDir).some((f) => {
        try {
          return (
            (JSON.parse(readFileSync(join(cacheDir, f), "utf8")) as { body?: string }).body
              ?.toLowerCase()
              .includes(q) ?? false
          );
        } catch {
          return false;
        }
      });
    checks.push({
      name: "docs index answers a known query",
      ok: hit,
      detail: hit
        ? `"${opts.knownQuery}" found in the doc cache`
        : "no cached docs answer the query",
    });
  }
  const ok = checks.every((c) => c.ok);
  await opts.log
    ?.append({ actor: "system", type: "airgap/selftest", payload: { ok, checks } })
    .catch(() => undefined);
  return { ok, checks };
}

// ------------------------------------------------------------ the command

/**
 * `sekhemet airgap <step>`:
 *   mirror [--store-dir d]                  seed the package mirror (X10)
 *   manifest <models-dir>                   write models.manifest.json (X11)
 *   verify-models <manifest> <dir> [--sig s --signers f --identity i]   (X11)
 *   docs <library-or-url> [--pages n]       prefetch docs into the cache (X12)
 *   export-docs <out> | import-docs <file>  move the doc cache (X12)
 *   sign <file> --key k                     sign an update bundle (X13)
 *   update <bundle> --sig s --signers f --identity i [--target d]   (X13)
 *   selftest [--models-dir d] [--query q]   the air-gap self-test (X14)
 */
export async function airgapCommand(
  repo: string,
  args: string[],
  deps: { log?: EventLog; registry?: ModelRegistry; print: (l: string) => void },
): Promise<number> {
  const { print } = deps;
  const done = (message: string, code: number): number => {
    print(message);
    return code;
  };
  const flag = (n: string) => {
    const i = args.indexOf(n);
    return i === -1 ? undefined : args[i + 1];
  };
  const [step, a1, a2] = args;
  const cacheDir =
    process.env.SEKHEMET_RESEARCH_CACHE ??
    join(process.env.HOME ?? "", ".cache", "sekhemet", "research");
  switch (step) {
    case "mirror": {
      const r = buildMirror(
        repo,
        flag("--store-dir") ? { storeDir: flag("--store-dir") as string } : {},
      );
      print(
        `Mirror allowlist: ${r.packages} package(s) at ${AIRGAP_DIR}/allowlist.json; ${r.detail}.`,
      );
      return r.fetched || !existsSync(join(repo, "pnpm-lock.yaml")) ? 0 : 1;
    }
    case "manifest": {
      if (!a1) return done("Usage: sekhemet airgap manifest <models-dir>", 1);
      const m = await buildModelManifest(a1);
      const out = join(repo, AIRGAP_DIR, "models.manifest.json");
      mkdirSync(join(repo, AIRGAP_DIR), { recursive: true });
      writeFileSync(out, `${JSON.stringify(m, null, 2)}\n`);
      print(
        `Manifest: ${m.models.length} model(s) at ${out}. Sign it: sekhemet airgap sign ${out} --key <key>`,
      );
      return 0;
    }
    case "verify-models": {
      if (!a1 || !a2) return done("Usage: sekhemet airgap verify-models <manifest> <dir>", 1);
      const sig = flag("--sig");
      if (sig) {
        const v = verifyBundle(a1, sig, flag("--signers") ?? "", flag("--identity") ?? "");
        if (!v.ok) return done(`Manifest signature rejected: ${v.detail}`, 1);
      }
      const results = await verifyModels(
        JSON.parse(readFileSync(a1, "utf8")) as ModelManifest,
        a2,
        deps.registry,
      );
      for (const r of results) print(`${r.ok ? "ok" : "FAIL"} ${r.id}: ${r.detail}`);
      return results.every((r) => r.ok) ? 0 : 1;
    }
    case "docs": {
      if (!a1) return done("Usage: sekhemet airgap docs <library-or-url>", 1);
      const { KNOWN_DOCS } = await import("./research/docs.js");
      const entry = /^https?:/.test(a1) ? a1 : KNOWN_DOCS[a1.toLowerCase()];
      if (!entry) return done(`No known docs home for ${a1}; pass its URL.`, 1);
      const fetchText: TextFetch = async (url) => {
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(
          () => undefined,
        );
        return res?.ok ? await res.text() : undefined;
      };
      const r = await prefetchDocs(
        entry,
        fetchText,
        new ResearchCache(cacheDir),
        Number(flag("--pages") ?? 200),
      );
      print(`Cached ${r.pages} page(s) of ${r.root ?? entry}.`);
      return 0;
    }
    case "export-docs": {
      if (!a1) return done("Usage: sekhemet airgap export-docs <out>", 1);
      const b = exportDocBundle(cacheDir, a1);
      print(
        `Exported ${b.entries.length} cached page(s) to ${a1} (sha256 ${b.sha256.slice(0, 12)}).`,
      );
      return 0;
    }
    case "import-docs": {
      if (!a1) return done("Usage: sekhemet airgap import-docs <file>", 1);
      print(`Imported ${importDocBundle(a1, cacheDir)} page(s) into ${cacheDir}.`);
      return 0;
    }
    case "sign": {
      const key = flag("--key");
      if (!a1 || !key) return done("Usage: sekhemet airgap sign <file> --key <private-key>", 1);
      print(`Signature: ${signBundle(a1, key)}`);
      return 0;
    }
    case "update": {
      const sig = flag("--sig");
      const signers = flag("--signers");
      const identity = flag("--identity");
      if (!a1 || !sig || !signers || !identity) {
        return done("Usage: sekhemet airgap update <bundle> --sig s --signers f --identity i", 1);
      }
      const r = applyUpdate(a1, {
        sig,
        allowedSigners: signers,
        identity,
        target: flag("--target") ?? join(repo, AIRGAP_DIR, "updates"),
        repo,
        schemaVersion: Number(flag("--schema") ?? 1),
      });
      print(r.detail);
      if (r.backup) print(`Ledger backed up to ${r.backup}.`);
      await deps.log
        ?.append({ actor: "system", type: "airgap/update", payload: r })
        .catch(() => undefined);
      return r.applied ? 0 : 1;
    }
    case "selftest": {
      const { loadGatesConfig } = await import("@sekhemet/gates");
      let gates: { id: string; command: string }[] = [];
      try {
        gates = loadGatesConfig(repo).gates.map((g) => ({ id: g.id, command: g.command }));
      } catch {
        gates = [];
      }
      const manifestPath = join(repo, AIRGAP_DIR, "models.manifest.json");
      const r = await airgapSelfTest(repo, {
        ...(deps.log ? { log: deps.log } : {}),
        gates,
        ...(existsSync(manifestPath) && flag("--models-dir")
          ? {
              manifest: JSON.parse(readFileSync(manifestPath, "utf8")) as ModelManifest,
              modelDir: flag("--models-dir") as string,
            }
          : {}),
        cacheDir,
        knownQuery: flag("--query") ?? "function",
      });
      for (const c of r.checks) print(`${c.ok ? "ok" : "FAIL"} ${c.name}: ${c.detail}`);
      print(r.ok ? "Air-gap self-test passed." : "Air-gap self-test FAILED.");
      return r.ok ? 0 : 1;
    }
    default:
      print(
        "Usage: sekhemet airgap mirror|manifest|verify-models|docs|export-docs|import-docs|sign|update|selftest",
      );
      return 1;
  }
}
