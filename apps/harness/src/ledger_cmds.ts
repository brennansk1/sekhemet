import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  BlobStore,
  EventLog,
  MigrationRefused,
  RestoreRefused,
  SCHEMA_VERSION,
  exportLedger,
  initSchema,
  ledgerBlobIds,
  ledgerEvidence,
  restoreBackup,
} from "@sekhemet/kernel";
import { plural } from "@sekhemet/ui";
import {
  type BackupSetInfo,
  describeSet,
  erasureRegisterFor,
  legacyErasureRegister,
  listBackupSets,
  refuseWhileInUse,
  restoreBackupSet,
  setsNaming,
  verifyBackupSet,
  workspaceErasureRegister,
  writeBackupSet,
} from "./backup_sets.js";
import type { CliExit } from "./commands/cli_result.js";
import type { CommandHandler } from "./commands/registry.js";
import { userSetup } from "./config.js";
import { backupCredentials, identityDir, restoreCredentials } from "./team/credential_store.js";
import { holdsLedger, ledgerFacts, workspaceFolderOf } from "./workspace_locator.js";

/**
 * The ledger's own commands (kernel NEW-kernel-1/2/7, security.md
 * NEW-security-7, runtime.md NEW-runtime-8): opening the ledger with the
 * install's person, the Ledger-Head anchor, backup, restore, export and
 * erase. The mechanisms are the kernel's; these are the commands.
 */

/**
 * Commands `main` hands to `ledgerCommand`. `backup` and `restore` are
 * command-registry entries since NEW-runtime-11 (`backupCommand`,
 * `restoreCommand` below).
 */
export const LEDGER_COMMANDS = ["export", "erase"] as const;
export type LedgerCommand = (typeof LEDGER_COMMANDS)[number];

/**
 * The workspace's ledger (kernel rule 38a): in the folder itself, or in the
 * workspace folder a project root's locator names (surface item 8a).
 */
const dbPathOf = (repoPath: string) => join(workspaceFolderOf(repoPath), ".sekhemet", "events.db");

/**
 * The erasure register: beside the workspace's backup sets, outside every
 * repository and every set (kernel rule 35, runtime item 35a) —
 * `<user dir>/backups/<workspace id>/erasure-register.ndjson`. A folder with
 * no ledger, or an empty one, has no workspace id yet: the old place.
 */
export function erasureRegisterPath(repoPath: string): string {
  const workspace = workspaceFolderOf(repoPath);
  const id = holdsLedger(workspace) ? ledgerFacts(workspace).workspaceId : undefined;
  return id ? erasureRegisterFor(id) : legacyErasureRegister(workspace);
}

/**
 * The solo install's person (kernel rule 19): the git `user.email`, else the
 * OS user. Kept only in the person record's private part.
 */
