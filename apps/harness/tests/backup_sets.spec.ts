import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { BoardServiceImpl } from "@sekhemet/board";
import {
  BlobStore,
  CardStore,
  EventLog,
  RunLedger,
  SCHEMA_VERSION,
  readErasureRegister,
} from "@sekhemet/kernel";
import { processStartTime } from "@sekhemet/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dailyBackupIfDue,
  erasureRegisterFor,
  installId,
  legacyErasureRegister,
  listBackupSets,
  newestVerifiedBackup,
  writeBackupSet,
} from "../src/backup_sets.js";
import { executeCard } from "../src/execute.js";
import { offerWorkspaceRestore } from "../src/first_run.js";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { mayStartCard } from "../src/reservation.js";
import { leasePath } from "../src/runner_lease.js";
import {
  CREDENTIALS_FILE,
  credentialBackupPath,
  identityDir,
  identityRoot,
  readIdentityMove,
  workspaceIdentityDir,
} from "../src/team/credential_store.js";
import { createServerIdentity } from "../src/team/serve.js";
import { identitySettings } from "../src/team/settings.js";
import { readLocator, registerProject } from "../src/workspace_locator.js";

/**
 * Backups that survive the repository, per workspace (runtime items 35, 35a,
 * 36, 37, 38; NEW-runtime-11 RUN-59..62, RUN-78; NEW-runtime-18 RUN-87, RUN-88;
 * SPEC-02; REL-18) and the credential store per workspace (security item 35a,
 * NEW-security-14). Real git repositories, real SQLite ledgers, a real user
 * directory under a temporary home, `git clean -xdf` for real, and the built
 * binary spawned for the commands (DEFINITION_OF_DONE §2A).
 */
const BIN = resolve(import.meta.dirname, "../dist/index.js");
const SECRET_NOTE = "call Ada on +44 20 7946 0000";
const dirs: string[] = [];
let home: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "sek-backup-home-")));
  dirs.push(home);
  // In-process calls and the spawned binary share one user directory.
  savedConfigDir = process.env.SEKHEMET_CONFIG_DIR;
  process.env.SEKHEMET_CONFIG_DIR = join(home, ".sekhemet");
});
afterEach(() => {
  if (savedConfigDir === undefined) Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
  else process.env.SEKHEMET_CONFIG_DIR = savedConfigDir;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function gitRepo(dir: string, file: string): string {
  mkdirSync(join(dir, "src"), { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jane Doe");
  git("config", "user.email", "jane@example.com");
  writeFileSync(join(dir, "src", file), `export const x = "${file}";\n`);
  writeFileSync(join(dir, ".gitignore"), ".sekhemet/\n");
  git("add", "-A");
  git("commit", "-q", "-m", `seed ${file}`);
  return realpathSync(dir);
}

function sekhemet(args: string[], cwd: string) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      SEKHEMET_CONFIG_DIR: join(home, ".sekhemet"),
      SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml",
      SEKHEMET_KEYCHAIN: "off",
      SEKHEMET_MODEL_LOADS: "off",
      BROWSER: "false",
    },
  });
}

const sha = (path: string) =>
  execFileSync("shasum", ["-a", "256", path], { encoding: "utf8" }).split(" ")[0];

interface Workspace {
  root: string;
  ws: string;
  b: string;
  aId: string;
  bId: string;
  pack: string;
  evidencePath: string;
  noteId: string;
}

/**
 * A workspace folder that is project Alpha's root, and project Beta beside
 * it: a card in each, a context pack named by a step, an evidence bundle on
 * disk and in the ledger, each project's config.toml and gates.toml, and a
 * private note.
 */
