import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initLocalKernel } from "../src/index.js";
import { planResearch } from "../src/research/plan_research.js";
import { configWriter, recordConfigAtStart } from "../src/team/config_audit.js";
import { identityDir } from "../src/team/credential_store.js";

/**
 * B4.11 close-out C2, teams TEAM-44 and TEAM-27: every writer of the user
 * config.toml inside Sekhemet records its write as `config/changed` — the
 * research question's answer (`research_consent.ts`, through `plan`) and the
 * start's renamed-key upgrade (`config_upgrade.ts`, in `initLocalKernel`) as
 * well as Configuration's model folders — so the next start reports no
 * outside change. Keys only, never a value. Real files and a real ledger.
 */

const dirs: string[] = [];
let userConfig: string;
let repo: string;
let db: DatabaseSync;
let log: EventLog;

const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

beforeEach(() => {
  const home = temp("cfg-writers-home-");
  userConfig = join(home, "config.toml");
  vi.stubEnv("SEKHEMET_USER_CONFIG", userConfig);
  vi.stubEnv("SEKHEMET_CONFIG_DIR", join(home, ".sekhemet"));
  repo = temp("cfg-writers-repo-");
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db);
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const rows = (d: DatabaseSync, type: string) =>
  d
    .prepare("SELECT actor, principal, payload FROM events WHERE type = ? ORDER BY seq")
    .all(type) as { actor: string; principal: string | null; payload: string }[];

const keysOf = (r: { payload: string } | undefined) =>
  (JSON.parse(r?.payload ?? "{}") as { keys?: string[] }).keys;

describe("TEAM-44: research consent's writes are Sekhemet's own", () => {
  it("the answer to the research question is `config/changed` with the person, and the next start finds nothing outside", async () => {
    writeFileSync(userConfig, "[sessions]\nidle_minutes = 60\n");
    const identity = temp("cfg-writers-id-");
    // The last recorded state: the file as it was at the last start.
    expect(recordConfigAtStart({ db, log, path: userConfig, identityDir: identity })).toEqual([
      "sessions.idle_minutes",
    ]);
    const research = await planResearch({
      repoPath: repo,
      log,
      newProject: true,
      print: () => undefined,
      ask: async () => true,
      fetchImpl: async () => new Response("{}"),
      recordConfigWrite: configWriter({
        db,
        log,
        path: userConfig,
        identityDir: identity,
        principal: log.localPrincipal(),
      }),
    });
    expect(research).toBeDefined();
    expect(readFileSync(userConfig, "utf8")).toMatch(/research = "yes"/);
    const changed = rows(db, "config/changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ actor: "human", principal: log.localPrincipal() });
    expect(keysOf(changed[0])).toEqual(["network.research", "network.research_hosts"]);
    // Never a value: not the answer, not a host it names.
    expect(changed[0]?.payload).not.toMatch(/"yes"|registry\.npmjs\.org|api\.deps\.dev/);
    // The next start: nothing changed outside Sekhemet.
    expect(recordConfigAtStart({ db, log, path: userConfig, identityDir: identity })).toEqual([]);
    expect(rows(db, "config/changed_outside")).toHaveLength(1);
  });

  it("the answer naming hosts an earlier yes did not is recorded the same way", async () => {
    writeFileSync(
      userConfig,
      '[network]\nresearch = "yes"\nresearch_hosts = ["registry.npmjs.org"]\n',
    );
    const identity = temp("cfg-writers-id-");
    recordConfigAtStart({ db, log, path: userConfig, identityDir: identity });
    await planResearch({
      repoPath: repo,
      log,
      newProject: true,
      print: () => undefined,
      ask: async () => false,
      fetchImpl: async () => new Response("{}"),
      recordConfigWrite: configWriter({
        db,
        log,
        path: userConfig,
        identityDir: identity,
        principal: log.localPrincipal(),
      }),
    });
    expect(readFileSync(userConfig, "utf8")).toMatch(/research_hosts_declined/);
    expect(keysOf(rows(db, "config/changed")[0])).toEqual(["network.research_hosts_declined"]);
    expect(recordConfigAtStart({ db, log, path: userConfig, identityDir: identity })).toEqual([]);
  });
});

describe("TEAM-44: the start's renamed-key upgrade is Sekhemet's own", () => {
  it("initLocalKernel records the rename as `config/changed` by Sekhemet, and the server's start finds nothing outside", () => {
    db.close();
    const git = temp("cfg-writers-git-");
    execFileSync("git", ["init", "-q", git]);
    writeFileSync(userConfig, '[machine]\nhours = "09:00-17:00"\n');
    const k = initLocalKernel(git);
    try {
      expect(readFileSync(userConfig, "utf8")).toMatch(/reserved_hours = /);
      const changed = rows(k.db, "config/changed");
      expect(changed).toHaveLength(1);
      // No person asked: Sekhemet itself made the change (the audit names it).
      expect(changed[0]).toMatchObject({ actor: "harness", principal: null });
      expect(keysOf(changed[0])).toEqual(["machine.hours", "machine.reserved_hours"]);
      expect(changed[0]?.payload).not.toContain("09:00");
      // First sight of the file: its keys were recorded as found, before the write.
      expect(keysOf(rows(k.db, "config/changed_outside")[0])).toEqual(["machine.hours"]);
      expect(
        recordConfigAtStart({ db: k.db, log: k.log, path: userConfig, identityDir: identityDir() }),
      ).toEqual([]);
      // Nothing to rename: a later start writes and records nothing.
      k.db.close();
      const again = initLocalKernel(git);
      expect(rows(again.db, "config/changed")).toHaveLength(1);
      expect(rows(again.db, "config/changed_outside")).toHaveLength(1);
      again.db.close();
    } finally {
      db = new DatabaseSync(":memory:");
    }
  });
});