export function localPersonDetails(repoPath: string): { email?: string; name?: string } {
  try {
    const email = execFileSync("git", ["config", "user.email"], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (email) return { email };
  } catch {
    // No git, or no email configured: the OS user names the person.
  }
  return { name: userInfo().username };
}

/**
 * Open a repository's ledger: schema checked (a newer one refused, an older
 * one backed up, migrated and chain-checked — RUN-44; a local person a
 * migration creates carries git's email), the erasure register wired, the
 * install's one person recorded, and any blob a recorded erasure named but a
 * crash left on disk deleted (kernel rule 34, K-N7-8), and any run file too
 * (RUN-57).
 */
export function openLocalLedger(repoPath: string): { db: DatabaseSync; log: EventLog } {
  // Kernel rule 38a: a project root with a locator opens its workspace's one
  // ledger, and the workspace's blobs and run files are beside it.
  const workspace = workspaceFolderOf(repoPath);
  mkdirSync(join(workspace, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(dbPathOf(repoPath));
  const person = localPersonDetails(repoPath);
  try {
    initSchema(db, { localPerson: person });
  } catch (err) {
    db.close();
    // Runtime item 38 (REL-18): with no pre-migration backup here, the newest
    // backup set this build opens, with the command that restores it.
    if (err instanceof MigrationRefused && err.newer && !err.newer.preMigrationBackup) {
      const { stored, current } = err.newer;
      const usable = setsNaming(workspace).filter((s) => s.manifest.schemaVersion <= current);
      if (usable[0]) {
        throw new MigrationRefused(
          `this database is at schema version ${stored}, newer than this build's version ${current}: upgrade Sekhemet to open it, or go back with \`sekhemet restore ${usable[0].path}\` (events recorded since entry ${usable[0].manifest.seq} are not in it; \`sekhemet backup --list\` lists the others).`,
          err.newer,
        );
      }
    }
    throw err;
  }
  // Kernel K-N2-1: a Team install's ledger refuses a person's event that
  // names no one; an unreadable user config is an error, never Solo (M6).
  let setup: "solo" | "team";
  try {
    setup = userSetup();
  } catch (err) {
    db.close();
    throw err;
  }
  // Runtime item 35a, RUN-78: the register beside the workspace's sets, carried
  // from the old place before any erasure appends to it.
  const log: EventLog = new EventLog(db, {
    erasureRegister: () => workspaceErasureRegister(workspace, log.workspaceId()),
    setup,
  });
  log.ensureLocalPerson(person);
  log.retryBlobErasures(new BlobStore(workspace));
  // RUN-57: likewise any run file (transcript, observation) an erasure named.
  log.retryFileErasures(join(workspace, ".sekhemet"));
  return { db, log };
}

/** `<seq>:<hash>` of the ledger's last event, for the Accept commit's `Ledger-Head` trailer. */
export function ledgerHeadTrailer(repoPath: string): string | undefined {
  const path = dbPathOf(repoPath);
  if (!existsSync(path)) return undefined;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1").get() as
      | { seq: number; hash: string }
      | undefined;
    return row ? `${row.seq}:${row.hash}` : undefined;
  } finally {
    db.close();
  }
}

export type AnchorCheck =
  | { status: "none" }
  | { status: "ok"; seq: number; root: string }
  | { status: "truncated"; seq: number; lastSeq: number; root: string }
  | { status: "mismatch"; seq: number; root: string };

/**
 * Cross-check the newest `Ledger-Head` trailer against the ledger (kernel
 * rule 12, K-N1-5): an anchor past the ledger's last seq means its tail was
 * cut; one whose hash differs means the chain was rewritten. In a workspace
 * of several projects each repository carries the anchors of its own
 * merges, all naming the one chain, so the newest anchor — the highest seq
 * — is read across every project's repository the ledger registers and the
 * folder given (K-N12-4), and the result names the repository it came from.
 */
export function checkLedgerAnchor(repoPath: string, db: DatabaseSync): AnchorCheck {
  const roots = new Set<string>([repoPath]);
  try {
    for (const r of db.prepare("SELECT root_path AS root FROM projects").all() as {
      root: string;
    }[])
      roots.add(r.root);
  } catch {
    // A ledger from before projects: the folder given alone.
  }
  let newest: { seq: number; hash: string; root: string } | undefined;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const head = ledgerHeadTrailers(root)[0];
    if (head && (!newest || head.seq > newest.seq)) newest = { ...head, root };
  }
  if (!newest) return { status: "none" };
  const { seq, root } = newest;
  const last = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get() as { s: number })
    .s;
  if (seq > last) return { status: "truncated", seq, lastSeq: last, root };
  const row = db.prepare("SELECT hash FROM events WHERE seq = ?").get(seq) as
    | { hash: string }
    | undefined;
  return row?.hash === newest.hash
    ? { status: "ok", seq, root }
    : { status: "mismatch", seq, root };
}

/**
 * The `Ledger-Head` trailers in a repository's recent history, newest first
 * (kernel rule 12): a repository with any belongs to a Sekhemet workspace
 * (surface item 8a, SUR-79). None when it has no history or no git.
 */