async function workspace(): Promise<Workspace> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sek-backup-ws-")));
  dirs.push(root);
  const ws = gitRepo(join(root, "alpha"), "a.ts");
  const b = gitRepo(join(root, "beta"), "b.ts");
  const { db, log } = openLocalLedger(ws);
  const store = new CardStore(db, log);
  const alpha = await store.ensureProject({ rootPath: ws, name: "Alpha" });
  const beta = await registerProject(store, log, ws, { rootPath: b, name: "Beta" });
  await store.createCard({ id: "a1", tier: "story", title: "Write a", projectId: alpha.id });
  await store.createCard({ id: "b1", tier: "story", title: "Write b", projectId: beta.id });
  const blobs = new BlobStore(ws);
  const pack = blobs.put(JSON.stringify({ prompt: "the exact prompt b1's step saw" }));
  const runs = new RunLedger(db, log);
  const attempt = await runs.startAttempt({ cardId: "b1", attemptNumber: 1, modelId: "m" });
  await log.append({
    actor: "executor",
    type: "step/x",
    cardId: "b1",
    attemptId: attempt.id,
    payload: { contextPackId: pack },
  });
  const evidenceRel = join(".sekhemet", "evidence", "ev_b1.json");
  mkdirSync(join(ws, ".sekhemet", "evidence"), { recursive: true });
  writeFileSync(join(ws, evidenceRel), '{"diff":"+x"}\n');
  await runs.recordEvidence({
    id: "ev_b1",
    cardId: "b1",
    attemptId: attempt.id,
    passed: true,
    stopReason: "completed",
    path: evidenceRel,
    sha256: sha(join(ws, evidenceRel)) as string,
    filesTouched: ["src/b.ts"],
    linesAdded: 1,
    linesRemoved: 0,
  });
  const note = await log.append({
    actor: "human",
    type: "card/note",
    cardId: "b1",
    payload: {},
    private: { text: SECRET_NOTE },
  });
  db.close();
  for (const [dir, tag] of [
    [ws, "alpha"],
    [b, "beta"],
  ] as const) {
    writeFileSync(join(dir, ".sekhemet", "config.toml"), `[review]\nwip = 3 # ${tag}\n`);
    writeFileSync(join(dir, ".sekhemet", "gates.toml"), `# ${tag} gates\n`);
  }
  return {
    root,
    ws,
    b,
    aId: alpha.id,
    bId: beta.id,
    pack,
    evidencePath: evidenceRel,
    noteId: note.id,
  };
}

function openWs(ws: string): { db: DatabaseSync; log: EventLog; store: CardStore } {
  const db = new DatabaseSync(join(ws, ".sekhemet", "events.db"));
  const log = new EventLog(db);
  return { db, log, store: new CardStore(db, log) };
}

const gitClean = (dir: string) => execFileSync("git", ["clean", "-xdfq"], { cwd: dir });

describe("RUN-59, RUN-87: a set outside every repository survives `git clean -xdf`", () => {
  it("restores every board, blob, evidence bundle and configuration after git clean in each project and the workspace folder, with a later erasure re-applied", async () => {
    const w = await workspace();
    const made = sekhemet(["backup"], w.ws);
    expect(made.stderr).toBe("");
    expect(made.status).toBe(0);
    expect(made.stdout).toMatch(/Backed up the workspace through entry \d+ to /);
    const sets = listBackupSets();
    expect(sets).toHaveLength(1);
    const set = sets[0] as (typeof sets)[number];
    expect(set.path.startsWith(join(home, ".sekhemet", "backups"))).toBe(true);
    expect(set.manifest).toMatchObject({
      workspaceFolder: w.ws,
      schemaVersion: SCHEMA_VERSION,
      kind: "manual",
      writtenBy: installId(),
      projects: [
        { id: w.aId, root: w.ws },
        { id: w.bId, root: w.b },
      ],
    });
    expect((statSync(set.path).mode & 0o777).toString(8)).toBe("700");
    // The ledger records the set, with its schema.
    {
      const { db, log } = openWs(w.ws);
      const rec = (await log.getEventsByTypes(["ledger/backed_up"]))[0];
      expect(rec?.payload).toEqual({
        path: set.path,
        seq: set.manifest.seq,
        schemaVersion: SCHEMA_VERSION,
      });
      // An erasure made after the set.
      await new EventLog(db, {
        erasureRegister: erasureRegisterFor(log.workspaceId() as string),
      }).erase({ eventIds: [w.noteId], reason: "erasure", principal: log.localPrincipal() });
      db.close();
    }

    gitClean(w.ws);
    gitClean(w.b);
    expect(existsSync(join(w.ws, ".sekhemet"))).toBe(false);
    expect(existsSync(join(w.b, ".sekhemet"))).toBe(false);

    const back = sekhemet(["restore", "--latest"], w.ws);
    expect(back.stderr).toBe("");
    expect(back.status).toBe(0);
    expect(back.stdout).toContain(`Restoring the newest verified set: ${set.path}.`);
    expect(back.stdout).toMatch(/re-applied 1 erasure/);

    const { db, log, store } = openWs(w.ws);
    expect(log.verifyHashChainSync({ full: true }).valid).toBe(true);
    expect((await store.getCard("a1"))?.projectId).toBe(w.aId);
    expect((await store.getCard("b1"))?.projectId).toBe(w.bId);
    expect(log.findPrivate(SECRET_NOTE)).toEqual([]);
    expect(log.erasureOf(w.noteId)).toBeGreaterThan(0);
    db.close();
    expect(new BlobStore(w.ws).get(w.pack)).toContain("the exact prompt");
    expect(readFileSync(join(w.ws, w.evidencePath), "utf8")).toBe('{"diff":"+x"}\n');
    for (const [dir, tag] of [
      [w.ws, "alpha"],
      [w.b, "beta"],
    ] as const) {
      expect(readFileSync(join(dir, ".sekhemet", "config.toml"), "utf8")).toContain(tag);
      expect(readFileSync(join(dir, ".sekhemet", "gates.toml"), "utf8")).toContain(tag);
    }
    // Beta finds its workspace again through its locator.
    expect(readLocator(w.b)?.workspaceFolder).toBe(w.ws);
    const status = sekhemet(["status", "--json"], w.b);
    expect(status.status).toBe(0);
  });

  it("RUN-88: a project whose repository is gone is restored as repository missing, with the root it expected", async () => {
    const w = await workspace();
    expect(sekhemet(["backup"], w.ws).status).toBe(0);
    gitClean(w.ws);
    rmSync(w.b, { recursive: true, force: true });
    const back = sekhemet(["restore", "--latest"], w.ws);
    expect(back.status).toBe(0);
    expect(back.stdout).toContain(`Beta (${w.bId}): repository missing — expected at ${w.b}.`);
    expect(back.stdout).toContain(`sekhemet project move ${w.bId} <folder>`);
    expect(back.stdout).toMatch(/Alpha: restored at /);
    const { db, store } = openWs(w.ws);
    expect((await store.getCard("b1"))?.projectId).toBe(w.bId);
    // RUN-94: none of its cards starts — not from the queue, not from `run`.
    const b1 = (await store.getCard("b1")) as NonNullable<
      Awaited<ReturnType<CardStore["getCard"]>>
    >;
    const said = `Beta's repository is missing — expected at ${w.b}; name its folder with \`sekhemet project move ${w.bId} <folder>\``;
    expect(await mayStartCard({ cardStore: store }, b1)).toBe(said);
    let asked = 0;
    const standIn = {
      modelId: "stand-in",
      supportedArms: ["arm_a_flat"],
      generate: async () => {
        asked++;
        throw new Error("never asked");
      },
    } as unknown as Parameters<typeof executeCard>[2];
    const err = await executeCard(
      {
        repoPath: w.ws,
        restrictedMode: false,
        cardStore: store,
        boardService: new BoardServiceImpl(store),
        log: () => {},
        headroomCheck: false,
      },
      b1,
      standIn,
    ).catch((e: unknown) => e);
    expect(String((err as Error).message)).toBe(`${b1.id} not started: ${said}.`);
    expect(asked).toBe(0);
    expect((await store.getCard("b1"))?.status).toBe(b1.status);
    // An Alpha card is not held back by Beta's absence.
    const a1 = (await store.getCard("a1")) as NonNullable<
      Awaited<ReturnType<CardStore["getCard"]>>
    >;
    expect(await mayStartCard({ cardStore: store }, a1)).toBeUndefined();
    db.close();
  });
});

