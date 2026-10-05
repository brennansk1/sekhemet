import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  BlobStore,
  type ErasureRegisterEntry,
  EventLog,
  RestoreRefused,
  SCHEMA_VERSION,
  type TomlTable,
  ledgerBlobIds,
  ledgerErasures,
  ledgerEvidence,
  parseToml,
  readErasureRegister,
  restoreBackup,
} from "@sekhemet/kernel";
import { userConfigPath } from "./config.js";
import { readDaemon } from "./daemon.js";
import { DiskLowError, checkFreeSpace } from "./disk_space.js";
import { runnerLease } from "./runner_lease.js";
import { CREDENTIALS_FILE, identityDir, replaceCredentialStore } from "./team/credential_store.js";
import { userPaths } from "./user_dir.js";
import { realPath, writeLocator } from "./workspace_locator.js";

/**
 * Backups that survive the repository (runtime items 35, 35a, 36; NEW-runtime-11,
 * NEW-runtime-18; DEC-51 for FINDINGS_C1 REL-01). A set is the workspace's,
 * written outside every repository to `<user dir>/backups/<workspace id>/<date>/`:
 * the ledger (a consistent copy), the blobs and evidence the ledger names that
 * are not erased, each project's `config.toml` and `gates.toml`, the workspace's
 * credential store and a manifest with every file's hash. The erasure register
 * is kept beside the sets, never in one (kernel rule 35). Sets are written
 * whole or not at all (`<date>.partial`, renamed into place), kept 7 daily and
 * 4 weekly, and only sets this install wrote are ever deleted.
 *
 * The event log stays the only durable channel (spine rule 2): a set is a copy
 * of it and of the files it names, and `ledger/backed_up` records each one.
 */

export interface BackupManifest {
  format: 1;
  workspaceFolder: string;
  workspaceId: string;
  projects: { id: string; name: string; root: string }[];
  /** The last event the set's ledger holds. */
  seq: number;
  schemaVersion: number;
  /** The release that wrote it. */
  release: string;
  /** The install that wrote it (`<user dir>/install-id`): only its own sets are pruned. */
  writtenBy: string;
  writtenAt: string;
  kind: BackupKind;
  /** Every file in the set (relative path → SHA-256), the manifest excepted. */
  files: Record<string, string>;
  /** Blobs the ledger names, never erased, that were absent or damaged when the set was written. */
  missingBlobs: string[];
  /** Evidence bundles the ledger records whose file was absent or changed. */
  missingEvidence: string[];
}

export type BackupKind = "daily" | "overnight" | "manual";

export const MANIFEST = "manifest.json";
const LEDGER_FILE = "events.db";
/** Files restored into the workspace folder sit under this prefix in the set. */
const WORKSPACE_PREFIX = "workspace";

/** `<user dir>/backups/`, outside every repository (runtime item 35a). */
export function backupsRoot(): string {
  return userPaths().backups;
}

/** One workspace's sets and its erasure register. */
export function workspaceBackupDir(workspaceId: string): string {
  if (!/^ws_[0-9a-f]{12}$/.test(workspaceId)) throw new Error(`Not a workspace id: ${workspaceId}`);
  return join(backupsRoot(), workspaceId);
}

/** The erasure register, beside the sets (kernel rule 35, runtime item 35a). */
export function erasureRegisterFor(workspaceId: string): string {
  return join(workspaceBackupDir(workspaceId), "erasure-register.ndjson");
}

/** Where an older build kept the register: inside the folder `git clean -xdf` removes. */
export function legacyErasureRegister(workspaceFolder: string): string {
  return join(workspaceFolder, ".sekhemet", "backups", "erasure-register.ndjson");
}

/**
 * Carry a register kept at the old place to the new one (RUN-78), keyed by
 * erasure id so no entry is lost or doubled; the new file is replaced
 * atomically, then the old one is renamed `erasure-register.carried.ndjson`
 * so it is not read again. Returns how many entries were carried.
 */
export function carryErasureRegister(workspaceFolder: string, workspaceId: string): number {
  const old = legacyErasureRegister(workspaceFolder);
  const entries = readErasureRegister(old);
  if (entries === undefined) return 0;
  const target = erasureRegisterFor(workspaceId);
  const have = readErasureRegister(target) ?? [];
  const known = new Set(have.map((e) => e.erasureId));
  const carried = entries.filter((e) => !known.has(e.erasureId));
  const merged: ErasureRegisterEntry[] = [...have, ...carried].sort((a, b) => a.seq - b.seq);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, merged.map((e) => `${JSON.stringify(e)}\n`).join(""));
  renameSync(tmp, target);
  renameSync(old, join(dirname(old), "erasure-register.carried.ndjson"));
  return carried.length;
}

