import { copyFileSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { BlobStore } from "./blobs.js";
import {
  type ChainRow,
  type ErasureRegisterEntry,
  EventLog,
  erasureIndexOf,
  ledgerErasures,
  readChainRows,
  verifyChainRows,
} from "./log.js";
import { initSchema } from "./schema.js";
import type { HashChainVerificationResult } from "./types.js";

/**
 * Backups that respect erasure, and the portable ledger export (kernel rule
 * 35, NEW-kernel-7; runtime.md NEW-runtime-8). The copy itself is
 * `EventLog.backup`; this module reads the erasure register, re-applies it
 * to a restored ledger, and writes and verifies the NDJSON export.
 */

const BLOB_ID = /\b[0-9a-f]{64}\b/g;

/**
 * The blobs a ledger names that are not erased (runtime items 35a and 37;
 * RUN-59, RUN-87, SPEC-02): every blob id in an event's payload or private
 * part, or a step's context pack, less every blob a `ledger/erased` names.
 * `held` are those the store holds with bytes that still hash to their id;
 * `missing` are named, never erased, and absent or damaged. One enumeration
 * for the backup set and the export. Reads only.
 */
export function ledgerBlobIds(
  db: DatabaseSync,
  blobs: BlobStore,
): { held: string[]; missing: string[] } {
  const named = new Set<string>();
  const scan = (text: string | null): void => {
    for (const m of text?.matchAll(BLOB_ID) ?? []) named.add(m[0]);
  };
  for (const r of db.prepare("SELECT payload FROM events WHERE type != 'ledger/erased'").all())
    scan((r as { payload: string }).payload);
  for (const r of db.prepare("SELECT body FROM event_private").all())
    scan((r as { body: string }).body);
  const steps = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'steps'")
    .get();
  if (steps) {
    for (const r of db
      .prepare("SELECT context_pack_id AS id FROM steps WHERE context_pack_id IS NOT NULL")
      .all())
      scan((r as { id: string }).id);
  }
  const erased = ledgerErasures(db).byBlob;
  const held: string[] = [];
  const missing: string[] = [];
  for (const id of [...named].sort()) {
    if (erased.has(id)) continue;
    if (blobs.get(id) !== undefined) held.push(id);
    else if (blobs.has(id) || looksLikeBlobRef(db, id)) missing.push(id);
  }
  return { held, missing };
}

/**
 * Whether a 64-hex value the ledger carries is meant as a blob: a step's
 * context pack, or a value under a key naming a pack or blob. An event hash
 * or a commit hash quoted in a payload is not.
 */
function looksLikeBlobRef(db: DatabaseSync, id: string): boolean {
  const steps = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'steps'")
    .get();
  if (steps && db.prepare("SELECT 1 AS x FROM steps WHERE context_pack_id = ?").get(id))
    return true;
  const keyed = new RegExp(
    `"[A-Za-z]*(?:[Pp]ack|[Bb]lob)[A-Za-z]*"\\s*:\\s*(?:\\[[^\\]]*)?"${id}"`,
  );
  const rows = db
    .prepare(
      "SELECT payload AS t FROM events WHERE instr(payload, ?) > 0 UNION ALL SELECT body AS t FROM event_private WHERE instr(body, ?) > 0",
    )
    .all(id, id) as { t: string }[];
  return rows.some((r) => keyed.test(r.t));
}

/** The evidence bundles a ledger records: id, path (relative to the workspace folder) and hash. */
export function ledgerEvidence(db: DatabaseSync): { id: string; path: string; sha256: string }[] {
  const table = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'evidence_bundles'")
    .get();
  if (!table) return [];
  return db
    .prepare("SELECT id, path, sha256 FROM evidence_bundles ORDER BY created_at, rowid")
    .all() as unknown as { id: string; path: string; sha256: string }[];
}

/** The register's entries, oldest first; undefined when the file does not exist. */
export function readErasureRegister(path: string): ErasureRegisterEntry[] | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as ErasureRegisterEntry);
}

export interface ApplyErasuresReport {
  /** Register entries this run re-applied (K-N7-9: reported the first time only). */
  reapplied: ErasureRegisterEntry[];
  /** Entries this ledger already carries, as the erasure or a re-application. */
  alreadyApplied: string[];
  /** Entries with nothing on this ledger to erase (their events came after the backup). */
  nothingToErase: string[];
}

/**
 * Re-apply every register entry newer than `afterSeq` to `log` (rule 35),
 * idempotently: an entry the ledger already carries is skipped, so a second
 * run changes nothing (K-N7-9). Each re-application is its own
 * `ledger/erased {…, reapplies}` event, so the restored chain names its gaps.
 */