describe("RUN-61: restore --latest takes the newest set that verifies, and names it", () => {
  it("skips a newer set whose files no longer match their hashes", async () => {
    const w = await workspace();
    const { db, log } = openLocalLedger(w.ws);
    const older = await writeBackupSet({
      workspaceFolder: w.ws,
      db,
      log,
      now: new Date("2026-10-01T10:00:00"),
    });
    const newer = await writeBackupSet({
      workspaceFolder: w.ws,
      db,
      log,
      now: new Date("2026-10-02T10:00:00"),
    });
    const id = log.workspaceId() as string;
    db.close();
    expect(newestVerifiedBackup(id)?.path).toBe(newer.path);
    const blob = readdirSync(join(newer.path, "workspace", ".sekhemet", "blobs"))[0] as string;
    const dir = join(newer.path, "workspace", ".sekhemet", "blobs", blob);
    const file = join(dir, readdirSync(dir)[0] as string);
    chmodSync(file, 0o600);
    writeFileSync(file, "damaged");
    expect(newestVerifiedBackup(id)?.path).toBe(older.path);
    gitClean(w.ws);
    const back = sekhemet(["restore", "--latest"], w.ws);
    expect(back.status).toBe(0);
    expect(back.stdout).toContain(`Skipped ${newer.path}: it does not verify`);
    expect(back.stdout).toContain(`Restoring the newest verified set: ${older.path}.`);
  });

  it("`backup` and `restore` run without `dev`, and `dev backup` / `dev restore` stay aliases", async () => {
    const w = await workspace();
    expect(sekhemet(["dev", "backup"], w.ws).status).toBe(0);
    const list = sekhemet(["backup", "--list"], w.ws);
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(new RegExp(`schema ${SCHEMA_VERSION}\\b`));
    gitClean(w.ws);
    const back = sekhemet(["dev", "restore", "--latest"], w.ws);
    expect(back.status).toBe(0);
  });
});

