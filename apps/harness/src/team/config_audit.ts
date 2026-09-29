import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type EventLog, type TomlTable, type TomlValue, parseToml } from "@sekhemet/kernel";
import { tightenModes, writePrivateFile } from "./credential_store.js";

/**
 * A change to the user `config.toml` made outside Sekhemet (teams item 27,
 * TEAM-44): at start the file is read, each key's value digested with a
 * keyed HMAC, and the digests compared with the last recorded state — the
 * latest `config/changed_outside` or `config/changed` on the ledger. When
 * they differ, `config/changed_outside {keys, state}` names the keys that
 * changed (added, edited or removed) and never their values. The HMAC key is
 * a 0600 file beside the credential store (`config-audit.key`, outside
 * `events.db`), so a digest on the ledger cannot be guessed back into a
 * value; it is not the credential store itself, whose presence marks a Team
 * install (M6). Without a user config and with nothing recorded, nothing is
 * read or written. A lost key reads as every key changed, once.
 * Sekhemet's own writes to the file record `config/changed` with the person
 * who made them, so the next start does not report them as outside changes.
 */

/** A dotted key a person reads (`sessions.idle_minutes`); any other character becomes `_`. */
const KEY = (parts: string[]) => parts.map((p) => p.replace(/[^A-Za-z0-9_-]/g, "_")).join(".");

function isTable(v: TomlValue): v is TomlTable {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A stable text of a value: tables' keys sorted, so reordering a line is no change. */
function canonical(v: TomlValue): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isTable(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k] as TomlValue)}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

/** Every leaf key of the file with its value's text; arrays are one value. */
export function flattenConfig(table: TomlTable, prefix: string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(table)) {
    const path = [...prefix, k];
    if (isTable(v)) for (const [kk, vv] of flattenConfig(v, path)) out.set(kk, vv);
    else out.set(KEY(path), canonical(v));
  }
  return out;
}

/** The file's leaf keys and values' text; empty when there is no file, `undefined` when unreadable. */
function readLeaves(path: string): Map<string, string> | undefined {
  if (!existsSync(path)) return new Map();
  try {
    return flattenConfig(parseToml(readFileSync(path, "utf8")));
  } catch {
    // An unreadable file is reported by the configuration check, not recorded here.
    return undefined;
  }
}

/** The state of the file as digests, one per key; `undefined` when it cannot be read. */
export function configState(path: string, key: Buffer): Record<string, string> | undefined {
  const leaves = readLeaves(path);
  if (!leaves) return undefined;
  const state: Record<string, string> = {};
  for (const [k, text] of [...leaves].sort(([a], [b]) => a.localeCompare(b))) {
    state[k] = createHmac("sha256", key).update(`${k}\0${text}`).digest("base64url").slice(0, 32);
  }
  return state;
}

/** The keys whose digest differs between two states: added, changed or removed. */
export function changedKeys(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => before[k] !== after[k]).sort();
}

export const CONFIG_AUDIT_KEY_FILE = "config-audit.key";

/** The HMAC key, created once as a 0600 file in the install's identity directory. */
export function configAuditKey(identityDir: string): Buffer {
  const path = join(identityDir, CONFIG_AUDIT_KEY_FILE);
  tightenModes(identityDir, [CONFIG_AUDIT_KEY_FILE]);
  if (existsSync(path)) return Buffer.from(readFileSync(path, "utf8").trim(), "base64url");
  const key = randomBytes(32);
  writePrivateFile(path, `${key.toString("base64url")}\n`);
  return key;
}

/** The last recorded state: the latest `config/changed_outside` or `config/changed`. */
export function recordedConfigState(db: DatabaseSync): Record<string, string> {
  const row = db
    .prepare(
      `SELECT payload FROM events WHERE type IN ('config/changed_outside', 'config/changed')
        ORDER BY seq DESC LIMIT 1`,
    )
    .get() as { payload: string } | undefined;
  if (!row) return {};
  const state = (JSON.parse(row.payload) as { state?: Record<string, string> }).state;
  return state && typeof state === "object" ? state : {};
}

/**
 * At start (TEAM-44): record `config/changed_outside {keys, state}` when the
 * user config differs from the last recorded state. Returns the keys, or
 * `[]` when nothing changed.
 */
export function recordConfigAtStart(input: {
  db: DatabaseSync;
  log: EventLog;
  path: string;
  identityDir: string;
}): string[] {
  const recorded = recordedConfigState(input.db);
  const leaves = readLeaves(input.path);
  // No user config, and none ever recorded: nothing to compare, nothing written.
  if (!leaves || (leaves.size === 0 && Object.keys(recorded).length === 0)) return [];
  const state = configState(input.path, configAuditKey(input.identityDir));
  if (!state) return [];
  const keys = changedKeys(recorded, state);
  if (keys.length === 0) return [];
  input.log.appendNow({
    actor: "harness",
    type: "config/changed_outside",
    payload: { keys, state },
  });
  return keys;
}

/**
 * Sekhemet's own write to the user config (Configuration's model folders):
 * any outside change found first is recorded as such, then the write, then
 * `config/changed {keys, state}` with the person who asked — so the audit
 * log names them and the next start sees no outside change.
 */
export function recordConfigWrite<T>(
  input: {
    db: DatabaseSync;
    log: EventLog;
    path: string;
    identityDir: string;
    principal: string;
  },
  write: () => T,
): T {
  const key = configAuditKey(input.identityDir);
  const before = configState(input.path, key);
  if (before) {
    const outside = changedKeys(recordedConfigState(input.db), before);
    if (outside.length)
      input.log.appendNow({
        actor: "harness",
        type: "config/changed_outside",
        payload: { keys: outside, state: before },
      });
  }
  const result = write();
  const after = configState(input.path, key);
  if (after) {
    const keys = changedKeys(before ?? recordedConfigState(input.db), after);
    if (keys.length)
      input.log.appendNow({
        actor: "human",
        type: "config/changed",
        principal: input.principal,
        payload: { keys, state: after },
      });
  }
  return result;
}
