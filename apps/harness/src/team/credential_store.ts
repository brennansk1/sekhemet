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
import { userDir } from "../user_dir.js";

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
 * The credential store's directory: the install's own directory
 * (`~/.sekhemet/identity`, or under `SEKHEMET_CONFIG_DIR`), which the
 * sandbox denies (security items 10, 35a) — one store for the workspace.
 */
export function identityDir(): string {
  return join(userDir(), "identity");
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

/** Restore the credential store saved beside a ledger backup; false when the backup has none. */
export function restoreCredentials(identityDir: string, backupPath: string): boolean {
  const source = credentialBackupPath(backupPath);
  if (!existsSync(source)) return false;
  tightenModes(identityDir, []);
  writePrivateFile(join(identityDir, CREDENTIALS_FILE), readFileSync(source, "utf8"));
  return true;
}
