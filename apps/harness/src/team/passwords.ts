import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Local-account passwords (teams item 11, TEAM-9; NIST SP 800-63B-4): at
 * least 15 characters, no composition rules, no forced rotation; refused
 * when it holds the person's name or email or the workspace's name, or is
 * on the bundled offline list of common and breached passwords. Never
 * checked by an online lookup. Hashed with scrypt from `node:crypto`.
 */

export const MIN_PASSWORD_LENGTH = 15;
/** Long enough for any passphrase, short enough that hashing it costs nothing extra. */
export const MAX_PASSWORD_LENGTH = 256;

/**
 * The bundled list: one password per line, under the package's `data/`
 * directory. The list itself is chosen and added under DEC-08's licence
 * check; until it is, the check reports it missing (never fetched).
 */
export const BUNDLED_PASSWORD_LIST = fileURLToPath(
  new URL("../../data/common-passwords.txt", import.meta.url),
);

export type PasswordRule = "length" | "name" | "email" | "workspace" | "common";

export type PasswordCheck =
  | { ok: true; listMissing?: true }
  | { ok: false; rule: PasswordRule; message: string };

export interface PasswordContext {
  name?: string;
  email?: string;
  workspace?: string;
  /** The list to check against; the bundled one by default. */
  listPath?: string;
}

const lists = new Map<string, { mtimeMs: number; words: Set<string> }>();

function loadList(path: string): Set<string> | undefined {
  if (!existsSync(path)) return undefined;
  const { mtimeMs } = statSync(path);
  const hit = lists.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.words;
  const words = new Set(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean),
  );
  lists.set(path, { mtimeMs, words });
  return words;
}

/** Whether the bundled (or named) list is present. */
export function passwordListPresent(listPath = BUNDLED_PASSWORD_LIST): boolean {
  return existsSync(listPath);
}

export function checkPassword(password: string, context: PasswordContext = {}): PasswordCheck {
  const length = [...password].length;
  if (length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      rule: "length",
      message: `A password needs at least ${MIN_PASSWORD_LENGTH} characters; a phrase of a few words is easiest.`,
    };
  }
  if (length > MAX_PASSWORD_LENGTH) {
    return {
      ok: false,
      rule: "length",
      message: `A password can be at most ${MAX_PASSWORD_LENGTH} characters.`,
    };
  }
  const lower = password.toLowerCase();
  const email = context.email?.trim().toLowerCase();
  const emailRefusal = {
    ok: false,
    rule: "email",
    message: "A password cannot contain your email address.",
  } as const;
  if (email && lower.includes(email)) return emailRefusal;
  const nameParts = (context.name ?? "")
    .toLowerCase()
    .split(/[\s.,'-]+/)
    .filter((p) => p.length >= 3);
  if (nameParts.some((p) => lower.includes(p))) {
    return { ok: false, rule: "name", message: "A password cannot contain your name." };
  }
  const local = email?.split("@")[0] ?? "";
  if (local.length >= 3 && lower.includes(local)) return emailRefusal;
  const workspace = context.workspace?.trim().toLowerCase();
  if (workspace && workspace.length >= 3 && lower.includes(workspace)) {
    return {
      ok: false,
      rule: "workspace",
      message: "A password cannot contain the workspace's name.",
    };
  }
  const words = loadList(context.listPath ?? BUNDLED_PASSWORD_LIST);
  if (!words) return { ok: true, listMissing: true };
  if (words.has(lower)) {
    return {
      ok: false,
      rule: "common",
      message: "That password is on the list of common and breached passwords; choose another.",
    };
  }
  return { ok: true };
}

/** scrypt at OWASP's N=2^14, r=8, p=5 (16 MiB): memory-hard, and gentle on a host running a model. */
const N = 2 ** 14;
const R = 8;
const P = 5;
const KEYLEN = 32;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      KEYLEN,
      { N: n, r, p, maxmem: 64 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** `scrypt$N$r$p$salt$hash` (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await derive(
    password,
    Buffer.from(salt, "base64url"),
    Number(n),
    Number(r),
    Number(p),
  );
  return key.length === expected.length && timingSafeEqual(key, expected);
}

let dummy: Promise<string> | undefined;
/** A hash to verify against when the account is unknown, so timing does not reveal it. */
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(24).toString("base64url"));
  return dummy;
}
