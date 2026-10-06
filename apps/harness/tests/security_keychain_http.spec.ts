import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pageWriteHeaders } from "./page_headers.js";
import { BIN, type G6Repo, g6Repo } from "./support/g6_review.js";

/**
 * security item 35 (SEC-27a) at the door (C2d, FINDINGS_C1 TST-01): the
 * built command (`apps/harness/dist/index.js`) spawned as `sekhemet serve`,
 * a Slack webhook saved over HTTP as the Integrations page saves it
 * (`PUT /api/integrations/slack`). The keychain is a real one made for this
 * file (never the person's login keychain, never on the search list) and
 * removed afterwards. A preload records the argument list of every program
 * the server starts, unchanged, so a test reads what reached a command line.
 */
const darwin = platform() === "darwin";
const sec = (...args: string[]) =>
  execFileSync("/usr/bin/security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const ARGV_PRELOAD = `
import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
const require = createRequire(import.meta.url);
const cp = require("node:child_process");
const log = (file, args) => {
  try { appendFileSync(process.env.G6_ARGV_LOG, JSON.stringify([String(file), ...(Array.isArray(args) ? args.map(String) : [])]) + "\\n"); } catch {}
};
for (const name of ["execFileSync", "spawnSync", "execFile", "spawn"]) {
  const orig = cp[name];
  cp[name] = function (file, args, ...rest) { log(file, args); return orig.call(this, file, args, ...rest); };
}
for (const name of ["execSync", "exec"]) {
  const orig = cp[name];
  cp[name] = function (command, ...rest) { log(command, []); return orig.call(this, command, ...rest); };
}
syncBuiltinESMExports();
`;

const HOOK = "https://hooks.slack.com/services/T0000/B0000/secretHOOKvalue123";

let keychain = "";
let keychainDir = "";
beforeAll(() => {
  if (!darwin) return;
  keychainDir = mkdtempSync(join(tmpdir(), "sek-g6-keychain-"));
  keychain = join(keychainDir, "test.keychain-db");
  sec("create-keychain", "-p", "test", keychain);
  sec("unlock-keychain", "-p", "test", keychain);
});
afterAll(() => {
  if (darwin && keychain) sec("delete-keychain", keychain);
  if (keychainDir) rmSync(keychainDir, { recursive: true, force: true });
});

const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
});

/** `sekhemet serve` with the keychain on and every program's arguments logged; `use` gets its address. */
async function served<T>(r: G6Repo, use: (base: string) => Promise<T>): Promise<T> {
  const preload = join(r.home, "argv_log.mjs");
  writeFileSync(preload, ARGV_PRELOAD);
  const child = spawn(process.execPath, ["--import", preload, BIN, "serve", "--port", "0"], {
    cwd: r.repo,
    env: r.env({
      env: {
        SEKHEMET_KEYCHAIN: "on",
        SEKHEMET_KEYCHAIN_FILE: keychain,
        G6_ARGV_LOG: join(r.root, "argv.jsonl"),
      },
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  child.stderr?.on("data", (d) => {
    out += String(d);
  });
  const base = await new Promise<string>((ok, bad) => {
    const timer = setTimeout(() => bad(new Error(`no address: ${out}`)), 30_000);
    child.stdout?.on("data", (d) => {
      out += String(d);
      const m = /running at:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        ok(m[1] as string);
      }
    });
    child.once("exit", (code) => bad(new Error(`serve exited ${code}: ${out}`)));
  });
  try {
    return await use(base);
  } finally {
    child.kill("SIGTERM");
    await new Promise((ok) => child.once("exit", ok));
  }
}

/** The project's integration settings file in the user directory. */
function settingsFile(r: G6Repo): string {
  const dir = join(r.home, ".sekhemet", "repos");
  const [f] = readdirSync(dir).filter((x) => x.endsWith(".json"));
  return join(dir, f as string);
}

const inKeychain = (account: string) => {
  try {
    return sec("find-generic-password", "-s", "sekhemet", "-a", account, "-w", keychain).trim();
  } catch {
    return undefined;
  }
};

/** Every argument list a program was started with while the server ran. */
const argvs = (r: G6Repo): string[][] => {
  const file = join(r.root, "argv.jsonl");
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[])
    : [];
};

describe.runIf(darwin)(
  "SEC-27a: an integration token saved over HTTP lives in the keychain",
  () => {
    it("SEC-27a: PUT /api/integrations/slack stores the webhook in the keychain, never in the settings file nor on any command line", async () => {
      const r = g6Repo();
      const saved = await served(r, async (base) => {
        const res = await fetch(`${base}/api/integrations/slack`, {
          method: "PUT",
          headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
          body: JSON.stringify({ webhookUrl: HOOK }),
        });
        return { status: res.status, body: (await res.json()) as { connected?: boolean } };
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.body.connected).toBe(true);
      const text = readFileSync(settingsFile(r), "utf8");
      expect(text).not.toContain("secretHOOKvalue123");
      const accounts = (JSON.parse(text) as { keychain: string[] }).keychain;
      const account = accounts.find((a) => a.endsWith(":slackWebhookUrl"));
      expect(account).toBeDefined();
      expect(inKeychain(account as string)).toBe(HOOK);
      // The keychain was written through /usr/bin/security, the secret on its standard input.
      const started = argvs(r);
      expect(started.some((a) => a[0] === "/usr/bin/security")).toBe(true);
      expect(started.filter((a) => a.join(" ").includes("secretHOOKvalue123"))).toEqual([]);
    }, 90_000);

    it("SEC-27a: a webhook an older settings file holds is moved into the keychain when the server reads it", async () => {
      const r = g6Repo();
      // A settings file from before the keychain: the token in the clear.
      await served(r, async (base) => {
        const res = await fetch(`${base}/api/integrations/github-pr`, {
          method: "PUT",
          headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
          body: JSON.stringify({ enabled: true }),
        });
        expect(res.status).toBe(200);
      });
      const path = settingsFile(r);
      writeFileSync(path, JSON.stringify({ githubPrOnAccept: true, slackWebhookUrl: HOOK }));
      const listed = await served(r, async (base) => {
        const res = await fetch(`${base}/api/integrations`);
        return (await res.json()) as { id: string; connected?: boolean }[];
      });
      expect(listed.find((i) => i.id === "slack")?.connected).toBe(true);
      const text = readFileSync(path, "utf8");
      expect(text).not.toContain("secretHOOKvalue123");
      const account = (JSON.parse(text) as { keychain: string[] }).keychain.find((a) =>
        a.endsWith(":slackWebhookUrl"),
      );
      expect(inKeychain(account as string)).toBe(HOOK);
      expect(argvs(r).filter((a) => a.join(" ").includes("secretHOOKvalue123"))).toEqual([]);
    }, 90_000);
  },
);
