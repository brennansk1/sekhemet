import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { CardStore } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { BIN } from "./cli_fixture.js";

/**
 * Surface item 20f, SUR-90 (FINDINGS_C1 REL-17, FINISH_LINE_PLAN B-16):
 * `sekhemet doctor --report` writes a redacted folder under
 * `<user dir>/reports/<workspace id>/`, prints its path and its table of
 * contents, and sends nothing. Generated secrets and private fields are
 * planted in every place the report reads, and none survives in any of its
 * files. The built binary is spawned; a preload records every outbound
 * connection it makes, and none leaves the machine.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const alnum = (n: number) => {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return [...randomBytes(n)].map((b) => abc[b % abc.length]).join("");
};
const upper = (n: number) =>
  [...randomBytes(n)].map((b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[b % 32]).join("");

/** Records the host of every socket the process opens. */
const NET_PRELOAD = `
import net from "node:net";
import { appendFileSync } from "node:fs";
const out = process.env.REPORT_NET_LOG;
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = args[0];
  const host = typeof o === "object" && o !== null ? (o.host ?? o.path ?? "localhost") : (typeof args[1] === "string" ? args[1] : "localhost");
  appendFileSync(out, String(host) + "\\n");
  return connect.apply(this, args);
};
`;

describe("sekhemet doctor --report (SUR-90)", () => {
  it("writes a redacted folder, prints its path and contents, keeps no planted secret or private field, and reaches no other host", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sek-report-")));
    dirs.push(root);
    const home = join(root, "home");
    const repo = join(root, "work", "acme-private-repo");
    mkdirSync(home);
    mkdirSync(repo, { recursive: true });
    const userDir = join(home, ".sekhemet");
    const userConfig = join(home, "config.toml");

    // The planted values.
    const githubToken = `ghp_${alnum(36)}`;
    const awsKey = `AKIA${upper(16)}`;
    const slackToken = `xoxb-${Math.floor(1e11 + Math.random() * 9e11)}-${Math.floor(1e11 + Math.random() * 9e11)}-${alnum(24)}`;
    const password = `pw-${alnum(20)}`;
    const configSecret = `cfg-${alnum(24)}`;
    const personName = `Quentin ${alnum(8)} Private`;
    const personEmail = `q.${alnum(8).toLowerCase()}@private-example.org`;
    const strayEmail = `someone.${alnum(6).toLowerCase()}@elsewhere.example`;
    const cardTitle = `Rewrite the ${alnum(10)} billing secret`;
    const host = hostname();
    const planted = {
      githubToken,
      awsKey,
      slackToken,
      password,
      configSecret,
      personName,
      personEmail,
      strayEmail,
      cardTitle,
      home,
      repo,
      host,
    };

    // A project with a person, a card and a ledger.
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Git Name");
    git("config", "user.email", personEmail);
    writeFileSync(join(repo, "README.md"), "x\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      SEKHEMET_CONFIG_DIR: userDir,
      SEKHEMET_USER_CONFIG: userConfig,
      SEKHEMET_MODEL_REGISTRY: join(userDir, "models.json"),
      SEKHEMET_MODEL_LOADS: "off",
      SEKHEMET_KEYCHAIN: "off",
      BROWSER: "false",
    };
    const saved = { ...process.env };
    Object.assign(process.env, env);
    let wsId: string;
    try {
      const { db, log } = openLocalLedger(repo);
      const store = new CardStore(db, log);
      await store.createCard({ id: "card_secret", tier: "story", title: cardTitle });
      // A teammate, named on the ledger (git's name is not recorded; its email is).
      await log.append({
        actor: "system",
        type: "person/created",
        payload: { principal: "p_teammate1", local: false },
        principal: "p_teammate1",
        private: { name: personName, email: `t.${personEmail}` },
      });
      wsId = log.workspaceId() as string;
      db.close();
    } finally {
      for (const k of Object.keys(env)) {
        if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = saved[k];
      }
    }
    expect(wsId).toMatch(/^ws_/);

    // The configuration, both layers.
    writeFileSync(
      userConfig,
      `[network]\nmode = "allowlist"\nfetch_allow = ["${configSecret}.example"]\n\n[integrations]\ntoken = "${githubToken}"\n\n[log]\nlevel = "info"\n`,
    );
    writeFileSync(
      join(repo, ".sekhemet", "config.toml"),
      `[models]\nworker = "${configSecret}"\n[docs]\nproduct = "${cardTitle}"\n`,
    );
    // The credential store, at its workspace's place.
    mkdirSync(join(userDir, "identity", wsId), { recursive: true });
    writeFileSync(
      join(userDir, "identity", wsId, "credentials.json"),
      JSON.stringify({ users: { [personEmail]: { password } } }),
      { mode: 0o600 },
    );
    // The daemon log, an error report and the lost-record log.
    writeFileSync(
      join(repo, ".sekhemet", "daemon.log"),
      [
        `2026-10-05T08:00:00.000Z INFO  serving ${repo} for ${personName} <${personEmail}>`,
        `2026-10-05T08:00:01.000Z WARN  token ${githubToken} rejected by github`,
        `2026-10-05T08:00:02.000Z ERROR aws ${awsKey} on ${host}, mail ${strayEmail}`,
        `2026-10-05T08:00:03.000Z INFO  wrote ${home}/notes.txt; slack ${slackToken}`,
        "",
      ].join("\n"),
    );
    mkdirSync(join(userDir, "logs", wsId), { recursive: true });
    writeFileSync(
      join(userDir, "logs", "error-20261005T080000Z-1.log"),
      `Sekhemet stopped.\nCommand: sekhemet run --token ${githubToken}\nat ${repo}/src/a.ts\n${cardTitle}\n`,
    );
    writeFileSync(
      join(userDir, "logs", wsId, "lost-records.ndjson"),
      `${JSON.stringify({ at: "2026-10-05T08:00:00.000Z", kind: "step 2", error: `aws ${awsKey} by ${personEmail}`, cardId: "card_secret" })}\n`,
    );

    const netLog = join(root, "net.log");
    const preload = join(root, "net.mjs");
    writeFileSync(preload, NET_PRELOAD);
    writeFileSync(netLog, "");
    const r = spawnSync(process.execPath, ["--import", preload, BIN, "doctor", "--report"], {
      cwd: repo,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...env, REPORT_NET_LOG: netLog },
    });
    expect([0, 1], r.stderr).toContain(r.status);

    // The folder, printed with its table of contents.
    const reports = join(userDir, "reports", wsId);
    const made = readdirSync(reports);
    expect(made).toHaveLength(1);
    const dir = join(reports, made[0] as string);
    expect(r.stdout).toContain(dir);
    expect(r.stdout).toMatch(/Nothing was sent/);
    const files = readdirSync(dir).sort();
    expect(files).toEqual(
      [
        "contents.txt",
        "daemon-log.txt",
        "doctor.json",
        "environment.json",
        "errors.txt",
        "ledger.json",
        "lost-records.txt",
      ].sort(),
    );
    for (const f of files) expect(r.stdout).toContain(f);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const f of files) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);

    // What it holds: the checks, the ledger's counts, the logs' lines, redacted.
    const doctor = JSON.parse(readFileSync(join(dir, "doctor.json"), "utf8"));
    expect(doctor.checks.length).toBeGreaterThan(10);
    const ledger = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8"));
    expect(ledger).toMatchObject({ chainValid: true, cardsByStatus: { ready: 1 } });
    expect(ledger.eventCount).toBeGreaterThan(0);
    const environment = JSON.parse(readFileSync(join(dir, "environment.json"), "utf8"));
    expect(environment.settings).toMatchObject({
      "network.mode": { layer: "user", value: "allowlist" },
      "network.fetch_allow": { layer: "user", value: "<array>" },
      "models.worker": { layer: "project", value: "<string>" },
    });
    const daemonLog = readFileSync(join(dir, "daemon-log.txt"), "utf8");
    expect(daemonLog).toMatch(/rejected by github/);
    expect(daemonLog).toMatch(/<workspace>/);
    expect(readFileSync(join(dir, "lost-records.txt"), "utf8")).toMatch(/step 2/);

    // What it never holds.
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      for (const [what, value] of Object.entries(planted))
        expect(text.includes(value), `${f} holds the planted ${what}`).toBe(false);
    }
    expect(existsSync(join(dir, "credentials.json"))).toBe(false);

    // Nothing left the machine.
    const hosts = readFileSync(netLog, "utf8").split("\n").filter(Boolean);
    expect(hosts.filter((h) => !["127.0.0.1", "localhost", "::1"].includes(h))).toEqual([]);
  }, 180_000);
});
