import { execFileSync, spawnSync } from "node:child_process";
import { constants, accessSync, existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * The OS secret store for integration secrets (security item 35, S3c,
 * SEC-27a, SEC-27b), through the operating system's own tool, no library:
 * on macOS the keychain through `security`; on Linux the Secret Service
 * (GNOME Keyring, KWallet, KeePassXC) through libsecret's `secret-tool`. A
 * secret never appears on a command line: `security -i` reads its command
 * from standard input, and `secret-tool store` reads the secret from it.
 * Where there is no store — no `secret-tool` in its fixed places, or
 * `SEKHEMET_KEYCHAIN=off` — this returns none, and the caller writes a
 * secret to its 0600 file only with the person's recorded choice
 * (`secret_store.ts`, SEC-27c).
 */
export type SecretStoreKind = "keychain" | "secret-service";

export interface SecretStore {
  kind: SecretStoreKind;
  get(account: string): string | undefined;
  set(account: string, secret: string): void;
  delete(account: string): void;
}

const SECURITY = "/usr/bin/security";
const SERVICE = "sekhemet";
/** An account no secret is stored under: the probe looks it up to see whether the service answers. */
const PROBE_ACCOUNT = "sekhemet-probe";
const TIMEOUT_MS = 15_000;
/** The probe only asks whether the service answers: a short wait (doctor, the status route). */
const PROBE_TIMEOUT_MS = 3_000;

/**
 * Where libsecret's `secret-tool` is installed by Debian, Ubuntu, Fedora and
 * Arch (and by hand). The secrets are piped to it, so it is never looked up
 * on PATH: `npx` and `pnpm` put a project's `node_modules/.bin` first there,
 * and a card could have written a `secret-tool` into it (as BWRAP_CANDIDATES).
 * `SEKHEMET_SECRET_TOOL` names another place, as an absolute path, for a
 * host that installs it elsewhere (NixOS, Guix, Homebrew on Linux).
 */
export const SECRET_TOOL_CANDIDATES = ["/usr/bin/secret-tool", "/usr/local/bin/secret-tool"];

/** A secret holds no line break: both tools read it as one line (and `security -i` as a command). */
function oneLine(value: string): string {
  if (/[\n\r\0]/.test(value)) throw new Error("a stored secret cannot hold a line break");
  return value;
}

/** One argument of a `security -i` command line, quoted. */
function quoted(value: string): string {
  return `"${oneLine(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function executable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The `secret-tool` this host uses: `SEKHEMET_SECRET_TOOL` when set, else a fixed place. */
export function secretToolPath(): string | undefined {
  const override = process.env.SEKHEMET_SECRET_TOOL?.trim();
  if (override) return isAbsolute(override) && executable(override) ? override : undefined;
  return SECRET_TOOL_CANDIDATES.find(executable);
}

function run(tool: string, args: string[], input?: string): string {
  return execFileSync(tool, args, {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    ...(input === undefined ? {} : { input }),
  });
}

/**
 * The macOS keychain. `SEKHEMET_KEYCHAIN_FILE` names one keychain to use
 * instead of the default search list (tests use a throwaway one).
 */
function macKeychain(): SecretStore {
  const file = process.env.SEKHEMET_KEYCHAIN_FILE?.trim() || undefined;
  return {
    kind: "keychain",
    get(account) {
      try {
        return run(SECURITY, [
          "find-generic-password",
          "-s",
          SERVICE,
          "-a",
          account,
          "-w",
          ...(file ? [file] : []),
        ]).replace(/\n$/, "");
      } catch {
        return undefined;
      }
    },
    set(account, secret) {
      const line = [
        "add-generic-password",
        "-U",
        "-s",
        quoted(SERVICE),
        "-a",
        quoted(account),
        "-w",
        quoted(secret),
        ...(file ? [quoted(file)] : []),
      ].join(" ");
      run(SECURITY, ["-i"], `${line}\n`);
      // `security -i` exits 0 even when its command fails: read it back.
      if (this.get(account) !== secret) throw new Error("the keychain did not keep the secret");
    },
    delete(account) {
      try {
        run(SECURITY, [
          "delete-generic-password",
          "-s",
          SERVICE,
          "-a",
          account,
          ...(file ? [file] : []),
        ]);
      } catch {
        // Not there: nothing to remove.
      }
    },
  };
}

/**
 * The Secret Service through libsecret's `secret-tool`: each secret an item
 * with the attributes `service sekhemet` and `account <account>`, its value
 * written on standard input (secret-tool reads it from there when that is
 * not a terminal), read back to confirm.
 */
function secretService(tool: string): SecretStore {
  const attrs = (account: string) => ["service", SERVICE, "account", account];
  return {
    kind: "secret-service",
    get(account) {
      try {
        return run(tool, ["lookup", ...attrs(account)]).replace(/\n$/, "");
      } catch {
        return undefined;
      }
    },
    set(account, secret) {
      run(tool, ["store", `--label=Sekhemet ${account}`, ...attrs(account)], oneLine(secret));
      if (this.get(account) !== secret)
        throw new Error("the Secret Service did not keep the secret");
    },
    delete(account) {
      try {
        run(tool, ["clear", ...attrs(account)]);
      } catch {
        // Not there: nothing to remove.
      }
    },
  };
}

/**
 * The secret store on this host, or undefined when there is none: the
 * keychain on macOS, the Secret Service where `secret-tool` is installed
 * elsewhere. A Secret Service that does not answer shows as a `set` that
 * throws; `probeSecretStore` says why.
 */
export function keychainStore(): SecretStore | undefined {
  if (process.env.SEKHEMET_KEYCHAIN === "off") return undefined;
  if (process.platform === "darwin") return existsSync(SECURITY) ? macKeychain() : undefined;
  const tool = secretToolPath();
  return tool ? secretService(tool) : undefined;
}

export interface SecretStoreProbe {
  /** The store that answered. */
  store?: SecretStoreKind;
  /** Its name as a person reads it. */
  name?: string;
  /** Why there is none, as a person reads it. */
  unavailable?: string;
}

/**
 * Whether this host has a secret store that answers, and if not, why
 * (doctor, Integrations). The Secret Service is asked for an item that is
 * never stored: "not found" (exit 1, nothing on stderr) means it answered;
 * anything on stderr — no session bus, no keyring daemon — means it did not.
 */
export function probeSecretStore(): SecretStoreProbe {
  if (process.env.SEKHEMET_KEYCHAIN === "off")
    return { unavailable: "SEKHEMET_KEYCHAIN is off, so no secret store is used" };
  if (process.platform === "darwin") {
    return existsSync(SECURITY)
      ? { store: "keychain", name: "the macOS keychain" }
      : { unavailable: `the macOS security tool (${SECURITY}) is missing` };
  }
  const tool = secretToolPath();
  if (!tool)
    return {
      unavailable: process.env.SEKHEMET_SECRET_TOOL?.trim()
        ? "SEKHEMET_SECRET_TOOL does not name secret-tool by its full path"
        : "secret-tool is not installed (the libsecret-tools package on Debian and Ubuntu, libsecret on Fedora and Arch)",
    };
  // An item that is never stored: no keyring unlock is asked for it.
  const r = spawnSync(tool, ["lookup", "service", SERVICE, "account", PROBE_ACCOUNT], {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const why = (r.stderr ?? "").trim().split("\n")[0] ?? "";
  if (!r.error && (r.status === 0 || (r.status === 1 && !why)))
    return { store: "secret-service", name: "the Secret Service (secret-tool)" };
  return {
    unavailable: `secret-tool is installed but the Secret Service did not answer (${why || r.error?.message || `exit ${r.status}`}); a keyring such as GNOME Keyring or KeePassXC must be running in your session`,
  };
}