/**
 * The register a workspace's erasures append to: carried from the old place
 * first (RUN-78). `undefined` workspace id (a ledger with no event) keeps
 * the old place, which the next backup carries across.
 */
export function workspaceErasureRegister(
  workspaceFolder: string,
  workspaceId: string | undefined,
): string {
  if (!workspaceId) return legacyErasureRegister(workspaceFolder);
  carryErasureRegister(workspaceFolder, workspaceId);
  return erasureRegisterFor(workspaceId);
}

/** This install's id, created once (`<user dir>/install-id`, 0600). */
export function installId(): string {
  const path = userPaths().installId;
  try {
    const id = readFileSync(path, "utf8").trim();
    if (id) return id;
  } catch {
    // First use.
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const id = `inst_${randomUUID()}`;
  writeFileSync(path, `${id}\n`, { mode: 0o600 });
  return id;
}

/** The release that writes a set: this package's version. */
function releaseVersion(): string {
  try {
    return (
      (
        JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
          version?: string;
        }
      ).version ?? "0.0.0"
    );
  } catch {
    return "0.0.0";
  }
}

export interface BackupPolicy {
  enabled: boolean;
  keepDaily: number;
  keepWeekly: number;
}

function backupTable(path: string): TomlTable {
  try {
    const t = parseToml(readFileSync(path, "utf8")).backup;
    return t && typeof t === "object" && !Array.isArray(t) ? (t as TomlTable) : {};
  } catch {
    return {};
  }
}

/**
 * `[backup] enabled`, `keep_daily`, `keep_weekly` (runtime item 35a): the
 * user config, then the workspace folder's project config, the later winning.
 * On by default (DEC-51).
 */