export async function applyErasures(
  log: EventLog,
  register: readonly ErasureRegisterEntry[],
  afterSeq: number,
  options: { blobs?: BlobStore } = {},
): Promise<ApplyErasuresReport> {
  const report: ApplyErasuresReport = { reapplied: [], alreadyApplied: [], nothingToErase: [] };
  const pending = register.filter((e) => e.seq > afterSeq).sort((a, b) => a.seq - b.seq);
  for (const entry of pending) {
    if (log.erasureApplied(entry.erasureId)) {
      report.alreadyApplied.push(entry.erasureId);
      continue;
    }
    const eventIds = entry.eventIds.filter((id) => log.hasEvent(id));
    const blobIds = options.blobs ? entry.blobIds : [];
    if (eventIds.length === 0 && blobIds.length === 0) {
      report.nothingToErase.push(entry.erasureId);
      continue;
    }
    try {
      await log.erase({
        eventIds,
        blobIds,
        ...(options.blobs ? { blobs: options.blobs } : {}),
        reason: entry.reason,
        principal: entry.principal,
        reapplies: entry.erasureId,
      });
    } catch (err) {
      if (/Nothing to erase/.test((err as Error).message)) {
        report.nothingToErase.push(entry.erasureId);
        continue;
      }
      throw err;
    }
    report.reapplied.push(entry);
  }
  return report;
}

/** A restore refused rather than bring erased data back (rule 35, K-N7-5, RUN-40). */
export class RestoreRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreRefused";
  }
}

function erasureCount(path: string): number {
  if (!existsSync(path)) return 0;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const hasEvents = db
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'events'")
      .get();
    if (!hasEvents) return 0;
    return (
      db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'ledger/erased'").get() as {
        n: number;
      }
    ).n;
  } finally {
    db.close();
  }
}

export interface RestoreReport {
  /** The last seq the backup holds. */
  backupSeq: number;
  reapplied: ErasureRegisterEntry[];
  /** Where the ledger it replaced was moved, so a restore loses nothing. */
  previousKeptAt?: string;
}

/**
 * Whether another connection has the ledger at `path` open (RUN-92). In WAL
 * mode every open connection holds a shared lock on the file for its whole
 * life, so an exclusive lock taken without waiting fails while any other
 * process — a server, a runner, an editor's MCP server, a script — has it
 * open, however idle. False when the file does not exist.
 */
export function ledgerInUse(path: string): boolean {
  if (!existsSync(path)) return false;
  const probe = new DatabaseSync(path, { timeout: 0 });
  try {
    probe.exec("PRAGMA locking_mode=EXCLUSIVE");
    probe.exec("BEGIN EXCLUSIVE");
    probe.exec("COMMIT");
    return false;
  } catch (err) {
    if (/locked|busy/i.test((err as Error).message)) return true;
    throw err;
  } finally {
    probe.close();
  }
}

/**
 * Restore `backupPath` over `targetPath` (rule 35, K-N7-5): the backup is
 * copied beside the target, migrated if older, and every register erasure
 * newer than its last seq is re-applied there — before the restored ledger is
 * moved into place, so nothing ever reads it unerased. Refused when erasures
 * are known to exist (in the backup or the ledger being replaced) and the
 * register is missing, or when the backup's chain does not verify. The
 * replaced ledger is kept beside it. Refused while another process has the
 * ledger open (RUN-92): it would go on writing to the file moved aside.
 */