export function ledgerHeadTrailers(repoPath: string): { seq: number; hash: string }[] {
  let text: string;
  try {
    text = execFileSync(
      "git",
      ["log", "--format=%(trailers:key=Ledger-Head,valueonly,separator=%x2C)%x1e", "-n", "200"],
      { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return [];
  }
  return text
    .split("\x1e")
    .flatMap((s) => s.split(","))
    .map((s) => s.trim().match(/^(\d+):([0-9a-f]{64})$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ seq: Number(m[1]), hash: m[2] as string }));
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}

/** The first positional after the command word. */
function positional(argv: readonly string[], command: string): string | undefined {
  const v = argv[argv.indexOf(command) + 1];
  return v && !v.startsWith("--") ? v : undefined;
}

/**
 * The secret to erase, from a file or stdin — never from the command line,
 * which a shell keeps in its history.
 */
function readSecret(argv: readonly string[]): string {
  const file = flagValue(argv, "--secret-file");
  const raw = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
  return raw.replace(/\r?\n$/, "");
}

/** Run one ledger command; returns the exit code. */
export async function ledgerCommand(
  command: LedgerCommand,
  argv: readonly string[],
  repoPath: string,
): Promise<number> {
  const { db, log } = openLocalLedger(repoPath);
  try {
    if (command === "export") {
      const out = flagValue(argv, "--out");
      if (!argv.includes("--ledger")) {
        if (!out) {
          console.error(
            "usage: sekhemet dev export --ledger [--no-private] [--out file.ndjson]  |  sekhemet dev export --out <dir> [--no-private]",
          );
          return 2;
        }
        return exportFolder(db, workspaceFolderOf(repoPath), resolve(out), argv);
      }
      const text = exportLedger(db, { includePrivate: !argv.includes("--no-private") });
      if (out) {
        writeFileSync(out, text, "utf8");
        console.log(`Exported ${text.split("\n").filter(Boolean).length} events to ${out}.`);
      } else {
        process.stdout.write(text);
      }
      return 0;
    }
    return await eraseCommand(argv, repoPath, log);
  } finally {
    db.close();
  }
}

const fileSha = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * `sekhemet dev export --out <dir>` (runtime item 37, SPEC-02): the NDJSON,
 * every projection table as NDJSON, the blobs the ledger names that are not
 * erased (the backup set's enumeration) and the evidence bundles it records.
 * With `--no-private` the NDJSON alone: projections derive from private
 * parts too, and a blob is model-visible text the ledger cannot split.
 */
function exportFolder(
  db: DatabaseSync,
  workspaceFolder: string,
  out: string,
  argv: readonly string[],
): number {
  if (existsSync(out) && statSync(out).isFile()) {
    console.error(`${out} is a file; --out without --ledger takes a folder.`);
    return 2;
  }
  const includePrivate = !argv.includes("--no-private");
  mkdirSync(out, { recursive: true });
  const text = exportLedger(db, { includePrivate });
  writeFileSync(join(out, "ledger.ndjson"), text, "utf8");
  const events = text.split("\n").filter(Boolean).length;
  if (!includePrivate) {
    console.log(
      `Exported ${plural(events, "event")} to ${out} without private parts; projections and blobs are left out, as they can hold private text.`,
    );
    return 0;
  }
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('events', 'event_private') ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((t) => t.name);
  mkdirSync(join(out, "projections"), { recursive: true });
  for (const table of tables) {
    const rows = db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all();
    writeFileSync(
      join(out, "projections", `${table}.ndjson`),
      rows.map((r) => `${JSON.stringify(r)}\n`).join(""),
      "utf8",
    );
  }
  const blobs = new BlobStore(workspaceFolder);
  const { held, missing } = ledgerBlobIds(db, blobs);
  for (const id of held) {
    const target = join(out, "blobs", id.slice(0, 2), `${id}.json`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(blobs.path(id), target);
  }
  let evidence = 0;
  for (const e of ledgerEvidence(db)) {
    const from = join(workspaceFolder, e.path);
    if (relative(workspaceFolder, from).startsWith("..") || !existsSync(from)) continue;
    if (fileSha(from) !== e.sha256) continue;
    const target = join(out, "evidence", `${e.id}.json`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(from, target);
    evidence++;
  }
  console.log(
    `Exported ${plural(events, "event")}, ${plural(tables.length, "projection")}, ${plural(held.length, "blob")} and ${plural(evidence, "check record")} to ${out}.`,
  );
  if (missing.length > 0)
    console.log(`${plural(missing.length, "blob")} the Activity log names could not be found.`);
  return 0;
}

/**
 * `sekhemet backup [<path>] [--list]` (runtime items 35, 35a; RUN-59,
 * RUN-61, RUN-87; REL-18). With no path, a backup set of the workspace in
 * `<user dir>/backups/<workspace id>/`; with a path, the ledger alone there
 * and the credential store beside it (item 35); `--list`, the workspace's
 * sets with their schema versions.
 */
export const backupCommand: CommandHandler = async (args, env): Promise<CliExit> => {
  if (args.values.list === true) {
    const id = ledgerFacts(env.workspaceFolder).workspaceId;
    const sets = id ? listBackupSets(id) : [];
    if (sets.length === 0) {
      console.log(
        "No backup sets yet for this workspace. `sekhemet backup` writes one; one is written automatically each day the board is used.",
      );
      return 0;
    }
    console.log(`Backup sets, newest first (this build reads schema ${SCHEMA_VERSION} and older):`);
    for (const set of sets) console.log(`  ${describeSet(set, verifyBackupSet(set.path).ok)}`);
    console.log(
      "Restore one with `sekhemet restore <set>`, or the newest with `sekhemet restore --latest`.",
    );
    return 0;
  }
  const { db, log } = (await env.kernel("read")) as { db: DatabaseSync; log: EventLog };
  try {
    return await writeBackup(args.positionals[0], env.repoPath, env.workspaceFolder, db, log);
  } finally {
    db.close();
  }
};

async function writeBackup(
  target: string | undefined,
  repoPath: string,
  workspaceFolder: string,
  db: DatabaseSync,
  log: EventLog,
): Promise<CliExit> {
  if (target) {
    const { path, seq } = await log.backup(resolve(target), { principal: log.localPrincipal() });
    console.log(`Backed up the Activity log through entry ${seq} to ${path} (verified).`);
    // security item 35a: the workspace's credential store goes with every backup, at 0600.
    const id = log.workspaceId();
    const credentials = id ? backupCredentials(identityDir(id), path) : undefined;
    if (credentials) console.log(`The credential store is backed up beside it (${credentials}).`);
    console.log(
      `This copy holds the Activity log alone; \`sekhemet backup\` with no path writes a whole set. The erasure register stays at ${erasureRegisterPath(repoPath)}.`,
    );
    return 0;
  }
  const set = await writeBackupSet({
    workspaceFolder,
    db,
    log,
    kind: "manual",
    principal: log.localPrincipal(),
  });
  const m = set.manifest;
  console.log(
    `Backed up the workspace through entry ${set.seq} to ${set.path} (verified): the Activity log, ${plural(Object.keys(m.files).filter((f) => f.includes("/blobs/")).length, "blob")}, ${plural(Object.keys(m.files).filter((f) => f.includes("/evidence/")).length, "check record")} and ${plural(m.projects.length, "project")}' configuration.`,
  );
  if (set.carried > 0)
    console.log(`Carried ${plural(set.carried, "erasure")} into the register beside the sets.`);
  if (m.missingBlobs.length + m.missingEvidence.length > 0)
    console.log(
      `Not in the set, because they were already missing: ${plural(m.missingBlobs.length, "blob")}, ${plural(m.missingEvidence.length, "check record")}.`,
    );
  if (set.pruned.length > 0)
    console.log(
      `Removed ${plural(set.pruned.length, "older set")} this install wrote (7 daily and 4 weekly are kept).`,
    );
  return 0;
}

/** The newest verified set among `sets`, with the ones skipped and why. */
function newestVerified(sets: readonly BackupSetInfo[]): {
  chosen?: BackupSetInfo;
  skipped: { path: string; problems: string[] }[];
} {
  const skipped: { path: string; problems: string[] }[] = [];
  for (const set of sets) {
    const check = verifyBackupSet(set.path);
    if (check.ok) return { chosen: set, skipped };
    skipped.push({ path: set.path, problems: check.problems });
  }
  return { skipped };
}

/**
 * `sekhemet restore <set or file> | --latest` (runtime items 35, 35a, 36;
 * RUN-40, RUN-61, RUN-87, RUN-88), with the server stopped. `--latest`
 * restores the newest set of this workspace — found from its ledger, or, in
 * a folder with none, from the sets whose manifest names the folder — whose
 * files and chain verify, and names it.
 */
export const restoreCommand: CommandHandler = async (args, env): Promise<CliExit> => {
  const given = args.positionals[0];
  if (!given && args.values.latest !== true) {
    console.error("usage: sekhemet restore <set or file> | --latest (with the server stopped)");
    return 2;
  }
  try {
    let setDir: string | undefined;
    if (given) {
      const path = resolve(given);
      if (existsSync(path) && statSync(path).isDirectory()) setDir = path;
      else return await restoreLedgerFile(path, env.repoPath);
    } else {
      const folder = env.workspaceFolder;
      const id = holdsLedger(folder) ? ledgerFacts(folder).workspaceId : undefined;
      const sets = id ? listBackupSets(id) : setsNaming(env.repoPath);
      const { chosen, skipped } = newestVerified(sets);
      for (const s of skipped)
        console.log(`Skipped ${s.path}: it does not verify (${s.problems.join("; ")}).`);
      if (!chosen) {
        console.error(
          sets.length === 0
            ? `No backup set names ${env.repoPath}; \`sekhemet backup --list\` in the workspace folder lists its sets.`
            : "No backup set of this workspace verifies; nothing was restored.",
        );
        return 1;
      }
      setDir = chosen.path;
      console.log(`Restoring the newest verified set: ${setDir}.`);
    }
    const report = await restoreBackupSet(setDir);
    console.log(
      `Restored the workspace ${report.manifest.workspaceFolder} through entry ${report.backupSeq}; re-applied ${plural(report.reapplied.length, "erasure")} from the register before anything read it; ${plural(report.blobs, "blob")} and ${plural(report.evidence, "check record")} put back.`,
    );
    if (report.previousKeptAt)
      console.log(`The Activity log it replaced is kept at ${report.previousKeptAt}.`);
    for (const p of report.projects) {
      if (p.state === "missing") {
        console.log(
          `${p.name} (${p.id}): repository missing — expected at ${p.root}. None of its issues will run until you name its folder: \`sekhemet project move ${p.id} <folder>\`.`,
        );
      } else {
        const wrote = p.configs.length ? `; wrote back ${p.configs.join(" and ")}` : "";
        const kept = p.keptLive.length ? `; kept your current ${p.keptLive.join(" and ")}` : "";
        console.log(`${p.name}: restored at ${p.root}${wrote}${kept}.`);
      }
    }
    if (report.credentials) console.log("The credential store was restored with it.");
    if (report.credentialsKeptAt)
      console.log(`The credential store it replaced is kept at ${report.credentialsKeptAt}.`);
    return 0;
  } catch (err) {
    if (err instanceof RestoreRefused) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
};

/** Restore a single ledger file written by `backup <path>` (item 35, RUN-40). */
async function restoreLedgerFile(backup: string, repoPath: string): Promise<CliExit> {
  const workspace = workspaceFolderOf(repoPath);
  // The register is the workspace's: its id is the backup's own first event's.
  let id: string | undefined;
  if (existsSync(backup)) {
    const copy = new DatabaseSync(backup, { readOnly: true });
    try {
      id = new EventLog(copy).workspaceId();
    } finally {
      copy.close();
    }
  }
  refuseWhileInUse(workspace, [repoPath]);
  const report = await restoreBackup({
    backupPath: backup,
    targetPath: dbPathOf(repoPath),
    registerPath: workspaceErasureRegister(workspace, id),
    blobs: new BlobStore(workspace),
  });
  console.log(
    `Restored the Activity log through entry ${report.backupSeq}; re-applied ${plural(report.reapplied.length, "erasure")} from the register before anything read it.`,
  );
  if (report.previousKeptAt)
    console.log(`The Activity log it replaced is kept at ${report.previousKeptAt}.`);
  const credentials = id
    ? restoreCredentials(identityDir(id), backup, report.previousKeptAt)
    : false;
  if (credentials) {
    console.log("The credential store was restored with it.");
    if (credentials.keptAt)
      console.log(`The credential store it replaced is kept at ${credentials.keptAt}.`);
  }
  return 0;
}

/**
 * `sekhemet erase` (kernel rule 34; security.md item 34b, SEC-50). With
 * `--secret-file f` (or the secret on stdin): the person is told to rotate
 * it first and nothing happens until they confirm with `--rotated`; then
 * every private field and every blob holding it is erased with reason
 * `secret`, and the chain is verified. With `--events id,id`: the private
 * parts of those events, reason `erasure`. The secret is never printed.
 */
async function eraseCommand(
  argv: readonly string[],
  repoPath: string,
  log: EventLog,
): Promise<number> {
  const principal = log.localPrincipal();
  const listed = flagValue(argv, "--events");
  if (listed) {
    const report = await log.erase({
      eventIds: listed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      reason: "erasure",
      principal,
    });
    console.log(
      `Erased the private parts of ${plural(report.eventIds.length, "event")} (ledger/erased seq ${report.erasedBySeq}).`,
    );
    console.log(report.outsideReach);
    return 0;
  }
  if (!argv.includes("--secret-file") && !argv.includes("--secret")) {
    console.error("usage: sekhemet erase --secret [--secret-file f] --rotated | --events id,id");
    return 2;
  }
  const secret = readSecret(argv);
  if (!secret) {
    console.error("No secret given.");
    return 2;
  }
  if (!argv.includes("--rotated")) {
    console.log(
      "Rotate the secret first: revoke it where it was issued and issue a new one. Erasing it here cannot recall a copy already used. Then run this again with --rotated.",
    );
    return 2;
  }
  const blobs = new BlobStore(workspaceFolderOf(repoPath));
  const events = log.findPrivate(secret).map((e) => e.id);
  const blobIds = blobs.findContaining(secret);
  // SEC-50: a structural payload the chain covers cannot be erased; name it.
  const structural = log.findInPayload(secret);
  const reportStructural = (): void => {
    if (structural.length === 0) return;
    for (const seq of structural) {
      console.log(
        `seq ${seq}: the secret is in the event's structural payload, which the hash chain covers and cannot be erased.`,
      );
    }
    console.log(
      "Rotation is the remedy for those events: make sure the secret is revoked where it was issued.",
    );
  };
  if (events.length === 0 && blobIds.length === 0) {
    if (structural.length === 0) {
      console.log("No private field, blob or payload holds that secret.");
      return 0;
    }
    console.log("No private field or blob holds that secret.");
    reportStructural();
    return 1;
  }
  const report = await log.erase({ eventIds: events, blobIds, blobs, reason: "secret", principal });
  const chain = await log.verifyHashChain({ full: true });
  console.log(
    `Erased the secret from ${plural(report.eventIds.length, "event")} and ${plural(report.blobIds.length, "blob")} (ledger/erased seq ${report.erasedBySeq}). Chain: ${chain.valid ? "valid" : `INVALID at seq ${chain.corruptedSeq}`}.`,
  );
  reportStructural();
  console.log(report.outsideReach);
  console.log(
    "Git history is outside the Activity log: if the secret was committed, it is still there.",
  );
  return chain.valid && structural.length === 0 ? 0 : 1;
}
