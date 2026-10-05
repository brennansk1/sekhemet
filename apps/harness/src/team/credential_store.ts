import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { EventLog } from "@sekhemet/kernel";
import { userPaths } from "../user_dir.js";

/**
 * The credential store (security item 35a, teams item 16, TEAM-11): what
 * people sign in with — password hashes, personal-access-token hashes,
 * passkey public keys, the setup token's hash until it is used, and the
 * hashes of invite and password-reset links. One JSON file of mode 0600 in a
 * directory of mode 0700, outside `events.db`; in every backup
 * (`backupCredentials`), in no export. The event log records only that a
 * credential was created, used, reset or revoked.
 *
 * The file is read on every operation and replaced atomically on every
 * write, so a CLI (`serve --new-setup-token`) and a running server agree.
 */

export interface PasswordEntry {
  hash: string;
  setAt: string;
}

export interface TokenEntry {
  principal: string;
  /** SHA-256 of the token's secret part (the secret has 256 bits; no slow hash is needed). */
  hash: string;
  level: string;
  expires: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface PasskeyEntry {
  /** The opaque reference the ledger names. */
  ref: string;
  /** The WebAuthn credential id (base64url). */
  id: string;
  /** The COSE public key (base64url). */
  publicKey: string;
  counter: number;
  transports?: string[];
}

export interface LinkEntry {
  /** The opaque reference the ledger names. */
  ref: string;
  principal?: string;
  expires: string;
}

export interface CredentialFile {
  version: 1;
  passwords: Record<string, PasswordEntry>;
  tokens: Record<string, TokenEntry>;
  passkeys: Record<string, PasskeyEntry[]>;
  setupToken?: { hash: string; createdAt: string; expires: string } | undefined;
  /** Invite links by the SHA-256 of their id. */
  invites: Record<string, LinkEntry>;
  /** Password-reset links by the SHA-256 of their id. */
  resets: Record<string, LinkEntry>;
  /**
   * The identity provider's subject each person signed in as (teams item 12):
   * `<iss> <sub>` to principal, so a later sign-in with the same email but
   * another subject is refused.
   */
  subjects: Record<string, string>;
}

export const CREDENTIALS_FILE = "credentials.json";

/**
 * The identity root, `<user dir>/identity/` (security item 35a): it holds
 * one folder per workspace, the user config's audit key (`config-audit.key`,
 * which belongs to the user config, one per operating-system user — TEAM-44),
 * and the record of the one-time move (`moved.json`). The sandbox denies it
 * with the rest of the user directory (item 10).
 */
export function identityRoot(): string {
  return userPaths().identity;
}

/**
 * The credential store's directory for one workspace (security item 35a,
 * NEW-security-14; DEC-57): `<user dir>/identity/<workspace id>/`, so two
 * servers of one operating-system user never share a store or a setup token.
 */
export function identityDir(workspaceId: string): string {
  if (!/^ws_[0-9a-f]{12}$/.test(workspaceId)) throw new Error(`Not a workspace id: ${workspaceId}`);
  return join(identityRoot(), workspaceId);
}

/** The files of a store, as the old single store kept them at the identity root. */
const STORE_FILES = [CREDENTIALS_FILE, "setup-token"];

/** What the one-time move did (SEC-N14-2), for `doctor`. */
export interface IdentityMove {
  /** The old place, `<user dir>/identity/`. */
  from: string;
  /** The workspace whose folder the store moved into. */
  workspaceId: string;
  to: string;
  at: string;
  /** The files moved, with their modes kept. */
  moved: string[];
}

/** The ledger event that records the move (SEC-N14-2; the spine: the event log is the only durable channel). */
export const STORE_MOVED_EVENT = "credentials/store_moved";

/** The move the workspace's ledger records, if it ran. */
export function readIdentityMove(db: DatabaseSync): IdentityMove | undefined {
  const row = db
    .prepare("SELECT payload, created_at FROM events WHERE type = ? ORDER BY seq DESC LIMIT 1")
    .get(STORE_MOVED_EVENT) as { payload: string; created_at: string } | undefined;
  if (!row) return undefined;
  const p = JSON.parse(row.payload) as {
    workspaceId: string;
    from: string;
    to: string;
    files: string[];
  };
  return { workspaceId: p.workspaceId, from: p.from, to: p.to, at: row.created_at, moved: p.files };
}

/**
 * The principals and references a store names: whose passwords, tokens,
 * passkeys, links and identity-provider subjects it holds.
 */
function storeReferences(file: Partial<CredentialFile>): Set<string> {
  const refs = new Set<string>();
  for (const k of Object.keys(file.passwords ?? {})) refs.add(k);
  for (const t of Object.values(file.tokens ?? {})) refs.add(t.principal);
  for (const [k, list] of Object.entries(file.passkeys ?? {})) {
    refs.add(k);
    for (const p of list) refs.add(p.ref);
  }
  for (const l of [...Object.values(file.invites ?? {}), ...Object.values(file.resets ?? {})]) {
    refs.add(l.ref);
    if (l.principal) refs.add(l.principal);
  }
  for (const v of Object.values(file.subjects ?? {})) refs.add(v);
  return refs;
}

/**
 * Move a store kept at the old place, `<user dir>/identity/`, into the
 * folder of the workspace whose ledger names its references, once
 * (SEC-N14-2): every file renamed with its mode kept, nothing lost, the move
 * recorded in the workspace's ledger (`credentials/store_moved`), which
 * `doctor` reads. A store naming no one yet (a setup token alone)
 * goes to the first workspace that opens it. A store this ledger does not
 * name is left where it is for the workspace that does. Returns the move,
 * or undefined when nothing moved.
 */
export function moveLegacyStore(
  workspaceId: string,
  ledgerNames: (refs: readonly string[]) => boolean,
  record: (move: Omit<IdentityMove, "at">) => void,
): IdentityMove | undefined {
  const from = identityRoot();
  const present = STORE_FILES.filter((f) => existsSync(join(from, f)));
  if (present.length === 0) return undefined;
  let file: Partial<CredentialFile> = {};
  if (present.includes(CREDENTIALS_FILE)) {
    try {
      file = JSON.parse(
        readFileSync(join(from, CREDENTIALS_FILE), "utf8"),
      ) as Partial<CredentialFile>;
    } catch {
      return undefined; // unreadable: left for a person, never guessed at
    }
  }
  const refs = [...storeReferences(file)];
  if (refs.length > 0 && !ledgerNames(refs)) return undefined;
  const to = identityDir(workspaceId);
  mkdirSync(to, { recursive: true, mode: 0o700 });
  const moved: string[] = [];
  for (const name of present) {
    if (existsSync(join(to, name))) continue; // never overwrite the workspace's own
    renameSync(join(from, name), join(to, name));
    moved.push(name);
  }
  if (moved.length === 0) return undefined;
  record({ from, workspaceId, to, moved });
  return { from, workspaceId, to, at: new Date().toISOString(), moved };
}

/**
 * The credential store's directory for the workspace whose ledger `db` is
 * (security item 35a): its id from the first event (kernel K-N12-1), with an
 * old single store moved into it first (SEC-N14-2). Undefined on a ledger
 * with no event yet, which no server serves: `openLocalLedger` records the
 * install's person before anything else.
 */
export function workspaceIdentityDir(db: DatabaseSync): string | undefined {
  const log = new EventLog(db);
  const workspaceId = log.workspaceId();
  if (!workspaceId) return undefined;
  moveLegacyStore(
    workspaceId,
    (refs) => {
      const named = db.prepare(
        "SELECT 1 AS x FROM events WHERE principal = ? OR instr(payload, ?) > 0 LIMIT 1",
      );
      return refs.some((r) => named.get(r, JSON.stringify(r)) !== undefined);
    },
    // A security-relevant change to where credentials live, recorded in the
    // ledger it belongs to (the spine); `doctor` reads it from there.
    (m) =>
      log.appendNow({
        actor: "system",
        type: STORE_MOVED_EVENT,
        payload: { workspaceId: m.workspaceId, from: m.from, to: m.to, files: m.moved },
      }),
  );
  return identityDir(workspaceId);
}

function empty(): CredentialFile {
  return {
    version: 1,
    passwords: {},
    tokens: {},
    passkeys: {},
    invites: {},
    resets: {},
    subjects: {},
  };
}

/** Make `dir` 0700 and each named file in it 0600, correcting wider modes. */
export function tightenModes(dir: string, files: readonly string[]): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  for (const name of files) {
    const path = join(dir, name);
    if (existsSync(path) && (statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600);
  }
}

/** Write `text` to `path` at mode 0600, atomically. */
export function writePrivateFile(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export class CredentialStore {
  public readonly path: string;

  constructor(public readonly dir: string) {
    this.path = join(dir, CREDENTIALS_FILE);
    tightenModes(dir, [CREDENTIALS_FILE, "setup-token"]);
  }

  public read(): CredentialFile {
    if (!existsSync(this.path)) return empty();
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<CredentialFile>;
    return { ...empty(), ...parsed, version: 1 };
  }

  /** Read, change and write back in one step. */
  public update<T>(change: (file: CredentialFile) => T): T {
    const file = this.read();
    const result = change(file);
    writePrivateFile(this.path, `${JSON.stringify(file, null, 2)}\n`);
    return result;
  }
}

/** Where a ledger backup's credential store goes: beside it, at 0600. */
export function credentialBackupPath(backupPath: string): string {
  return `${backupPath}.credentials.json`;
}

/**
 * Copy the credential store beside a ledger backup (security item 35a: in
 * every backup). Returns the copy's path, or undefined when there is none.
 */
export function backupCredentials(identityDir: string, backupPath: string): string | undefined {
  const source = join(identityDir, CREDENTIALS_FILE);
  if (!existsSync(source)) return undefined;
  const target = credentialBackupPath(backupPath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  chmodSync(target, 0o600);
  return target;
}

/**
 * Restore the credential store saved beside a ledger backup; false when the
 * backup has none. `keptLedger` is where the restore moved the replaced
 * ledger: the replaced store is kept beside it (RUN-93).
 */
export function restoreCredentials(
  identityDir: string,
  backupPath: string,
  keptLedger?: string,
): { keptAt?: string } | false {
  const source = credentialBackupPath(backupPath);
  if (!existsSync(source)) return false;
  const keptAt = replaceCredentialStore(identityDir, readFileSync(source, "utf8"), keptLedger);
  return keptAt ? { keptAt } : {};
}

/**
 * Write `text` as the workspace's credential store, keeping the store it
 * replaces when that differs (RUN-93): a restore must not undo a password
 * change or a revocation for good. The copy goes beside the ledger the
 * restore moved aside (`<that file>.credentials.json`, so restoring that file
 * brings the store back with it), or, with none, into the identity folder as
 * `credentials.json.before-restore-<time>`; mode 0600 either way. Returns
 * the copy's path, or undefined when nothing differed.
 */
export function replaceCredentialStore(
  identityDir: string,
  text: string,
  keptLedger?: string,
): string | undefined {
  mkdirSync(identityDir, { recursive: true, mode: 0o700 });
  tightenModes(identityDir, []);
  const live = join(identityDir, CREDENTIALS_FILE);
  let keptAt: string | undefined;
  if (existsSync(live)) {
    const current = readFileSync(live, "utf8");
    if (current !== text) {
      keptAt = keptLedger
        ? credentialBackupPath(keptLedger)
        : `${live}.before-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      writePrivateFile(keptAt, current);
    }
  }
  writePrivateFile(live, text);
  return keptAt;
}
