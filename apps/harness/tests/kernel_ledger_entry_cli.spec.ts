import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BlobStore, CardStore, EventLog, SCHEMA_VERSION, initSchema } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { type Place, cliEnv, place } from "./support/cli_spawn.js";

/**
 * The ledger's invariants reached the way a person reaches them (C2d,
 * FINDINGS_C1 TST-01; kernel.md rules 8, 33–35, 38): the built command
 * (`apps/harness/dist/index.js`) spawned in a real git repository over a
 * real SQLite ledger — `log`, `backup`, `restore`, `erase` — with the file
 * edited directly in SQLite where a criterion is about tampering, and the
 * schema fixtures an earlier build wrote (`packages/kernel/tests/fixtures/
 * schemas`) where it is about migration. No model is loaded.
 */

/** The built command, as a person runs it. */
const BIN = resolve(import.meta.dirname, "../dist/index.js");

/** `sekhemet <args>` spawned in the repository; resolves with its exit code and output. */
function sekhemet(args: string[], p: Place): { exited: Promise<number | null>; out: () => string } {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: p.repo,
    env: cliEnv(p),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  child.stdout.on("data", (d: Buffer) => {
    text += d.toString("utf8");
  });
  child.stderr.on("data", (d: Buffer) => {
    text += d.toString("utf8");
  });
  const exited = new Promise<number | null>((r) => child.once("close", (code) => r(code)));
  return { exited, out: () => text };
}

async function runCli(args: string[], p: Place): Promise<{ code: number | null; out: string }> {
  const s = sekhemet(args, p);
  const code = await s.exited;
  return { code, out: s.out() };
}

const FIXTURES = resolve(import.meta.dirname, "../../../packages/kernel/tests/fixtures/schemas");
const EMAIL = "grace.hopper@example.com";

/** A real repository, committed once, with the person's git identity. */
function repo(prefix: string): Place {
  const p = place(prefix);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: p.repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", EMAIL);
  git("config", "user.name", "Grace Hopper");
  writeFileSync(join(p.repo, "README.md"), "# Timesheets\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return p;
}

const ledgerPath = (p: Place) => join(p.repo, ".sekhemet", "events.db");

/**
 * `repo()` made a Sekhemet project: its ledger opened as the ledger commands
 * open it (`openLocalLedger`: the schema, the workspace and the install's
 * person from git's email). `log`, `erase` and the others refuse a folder
 * that is no project yet (FINDINGS_C1 CLI-05; surface.md).
 */
function project(prefix: string): Place {
  const p = repo(prefix);
  openLocalLedger(p.repo).db.close();
  return p;
}

/** A schema fixture an earlier build wrote, as this repository's ledger. */
function withFixture(p: Place, name: string): string {
  mkdirSync(join(p.repo, ".sekhemet"), { recursive: true });
  copyFileSync(join(FIXTURES, `${name}.db`), ledgerPath(p));
  return ledgerPath(p);
}

/** Run SQL on the ledger file directly, as a person with `sqlite3` would. */
function sql<T = Record<string, unknown>>(file: string, query: string, ...args: unknown[]): T[] {
  const db = new DatabaseSync(file);
  try {
    const st = db.prepare(query);
    if (/^\s*(select|pragma)/i.test(query)) return st.all(...(args as never[])) as T[];
    st.run(...(args as never[]));
    return [];
  } finally {
    db.close();
  }
}

/** Drop the append-only triggers, as someone editing the file would, to tamper with it. */
function tamper(file: string, statement: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(
      "DROP TRIGGER IF EXISTS events_no_update; DROP TRIGGER IF EXISTS event_private_no_update",
    );
    db.exec(statement);
  } finally {
    db.close();
  }
}

