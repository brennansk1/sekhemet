import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  BlobStore,
  EventLog,
  RestoreRefused,
  exportLedger,
  initSchema,
  restoreBackup,
} from "@sekhemet/kernel";
import { plural } from "@sekhemet/ui";
import { userSetup } from "./config.js";
import { backupCredentials, identityDir, restoreCredentials } from "./team/credential_store.js";

/**
 * The ledger's own commands (kernel NEW-kernel-1/2/7, security.md
 * NEW-security-7, runtime.md NEW-runtime-8): opening the ledger with the
 * install's person, the Ledger-Head anchor, backup, restore, export and
 * erase. The mechanisms are the kernel's; these are the commands.
 */

/** Commands `main` hands to `ledgerCommand`. */
export const LEDGER_COMMANDS = ["backup", "restore", "export", "erase"] as const;
export type LedgerCommand = (typeof LEDGER_COMMANDS)[number];

const dbPathOf = (repoPath: string) => join(repoPath, ".sekhemet", "events.db");

/** The erasure register: beside the backups, outside the backup set (kernel rule 35). */
export function erasureRegisterPath(repoPath: string): string {
  return join(repoPath, ".sekhemet", "backups", "erasure-register.ndjson");
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
  mkdirSync(join(repoPath, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(dbPathOf(repoPath));
  const person = localPersonDetails(repoPath);
  try {
    initSchema(db, { localPerson: person });
  } catch (err) {
    db.close();
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
  const log = new EventLog(db, { erasureRegister: erasureRegisterPath(repoPath), setup });
  log.ensureLocalPerson(person);
  log.retryBlobErasures(new BlobStore(repoPath));
  // RUN-57: likewise any run file (transcript, observation) an erasure named.
  log.retryFileErasures(join(repoPath, ".sekhemet"));
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
  | { status: "ok"; seq: number }
  | { status: "truncated"; seq: number; lastSeq: number }
  | { status: "mismatch"; seq: number };

/**
 * Cross-check the newest `Ledger-Head` trailer on the checked-out branch
 * against the ledger (kernel rule 12, K-N1-5): an anchor past the ledger's
 * last seq means its tail was cut; one whose hash differs means the chain
 * was rewritten.
 */
export function checkLedgerAnchor(repoPath: string, db: DatabaseSync): AnchorCheck {
  let text: string;
  try {
    text = execFileSync(
      "git",
      ["log", "--format=%(trailers:key=Ledger-Head,valueonly,separator=%x2C)%x1e", "-n", "200"],
      { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return { status: "none" };
  }
  const newest = text
    .split("\x1e")
    .map((s) => s.trim())
    .find((s) => s !== "");
  const match = newest
    ?.split(",")[0]
    ?.trim()
    .match(/^(\d+):([0-9a-f]{64})$/);
  if (!match) return { status: "none" };
  const seq = Number(match[1]);
  const last = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get() as { s: number })
    .s;
  if (seq > last) return { status: "truncated", seq, lastSeq: last };
  const row = db.prepare("SELECT hash FROM events WHERE seq = ?").get(seq) as
    | { hash: string }
    | undefined;
  return row?.hash === match[2] ? { status: "ok", seq } : { status: "mismatch", seq };
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
  if (command === "restore") return restoreCommand(argv, repoPath);
  const { db, log } = openLocalLedger(repoPath);
  try {
    if (command === "backup") {
      const target = positional(argv, "backup");
      if (!target) {
        console.error("usage: sekhemet dev backup <path>");
        return 2;
      }
      const { path, seq } = await log.backup(resolve(target), { principal: log.localPrincipal() });
      console.log(`Backed up the Activity log through entry ${seq} to ${path} (verified).`);
      // security item 35a: the Team setup's credential store goes with every backup, at 0600.
      const credentials = backupCredentials(identityDir(), path);
      if (credentials) console.log(`The credential store is backed up beside it (${credentials}).`);
      console.log(
        `The erasure register stays at ${erasureRegisterPath(repoPath)}; keep it with your backups.`,
      );
      return 0;
    }
    if (command === "export") {
      if (!argv.includes("--ledger")) {
        console.error("usage: sekhemet dev export --ledger [--no-private] [--out file.ndjson]");
        return 2;
      }
      const text = exportLedger(db, { includePrivate: !argv.includes("--no-private") });
      const out = flagValue(argv, "--out");
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

async function restoreCommand(argv: readonly string[], repoPath: string): Promise<number> {
  const backup = positional(argv, "restore");
  if (!backup) {
    console.error("usage: sekhemet dev restore <backup> (with the server stopped)");
    return 2;
  }
  try {
    const report = await restoreBackup({
      backupPath: resolve(backup),
      targetPath: dbPathOf(repoPath),
      registerPath: erasureRegisterPath(repoPath),
      blobs: new BlobStore(repoPath),
    });
    console.log(
      `Restored the Activity log through entry ${report.backupSeq}; re-applied ${plural(report.reapplied.length, "erasure")} from the register before anything read it.`,
    );
    if (report.previousKeptAt)
      console.log(`The Activity log it replaced is kept at ${report.previousKeptAt}.`);
    if (restoreCredentials(identityDir(), resolve(backup)))
      console.log("The credential store was restored with it.");
    return 0;
  } catch (err) {
    if (err instanceof RestoreRefused) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
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
  const blobs = new BlobStore(repoPath);
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
