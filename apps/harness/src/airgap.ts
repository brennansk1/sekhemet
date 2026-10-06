import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { approveSkill } from "@sekhemet/context";
import { type RegistryLookup, onPath } from "@sekhemet/gates";
import type { EventLog } from "@sekhemet/kernel";
import { pinsOf } from "@sekhemet/loop";
import { type ModelRegistry, readChatTemplate, templateChecksum } from "@sekhemet/models";
import {
  EgressProxy,
  type EgressRecord,
  ProcessSandbox,
  mergeNetworkConfigs,
  policyFetch,
} from "@sekhemet/sandbox";
import { plural } from "@sekhemet/ui";
import { networkConfigs } from "./config_apply.js";
import { egressEvent } from "./egress_event.js";
import { reportLostRecord } from "./lost_records.js";
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

/**
 * Every package and version the project's lockfiles pin, read through the
 * one pins reader (design-stage DS-N9-7), in the mirror's shape: npm, PyPI
 * (names lower-cased) and crates. Go modules are not mirrored.
 */
export function allowlistFromLockfiles(repo: string): MirrorAllowlist {
  const out: MirrorAllowlist = {
    npm: {},
    pypi: {},
    crates: {},
    generatedAt: new Date().toISOString(),
  };
  for (const pin of pinsOf(repo)) {
    if (pin.eco === "npm") addVersion(out.npm, pin.name, pin.version);
    else if (pin.eco === "python") addVersion(out.pypi, pin.name.toLowerCase(), pin.version);
    else if (pin.eco === "rust") addVersion(out.crates, pin.name, pin.version);
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
    const template = await readChatTemplate(path);
    models.push({
      id: f.replace(/\.(gguf|safetensors|bin)$/, ""),
      file: f,
      sha256: await sha256File(path),
      // "none" is recorded too, so a template added later is caught.
      templateChecksum: template ? templateChecksum(template.template) : "none",
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
    // SEC-34a: identical weights can still run a different chat template.
    if (m.templateChecksum) {
      const template = await readChatTemplate(path);
      const sum = template ? templateChecksum(template.template) : "none";
      if (sum !== m.templateChecksum) {
        out.push({
          id: m.id,
          ok: false,
          detail: template
            ? `chat template checksum mismatch in ${basename(template.source)} (${sum.slice(0, 12)} != ${m.templateChecksum.slice(0, 12)})`
            : "chat template missing: the manifest names one, the model has none",
        });
        continue;
      }
    }
    // SEC-34b: the manifest's tier is recorded, never trusted as this
    // machine's qualification; the model still qualifies here before a card.
    registry?.upsert(m.id, {
      ...(m.quant ? { quant: m.quant } : {}),
      ...(m.tier ? { manifestTier: m.tier } : {}),
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
  /** SEC-44: the dependency versions the docs were fetched at (`npm:<name>` → versions). */
  versions?: Record<string, string[]>;
  /** SEC-45: the dependencies (same keys) whose docs could not be fetched at these versions. */
  unavailable?: Record<string, string[]>;
}

/** Where an imported bundle's versions are kept beside the cache (not a cache entry). */
const BUNDLE_META = ".bundle-meta";

type BundleMeta = Pick<DocBundle, "versions" | "unavailable">;

function readBundleMeta(cacheDir: string): BundleMeta | undefined {
  const file = join(cacheDir, BUNDLE_META);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as BundleMeta;
  } catch {
    // A corrupt record is treated as no record, never a crash of the self-test.
    return undefined;
  }
}

function writeBundleMeta(cacheDir: string, meta: BundleMeta): void {
  writeFileSync(join(cacheDir, BUNDLE_META), JSON.stringify(meta));
}

/**
 * SEC-44: each direct dependency's docs and any published `llms.txt`, at the
 * version the lockfile pins, fetched on the connected machine into the
 * research cache; returns the versions for the bundle to record.
 */
export async function prefetchPinnedDocs(
  repo: string,
  fetchText: TextFetch,
  cache: ResearchCache,
): Promise<{
  versions: Record<string, string[]>;
  unavailable: Record<string, string[]>;
  pages: number;
  missing: string[];
}> {
  const pinned = allowlistFromLockfiles(repo);
  const versions: Record<string, string[]> = {};
  const unavailable: Record<string, string[]> = {};
  const missing: string[] = [];
  let pages = 0;
  const store = async (url: string): Promise<string | undefined> => {
    const body = await fetchText(url).catch(() => undefined);
    if (body === undefined) return undefined;
    cache.set(url, 200, "text/plain", body);
    pages++;
    return body;
  };
  // `llms.txt` lives on a project's docs site, not in its package (B1 review):
  // try the site's origin as well as the package itself.
  const siteLlms = async (site: unknown): Promise<number> => {
    if (typeof site !== "string" || !/^https?:\/\//.test(site)) return 0;
    return (await store(`${new URL(site).origin}/llms.txt`)) === undefined ? 0 : 1;
  };
  for (const name of directNpmDependencies(repo)) {
    const vs = pinned.npm[name];
    if (!vs?.length) continue;
    let got = 0;
    for (const v of vs) {
      if ((await store(`https://unpkg.com/${name}@${v}/README.md`)) !== undefined) got++;
      if ((await store(`https://unpkg.com/${name}@${v}/llms.txt`)) !== undefined) got++;
      const manifest = await store(`https://unpkg.com/${name}@${v}/package.json`);
      if (manifest !== undefined) {
        try {
          got += await siteLlms((JSON.parse(manifest) as { homepage?: unknown }).homepage);
        } catch {
          // A manifest that is not JSON names no site.
        }
      }
    }
    // SEC-44: a version is recorded only for docs actually stored.
    if (got > 0) versions[`npm:${name}`] = vs;
    else {
      unavailable[`npm:${name}`] = vs;
      missing.push(name);
    }
  }
  for (const [name, vs] of Object.entries(pinned.pypi).sort()) {
    let got = 0;
    for (const v of vs) {
      const meta = await store(`https://pypi.org/pypi/${name}/${v}/json`);
      if (meta === undefined) continue;
      got++;
      try {
        const urls = (JSON.parse(meta) as { info?: { project_urls?: Record<string, string> } }).info
          ?.project_urls;
        for (const site of Object.values(urls ?? {})) got += await siteLlms(site);
      } catch {
        // As above.
      }
    }
    if (got > 0) versions[`pypi:${name}`] = vs;
    else {
      unavailable[`pypi:${name}`] = vs;
      missing.push(name);
    }
  }
  return { versions, unavailable, pages, missing };
}

/** The project's direct npm dependencies (dependencies and devDependencies). */
function directNpmDependencies(repo: string): string[] {
  const pkgPath = join(repo, "package.json");
  if (!existsSync(pkgPath)) return [];
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: object;
    devDependencies?: object;
  };
  return Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }).sort();
}

/** SEC-45: the packages whose imported docs no longer match the lockfile. */
export function docsBundleStaleness(repo: string, cacheDir: string): string[] {
  const meta = readBundleMeta(cacheDir);
  if (!meta) return [];
  // Docs that could not be fetched at a version count as recorded at it, so
  // they are not flagged on every run; a new version is worth trying again.
  const recorded = { ...(meta.unavailable ?? {}), ...(meta.versions ?? {}) };
  const now = allowlistFromLockfiles(repo);
  const stale: string[] = [];
  // A dependency added since the bundle was built has no docs in it (B1 review).
  for (const name of directNpmDependencies(repo)) {
    if (now.npm[name]?.length && !recorded[`npm:${name}`]) stale.push(name);
  }
  for (const [name, vs] of Object.entries(now.pypi)) {
    if (vs.length && !recorded[`pypi:${name}`]) stale.push(name);
  }
  for (const [key, vs] of Object.entries(recorded)) {
    const [eco, ...rest] = key.split(":");
    const name = rest.join(":");
    const current = (eco === "pypi" ? now.pypi : now.npm)[name] ?? [];
    // A dependency no longer in the lockfile needs no docs.
    if (current.length === 0) continue;
    if (JSON.stringify([...current].sort()) !== JSON.stringify([...vs].sort())) stale.push(name);
  }
  return stale.sort();
}

/** Export the research cache as one bundle file (with its checksum). */
export function exportDocBundle(cacheDir: string, out: string, meta: BundleMeta = {}): DocBundle {
  const entries = existsSync(cacheDir)
    ? readdirSync(cacheDir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => ({ file: f, json: readFileSync(join(cacheDir, f), "utf8") }))
    : [];
  const sha256 = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  // The versions `docs --pinned` recorded beside the cache travel with it.
  const stored = meta.versions || meta.unavailable ? meta : readBundleMeta(cacheDir);
  const versions = stored?.versions;
  const unavailable = stored?.unavailable;
  const bundle: DocBundle = {
    version: 1,
    createdAt: new Date().toISOString(),
    entries,
    sha256,
    ...(versions ? { versions } : {}),
    ...(unavailable ? { unavailable } : {}),
  };
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
  if (b.versions || b.unavailable)
    writeBundleMeta(cacheDir, {
      ...(b.versions ? { versions: b.versions } : {}),
      ...(b.unavailable ? { unavailable: b.unavailable } : {}),
    });
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
  /** SEC-46: skills this signed bundle carries, name → SHA-256 of its SKILL.md. */
  skills?: Record<string, string>;
}

const verifiedSkillsPath = (repo: string) =>
  join(repo, ".sekhemet", "airgap", "verified-skills.json");

/**
 * SEC-46: in air-gap mode a skill is accepted only as the content a signed
 * update bundle carried; approval by content hash is still required after.
 */
export function airgapSkillApproval(
  repo: string,
  skillsDir: string,
  name: string,
): { ok: boolean; reason?: string; sha256?: string } {
  if (!isAirgapped(repo)) return { ok: true };
  const file = join(skillsDir, name, "SKILL.md");
  if (!existsSync(file)) return { ok: false, reason: `no skill ${name}` };
  const sha = createHash("sha256").update(readFileSync(file, "utf8"), "utf8").digest("hex");
  let verified: Record<string, string> = {};
  try {
    verified = JSON.parse(readFileSync(verifiedSkillsPath(repo), "utf8")) as Record<string, string>;
  } catch {
    verified = {};
  }
  return verified[name] === sha
    ? { ok: true, sha256: sha }
    : {
        ok: false,
        reason: `air-gap mode: ${name} is not the content of a signed update bundle; import it with sekhemet airgap update`,
      };
}

/**
 * Approve a skill and check the pin is the content the air-gap check
 * verified (`expectedSha`, or anything when not air-gapped). On a mismatch
 * the lock file is restored byte for byte, so an earlier valid pin survives
 * (SEC-46, B1 re-review).
 */
export function approveVerifiedSkill(
  skillsDir: string,
  name: string,
  lockPath: string,
  expectedSha: string | undefined,
): { ok: boolean; sha256: string } {
  const before = existsSync(lockPath) ? readFileSync(lockPath) : undefined;
  const e = approveSkill(skillsDir, name, "human", lockPath);
  if (!expectedSha || e.sha256 === expectedSha) return { ok: true, sha256: e.sha256 };
  if (before) {
    // Atomic, as `writeSkillLock` writes it.
    const tmpFile = `${lockPath}.${process.pid}.tmp`;
    writeFileSync(tmpFile, before);
    renameSync(tmpFile, lockPath);
  } else rmSync(lockPath, { force: true });
  return { ok: false, sha256: e.sha256 };
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
      detail: `update ${manifest.version} does not support the Activity log's schema ${opts.schemaVersion}: ${manifest.note}`,
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
  if (manifest.skills && Object.keys(manifest.skills).length > 0) {
    const path = verifiedSkillsPath(opts.repo);
    let verified: Record<string, string> = {};
    try {
      verified = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    } catch {
      verified = {};
    }
    mkdirSync(join(opts.repo, ".sekhemet", "airgap"), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...verified, ...manifest.skills }, null, 2));
  }
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
    /** The project's gate commands, run as a card runs them (SEC-33). */
    gateRuns?: { id: string; command: string; args: string[]; timeoutS?: number }[];
  } = {},
): Promise<{ ok: boolean; checks: SelfTestCheck[] }> {
  const checks: SelfTestCheck[] = [];
  const sandbox = opts.sandbox ?? new ProcessSandbox();
  // A direct connection, bypassing any proxy, must fail in the sandbox.
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
  // SEC-33: run the project's gates confined, with a proxy that allows
  // nothing; any request it records is an attempt to leave the machine.
  if (opts.gateRuns?.length) {
    const attempts: EgressRecord[] = [];
    const notRun: string[] = [];
    const proxy = new EgressProxy({ allow: [], onRequest: (rec) => attempts.push(rec) });
    const port = await proxy.start();
    try {
      for (const g of opts.gateRuns) {
        // Each gate's own time limit, and its exit recorded: a gate that never
        // ran proves nothing about the network (B1 review).
        const res = await sandbox
          .execute(g.command, g.args, {
            allowedPaths: [repo],
            allowNetwork: false,
            egressProxyPort: port,
            timeoutMs: (g.timeoutS ?? 60) * 1000,
            cwd: repo,
          })
          .catch(() => undefined);
        if (!res || res.exitCode === 126 || res.exitCode === 127 || res.timedOut) {
          notRun.push(
            `${g.id} (${res?.timedOut ? "timed out" : `exit ${res?.exitCode ?? "error"}`})`,
          );
        }
      }
    } finally {
      await proxy.close();
    }
    checks.push({
      name: "checks make no outbound attempt",
      ok: attempts.length === 0 && notRun.length === 0,
      detail:
        attempts.length > 0
          ? `outbound attempts: ${[...new Set(attempts.map((a) => a.host))].join(", ")}`
          : notRun.length > 0
            ? `not proven, these checks did not run to completion: ${notRun.join(", ")}`
            : `${plural(opts.gateRuns.length, "check")} ran with no outbound attempt`,
    });
  }
  for (const g of opts.gates ?? []) {
    const found = onPath(g.command);
    checks.push({
      name: `check ${g.id} runnable`,
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
  // SEC-45: the imported docs bundle against today's lockfile.
  if (cacheDir && existsSync(join(cacheDir, BUNDLE_META))) {
    const stale = docsBundleStaleness(repo, cacheDir);
    checks.push({
      name: "docs bundle matches the lockfile",
      ok: stale.length === 0,
      detail:
        stale.length === 0
          ? "every package's docs match its pinned version"
          : `stale: ${stale.join(", ")}`,
    });
  }
  let ok = checks.every((c) => c.ok);
  // RUN-90: the self-test's record is the air-gap's evidence: one that
  // cannot be written fails the self-test rather than vanish.
  try {
    await opts.log?.append({ actor: "system", type: "airgap/selftest", payload: { ok, checks } });
  } catch (err) {
    reportLostRecord("airgap/selftest", err, { workspaceId: opts.log?.workspaceId() });
    checks.push({
      name: "self-test recorded on the Activity log",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
    ok = false;
  }
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
        `Mirror allowlist: ${plural(r.packages, "package")} at ${AIRGAP_DIR}/allowlist.json; ${r.detail}.`,
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
        `Manifest: ${plural(m.models.length, "model")} at ${out}. Sign it: sekhemet airgap sign ${out} --key <key>`,
      );
      return 0;
    }
    case "verify-models": {
      if (!a1 || !a2) return done("Usage: sekhemet airgap verify-models <manifest> <dir>", 1);
      const sig = flag("--sig");
      // SEC-34: offline, the signature is the only proof the manifest is the
      // one the connected machine built; without it nothing is registered.
      if (!sig && isAirgapped(repo)) {
        return done(
          "Air-gap mode needs a signed manifest: pass --sig <signature> --signers <file> --identity <id>.",
          1,
        );
      }
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
      if (!a1) return done("Usage: sekhemet airgap docs <library-or-url> | --pinned", 1);
      // Through the one network policy, recorded (security item 32).
      const nets = networkConfigs(repo);
      const policied = policyFetch(mergeNetworkConfigs(nets.user, nets.project), {
        purpose: "docs",
        ...(deps.log
          ? {
              record: (r) => deps.log?.append({ actor: "system", ...egressEvent(r) }),
            }
          : {}),
      });
      const fetchText: TextFetch = async (url) => {
        const res = await policied(url, { signal: AbortSignal.timeout(20_000) }).catch(
          () => undefined,
        );
        return res?.ok ? await res.text() : undefined;
      };
      if (a1 === "--pinned") {
        const r = await prefetchPinnedDocs(repo, fetchText, new ResearchCache(cacheDir));
        mkdirSync(cacheDir, { recursive: true });
        writeBundleMeta(cacheDir, { versions: r.versions, unavailable: r.unavailable });
        print(
          `Cached ${plural(r.pages, "page")} for ${Object.keys(r.versions).length} pinned dependencies.`,
        );
        if (r.missing.length) {
          print(
            `No docs fetched for: ${r.missing.join(", ")} (check [network] in your config.toml; offline refuses every request).`,
          );
        }
        return r.pages > 0 ? 0 : 1;
      }
      const { KNOWN_DOCS } = await import("./research/docs.js");
      const entry = /^https?:/.test(a1) ? a1 : KNOWN_DOCS[a1.toLowerCase()];
      if (!entry) return done(`No known docs home for ${a1}; pass its URL.`, 1);
      const r = await prefetchDocs(
        entry,
        fetchText,
        new ResearchCache(cacheDir),
        Number(flag("--pages") ?? 200),
      );
      print(`Cached ${plural(r.pages, "page")} of ${r.root ?? entry}.`);
      return 0;
    }
    case "export-docs": {
      if (!a1) return done("Usage: sekhemet airgap export-docs <out>", 1);
      const b = exportDocBundle(cacheDir, a1);
      print(
        `Exported ${plural(b.entries.length, "cached page")} to ${a1} (sha256 ${b.sha256.slice(0, 12)}).`,
      );
      return 0;
    }
    case "import-docs": {
      if (!a1) return done("Usage: sekhemet airgap import-docs <file>", 1);
      print(`Imported ${plural(importDocBundle(a1, cacheDir), "page")} into ${cacheDir}.`);
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
      if (r.backup) print(`Activity log backed up to ${r.backup}.`);
      // RUN-90: an update whose record cannot be written fails the command.
      try {
        await deps.log?.append({ actor: "system", type: "airgap/update", payload: r });
      } catch (err) {
        reportLostRecord("airgap/update", err, { workspaceId: deps.log?.workspaceId() });
        print(
          `The update's record could not be written to the Activity log: ${err instanceof Error ? err.message : String(err)}.`,
        );
        return 1;
      }
      return r.applied ? 0 : 1;
    }
    case "selftest": {
      const { loadGatesConfig } = await import("@sekhemet/gates");
      let gates: { id: string; command: string; args: string[] }[] = [];
      try {
        gates = loadGatesConfig(repo).gates.map((g) => ({
          id: g.id,
          command: g.command,
          args: g.args ?? [],
          ...(g.timeoutMs ? { timeoutS: Math.ceil(g.timeoutMs / 1000) } : {}),
        }));
      } catch {
        gates = [];
      }
      const manifestPath = join(repo, AIRGAP_DIR, "models.manifest.json");
      const r = await airgapSelfTest(repo, {
        ...(deps.log ? { log: deps.log } : {}),
        gates,
        // SEC-33: the gates run as a card runs them, watched at a deny-all proxy.
        ...(args.includes("--run-gates") ? { gateRuns: gates } : {}),
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