export function backupPolicy(workspaceFolder: string): BackupPolicy {
  const merged = {
    ...backupTable(userConfigPath()),
    ...backupTable(join(workspaceFolder, ".sekhemet", "config.toml")),
  };
  const count = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : fallback;
  return {
    enabled: merged.enabled !== false,
    keepDaily: count(merged.keep_daily, 7),
    keepWeekly: count(merged.keep_weekly, 4),
  };
}

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const pad = (n: number): string => String(n).padStart(2, "0");
/** The local calendar date. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localTime(d: Date): string {
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
/** ISO week of a local date, as `YYYY-Www`. */
function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad(week)}`;
}

/**
 * Put `from` into the set at `rel` and record its hash. Always a copy, never
 * a hard link to an earlier set's file: a set that can be restored when a
 * newer one is damaged needs bytes of its own (RUN-61).
 */
function copyInto(from: string, setDir: string, rel: string, files: Record<string, string>): void {
  const target = join(setDir, rel);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(from, target);
  files[rel.split(sep).join("/")] = sha256(target);
}

export interface BackupSetResult {
  path: string;
  seq: number;
  manifest: BackupManifest;
  /** Older sets this install wrote that retention deleted (RUN-60). */
  pruned: string[];
  /** Register entries carried from the old place (RUN-78). */
  carried: number;
}

/**
 * Write one backup set for the workspace whose ledger `log` is (RUN-59,
 * RUN-87): see the module's comment for what it holds. The set is verified
 * before it is renamed into place, then `ledger/backed_up {path, seq,
 * schemaVersion}` records it and retention runs (RUN-60).
 */
export async function writeBackupSet(input: {
  workspaceFolder: string;
  db: DatabaseSync;
  log: EventLog;
  kind?: BackupKind;
  principal?: string;
  now?: Date;
}): Promise<BackupSetResult> {
  const now = input.now ?? new Date();
  const workspaceId = input.log.workspaceId();
  if (!workspaceId) throw new Error("The Activity log is empty: there is nothing to back up yet");
  const workspaceFolder = realPath(input.workspaceFolder);
  const carried = carryErasureRegister(workspaceFolder, workspaceId);
  const base = workspaceBackupDir(workspaceId);
  // RUN-69 (C4 builder C): no backup starts while the workspace's volume or
  // the backup folder's is below the free-space floor.
  const space = checkFreeSpace([workspaceFolder, base]);
  if (!space.ok) throw new DiskLowError(space);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  let name = localDate(now);
  if (existsSync(join(base, name))) name = `${name}-${localTime(now)}`;
  for (let n = 2; existsSync(join(base, name)); n++)
    name = `${localDate(now)}-${localTime(now)}-${n}`;
  const finalDir = join(base, name);
  const partial = `${finalDir}.partial`;
  // A set a crash left half-written: removed once it is an hour old.
  for (const stale of readdirSync(base).filter((n) => n.endsWith(".partial"))) {
    const at = join(base, stale);
    if (at === partial || now.getTime() - statSync(at).mtimeMs > 3_600_000)
      rmSync(at, { recursive: true, force: true });
  }
  mkdirSync(partial, { recursive: true, mode: 0o700 });
  try {
    const files: Record<string, string> = {};
    const ledger = join(partial, LEDGER_FILE);
    const { seq } = await input.log.copyVerified(ledger);
    files[LEDGER_FILE] = sha256(ledger);
    // What the set holds is read from its own ledger copy, so the two agree.
    const copy = new DatabaseSync(ledger, { readOnly: true });
    let projects: BackupManifest["projects"];
    let blobIds: { held: string[]; missing: string[] };
    let evidence: { id: string; path: string; sha256: string }[];
    try {
      blobIds = ledgerBlobIds(copy, new BlobStore(workspaceFolder));
      evidence = ledgerEvidence(copy);
      projects = (
        copy
          .prepare("SELECT id, name, root_path AS root FROM projects ORDER BY created_at, rowid")
          .all() as unknown as BackupManifest["projects"]
      ).map((p) => ({ id: p.id, name: p.name, root: p.root }));
    } finally {
      copy.close();
    }
    const blobs = new BlobStore(workspaceFolder);
    for (const id of blobIds.held) {
      const rel = join(WORKSPACE_PREFIX, relative(workspaceFolder, blobs.path(id)));
      try {
        copyInto(blobs.path(id), partial, rel, files);
      } catch (err) {
        // Deleted since the ledger was copied (an erasure the copy predates).
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (files[rel.split(sep).join("/")] !== id) {
        delete files[rel.split(sep).join("/")];
        rmSync(join(partial, rel), { force: true });
        blobIds.missing.push(id);
      }
    }
    const missingEvidence: string[] = [];
    for (const e of evidence) {
      const from = join(workspaceFolder, e.path);
      const inside = !relative(workspaceFolder, from).startsWith("..");
      if (!inside || !existsSync(from) || sha256(from) !== e.sha256) {
        missingEvidence.push(e.id);
        continue;
      }
      copyInto(from, partial, join(WORKSPACE_PREFIX, relative(workspaceFolder, from)), files);
    }
    // Each project's configuration (RUN-87), and the workspace folder's when it is no project.
    const roots = [...projects];
    if (!roots.some((p) => realPath(p.root) === workspaceFolder)) {
      roots.push({ id: "workspace", name: "workspace", root: workspaceFolder });
    }
    for (const p of roots) {
      for (const f of ["config.toml", "gates.toml"]) {
        const from = join(p.root, ".sekhemet", f);
        if (existsSync(from)) copyInto(from, partial, join("projects", p.id, f), files);
      }
    }
    // The workspace's credential store (security item 35a), at 0600.
    const credentials = join(identityDir(workspaceId), CREDENTIALS_FILE);
    if (existsSync(credentials)) {
      copyInto(credentials, partial, CREDENTIALS_FILE, files);
      chmodSync(join(partial, CREDENTIALS_FILE), 0o600);
    }
    const manifest: BackupManifest = {
      format: 1,
      workspaceFolder,
      workspaceId,
      projects,
      seq,
      schemaVersion: SCHEMA_VERSION,
      release: releaseVersion(),
      writtenBy: installId(),
      writtenAt: now.toISOString(),
      kind: input.kind ?? "manual",
      files,
      missingBlobs: blobIds.missing,
      missingEvidence,
    };
    writeFileSync(join(partial, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    const check = verifyBackupSet(partial);
    if (!check.ok) throw new Error(`The backup set does not verify: ${check.problems.join("; ")}`);
    renameSync(partial, finalDir);
    await input.log.recordBackup({
      path: finalDir,
      seq,
      schemaVersion: SCHEMA_VERSION,
      ...(input.principal ? { principal: input.principal } : {}),
    });
    const pruned = pruneBackupSets(workspaceId, backupPolicy(workspaceFolder), now);
    return { path: finalDir, seq, manifest, pruned, carried };
  } catch (err) {
    rmSync(partial, { recursive: true, force: true });
    throw err;
  }
}

export function readManifest(setDir: string): BackupManifest | undefined {
  try {
    const m = JSON.parse(readFileSync(join(setDir, MANIFEST), "utf8")) as BackupManifest;
    return m.format === 1 && typeof m.workspaceId === "string" ? m : undefined;
  } catch {
    return undefined;
  }
}

export interface BackupSetInfo {
  path: string;
  manifest: BackupManifest;
}

/** Every complete set, newest first; one workspace's when an id is given. */
export function listBackupSets(workspaceId?: string): BackupSetInfo[] {
  const root = backupsRoot();
  let workspaces: string[];
  try {
    workspaces = workspaceId ? [workspaceId] : readdirSync(root);
  } catch {
    return [];
  }
  const out: BackupSetInfo[] = [];
  for (const ws of workspaces) {
    let names: string[];
    try {
      names = readdirSync(join(root, ws));
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith(".partial")) continue;
      const path = join(root, ws, name);
      try {
        if (!statSync(path).isDirectory()) continue;
      } catch {
        continue;
      }
      const manifest = readManifest(path);
      if (manifest) out.push({ path, manifest });
    }
  }
  return out.sort((a, b) => b.manifest.writtenAt.localeCompare(a.manifest.writtenAt));
}

/**
 * Check a set against its manifest (RUN-61): every file's hash, the
 * ledger's chain, and its last seq. A blob's file hash is its id.
 */
export function verifyBackupSet(setDir: string): { ok: boolean; problems: string[] } {
  const manifest = readManifest(setDir);
  if (!manifest) return { ok: false, problems: ["no readable manifest"] };
  const problems: string[] = [];
  for (const [rel, hash] of Object.entries(manifest.files)) {
    const path = join(setDir, rel);
    if (!existsSync(path)) problems.push(`${rel} is missing`);
    else if (sha256(path) !== hash) problems.push(`${rel} does not match its hash`);
  }
  if (!(LEDGER_FILE in manifest.files)) problems.push("the set holds no ledger");
  else if (existsSync(join(setDir, LEDGER_FILE))) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(join(setDir, LEDGER_FILE), { readOnly: true });
      const rows = db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get() as {
        s: number;
      };
      if (rows.s !== manifest.seq)
        problems.push(`the ledger ends at ${rows.s}, not ${manifest.seq}`);
      const chain = new EventLog(db).verifyHashChainSync({ full: true });
      if (!chain.valid)
        problems.push(`the ledger's chain does not verify (${chain.reason ?? chain.corruptedSeq})`);
    } catch (err) {
      problems.push(`the ledger cannot be read: ${(err as Error).message}`);
    } finally {
      db?.close();
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The newest set of a workspace whose files and chain verify (RUN-61,
 * RUN-63: `doctor` shows its age). Undefined when there is none.
 */
export function newestVerifiedBackup(
  workspaceId: string,
  now: Date = new Date(),
): (BackupSetInfo & { ageHours: number }) | undefined {
  for (const set of listBackupSets(workspaceId)) {
    if (verifyBackupSet(set.path).ok) {
      return {
        ...set,
        ageHours: (now.getTime() - Date.parse(set.manifest.writtenAt)) / 3_600_000,
      };
    }
  }
  return undefined;
}

/**
 * The sets whose manifest names `folder` as the workspace folder or a
 * project's root, newest first (RUN-62, RUN-61 in a folder with no ledger).
 */
export function setsNaming(folder: string): BackupSetInfo[] {
  const real = realPath(folder);
  return listBackupSets().filter(
    (s) =>
      realPath(s.manifest.workspaceFolder) === real ||
      s.manifest.projects.some((p) => realPath(p.root) === real),
  );
}

/**
 * Retention (RUN-60): keep the newest set of each of the `keepDaily` newest
 * days that have one, and the newest set of each of the `keepWeekly` newest
 * ISO weeks that have one; delete every other set whose manifest says this
 * install wrote it. Returns the deleted sets' paths.
 */
export function pruneBackupSets(
  workspaceId: string,
  policy: Pick<BackupPolicy, "keepDaily" | "keepWeekly">,
  _now: Date = new Date(),
): string[] {
  const sets = listBackupSets(workspaceId);
  const keep = new Set<string>();
  const days = new Map<string, string>();
  const weeks = new Map<string, string>();
  for (const s of sets) {
    const at = new Date(s.manifest.writtenAt);
    const day = localDate(at);
    const week = isoWeek(at);
    if (!days.has(day)) days.set(day, s.path);
    if (!weeks.has(week)) weeks.set(week, s.path);
  }
  for (const p of [...days.values()].slice(0, policy.keepDaily)) keep.add(p);
  for (const p of [...weeks.values()].slice(0, policy.keepWeekly)) keep.add(p);
  const me = installId();
  const pruned: string[] = [];
  for (const s of sets) {
    if (keep.has(s.path) || s.manifest.writtenBy !== me) continue;
    rmSync(s.path, { recursive: true, force: true });
    pruned.push(s.path);
  }
  return pruned;
}

/**
 * The automatic backup (RUN-59): the first `queue`, `overnight` or `serve`
 * of a calendar day, and the end of every `overnight`, write a set unless
 * `[backup] enabled = false`. Due when this workspace has no set written
 * today (local date), or always for the end of an overnight. The triggers
 * call this (C4's builder B wires them).
 */
export async function dailyBackupIfDue(input: {
  workspaceFolder: string;
  db: DatabaseSync;
  log: EventLog;
  kind?: "daily" | "overnight";
  now?: Date;
}): Promise<BackupSetResult | { skipped: "disabled" | "done-today" | "empty-ledger" }> {
  const now = input.now ?? new Date();
  if (!backupPolicy(input.workspaceFolder).enabled) return { skipped: "disabled" };
  const workspaceId = input.log.workspaceId();
  if (!workspaceId) return { skipped: "empty-ledger" };
  const kind = input.kind ?? "daily";
  if (
    kind === "daily" &&
    listBackupSets(workspaceId).some(
      (s) => localDate(new Date(s.manifest.writtenAt)) === localDate(now),
    )
  ) {
    return { skipped: "done-today" };
  }
  return writeBackupSet({ ...input, kind, now });
}

export interface ProjectRestore {
  id: string;
  name: string;
  root: string;
  /** `missing`: the root no longer holds a repository (RUN-88). */
  state: "restored" | "missing";
  /** Configuration files written back; a different live file is kept. */
  configs: string[];
  keptLive: string[];
}

export interface SetRestoreReport {
  set: string;
  manifest: BackupManifest;
  backupSeq: number;
  reapplied: ErasureRegisterEntry[];
  previousKeptAt?: string;
  projects: ProjectRestore[];
  blobs: number;
  evidence: number;
  credentials: boolean;
  /** Where the credential store it replaced is kept (RUN-93), when it differed. */
  credentialsKeptAt?: string;
}

/**
 * Restore a whole workspace from a set (RUN-61, RUN-87, RUN-88; item 36):
 * refused unless every file and the chain verify; the ledger restored with
 * every register erasure newer than the set re-applied before anything
 * reads it (kernel `restoreBackup`); then the blobs and evidence (an erased
 * blob never comes back), each project's configuration where its file is
 * missing, the locators, and the credential store. A project whose root no
 * longer holds its repository is listed as missing, with the root expected;
 * a person names its new folder with `sekhemet project move` (K-N12-7). Run
 * with the server stopped: it replaces the ledger file.
 */
export async function restoreBackupSet(setDir: string): Promise<SetRestoreReport> {
  const manifest = readManifest(setDir);
  if (!manifest) throw new RestoreRefused(`No backup set at ${setDir} (no readable manifest)`);
  refuseWhileInUse(
    manifest.workspaceFolder,
    manifest.projects.map((p) => p.root),
  );
  const check = verifyBackupSet(setDir);
  if (!check.ok) {
    throw new RestoreRefused(
      `Refusing to restore ${setDir}: it does not verify — ${check.problems.join("; ")}`,
    );
  }
  const ws = manifest.workspaceFolder;
  mkdirSync(join(ws, ".sekhemet"), { recursive: true });
  carryErasureRegister(ws, manifest.workspaceId);
  const blobs = new BlobStore(ws);
  const restored = await restoreBackup({
    backupPath: join(setDir, LEDGER_FILE),
    targetPath: join(ws, ".sekhemet", "events.db"),
    registerPath: erasureRegisterFor(manifest.workspaceId),
    blobs,
  });
  // What the restored ledger erased — in the set or re-applied — never comes back.
  const db = new DatabaseSync(join(ws, ".sekhemet", "events.db"), { readOnly: true });
  let erased: Set<string>;
  try {
    erased = new Set(ledgerErasures(db).byBlob.keys());
  } finally {
    db.close();
  }
  let blobCount = 0;
  let evidenceCount = 0;
  for (const rel of Object.keys(manifest.files)) {
    if (!rel.startsWith(`${WORKSPACE_PREFIX}/`)) continue;
    const inner = rel.slice(WORKSPACE_PREFIX.length + 1);
    const blob = /^\.sekhemet\/blobs\/[0-9a-f]{2}\/([0-9a-f]{64})\.json$/.exec(inner);
    if (blob && erased.has(blob[1] as string)) continue;
    const target = join(ws, inner);
    if (relative(ws, target).startsWith("..")) continue;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(setDir, rel), target);
    if (blob) blobCount++;
    else evidenceCount++;
  }
  const projects: ProjectRestore[] = [];
  for (const p of manifest.projects) {
    const present = existsSync(join(p.root, ".git"));
    const entry: ProjectRestore = {
      id: p.id,
      name: p.name,
      root: p.root,
      state: present ? "restored" : "missing",
      configs: [],
      keptLive: [],
    };
    if (present) restoreConfigs(setDir, manifest, p.id, p.root, entry);
    if (present && realPath(p.root) !== realPath(ws)) {
      writeLocator(p.root, { workspaceFolder: ws, workspaceId: manifest.workspaceId });
    }
    projects.push(entry);
  }
  if (!manifest.projects.some((p) => realPath(p.root) === realPath(ws))) {
    restoreConfigs(setDir, manifest, "workspace", ws, {
      id: "workspace",
      name: "workspace",
      root: ws,
      state: "restored",
      configs: [],
      keptLive: [],
    });
  }
  let credentials = false;
  let credentialsKeptAt: string | undefined;
  if (CREDENTIALS_FILE in manifest.files) {
    credentialsKeptAt = replaceCredentialStore(
      identityDir(manifest.workspaceId),
      readFileSync(join(setDir, CREDENTIALS_FILE), "utf8"),
      restored.previousKeptAt,
    );
    credentials = true;
  }
  return {
    set: setDir,
    manifest,
    backupSeq: restored.backupSeq,
    reapplied: restored.reapplied,
    ...(restored.previousKeptAt ? { previousKeptAt: restored.previousKeptAt } : {}),
    projects,
    blobs: blobCount,
    evidence: evidenceCount,
    credentials,
    ...(credentialsKeptAt ? { credentialsKeptAt } : {}),
  };
}

