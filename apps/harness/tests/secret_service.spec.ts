import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { secretStoreCheck } from "../src/doctor.js";
import { readSettings, writeSettings } from "../src/integrations.js";
import {
  SECRET_TOOL_CANDIDATES,
  keychainStore,
  probeSecretStore,
  secretToolPath,
} from "../src/keychain.js";
import {
  SecretNotStored,
  cleartextSecretsChoice,
  recordCleartextSecretsChoice,
  secretStoreStatus,
} from "../src/secret_store.js";
import { startDashboardServer } from "../src/server.js";
import { routePermissions } from "../src/team/access.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * B-12 (security item 35, SEC-27b, SEC-27c): on Linux the integration secrets
 * — the Slack webhook URL and bot token, the push token, the SMTP password —
 * go to the Secret Service through `secret-tool`, as the macOS keychain is
 * used on a Mac. Where there is none, the product says so plainly (doctor,
 * Integrations), and nothing is written in cleartext without the person's
 * explicit choice, recorded in their config.toml and on the ledger.
 *
 * A fake `secret-tool`, named by `SEKHEMET_SECRET_TOOL` (the harness never
 * searches PATH for it), stands in for libsecret's: it keeps its items
 * in a JSON file, logs every command line it was given (so a test can prove
 * no secret was ever on one), and in `FAKE_SECRET_BROKEN` mode answers as
 * secret-tool does when no Secret Service is running. The platform is set to
 * Linux for these tests, so the code under test takes its Linux path on any
 * host.
 */

const dirs: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

