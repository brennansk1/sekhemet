import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readSettings, writeSettings } from "../src/integrations.js";
import { keychainStore } from "../src/keychain.js";
import { SecretNotStored, recordCleartextSecretsChoice } from "../src/secret_store.js";

/**
 * S3c, security item 35 (SEC-27a): on a host with a keychain the integration
 * tokens — the Slack webhook URL, the push token — live in it, through the
 * macOS `security` tool, and never in the settings file. A real keychain: a
 * throwaway one made for this file (never the person's login keychain, and
 * never added to the search list), removed afterwards.
 */
const darwin = platform() === "darwin";
const dirs: string[] = [];
let keychain: string;
const sec = (...args: string[]) =>
  execFileSync("/usr/bin/security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

beforeAll(() => {
  if (!darwin) return;
  const dir = mkdtempSync(join(tmpdir(), "sek-keychain-"));
  dirs.push(dir);
  keychain = join(dir, "test.keychain-db");
  sec("create-keychain", "-p", "test", keychain);
  sec("unlock-keychain", "-p", "test", keychain);
});
afterAll(() => {
  if (darwin && keychain) sec("delete-keychain", keychain);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let base: string;
let repo: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "sek-kc-user-"));
  repo = mkdtempSync(join(tmpdir(), "sek-kc-repo-"));
  dirs.push(base, repo);
  vi.stubEnv("SEKHEMET_CONFIG_DIR", base);
  vi.stubEnv("SEKHEMET_KEYCHAIN", "on");
  vi.stubEnv("SEKHEMET_KEYCHAIN_FILE", keychain ?? "");
});
afterEach(() => vi.unstubAllEnvs());

const settingsFile = () => {
  const [f] = readdirSync(join(base, "repos"));
  return readFileSync(join(base, "repos", f as string), "utf8");
};
const inKeychain = (account: string) => {
  try {
    return sec("find-generic-password", "-s", "sekhemet", "-a", account, "-w", keychain).trim();
  } catch {
    return undefined;
  }
};

describe.runIf(darwin)("SEC-27a: integration tokens in the OS keychain", () => {
  const webhook = "https://hooks.slack.test/T0/B0/secret-hook";
  const token = 'tk_"quoted" \\ secret';

  it("stores the webhook and the push token in the keychain, not the file, and reads them back", () => {
    writeSettings(repo, {
      slackWebhookUrl: webhook,
      push: { kind: "ntfy", url: "https://ntfy.test", topic: "t", token },
    });
    const file = settingsFile();
    expect(file).not.toContain("secret-hook");
    expect(file).not.toContain("tk_");
    const accounts = (JSON.parse(file) as { keychain: string[] }).keychain;
    expect(accounts.map((a) => a.split(":").at(-1)).sort()).toEqual(
      ["push.token", "slackWebhookUrl"].sort(),
    );
    expect(inKeychain(accounts.find((a) => a.endsWith(":slackWebhookUrl")) as string)).toBe(
      webhook,
    );
    expect(readSettings(repo)).toMatchObject({
      slackWebhookUrl: webhook,
      push: { kind: "ntfy", url: "https://ntfy.test", topic: "t", token },
    });
    // Removing a setting removes its secret.
    const acct = accounts.find((a) => a.endsWith(":slackWebhookUrl")) as string;
    writeSettings(repo, { slackWebhookUrl: undefined });
    expect(inKeychain(acct)).toBeUndefined();
    expect(readSettings(repo).slackWebhookUrl).toBeUndefined();
    expect(readSettings(repo).push?.token).toBe(token);
  });

  it("moves a token an older file holds into the keychain on the next read", () => {
    writeSettings(repo, { githubPrOnAccept: true });
    const [f] = readdirSync(join(base, "repos"));
    const path = join(base, "repos", f as string);
    writeFileSync(path, JSON.stringify({ githubPrOnAccept: true, slackWebhookUrl: webhook }));
    expect(readSettings(repo)).toMatchObject({ githubPrOnAccept: true, slackWebhookUrl: webhook });
    expect(readFileSync(path, "utf8")).not.toContain("secret-hook");
    expect(readSettings(repo).slackWebhookUrl).toBe(webhook);
  });

  it("is off where asked; the file keeps the token only by the person's recorded choice (SEC-27, SEC-27c)", () => {
    vi.stubEnv("SEKHEMET_KEYCHAIN", "off");
    vi.stubEnv("SEKHEMET_USER_CONFIG", join(base, "config.toml"));
    expect(keychainStore()).toBeUndefined();
    expect(() => writeSettings(repo, { slackWebhookUrl: webhook })).toThrow(SecretNotStored);
    recordCleartextSecretsChoice(true);
    writeSettings(repo, { slackWebhookUrl: webhook });
    expect(settingsFile()).toContain("secret-hook");
  });
});