describe("RUN-60: retention keeps 7 daily and 4 weekly sets, and deletes only this install's", () => {
  it("keeps the newest set of each of the 7 newest days and 4 newest weeks; a set another install wrote stays", async () => {
    const w = await workspace();
    const { db, log } = openLocalLedger(w.ws);
    const id = log.workspaceId() as string;
    const paths: string[] = [];
    for (let day = 0; day < 40; day++) {
      const now = new Date(2026, 8, 1 + day, 10, 0, 0);
      paths.push((await writeBackupSet({ workspaceFolder: w.ws, db, log, now })).path);
      if (day === 0) {
        // The first set is marked as another install's: never deleted.
        const m = join(paths[0] as string, "manifest.json");
        const manifest = JSON.parse(readFileSync(m, "utf8"));
        manifest.writtenBy = "inst_another";
        writeFileSync(m, JSON.stringify(manifest));
      }
    }
    db.close();
    const kept = listBackupSets(id)
      .map((s) => s.path)
      .sort();
    // Sets of Sep 1 .. Oct 10, 2026. Daily: Oct 4..10 (the 7 newest days).
    // Weekly, the newest set of the 4 newest ISO weeks: W41 Oct 10 and W40
    // Oct 4 (already daily), W39 Sep 27, W38 Sep 20. And Sep 1, which another
    // install wrote, is never deleted.
    const expected = [0, 19, 26, 33, 34, 35, 36, 37, 38, 39].map((i) => paths[i] as string).sort();
    expect(kept).toEqual(expected);
  });

  it("the daily backup runs once a calendar day, and not at all with [backup] enabled = false", async () => {
    const w = await workspace();
    const { db, log } = openLocalLedger(w.ws);
    const now = new Date("2026-10-05T09:00:00");
    const first = await dailyBackupIfDue({ workspaceFolder: w.ws, db, log, now });
    expect("path" in first).toBe(true);
    expect(await dailyBackupIfDue({ workspaceFolder: w.ws, db, log, now })).toEqual({
      skipped: "done-today",
    });
    writeFileSync(join(w.ws, ".sekhemet", "config.toml"), "[backup]\nenabled = false\n");
    expect(
      await dailyBackupIfDue({
        workspaceFolder: w.ws,
        db,
        log,
        now: new Date("2026-10-06T09:00:00"),
      }),
    ).toEqual({ skipped: "disabled" });
    db.close();
  });
});

describe("RUN-78: a register kept at the old place is carried across", () => {
  it("carries every entry once, keyed by erasure id, before a later erasure appends at the new place", async () => {
    const w = await workspace();
    const old = legacyErasureRegister(w.ws);
    mkdirSync(join(w.ws, ".sekhemet", "backups"), { recursive: true });
    const entry = (n: number) => ({
      erasureId: `evt_old${n}`,
      seq: n,
      eventIds: [],
      blobIds: [],
      reason: "erasure",
      principal: "p_x",
      at: "2026-09-01T00:00:00Z",
    });
    writeFileSync(old, `${JSON.stringify(entry(1))}\n${JSON.stringify(entry(2))}\n`);
    const { db, log } = openLocalLedger(w.ws);
    const id = log.workspaceId() as string;
    // The first erasure after the change appends at the new place, after the carry.
    await log.erase({ eventIds: [w.noteId], reason: "erasure", principal: log.localPrincipal() });
    const register = readErasureRegister(erasureRegisterFor(id)) ?? [];
    expect(register.map((e) => e.erasureId).slice(0, 2)).toEqual(["evt_old1", "evt_old2"]);
    expect(register).toHaveLength(3);
    expect(existsSync(old)).toBe(false);
    // The old file reappearing (a restore of an old .sekhemet) doubles nothing.
    writeFileSync(old, `${JSON.stringify(entry(2))}\n${JSON.stringify(entry(3))}\n`);
    const set = await writeBackupSet({ workspaceFolder: w.ws, db, log });
    db.close();
    expect(set.carried).toBe(1);
    const after = readErasureRegister(erasureRegisterFor(id)) ?? [];
    expect(after.map((e) => e.erasureId).sort()).toEqual(
      ["evt_old1", "evt_old2", "evt_old3", register[2]?.erasureId].sort(),
    );
    // Never inside a set.
    expect(readdirSync(set.path)).not.toContain("erasure-register.ndjson");
  });
});