/**
 * Refuse a restore while something still writes the workspace's ledger
 * (RUN-92): a dashboard server a project's daemon.json names, or the runner
 * lease's holder, each named so the person can stop it. The kernel's restore
 * refuses any other process the operating system sees holding the file.
 */
export function refuseWhileInUse(workspaceFolder: string, projectRoots: readonly string[]): void {
  const said: string[] = [];
  for (const root of new Set([workspaceFolder, ...projectRoots])) {
    const daemon = readDaemon(root);
    if (daemon) {
      said.push(
        `the dashboard server (pid ${daemon.pid}, port ${daemon.port}) runs in ${root}: \`sekhemet daemon stop\` there`,
      );
    }
  }
  const lease = runnerLease(workspaceFolder);
  if (lease) {
    const what = lease.kind === "run" && lease.cardId ? `run ${lease.cardId}` : lease.kind;
    said.push(
      `a runner holds the lease (pid ${lease.pid}${what ? `, ${what}` : ""}, since ${lease.startedAt}): let it finish or stop it`,
    );
  }
  if (said.length > 0) {
    throw new RestoreRefused(
      `Refusing to restore while the workspace is in use — ${said.join("; ")}. A restore replaces the Activity log, and a process still writing it would go on writing to the file moved aside.`,
    );
  }
}

function restoreConfigs(
  setDir: string,
  manifest: BackupManifest,
  id: string,
  root: string,
  entry: ProjectRestore,
): void {
  for (const f of ["config.toml", "gates.toml"]) {
    const rel = `projects/${id}/${f}`;
    if (!(rel in manifest.files)) continue;
    const target = join(root, ".sekhemet", f);
    if (existsSync(target)) {
      if (sha256(target) !== manifest.files[rel]) entry.keptLive.push(f);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(setDir, rel), target);
    entry.configs.push(f);
  }
}

/** One line per set for `sekhemet backup --list` (REL-18). */
export function describeSet(set: BackupSetInfo, verified: boolean): string {
  const m = set.manifest;
  return `${set.path}  ${m.writtenAt.slice(0, 16).replace("T", " ")}  through entry ${m.seq}  schema ${m.schemaVersion}  release ${m.release}  ${m.kind}${verified ? "" : "  DOES NOT VERIFY"}`;
}
