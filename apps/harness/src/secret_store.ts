import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type TomlTable, parseToml } from "@sekhemet/kernel";
import { type SecretStoreKind, probeSecretStore } from "./keychain.js";
import type { ConfigWrite } from "./team/config_audit.js";
import { writeTomlTableKeys } from "./toml_keys.js";
import { userPaths } from "./user_dir.js";

/**
 * Where integration secrets may be kept (security item 35, SEC-27c, B-12).
 * They go to the OS secret store (`keychain.ts`). Where a host has none — a
 * Linux machine without `secret-tool` or a running keyring, a headless Team
 * server — a secret is written to the 0600 settings file only after the
 * person chose that, and the choice is recorded: `[secrets] cleartext_file =
 * "yes"` with its time in their config.toml, written through the config
 * audit so the ledger names who chose it (`config/changed`, TEAM-44).
 * Without the choice the secret is refused and nothing is written.
 */

/** The settings that are secrets: a Slack webhook URL can post to the channel, a push token to the phone. */
export const SECRET_FIELDS = [
  "slackWebhookUrl",
  "slackBotToken",
  "push.token",
  "email.password",
] as const;
export type SecretField = (typeof SECRET_FIELDS)[number];

/** Each secret as a person reads it. */
export const SECRET_FIELD_WORDS: Record<SecretField, string> = {
  slackWebhookUrl: "the Slack webhook URL",
  slackBotToken: "the Slack bot token",
  "push.token": "the push notification token",
  "email.password": "the SMTP password",
};

const TABLE = "secrets";

/** The user's config.toml (SUR-25); the test override first, as every reader of it. */
const userConfigPath = () => process.env.SEKHEMET_USER_CONFIG ?? userPaths().config;

/** The person's recorded choice to keep secrets in a private file, and when they made it. */
export function cleartextSecretsChoice(path = userConfigPath()): { chosen: boolean; at?: string } {
  if (!existsSync(path)) return { chosen: false };
  try {
    const t = (parseToml(readFileSync(path, "utf8"))[TABLE] ?? {}) as TomlTable;
    const at = typeof t.cleartext_file_at === "string" ? t.cleartext_file_at : undefined;
    return { chosen: t.cleartext_file === "yes", ...(at ? { at } : {}) };
  } catch {
    // An unreadable file allows nothing.
    return { chosen: false };
  }
}

/** A write not recorded on a ledger: only where no ledger is open. */
const unrecorded: ConfigWrite = (write) => write();

/**
 * Record the person's answer: `yes` lets a secret go to the 0600 file on a
 * host with no secret store; `no` takes that back (secrets already in a file
 * stay until their setting is removed or changed).
 */
export function recordCleartextSecretsChoice(
  allow: boolean,
  path = userConfigPath(),
  record: ConfigWrite = unrecorded,
  now: Date = new Date(),
): void {
  record(() =>
    writeTomlTableKeys(path, TABLE, [
      ["cleartext_file", allow ? '"yes"' : '"no"'],
      ["cleartext_file_at", `"${now.toISOString()}"`],
    ]),
  );
}

/** Secrets refused: no store kept them and the person has not chosen a file. */
export class SecretNotStored extends Error {
  readonly needs = "secret-store-choice";
  constructor(
    readonly fields: SecretField[],
    readonly reason: string,
  ) {
    const what = fields.map((f) => SECRET_FIELD_WORDS[f]);
    const list =
      what.length > 1 ? `${what.slice(0, -1).join(", ")} and ${what.at(-1)}` : (what[0] ?? "");
    super(
      `Sekhemet did not save ${list}: ${reason}. Install a secret store, or choose in Integrations to keep secrets in a private file on this machine (readable only by your user, never by the Agent).`,
    );
    this.name = "SecretNotStored";
  }
}

export interface SecretStoreStatus {
  /** The store that answered on this host. */
  store?: SecretStoreKind;
  storeName?: string;
  /** Why there is none. */
  unavailable?: string;
  cleartextChosen: boolean;
  cleartextChosenAt?: string;
  /** Integration secrets already held in a settings file in cleartext. */
  heldInFiles: number;
  /** One plain sentence for doctor and Integrations. */
  message: string;
}

/** How many integration secrets the settings files hold in cleartext now. */
export function secretsHeldInFiles(): number {
  const dir = userPaths().integrations;
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const o = JSON.parse(readFileSync(join(dir, f), "utf8")) as object;
      for (const field of SECRET_FIELDS) {
        const v = field
          .split(".")
          .reduce<unknown>((x, k) => (x as Record<string, unknown>)?.[k], o);
        if (typeof v === "string" && v) n++;
      }
    } catch {
      // Not a settings file this can read.
    }
  }
  return n;
}

/** The store on this host, the person's choice, and what that means, in plain words. */
export function secretStoreStatus(path = userConfigPath()): SecretStoreStatus {
  const probe = probeSecretStore();
  const choice = cleartextSecretsChoice(path);
  const held = secretsHeldInFiles();
  const base = {
    ...(probe.store ? { store: probe.store } : {}),
    ...(probe.name ? { storeName: probe.name } : {}),
    ...(probe.unavailable ? { unavailable: probe.unavailable } : {}),
    cleartextChosen: choice.chosen,
    ...(choice.at ? { cleartextChosenAt: choice.at } : {}),
    heldInFiles: held,
  };
  const inFiles = held
    ? ` ${held} secret${held === 1 ? " is" : "s are"} held in a private file on this machine.`
    : "";
  if (probe.store)
    return {
      ...base,
      message: `Integration secrets (Slack, push and email) are kept in ${probe.name}.${inFiles}`,
    };
  const when = choice.at ? ` on ${choice.at.slice(0, 10)}` : "";
  return {
    ...base,
    message: choice.chosen
      ? `This machine has no secret store: ${probe.unavailable}. You chose${when} to keep integration secrets in a private file (mode 0600, readable only by your user, never by the Agent).${inFiles}`
      : `This machine has no secret store: ${probe.unavailable}. Integration secrets (Slack, push and email) are not saved until you install one or choose, in Integrations, to keep them in a private file.${inFiles}`,
  };
}