describe("REL-18: after a rollback the refusal names the backups this build opens", () => {
  it("lists the sets by schema, and the newer-database refusal names `sekhemet restore` with a set", async () => {
    const w = await workspace();
    expect(sekhemet(["backup"], w.ws).status).toBe(0);
    const db = new DatabaseSync(join(w.ws, ".sekhemet", "events.db"));
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    const refused = sekhemet(["status"], w.ws);
    expect(refused.status).not.toBe(0);
    const text = `${refused.stdout}${refused.stderr}`;
    expect(text).toMatch(/newer than this build/);
    expect(text).toMatch(/sekhemet backup --list/);
    expect(text).toContain(`sekhemet restore ${listBackupSets()[0]?.path}`);
  });
});

describe("SPEC-02: `dev export --out <dir>` writes the projections and blobs beside the NDJSON", () => {
  it("writes ledger.ndjson, every projection, the named blobs and evidence; --no-private the NDJSON alone", async () => {
    const w = await workspace();
    const out = join(w.root, "export");
    const full = sekhemet(["dev", "export", "--out", out], w.ws);
    expect(full.stderr).toBe("");
    expect(full.status).toBe(0);
    expect(readFileSync(join(out, "ledger.ndjson"), "utf8")).toContain(SECRET_NOTE);
    const cards = readFileSync(join(out, "projections", "cards.ndjson"), "utf8");
    expect(cards).toContain('"a1"');
    expect(cards).toContain('"b1"');
    expect(existsSync(join(out, "projections", "projects.ndjson"))).toBe(true);
    expect(existsSync(join(out, "blobs", w.pack.slice(0, 2), `${w.pack}.json`))).toBe(true);
    expect(readFileSync(join(out, "evidence", "ev_b1.json"), "utf8")).toBe('{"diff":"+x"}\n');

    const bare = join(w.root, "export-bare");
    expect(sekhemet(["dev", "export", "--out", bare, "--no-private"], w.ws).status).toBe(0);
    expect(readdirSync(bare)).toEqual(["ledger.ndjson"]);
    expect(readFileSync(join(bare, "ledger.ndjson"), "utf8")).not.toContain(SECRET_NOTE);
  });

  it("leaves out an erased blob", async () => {
    const w = await workspace();
    const { db, log } = openLocalLedger(w.ws);
    await log.erase({
      eventIds: [],
      blobIds: [w.pack],
      blobs: new BlobStore(w.ws),
      reason: "secret",
      principal: log.localPrincipal(),
    });
    db.close();
    const out = join(w.root, "export-erased");
    expect(sekhemet(["dev", "export", "--out", out], w.ws).status).toBe(0);
    expect(existsSync(join(out, "blobs"))).toBe(false);
  });
});

describe("RUN-62: an emptied folder is offered its workspace back", () => {
  it("offers, and at a confirmation restores, the workspace a set names this folder for", async () => {
    const w = await workspace();
    expect(sekhemet(["backup"], w.ws).status).toBe(0);
    gitClean(w.ws);
    gitClean(w.b);
    // From a project's root, under --yes: offered, nothing restored.
    const said: string[] = [];
    const say = (l: string) => said.push(l);
    expect(await offerWorkspaceRestore(w.b, { yes: true, interactive: false, say })).toBe(
      "offered",
    );
    expect(said.join("\n")).toContain(`A backup of the workspace ${w.ws} names this folder`);
    expect(said.join("\n")).toContain("sekhemet restore --latest");
    expect(existsSync(join(w.ws, ".sekhemet", "events.db"))).toBe(false);
    // At a terminal, confirmed: the whole workspace comes back.
    const restored = await offerWorkspaceRestore(w.ws, {
      interactive: true,
      ask: async () => true,
      say,
    });
    expect(restored).toBe("restored");
    const { db, store } = openWs(w.ws);
    expect((await store.getCard("b1"))?.projectId).toBe(w.bId);
    db.close();
    // A folder no set names is offered nothing.
    const other = gitRepo(join(w.root, "gamma"), "g.ts");
    expect(await offerWorkspaceRestore(other, { interactive: false, say })).toBe("none");
  });
});