/** Every file under `dir` holding `needle`, read as bytes. */
function filesHolding(dir: string, needle: string): string[] {
  if (!existsSync(dir)) return [];
  if (!statSync(dir).isDirectory())
    return readFileSync(dir).includes(Buffer.from(needle)) ? [dir] : [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((f) => join(dir, f))
    .filter((f) => {
      try {
        return readFileSync(f).includes(Buffer.from(needle));
      } catch {
        return false; // a folder
      }
    });
}

describe("the hash chain through `sekhemet log` (K-N1, K-N10)", () => {
  it("K-N1-1: a row's created_at edited in SQLite makes `log` report the chain corrupted at that seq and exit 1", async () => {
    const p = project("sek-k-n1-1-");
    expect((await runCli(["log"], p)).code).toBe(0);
    tamper(ledgerPath(p), "UPDATE events SET created_at = '2001-01-01 00:00:00' WHERE seq = 2");
    const after = await runCli(["log"], p);
    expect(after.code).toBe(1);
    expect(after.out).toContain("CORRUPTED at seq 2");
  });

  it("K-N1-2: an UPDATE or DELETE of a row the command wrote is aborted, and `log` still verifies", async () => {
    const p = project("sek-k-n1-2-");
    expect((await runCli(["log"], p)).code).toBe(0);
    const db = new DatabaseSync(ledgerPath(p));
    try {
      expect(() => db.exec("UPDATE events SET payload = '{}' WHERE seq = 1")).toThrow(
        /append-only/,
      );
      expect(() => db.exec("DELETE FROM events WHERE seq = 2")).toThrow(/append-only/);
      expect(() => db.exec("UPDATE event_private SET body = '{}'")).toThrow(/never altered/);
    } finally {
      db.close();
    }
    const after = await runCli(["log"], p);
    expect(after.code).toBe(0);
    expect(after.out).toContain("VALID (100% Intact)");
  });

  it("K-N1-4: a ledger an earlier build wrote under the v2 formula, extended by this build under v3, verifies row by row", async () => {
    const p = repo("sek-k-n1-4-");
    const file = withFixture(p, "legacy-pre-migrations");
    const run = await runCli(["log"], p);
    expect(run.code).toBe(0);
    expect(run.out).toContain("VALID (100% Intact)");
    // Both formulas are in the file: the old rows unversioned (v2), this build's v3.
    const versions = sql<{ v: number | null; n: number }>(
      file,
      "SELECT hash_version AS v, COUNT(*) AS n FROM events GROUP BY hash_version ORDER BY v",
    ).map((r) => ({ ...r }));
    expect(versions).toEqual([
      { v: null, n: 11 },
      { v: 3, n: expect.any(Number) },
    ]);
  });

  it("K-N1-7: an event_private row altered (not deleted) in SQLite makes `log` report the chain corrupted at that event's seq", async () => {
    const p = project("sek-k-n1-7-");
    expect((await runCli(["log"], p)).code).toBe(0);
    // The install's person, recorded with git's email in its private part.
    const [person] = sql<{ seq: number; id: string }>(
      ledgerPath(p),
      "SELECT e.seq, e.id FROM events e JOIN event_private p ON p.event_id = e.id WHERE e.type = 'person/created'",
    );
    expect(person).toBeDefined();
    tamper(
      ledgerPath(p),
      `UPDATE event_private SET body = '{"email":"someone.else@example.com"}' WHERE event_id = '${person?.id}'`,
    );
    const after = await runCli(["log"], p);
    expect(after.code).toBe(1);
    expect(after.out).toContain(`CORRUPTED at seq ${person?.seq}`);
  });

  it("K-N10-2: a stored event's on_behalf_of edited in SQLite makes `log` report the chain corrupted at that seq", async () => {
    const p = project("sek-k-n10-2-");
    expect((await runCli(["log"], p)).code).toBe(0);
    tamper(ledgerPath(p), "UPDATE events SET on_behalf_of = 'p_someone' WHERE seq = 2");
    const after = await runCli(["log"], p);
    expect(after.code).toBe(1);
    expect(after.out).toContain("CORRUPTED at seq 2");
  });
});

describe("migrations when the command opens an older ledger (K-N4)", () => {
  it("K-N4-1, K-N4-5: a ledger at user_version 0 is migrated to the current version, a backup written first, and the chain verified after", async () => {
    const p = repo("sek-k-n4-1-");
    const file = withFixture(p, "legacy-pre-migrations");
    expect(sql(file, "PRAGMA user_version")).toEqual([{ user_version: 0 }]);
    const run = await runCli(["log"], p);
    expect(run.code).toBe(0);
    expect(sql(file, "PRAGMA user_version")).toEqual([{ user_version: SCHEMA_VERSION }]);
    // K-N4-5: the backup was written before migrating, beside the database.
    const backups = readdirSync(join(p.repo, ".sekhemet", "backups"));
    expect(backups).toEqual([
      expect.stringMatching(new RegExp(`^pre-migration-v0-to-v${SCHEMA_VERSION}-`)),
    ]);
    // The backup is the database as it was: still at version 0, all eleven events.
    const copy = join(p.repo, ".sekhemet", "backups", backups[0] as string);
    expect(sql(copy, "PRAGMA user_version")).toEqual([{ user_version: 0 }]);
    expect(sql(copy, "SELECT COUNT(*) AS n FROM events")).toEqual([{ n: 11 }]);
    expect(run.out).toContain("VALID (100% Intact)");
  });

  it("K-N4-5: a ledger whose chain is invalid once migrated is refused, naming the backup written before the migration", async () => {
    const p = repo("sek-k-n4-5-");
    const file = withFixture(p, "legacy-pre-migrations");
    // An old row altered before this build ever opened it (the old file had no triggers).
    sql(
      file,
      "UPDATE events SET payload = replace(payload, 'Record a shift', 'Record a shaft') WHERE seq = 3",
    );
    const run = await runCli(["log"], p);
    expect(run.code).toBe(1);
    expect(run.out).toContain(
      "refusing to serve this ledger: its hash chain is invalid after migrating",
    );
    expect(run.out).toContain("Hash mismatch at seq 3");
    expect(run.out).toContain("the backup before the migration is");
    expect(readdirSync(join(p.repo, ".sekhemet", "backups"))).toHaveLength(1);
    // Nothing was appended to the refused ledger.
    expect(sql(file, "SELECT COUNT(*) AS n FROM events")).toEqual([{ n: 11 }]);
  });

  it("K-N4-2: a ledger whose user_version is above this build's is refused, the message naming both versions", async () => {
    const p = repo("sek-k-n4-2-");
    const file = withFixture(p, "v21-previous-release");
    sql(file, `PRAGMA user_version = ${SCHEMA_VERSION + 7}`);
    const run = await runCli(["log"], p);
    expect(run.code).toBe(1);
    expect(run.out).toContain(
      `schema version ${SCHEMA_VERSION + 7}, newer than this build's version ${SCHEMA_VERSION}`,
    );
    expect(sql(file, "SELECT COUNT(*) AS n FROM events")).toEqual([{ n: 9 }]);
  });

  it("K-N4-3: migrating an old cards table keeps a column that holds a value, with its value", async () => {
    const p = repo("sek-k-n4-3-");
    const file = withFixture(p, "legacy-pre-migrations");
    sql(file, "ALTER TABLE cards ADD COLUMN reviewer_note TEXT");
    sql(file, "UPDATE cards SET reviewer_note = 'keep me' WHERE id = 'card_a'");
    await runCli(["log"], p);
    expect(sql(file, "PRAGMA user_version")).toEqual([{ user_version: SCHEMA_VERSION }]);
    expect(
      sql(file, "SELECT id, reviewer_note FROM cards WHERE reviewer_note IS NOT NULL").map((r) => ({
        ...r,
      })),
    ).toEqual([{ id: "card_a", reviewer_note: "keep me" }]);
  });
});

describe("the legacy assignee when the command migrates a ledger (K-N6-6)", () => {
  it("K-N6-6: `worker` becomes the Worker delegate, `human` the install's person as owner, a name that person's principal; replay agrees", async () => {
    const p = repo("sek-k-n6-6-");
    // A ledger as builds before migration 15 left it: cards whose card/created named an assignee.
    mkdirSync(join(p.repo, ".sekhemet"), { recursive: true });
    const legacy = new DatabaseSync(ledgerPath(p));
    initSchema(legacy);
    const store = new CardStore(legacy, new EventLog(legacy));
    await store.createCard({ id: "tmpl", tier: "task", title: "T" });
    const [created] = await store.cardEvents("tmpl", ["card/created"]);
    for (const [id, assignee] of [
      ["c_worker", "worker"],
      ["c_human", "human"],
      ["c_named", "Ada Lovelace"],
    ] as const) {
      store.applyEvent(
        new EventLog(legacy).appendNow({
          actor: "planner",
          type: "card/created",
          cardId: id,
          payload: { ...(created?.payload as object), id, assignee },
        }) as never,
      );
    }
    legacy.exec("PRAGMA user_version = 14");
    legacy.close();
    const run = await runCli(["log"], p);
    expect(run.code).toBe(0);
    expect(run.out).toContain("VALID (100% Intact)");
    expect(run.out).toMatch(/Projections: rebuilt from \d+ events, byte-identical\./);
    const cards = Object.fromEntries(
      sql<{ id: string; owner: string | null; delegate: string | null }>(
        ledgerPath(p),
        "SELECT id, owner, delegate FROM cards WHERE id LIKE 'c_%'",
      ).map((c) => [
        c.id,
        { owner: c.owner, delegate: c.delegate ? JSON.parse(c.delegate) : null },
      ]),
    );
    const local = sql<{ principal: string; payload: string }>(
      ledgerPath(p),
      "SELECT principal, payload FROM events WHERE type = 'person/created'",
    );
    const me = local.find((e) => JSON.parse(e.payload).local === true)?.principal;
    const ada = local.find((e) => JSON.parse(e.payload).local !== true)?.principal;
    expect(me).toMatch(/^p_/);
    expect(ada).toMatch(/^p_/);
    expect(cards.c_worker).toEqual({ owner: null, delegate: { kind: "worker" } });
    expect(cards.c_human).toEqual({ owner: me, delegate: null });
    expect(cards.c_named).toEqual({ owner: ada, delegate: null });
  });
});

describe("erasure, backup and restore through the commands (K-N7)", () => {
  it("K-N7-1, K-N7-2, K-N7-3, K-N7-7: `erase --secret-file --rotated` removes the private part holding the secret from the file, records ledger/erased and the register, and `log` names the gap", async () => {
    const p = project("sek-k-n7-1-");
    expect((await runCli(["log"], p)).code).toBe(0);
    expect(filesHolding(join(p.repo, ".sekhemet"), EMAIL).length).toBeGreaterThan(0);
    const secret = join(p.root, "secret.txt");
    writeFileSync(secret, `${EMAIL}\n`);
    // Rotation first: nothing happens until the person confirms it.
    const asked = await runCli(["erase", "--secret-file", secret], p);
    expect(asked.code).toBe(2);
    expect(asked.out).toContain("Rotate the secret first");
    expect(
      sql(ledgerPath(p), "SELECT COUNT(*) AS n FROM events WHERE type = 'ledger/erased'"),
    ).toEqual([{ n: 0 }]);
    const erased = await runCli(["erase", "--secret-file", secret, "--rotated"], p);
    expect(erased.code).toBe(0);
    const m = erased.out.match(
      /Erased the secret from 1 event and 0 blobs \(ledger\/erased seq (\d+)\)\. Chain: valid\./,
    );
    expect(m).not.toBeNull();
    const erasedSeq = Number(m?.[1]);
    // K-N7-7: the needle is never written out — not to the output, the ledger or any file.
    expect(erased.out).not.toContain(EMAIL);
    expect(filesHolding(join(p.repo, ".sekhemet"), EMAIL)).toEqual([]);
    // K-N7-1: the private row is gone, ledger/erased names it, the register lists it.
    const [person] = sql<{ seq: number; id: string }>(
      ledgerPath(p),
      "SELECT seq, id FROM events WHERE type = 'person/created'",
    );
    expect(
      sql(ledgerPath(p), "SELECT COUNT(*) AS n FROM event_private WHERE event_id = ?", person?.id),
    ).toEqual([{ n: 0 }]);
    const [record] = sql<{ payload: string; principal: string }>(
      ledgerPath(p),
      "SELECT payload, principal FROM events WHERE seq = ?",
      erasedSeq,
    );
    expect(JSON.parse(record?.payload ?? "{}")).toMatchObject({
      eventIds: [person?.id],
      reason: "secret",
    });
    expect(record?.principal).toMatch(/^p_/);
    const registers = filesHolding(join(p.home, ".sekhemet", "backups"), String(person?.id)).filter(
      (f) => f.endsWith("erasure-register.ndjson"),
    );
    expect(registers).toHaveLength(1);
    expect(readFileSync(registers[0] as string, "utf8")).toContain(`"seq":${erasedSeq}`);
    // K-N7-2, K-N7-3: the chain is valid, the gap is named, and the projections rebuild identically.
    const log = await runCli(["log"], p);
    expect(log.code).toBe(0);
    expect(log.out).toContain("VALID (100% Intact)");
    expect(log.out).toContain(`erased at seq ${person?.seq} by ledger/erased seq ${erasedSeq}`);
    expect(log.out).toMatch(/Projections: rebuilt from \d+ events, byte-identical\./);
  });

  it("K-N7-8: an erasure naming a blob deletes it, lists it in ledger/erased, and `log` reads it as erased, not missing", async () => {
    const p = project("sek-k-n7-8-");
    expect((await runCli(["log"], p)).code).toBe(0);
    // A context pack the Worker stored, holding the secret (setup, as a run leaves it).
    const SECRET = "AKIAIOSFODNN7EXAMPLE";
    const blobs = new BlobStore(p.repo);
    const pack = blobs.put(JSON.stringify({ prompt: `export KEY=${SECRET}` }));
    const secret = join(p.root, "secret.txt");
    writeFileSync(secret, SECRET);
    const erased = await runCli(["erase", "--secret-file", secret, "--rotated"], p);
    expect(erased.code).toBe(0);
    expect(erased.out).toMatch(
      /Erased the secret from 0 events and 1 blob \(ledger\/erased seq \d+\)/,
    );
    expect(blobs.has(pack)).toBe(false);
    const [record] = sql<{ payload: string }>(
      ledgerPath(p),
      "SELECT payload FROM events WHERE type = 'ledger/erased'",
    );
    expect(JSON.parse(record?.payload ?? "{}").blobIds).toEqual([pack]);
    const log = await runCli(["log"], p);
    expect(log.code).toBe(0);
    expect(log.out).toMatch(/Projections: rebuilt from \d+ events, byte-identical\./);
    expect(filesHolding(join(p.repo, ".sekhemet"), SECRET)).toEqual([]);
  });

  it("K-N7-4: `backup <path>` taken while another writer appends is a consistent copy that verifies, and records ledger/backed_up", async () => {
    const p = project("sek-k-n7-4-");
    expect((await runCli(["log"], p)).code).toBe(0);
    // A second writer on the same file, appending the whole time the backup runs.
    const db = new DatabaseSync(ledgerPath(p));
    initSchema(db);
    const writer = new EventLog(db);
    let appended = 0;
    let stop = false;
    const loop = (async () => {
      while (!stop) {
        await writer.append({ actor: "human", type: "card/note_by_person", payload: {} });
        appended++;
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    const target = join(p.root, "copy.db");
    const run = sekhemet(["backup", target], p);
    const code = await run.exited;
    stop = true;
    await loop;
    db.close();
    expect(code).toBe(0);
    const m = run
      .out()
      .match(/Backed up the Activity log through entry (\d+) to .* \(verified\)\./);
    expect(m).not.toBeNull();
    expect(appended).toBeGreaterThan(0);
    // The copy verifies on its own and holds the events through the seq it names.
    const copy = new DatabaseSync(target, { readOnly: true });
    try {
      expect(new EventLog(copy).verifyHashChainSync({ full: true })).toMatchObject({ valid: true });
      const last = (copy.prepare("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s;
      expect(last).toBeGreaterThanOrEqual(Number(m?.[1]));
    } finally {
      copy.close();
    }
    const [backedUp] = sql<{ payload: string }>(
      ledgerPath(p),
      "SELECT payload FROM events WHERE type = 'ledger/backed_up'",
    );
    expect(JSON.parse(backedUp?.payload ?? "{}")).toMatchObject({ seq: Number(m?.[1]) });
    expect(JSON.parse(backedUp?.payload ?? "{}").path).toContain("copy.db");
    expect((await runCli(["log"], p)).out).toContain("VALID (100% Intact)");
  });

  it("K-N7-5: `restore --latest` re-applies an erasure made after the backup before anything reads it, and refuses when the register is missing", async () => {
    const p = project("sek-k-n7-5-");
    expect((await runCli(["log"], p)).code).toBe(0);
    const backup = await runCli(["backup"], p);
    expect(backup.code).toBe(0);
    // The set holds the email; the erasure comes after it.
    const secret = join(p.root, "secret.txt");
    writeFileSync(secret, EMAIL);
    expect((await runCli(["erase", "--secret-file", secret, "--rotated"], p)).code).toBe(0);
    const restored = await runCli(["restore", "--latest"], p);
    expect(restored.code).toBe(0);
    expect(restored.out).toContain(
      "re-applied 1 erasure from the register before anything read it",
    );
    // The restored ledger does not hold the erased email, though the set it came from does.
    expect(filesHolding(ledgerPath(p), EMAIL)).toEqual([]);
    expect(filesHolding(`${ledgerPath(p)}-wal`, EMAIL)).toEqual([]);
    expect(filesHolding(join(p.home, ".sekhemet", "backups"), EMAIL).length).toBeGreaterThan(0);
    const log = await runCli(["log"], p);
    expect(log.out).toContain("VALID (100% Intact)");
    // Without the register, a restore that knows of an erasure refuses and says why.
    const register = filesHolding(join(p.home, ".sekhemet", "backups"), "erasureId").find((f) =>
      f.endsWith("erasure-register.ndjson"),
    ) as string;
    expect(register).toBeDefined();
    copyFileSync(register, `${register}.moved`);
    execFileSync("rm", [register]);
    const refused = await runCli(["restore", "--latest"], p);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("Refusing to restore");
    expect(refused.out).toContain("is missing — restoring without it could bring erased data back");
  });
});