const FAKE = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.FAKE_SECRET_DIR;
fs.appendFileSync(path.join(dir, "argv.log"), JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.FAKE_SECRET_BROKEN) {
  process.stderr.write("secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\\n");
  process.exit(1);
}
const db = path.join(dir, "store.json");
// A keyring that is locked, or whose unlock prompt timed out: lookups fail, the rest answers.
if (process.env.FAKE_LOOKUP_BROKEN && process.argv[2] === "lookup") {
  process.stderr.write("secret-tool: Cannot get secret of a locked object\\n");
  process.exit(1);
}
const items = fs.existsSync(db) ? JSON.parse(fs.readFileSync(db, "utf8")) : {};
const [cmd, ...rest] = process.argv.slice(2);
const label = rest.find((a) => a.startsWith("--label="));
const args = rest.filter((a) => !a.startsWith("--"));
const attrs = {};
for (let i = 0; i < args.length; i += 2) attrs[args[i]] = args[i + 1];
const key = JSON.stringify(Object.entries(attrs).sort());
if (cmd === "store") {
  if (!label) { process.stderr.write("must specify a label\\n"); process.exit(2); }
  items[key] = fs.readFileSync(0, "utf8");
  fs.writeFileSync(db, JSON.stringify(items));
} else if (cmd === "lookup") {
  if (!(key in items)) process.exit(1);
  process.stdout.write(items[key]);
} else if (cmd === "clear") {
  delete items[key];
  fs.writeFileSync(db, JSON.stringify(items));
} else {
  process.stderr.write("usage: secret-tool store|lookup|clear\\n");
  process.exit(2);
}
`;

let fakeDir: string;
let binDir: string;
let base: string;
let repo: string;
let userConfig: string;
const realPlatform = process.platform;

function linux() {
  Object.defineProperty(process, "platform", { value: "linux" });
}

beforeEach(() => {
  fakeDir = temp("sek-fake-secrets-");
  binDir = temp("sek-fake-bin-");
  base = temp("sek-ss-user-");
  repo = temp("sek-ss-repo-");
  userConfig = join(temp("sek-ss-home-"), "config.toml");
  linux();
  vi.stubEnv("SEKHEMET_CONFIG_DIR", base);
  vi.stubEnv("SEKHEMET_USER_CONFIG", userConfig);
  vi.stubEnv("SEKHEMET_KEYCHAIN", "on");
  vi.stubEnv("FAKE_SECRET_DIR", fakeDir);
  // Only the fake: a real secret-tool elsewhere on the host is never reached.
  vi.stubEnv("SEKHEMET_SECRET_TOOL", join(binDir, "secret-tool"));
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function installFake() {
  const tool = join(binDir, "secret-tool");
  writeFileSync(tool, FAKE);
  chmodSync(tool, 0o755);
}

const fakeItems = (): Record<string, string> => {
  const db = join(fakeDir, "store.json");
  return existsSync(db) ? (JSON.parse(readFileSync(db, "utf8")) as Record<string, string>) : {};
};
const argvLog = () =>
  existsSync(join(fakeDir, "argv.log")) ? readFileSync(join(fakeDir, "argv.log"), "utf8") : "";

/** Every file under the user directory, read as text: where a cleartext secret would be. */
function userFiles(): string {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(readFileSync(p, "utf8"));
    }
  };
  walk(base);
  return out.join("\n");
}

const settingsFile = () => {
  const [f] = readdirSync(join(base, "repos"));
  return join(base, "repos", f as string);
};

const WEBHOOK = "https://hooks.slack.com/services/T0/B0/secret-hook";
const PUSH = 'tk_"quoted" \\ secret';
const SMTP = "smtp-pass-7Hq";

describe("SEC-27b: on Linux the secrets live in the Secret Service (secret-tool)", () => {
  it("stores each secret through secret-tool, never on a command line, and reads it back", () => {
    installFake();
    expect(keychainStore()?.kind).toBe("secret-service");
    writeSettings(repo, {
      slackWebhookUrl: WEBHOOK,
      push: { kind: "ntfy", url: "https://ntfy.test", topic: "t", token: PUSH },
      email: { host: "smtp.test", port: 587, user: "u", password: SMTP, from: "a@b.test" },
    });
    const file = readFileSync(settingsFile(), "utf8");
    for (const s of ["secret-hook", "tk_", SMTP]) expect(file).not.toContain(s);
    expect(Object.values(fakeItems()).sort()).toEqual([WEBHOOK, PUSH, SMTP].sort());
    // Not a secret on any command line secret-tool was given.
    const log = argvLog();
    expect(log).toMatch(/"store"/);
    for (const s of ["secret-hook", "tk_", SMTP]) expect(log).not.toContain(s);
    expect(readSettings(repo)).toMatchObject({
      slackWebhookUrl: WEBHOOK,
      push: { token: PUSH },
      email: { password: SMTP },
    });
    // Removing a setting clears its secret.
    writeSettings(repo, { slackWebhookUrl: undefined });
    expect(Object.values(fakeItems())).not.toContain(WEBHOOK);
    expect(readSettings(repo).slackWebhookUrl).toBeUndefined();
    expect(readSettings(repo).push?.token).toBe(PUSH);
  });

  it("moves a secret an older file holds in cleartext into the Secret Service on the next read", () => {
    installFake();
    mkdirSync(join(base, "repos"), { recursive: true });
    writeSettings(repo, { githubPrOnAccept: true });
    writeFileSync(
      settingsFile(),
      JSON.stringify({ githubPrOnAccept: true, slackWebhookUrl: WEBHOOK }),
    );
    expect(readSettings(repo).slackWebhookUrl).toBe(WEBHOOK);
    expect(readFileSync(settingsFile(), "utf8")).not.toContain("secret-hook");
    expect(Object.values(fakeItems())).toContain(WEBHOOK);
  });

  it("W1 review G3: a Secret Service that cannot be read keeps the secrets a later write does not touch", () => {
    installFake();
    writeSettings(repo, {
      slackWebhookUrl: WEBHOOK,
      push: { kind: "ntfy", url: "https://ntfy.test", topic: "t", token: PUSH },
    });
    for (const broken of ["FAKE_LOOKUP_BROKEN", "FAKE_SECRET_BROKEN"]) {
      vi.stubEnv(broken, "1");
      // Unreadable now: the settings come back without the secrets.
      expect(readSettings(repo).slackWebhookUrl).toBeUndefined();
      // Writes that do not touch them — the sync's time, a toggle — keep them.
      writeSettings(repo, { lastSync: { github: "2026-09-29T00:00:00Z" } });
      writeSettings(repo, { researchWeb: true });
      vi.stubEnv(broken, "");
      expect(Object.values(fakeItems()).sort(), broken).toEqual([WEBHOOK, PUSH].sort());
      expect(readSettings(repo), broken).toMatchObject({
        slackWebhookUrl: WEBHOOK,
        push: { token: PUSH },
        researchWeb: true,
        lastSync: { github: "2026-09-29T00:00:00Z" },
      });
    }
    // A write that does replace one, while it cannot be read, still removes it.
    vi.stubEnv("FAKE_LOOKUP_BROKEN", "1");
    writeSettings(repo, { slackWebhookUrl: undefined });
    vi.stubEnv("FAKE_LOOKUP_BROKEN", "");
    expect(Object.values(fakeItems())).toEqual([PUSH]);
    expect(readSettings(repo).slackWebhookUrl).toBeUndefined();
    expect(readSettings(repo).push?.token).toBe(PUSH);
  });

  it("W1 review: secret-tool is taken from fixed places, never from PATH, which a project can prepend to", () => {
    installFake();
    expect(secretToolPath()).toBe(join(binDir, "secret-tool"));
    // Without the override, a secret-tool on PATH (a project's node_modules/.bin, say) is not used.
    vi.stubEnv("SEKHEMET_SECRET_TOOL", "");
    vi.stubEnv("PATH", binDir);
    const found = secretToolPath();
    expect(found).not.toBe(join(binDir, "secret-tool"));
    if (found !== undefined) expect(SECRET_TOOL_CANDIDATES).toContain(found);
    expect(SECRET_TOOL_CANDIDATES).toEqual(["/usr/bin/secret-tool", "/usr/local/bin/secret-tool"]);
    // A relative override names nothing.
    vi.stubEnv("SEKHEMET_SECRET_TOOL", "secret-tool");
    expect(secretToolPath()).toBeUndefined();
  });

  it("the probe names the Secret Service when it answers", () => {
    installFake();
    expect(probeSecretStore()).toMatchObject({ store: "secret-service" });
    expect(secretStoreCheck()).toMatchObject({ status: "pass" });
    expect(secretStoreCheck().detail).toMatch(/Secret Service/);
  });
});

describe("SEC-27c: no secret store, no cleartext without the person's recorded choice", () => {
  it("with no secret-tool, a secret is refused, named plainly, and nothing is written", () => {
    expect(keychainStore()).toBeUndefined();
    const err = (() => {
      try {
        writeSettings(repo, { slackWebhookUrl: WEBHOOK });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(SecretNotStored);
    expect((err as Error).message).toMatch(/Slack webhook URL/);
    expect((err as Error).message).toMatch(/secret-tool/);
    expect(userFiles()).not.toContain("secret-hook");
    // A setting that is not a secret still saves.
    writeSettings(repo, { researchWeb: true });
    expect(readSettings(repo).researchWeb).toBe(true);
    expect(readSettings(repo).slackWebhookUrl).toBeUndefined();
  });

  it("a Secret Service that does not answer refuses the same way, and says why", () => {
    installFake();
    vi.stubEnv("FAKE_SECRET_BROKEN", "1");
    const probe = probeSecretStore();
    expect(probe.store).toBeUndefined();
    expect(probe.unavailable).toMatch(/D-Bus/);
    expect(() => writeSettings(repo, { email: emailWith(SMTP) })).toThrow(SecretNotStored);
    expect(userFiles()).not.toContain(SMTP);
  });

  it("after the person's recorded choice, the file keeps the secret at mode 0600", () => {
    expect(cleartextSecretsChoice().chosen).toBe(false);
    recordCleartextSecretsChoice(true);
    const choice = cleartextSecretsChoice();
    expect(choice.chosen).toBe(true);
    expect(choice.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(readFileSync(userConfig, "utf8")).toMatch(/\[secrets\]\s*\ncleartext_file = "yes"/);
    writeSettings(repo, { slackWebhookUrl: WEBHOOK });
    expect(readFileSync(settingsFile(), "utf8")).toContain("secret-hook");
    expect(statSync(settingsFile()).mode & 0o777).toBe(0o600);
    expect(readSettings(repo).slackWebhookUrl).toBe(WEBHOOK);
    // Taking the choice back refuses the next new secret.
    recordCleartextSecretsChoice(false);
    expect(() => writeSettings(repo, { slackBotToken: "xoxb-new" })).toThrow(SecretNotStored);
    expect(userFiles()).not.toContain("xoxb-new");
  });

  it("a secret an older file already holds does not block other settings", () => {
    writeSettings(repo, { researchWeb: false });
    writeFileSync(settingsFile(), JSON.stringify({ slackWebhookUrl: WEBHOOK }));
    writeSettings(repo, { lastSync: { github: "2026-09-29T00:00:00Z" } });
    expect(readSettings(repo)).toMatchObject({
      slackWebhookUrl: WEBHOOK,
      lastSync: { github: "2026-09-29T00:00:00Z" },
    });
  });

  it("doctor and the status say so plainly, before and after the choice", () => {
    const before = secretStoreCheck();
    expect(before.status).toBe("warn");
    expect(before.detail).toMatch(/no secret store/i);
    expect(before.detail).toMatch(/secret-tool/);
    expect(before.detail).toMatch(/not saved/);
    expect(secretStoreStatus()).toMatchObject({ cleartextChosen: false });
    recordCleartextSecretsChoice(true);
    const after = secretStoreCheck();
    expect(after.status).toBe("warn");
    expect(after.detail).toMatch(/you chose/i);
    expect(secretStoreStatus()).toMatchObject({ cleartextChosen: true });
  });

  it("SEKHEMET_KEYCHAIN=off turns every store off, and the rule still holds", () => {
    installFake();
    vi.stubEnv("SEKHEMET_KEYCHAIN", "off");
    expect(keychainStore()).toBeUndefined();
    expect(probeSecretStore().unavailable).toMatch(/SEKHEMET_KEYCHAIN/);
    expect(() => writeSettings(repo, { slackWebhookUrl: WEBHOOK })).toThrow(SecretNotStored);
  });
});

function emailWith(password: string) {
  return { host: "smtp.test", port: 587, user: "u", password, from: "a@b.test" };
}

describe("SEC-27c on a real server: Integrations refuses, and records the choice", () => {
  it("a secret is refused with 409 until the person chooses a file; the choice is on the ledger with them", async () => {
    const root = temp("sek-ss-server-");
    mkdirSync(join(root, ".sekhemet"), { recursive: true });
    const db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const cards = new CardStore(db, log);
    const server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cards),
      cardStore: cards,
      repoPath: root,
      port: 0,
      streamIntervalMs: 10_000,
      pressureLevel: () => 1,
      pmAdapter: () => new MockInferenceAdapter("dirk-27b", []),
    });
    const at = `http://127.0.0.1:${server.port}`;
    try {
      const send = async (method: string, path: string, body?: unknown) =>
        fetch(`${at}${path}`, {
          method,
          headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(at)) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const status = await (await fetch(`${at}/api/integrations/secret-store`)).json();
      expect(status).toMatchObject({ cleartextChosen: false });
      expect(status.store).toBeUndefined();
      expect(status.message).toMatch(/secret-tool/);

      const refused = await send("PUT", "/api/integrations/slack", { webhookUrl: WEBHOOK });
      expect(refused.status).toBe(409);
      const body = (await refused.json()) as { error: string; needs: string };
      expect(body.needs).toBe("secret-store-choice");
      expect(body.error).toMatch(/Slack webhook URL/);
      expect(userFiles()).not.toContain("secret-hook");

      // A write without the page's token changes nothing.
      const forged = await fetch(`${at}/api/integrations/secret-store`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Sekhemet-Action": "1" },
        body: JSON.stringify({ cleartextFile: true }),
      });
      expect(forged.status).toBe(403);
      expect(cleartextSecretsChoice().chosen).toBe(false);

      const chose = await send("PUT", "/api/integrations/secret-store", { cleartextFile: true });
      expect(chose.status).toBe(200);
      expect(await chose.json()).toMatchObject({ cleartextChosen: true });
      const changed = db
        .prepare("SELECT actor, principal, payload FROM events WHERE type = 'config/changed'")
        .all() as { actor: string; principal: string; payload: string }[];
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({ actor: "human", principal: log.localPrincipal() });
      expect(JSON.parse(changed[0]?.payload ?? "{}").keys).toContain("secrets.cleartext_file");

      expect((await send("PUT", "/api/integrations/slack", { webhookUrl: WEBHOOK })).status).toBe(
        200,
      );
      expect(readSettings(root).slackWebhookUrl).toBe(WEBHOOK);
    } finally {
      await server.close();
      db.close();
    }
  });

  it("in the Team setup the choice is an Admin's, as every integration write is", () => {
    const rule = routePermissions("PUT", "/api/integrations/secret-store", {});
    expect(rule?.permissions).toEqual(["integration.connect"]);
  });
});