describe("NEW-security-14: the credential store per workspace", () => {
  const PASSWORD = "correct horse battery staple";

  async function teamServer(folder: string) {
    const { db, log } = openLocalLedger(folder);
    const list = join(folder, "common.txt");
    writeFileSync(list, "passwordpassword1\n");
    const { identity } = createServerIdentity(db, log, folder, {
      settings: identitySettings({ mode: "team", workspace: "Northwind" }),
      passwordList: list,
    });
    return { db, log, identity };
  }

  it("SEC-N14-1: two Team servers of one user keep their own stores and setup tokens, and one's credential signs no one in on the other", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sek-identity-")));
    dirs.push(root);
    const a = await teamServer(gitRepo(join(root, "a"), "a.ts"));
    const b = await teamServer(gitRepo(join(root, "b"), "b.ts"));
    const dirA = workspaceIdentityDir(a.db) as string;
    const dirB = workspaceIdentityDir(b.db) as string;
    expect(dirA).toBe(identityDir(a.log.workspaceId() as string));
    expect(dirB).not.toBe(dirA);
    a.identity.ensureSetupToken();
    b.identity.ensureSetupToken();
    const tokenA = readFileSync(join(dirA, "setup-token"), "utf8").trim();
    const tokenB = readFileSync(join(dirB, "setup-token"), "utf8").trim();
    expect(tokenA).not.toBe(tokenB);
    const person = { name: "Ada Admin", email: "ada@northwind.test", password: PASSWORD };
    // A's setup token does not make an Admin on B.
    expect((await b.identity.presentSetupToken(tokenA, person, "10.0.0.1")).ok).toBe(false);
    expect((await a.identity.presentSetupToken(tokenA, person, "10.0.0.1")).ok).toBe(true);
    expect((await a.identity.signIn(person.email, PASSWORD, "10.0.0.1")).ok).toBe(true);
    expect((await b.identity.signIn(person.email, PASSWORD, "10.0.0.1")).ok).toBe(false);
    // A's password hash is in A's store alone.
    const passwords = (dir: string) =>
      Object.keys(JSON.parse(readFileSync(join(dir, CREDENTIALS_FILE), "utf8")).passwords ?? {});
    expect(passwords(dirA)).toHaveLength(1);
    expect(passwords(dirB)).toEqual([]);
    a.db.close();
    b.db.close();
  });

  it("SEC-N14-2: a store at the old place moves once into the workspace whose ledger names it, modes kept, recorded for doctor", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sek-identity-move-")));
    dirs.push(root);
    const a = await teamServer(gitRepo(join(root, "a"), "a.ts"));
    a.identity.ensureSetupToken();
    const dirA = workspaceIdentityDir(a.db) as string;
    const token = readFileSync(join(dirA, "setup-token"), "utf8").trim();
    const made = await a.identity.presentSetupToken(
      token,
      { name: "Ada Admin", email: "ada@northwind.test", password: PASSWORD },
      "10.0.0.1",
    );
    if (!made.ok) throw new Error("no admin");
    a.db.close();
    // As an older build kept it: one store at the identity root.
    const legacy = identityRoot();
    const store = readFileSync(join(dirA, CREDENTIALS_FILE), "utf8");
    rmSync(dirA, { recursive: true, force: true });
    writeFileSync(join(legacy, CREDENTIALS_FILE), store, { mode: 0o600 });
    // Another workspace's server starts first: its ledger names none of it.
    const b = await teamServer(gitRepo(join(root, "b"), "b.ts"));
    workspaceIdentityDir(b.db);
    expect(existsSync(join(legacy, CREDENTIALS_FILE))).toBe(true);
    b.db.close();
    // The workspace that names it takes it, once.
    const again = openLocalLedger(join(root, "a"));
    const moved = workspaceIdentityDir(again.db) as string;
    expect(existsSync(join(legacy, CREDENTIALS_FILE))).toBe(false);
    expect(readFileSync(join(moved, CREDENTIALS_FILE), "utf8")).toBe(store);
    expect(statSync(join(moved, CREDENTIALS_FILE)).mode & 0o777).toBe(0o600);
    // Recorded in the ledger (the spine's one durable channel), once.
    expect(readIdentityMove(again.db)).toMatchObject({
      workspaceId: again.log.workspaceId(),
      from: legacy,
      to: moved,
      moved: [CREDENTIALS_FILE],
    });
    const records = await again.log.getEventsByTypes(["credentials/store_moved"]);
    expect(records).toHaveLength(1);
    expect(records[0]?.payload).toEqual({
      workspaceId: again.log.workspaceId(),
      from: legacy,
      to: moved,
      files: [CREDENTIALS_FILE],
    });
    expect(existsSync(join(legacy, "moved.json"))).toBe(false);
    workspaceIdentityDir(again.db);
    expect(await again.log.getEventsByTypes(["credentials/store_moved"])).toHaveLength(1);
    again.db.close();
  });
});

/**
 * A restore replaces the ledger file; a process that still has it open would
 * go on appending to the file moved aside, and one ledger would split in two
 * (spine rule 2). Every holder is refused: one the operating system sees
 * holding the file (a foreground `serve`, an editor's MCP server, a script),
 * a daemon a project's daemon.json names, and the runner lease's holder.
 */