export async function restoreBackup(options: {
  backupPath: string;
  targetPath: string;
  registerPath: string;
  blobs?: BlobStore;
}): Promise<RestoreReport> {
  const { backupPath, targetPath, registerPath } = options;
  if (!existsSync(backupPath)) throw new RestoreRefused(`No backup at ${backupPath}`);
  const known = erasureCount(backupPath) + erasureCount(targetPath);
  const register = readErasureRegister(registerPath);
  if (register === undefined && known > 0) {
    throw new RestoreRefused(
      `Refusing to restore: ${known} erasure(s) are recorded, and the erasure register ${registerPath} is missing — restoring without it could bring erased data back (kernel rule 35)`,
    );
  }

  const staging = `${targetPath}.restoring`;
  for (const f of [staging, `${staging}-wal`, `${staging}-shm`]) rmSync(f, { force: true });
  copyFileSync(backupPath, staging);
  let backupSeq: number;
  let reapplied: ErasureRegisterEntry[];
  const db = new DatabaseSync(staging);
  try {
    initSchema(db);
    const log = new EventLog(db);
    const before = log.verifyHashChainSync({ full: true });
    if (!before.valid) {
      throw new RestoreRefused(
        `Refusing to restore: the backup's chain does not verify (${before.reason ?? `seq ${before.corruptedSeq}`})`,
      );
    }
    backupSeq = log.lastSeq();
    const applied = await applyErasures(log, register ?? [], backupSeq, {
      ...(options.blobs ? { blobs: options.blobs } : {}),
    });
    reapplied = applied.reapplied;
    const after = log.verifyHashChainSync({ full: true });
    if (!after.valid) {
      throw new RestoreRefused(
        `The restored ledger does not verify after re-applying erasures: ${after.reason}`,
      );
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (err) {
    db.close();
    for (const f of [staging, `${staging}-wal`, `${staging}-shm`]) rmSync(f, { force: true });
    throw err;
  }
  db.close();

  let previousKeptAt: string | undefined;
  if (ledgerInUse(targetPath)) {
    for (const f of [staging, `${staging}-wal`, `${staging}-shm`]) rmSync(f, { force: true });
    throw new RestoreRefused(
      `Refusing to restore: another process has the Activity log ${targetPath} open, and would go on writing to the file a restore moves aside. Stop the dashboard server (\`sekhemet daemon stop\`, or the terminal running \`sekhemet serve\`), any runner and any editor connected to it, then restore again.`,
    );
  }
  if (existsSync(targetPath)) {
    previousKeptAt = `${targetPath}.before-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    renameSync(targetPath, previousKeptAt);
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(`${targetPath}${ext}`))
        renameSync(`${targetPath}${ext}`, `${previousKeptAt}${ext}`);
    }
  }
  renameSync(staging, targetPath);
  for (const ext of ["-wal", "-shm"]) rmSync(`${staging}${ext}`, { force: true });
  return { backupSeq, reapplied, ...(previousKeptAt ? { previousKeptAt } : {}) };
}

/** One exported event: CloudEvents 1.0 attributes plus the chain's own (RUN-42). */
interface ExportLine {
  specversion: "1.0";
  id: string;
  source: "sekhemet/ledger";
  type: string;
  time: string;
  datacontenttype: "application/json";
  subject?: string;
  data: unknown;
  seq: number;
  hash: string;
  prevhash: string;
  payloadhash: string;
  hashversion?: number;
  actor: string;
  principal?: string;
  onbehalfof?: string;
  cardid?: string;
  attemptid?: string;
  stepid?: string;
  commitment?: string;
  /** The payload text a v1 row's hash covers. */
  legacypayload?: string;
  private?: { salt: string; body: string };
  /** Set by `--no-private` on a row whose private part was left out (RUN-43). */
  privateomitted?: true;
}

/**
 * The ledger as NDJSON (runtime.md RUN-42, RUN-43): one line per event with
 * `seq`, `hash`, `prevhash` and the commitment beside the CloudEvents
 * attributes (a field mapping only, no SDK). `includePrivate: false` leaves
 * every private part out; the chain still verifies, because it covers the
 * commitment, not the body.
 */
export function exportLedger(db: DatabaseSync, options: { includePrivate: boolean }): string {
  return readChainRows(db)
    .map((r) => {
      const line: ExportLine = {
        specversion: "1.0",
        id: r.id,
        source: "sekhemet/ledger",
        type: r.type,
        time: r.created_at,
        datacontenttype: "application/json",
        ...(r.card_id ? { subject: r.card_id } : {}),
        data: JSON.parse(r.payload) as unknown,
        seq: r.seq,
        hash: r.hash,
        prevhash: r.prev_hash,
        payloadhash: r.payload_hash,
        ...(r.hash_version ? { hashversion: r.hash_version } : {}),
        actor: r.actor,
        ...(r.principal ? { principal: r.principal } : {}),
        ...(r.on_behalf_of ? { onbehalfof: r.on_behalf_of } : {}),
        ...(r.card_id ? { cardid: r.card_id } : {}),
        ...(r.attempt_id ? { attemptid: r.attempt_id } : {}),
        ...(r.step_id ? { stepid: r.step_id } : {}),
        ...(r.commitment ? { commitment: r.commitment } : {}),
        ...(r.payload_hash === "" ? { legacypayload: r.payload } : {}),
      };
      if (r.private_body !== null && r.private_salt !== null) {
        if (options.includePrivate) line.private = { salt: r.private_salt, body: r.private_body };
        else line.privateomitted = true;
      }
      return JSON.stringify(line);
    })
    .map((l) => `${l}\n`)
    .join("");
}

/**
 * Verify an export from the file alone (RUN-42): the same chain check as
 * the ledger's, over the exported fields, so it reaches the same verdict.
 */
export function verifyLedgerExport(ndjson: string): HashChainVerificationResult {
  const lines = ndjson
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as ExportLine);
  const rows: ChainRow[] = lines.map((l) => ({
    seq: l.seq,
    id: l.id,
    actor: l.actor,
    type: l.type,
    card_id: l.cardid ?? null,
    attempt_id: l.attemptid ?? null,
    step_id: l.stepid ?? null,
    payload: l.legacypayload ?? JSON.stringify(l.data),
    payload_hash: l.payloadhash,
    hash: l.hash,
    prev_hash: l.prevhash,
    created_at: l.time,
    hash_version: l.hashversion ?? null,
    principal: l.principal ?? null,
    on_behalf_of: l.onbehalfof ?? null,
    commitment: l.commitment ?? null,
    private_salt: l.private?.salt ?? null,
    private_body: l.private?.body ?? null,
  }));
  const erasures = erasureIndexOf(
    lines
      .filter((l) => l.type === "ledger/erased")
      .map((l) => ({ seq: l.seq, payload: JSON.stringify(l.data) })),
  );
  const omitted = lines.some((l) => l.privateomitted);
  return verifyChainRows(rows, { erasures, privateOmitted: omitted });
}
