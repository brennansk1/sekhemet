import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * The OS keychain for integration tokens (security item 35, S3c, SEC-27a):
 * macOS's own `security` tool, no library. A secret never appears on a
 * command line: it is written through `security -i`, which reads its command
 * from standard input. Where there is no keychain — Linux, or
 * `SEKHEMET_KEYCHAIN=off` — there is no store, and the caller keeps the
 * token in its 0600 file (SEC-27).
 */
export interface SecretStore {
  get(account: string): string | undefined;
  set(account: string, secret: string): void;
  delete(account: string): void;
}

const SECURITY = "/usr/bin/security";
const SERVICE = "sekhemet";

/** One argument of a `security -i` command line, quoted. */
function quoted(value: string): string {
  if (/[\n\r\0]/.test(value)) throw new Error("a keychain value cannot hold a line break");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The keychain store on this host, or undefined when there is none.
 * `SEKHEMET_KEYCHAIN_FILE` names one keychain to use instead of the default
 * search list (tests use a throwaway one).
 */
export function keychainStore(): SecretStore | undefined {
  if (process.env.SEKHEMET_KEYCHAIN === "off") return undefined;
  if (process.platform !== "darwin" || !existsSync(SECURITY)) return undefined;
  const file = process.env.SEKHEMET_KEYCHAIN_FILE?.trim() || undefined;
  const run = (args: string[], input?: string) =>
    execFileSync(SECURITY, args, {
      encoding: "utf8",
      timeout: 15_000,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      ...(input === undefined ? {} : { input }),
    });
  return {
    get(account) {
      try {
        return run([
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
      run(["-i"], `${line}\n`);
      // `security -i` exits 0 even when its command fails: read it back.
      if (this.get(account) !== secret) throw new Error("the keychain did not keep the secret");
    },
    delete(account) {
      try {
        run(["delete-generic-password", "-s", SERVICE, "-a", account, ...(file ? [file] : [])]);
      } catch {
        // Not there: nothing to remove.
      }
    },
  };
}