describe("RUN-92: restore refuses while the Activity log is in use", () => {
  const KERNEL = pathToFileURL(
    resolve(import.meta.dirname, "../../../packages/kernel/dist/index.js"),
  ).href;
  const children: ChildProcess[] = [];
  afterEach(async () => {
    for (const c of children.splice(0)) {
      if (c.exitCode === null && c.signalCode === null) {
        const gone = new Promise((r) => c.once("exit", r));
        c.kill("SIGKILL");
        await gone;
      }
    }
  });

  /** A real second process: `script` runs as an ES module; resolves once it prints "ready". */
  async function holder(script: string): Promise<ChildProcess> {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    children.push(child);
    await new Promise<void>((ok, fail) => {
      child.stdout?.on("data", (d: Buffer) => {
        if (d.toString().includes("ready")) ok();
      });
      child.once("exit", (code) => fail(new Error(`holder exited ${code}`)));
    });
    return child;
  }

  const beforeRestoreFiles = (ws: string) =>
    readdirSync(join(ws, ".sekhemet")).filter((f) => f.includes("before-restore"));

  it("a second process appending to the ledger: `restore --latest` is refused and every append stays in the one live file", async () => {
    const w = await workspace();
    expect(sekhemet(["backup"], w.ws).status).toBe(0);
    const ledger = join(w.ws, ".sekhemet", "events.db");
    const writer = await holder(`
      import { DatabaseSync } from "node:sqlite";
      const { EventLog } = await import(${JSON.stringify(KERNEL)});
      const db = new DatabaseSync(${JSON.stringify(ledger)}, { timeout: 5000 });
      db.exec("PRAGMA journal_mode=WAL");
      const log = new EventLog(db);
      await log.append({ actor: "human", type: "card/note", cardId: "a1", payload: {} });
      console.log("ready");
      setInterval(() => { log.append({ actor: "human", type: "card/note", cardId: "a1", payload: {} }); }, 50);
    `);
    const back = sekhemet(["restore", "--latest"], w.ws);
    expect(back.status).toBe(1);
    expect(back.stderr).toMatch(/another process has the Activity log .*events\.db open/);
    expect(back.stderr).toContain("sekhemet daemon stop");
    expect(beforeRestoreFiles(w.ws)).toEqual([]);
    // The writer goes on, and what it wrote is in the file every reader opens.
    await new Promise((r) => setTimeout(r, 300));
    const gone = new Promise((r) => writer.once("exit", r));
    writer.kill("SIGKILL");
    await gone;
    const { db, log } = openWs(w.ws);
    const notes = await log.getEventsByTypes(["card/note"]);
    expect(notes.length).toBeGreaterThan(3);
    expect(log.verifyHashChainSync({ full: true }).valid).toBe(true);
    db.close();
  });

  it("a live daemon named by a project's daemon.json: refused, naming its pid and `sekhemet daemon stop`", async () => {
    const w = await workspace();
    expect(sekhemet(["backup"], w.ws).status).toBe(0);
    gitClean(w.ws);
    const daemon = await holder(`console.log("ready"); setInterval(() => {}, 1000);`);
    const pid = daemon.pid as number;
    mkdirSync(join(w.b, ".sekhemet"), { recursive: true });
    writeFileSync(
      join(w.b, ".sekhemet", "daemon.json"),
      JSON.stringify({
        pid,
        port: 4321,
        startedAt: new Date().toISOString(),
        processStart: processStartTime(pid),
        log: "x",
      }),
    );
    const back = sekhemet(["restore", "--latest"], w.ws);
    expect(back.status).toBe(1);
    expect(back.stderr).toContain(`the dashboard server (pid ${pid}, port 4321) runs in ${w.b}`);
    expect(back.stderr).toContain("sekhemet daemon stop");
    expect(existsSync(join(w.ws, ".sekhemet", "events.db"))).toBe(false);
  });

  it("the runner lease held by a live process: refused, naming the holder", async () => {
    const w = await workspace();
    expect(sekhemet(["backup"], w.ws).status).toBe(0);
    const runner = await holder(`console.log("ready"); setInterval(() => {}, 1000);`);
    const pid = runner.pid as number;
    const now = new Date().toISOString();
    writeFileSync(
      leasePath(w.ws),
      JSON.stringify({
        pid,
        processStart: processStartTime(pid),
        token: "t",
        startedAt: now,
        heartbeatAt: now,
        kind: "queue",
      }),
    );
    const back = sekhemet(["restore", "--latest"], w.ws);
    expect(back.status).toBe(1);
    expect(back.stderr).toContain(`a runner holds the lease (pid ${pid}, queue`);
    expect(beforeRestoreFiles(w.ws)).toEqual([]);
  });
});

describe("RUN-93: a restore keeps the credential store it replaces", () => {
  it("keeps a newer store at 0600 beside the ledger it moved aside, says where, and restoring that file brings both back", async () => {
    const w = await workspace();
    const { db, log } = openLocalLedger(w.ws);
    const id = log.workspaceId() as string;
    db.close();
    const dir = identityDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, CREDENTIALS_FILE), '{"passwords":{"ada":"old-hash"}}\n', {
      mode: 0o600,
    });
    expect(sekhemet(["backup"], w.ws).status).toBe(0);
    // After the set: a password change.
    writeFileSync(join(dir, CREDENTIALS_FILE), '{"passwords":{"ada":"new-hash"}}\n', {
      mode: 0o600,
    });
    const back = sekhemet(["restore", "--latest"], w.ws);
    expect(back.stderr).toBe("");
    expect(back.status).toBe(0);
    expect(readFileSync(join(dir, CREDENTIALS_FILE), "utf8")).toContain("old-hash");
    const kept = /The credential store it replaced is kept at (\S+)\.$/m.exec(
      back.stdout,
    )?.[1] as string;
    expect(kept).toBeDefined();
    const previous = /The Activity log it replaced is kept at (\S+)\.$/m.exec(
      back.stdout,
    )?.[1] as string;
    expect(kept).toBe(credentialBackupPath(previous));
    expect(readFileSync(kept, "utf8")).toContain("new-hash");
    expect(statSync(kept).mode & 0o777).toBe(0o600);
    // Undo: the kept ledger file restores the store with it.
    const undo = sekhemet(["restore", previous], w.ws);
    expect(undo.status).toBe(0);
    expect(readFileSync(join(dir, CREDENTIALS_FILE), "utf8")).toContain("new-hash");
  });

  it("after `git clean` (no ledger to move aside) keeps the newer store in the identity folder at 0600", async () => {
    const w = await workspace();
    const { db, log } = openLocalLedger(w.ws);
    const id = log.workspaceId() as string;
    db.close();
    const dir = identityDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, CREDENTIALS_FILE), '{"revoked":[]}\n', { mode: 0o600 });
    expect(sekhemet(["backup"], w.ws).status).toBe(0);
    writeFileSync(join(dir, CREDENTIALS_FILE), '{"revoked":["tok_1"]}\n', { mode: 0o600 });
    gitClean(w.ws);
    const back = sekhemet(["restore", "--latest"], w.ws);
    expect(back.status).toBe(0);
    const kept = /The credential store it replaced is kept at (\S+)\.$/m.exec(
      back.stdout,
    )?.[1] as string;
    expect(kept.startsWith(join(dir, `${CREDENTIALS_FILE}.before-restore-`))).toBe(true);
    expect(readFileSync(kept, "utf8")).toContain("tok_1");
    expect(statSync(kept).mode & 0o777).toBe(0o600);
  });

  it("keeps nothing when the store is the set's own", async () => {
    const w = await workspace();
    const { db, log } = openLocalLedger(w.ws);
    const dir = identityDir(log.workspaceId() as string);
    db.close();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, CREDENTIALS_FILE), '{"same":1}\n', { mode: 0o600 });
    expect(sekhemet(["backup"], w.ws).status).toBe(0);
    gitClean(w.ws);
    const back = sekhemet(["restore", "--latest"], w.ws);
    expect(back.status).toBe(0);
    expect(back.stdout).not.toContain("credential store it replaced");
    expect(readdirSync(dir).filter((f) => f.includes("before-restore"))).toEqual([]);
  });
});

describe("RUN-87: an erased blob never comes back from a set", () => {
  it("a blob in the set, erased after it: after `git clean` and a restore it stays erased", async () => {
    const w = await workspace();
    expect(sekhemet(["backup"], w.ws).status).toBe(0);
    const set = listBackupSets()[0] as ReturnType<typeof listBackupSets>[number];
    const inSet = join(
      set.path,
      "workspace",
      ".sekhemet",
      "blobs",
      w.pack.slice(0, 2),
      `${w.pack}.json`,
    );
    expect(existsSync(inSet)).toBe(true);
    {
      const { db, log } = openLocalLedger(w.ws);
      await log.erase({
        eventIds: [],
        blobIds: [w.pack],
        blobs: new BlobStore(w.ws),
        reason: "secret",
        principal: log.localPrincipal(),
      });
      db.close();
    }
    gitClean(w.ws);
    const back = sekhemet(["restore", "--latest"], w.ws);
    expect(back.stderr).toBe("");
    expect(back.status).toBe(0);
    expect(back.stdout).toMatch(/re-applied 1 erasure/);
    expect(existsSync(join(w.ws, ".sekhemet", "blobs", w.pack.slice(0, 2), `${w.pack}.json`))).toBe(
      false,
    );
    expect(new BlobStore(w.ws).get(w.pack)).toBeUndefined();
    // The set itself still holds it: the guard, not the set, kept it out.
    expect(existsSync(inSet)).toBe(true);
  });
});
