import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BlobStore, CardStore, EventLog, initSchema, verifyLedgerExport } from "@sekhemet/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initLocalKernel, main } from "../src/index.js";
import { checkLedgerAnchor, erasureRegisterPath, ledgerHeadTrailer } from "../src/ledger_cmds.js";
import { registerProject } from "../src/workspace_locator.js";

// kernel.md NEW-kernel-1 (K-N1-5), NEW-kernel-2 (K-N2-7), NEW-kernel-7;
// security.md NEW-security-7 (SEC-50); runtime.md NEW-runtime-8 (RUN-39,
// RUN-40, RUN-42, RUN-43, RUN-44). Real git repositories and SQLite files,
// driven through the CLI's `main`.

const EMAIL = "ada.lovelace@example.com";
const SECRET = "AKIAIOSFODNN7EXAMPLE";
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

function repo(): string {
  const r = mkdtempSync(join(tmpdir(), "sekhemet-ledger-cmds-"));
  dirs.push(r);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: r, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", EMAIL);
  git("config", "user.name", "Ada Lovelace");
  writeFileSync(join(r, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return r;
}

function output(): { lines: string[] } {
  const out = { lines: [] as string[] };
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    out.lines.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    out.lines.push(a.join(" "));
  });
  return out;
}

describe("K-N2-7: the solo install's person, with the email kept private", () => {
  it("records one principal and keeps the git email out of every structural column", async () => {
    const r = repo();
    const { db, log, cardStore } = initLocalKernel(r);
    await cardStore.createCard({ id: "card_p", tier: "task", title: "P" });
    const moved = await log.append({ actor: "human", type: "card/note_by_person", payload: {} });
    const person = (await log.getEventsByTypes(["person/created"]))[0];
    expect(person?.principal).toMatch(/^p_[0-9a-z]+$/);
    expect(person?.private).toEqual({ email: EMAIL });
    expect(moved.principal).toBe(person?.principal);
    const structural = JSON.stringify(
      db
        .prepare(
          "SELECT id, actor, type, card_id, attempt_id, step_id, payload, principal, on_behalf_of FROM events",
        )
        .all(),
    );
    expect(structural).not.toContain(EMAIL);
    expect(structural).not.toContain("Ada Lovelace");
    db.close();
    // A second open reuses the one person.
    const again = initLocalKernel(r);
    expect(await again.log.getEventsByTypes(["person/created"])).toHaveLength(1);
    again.db.close();
  });
});

describe("K-N1-5: the Ledger-Head anchor", () => {
  it("reports a truncated ledger and exits 1 from `sekhemet log`", async () => {
    const r = repo();
    const { db } = initLocalKernel(r);
    db.close();
    execFileSync(
      "git",
      ["commit", "-q", "--allow-empty", "-m", `feat: x\n\nLedger-Head: 999:${"a".repeat(64)}`],
      { cwd: r },
    );
    const out = output();
    await main(["log", "--repo", r]);
    expect(process.exitCode).toBe(1);
    expect(out.lines.join("\n")).toMatch(/truncated/i);
  });

  it("passes when the newest anchor matches the ledger, and writes the trailer's value", async () => {
    const r = repo();
    const { db, log } = initLocalKernel(r);
    await log.append({ actor: "system", type: "x", payload: {} });
    const head = ledgerHeadTrailer(r);
    const last = await log.getLastEvent();
    expect(head).toBe(`${last?.seq}:${last?.hash}`);
    db.close();
    execFileSync(
      "git",
      ["commit", "-q", "--allow-empty", "-m", `feat: y\n\nLedger-Head: ${head}`],
      {
        cwd: r,
      },
    );
    const reopened = initLocalKernel(r);
    expect(checkLedgerAnchor(r, reopened.db)).toMatchObject({ status: "ok" });
    reopened.db.close();
    output();
    await main(["log", "--repo", r]);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe("RUN-39, RUN-40: backup and restore", () => {
  it("backs up through `sekhemet dev backup`, recording ledger/backed_up with path and seq", async () => {
    const r = repo();
    const target = join(r, "..", `${r.split("/").at(-1)}-b1.db`);
    dirs.push(target);
    // A project with a ledger: backing up a folder that is none is refused (CLI-05).
    initLocalKernel(r).db.close();
    output();
    await main(["dev", "backup", target, "--repo", r]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(existsSync(target)).toBe(true);
    const { db, log } = initLocalKernel(r);
    const rec = (await log.getEventsByTypes(["ledger/backed_up"]))[0];
    const copy = new DatabaseSync(target, { readOnly: true });
    const copySeq = (copy.prepare("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s;
    copy.close();
    expect(rec?.payload).toEqual({ path: target, seq: copySeq });
    db.close();
  });

  it("restores, re-applying an erasure made after the backup, and refuses without the register", async () => {
    const r = repo();
    const { db, log } = initLocalKernel(r);
    const leaked = await log.append({
      actor: "human",
      type: "card/note",
      payload: {},
      private: { text: `key ${SECRET}` },
    });
    db.close();
    const target = join(r, ".sekhemet", "backups", "b.db");
    output();
    await main(["backup", target, "--repo", r]);
    const secretFile = join(r, "..", `${r.split("/").at(-1)}-secret.txt`);
    dirs.push(secretFile);
    writeFileSync(secretFile, `${SECRET}\n`);
    await main(["erase", "--secret-file", secretFile, "--rotated", "--repo", r]);
    expect(process.exitCode ?? 0).toBe(0);

    await main(["restore", target, "--repo", r]);
    expect(process.exitCode ?? 0).toBe(0);
    const restored = new DatabaseSync(join(r, ".sekhemet", "events.db"));
    const rlog = new EventLog(restored);
    expect(await rlog.verifyHashChain({ full: true })).toMatchObject({ valid: true });
    expect(rlog.erasureOf(leaked.id)).toBeGreaterThan(0);
    expect(rlog.findPrivate(SECRET)).toEqual([]);
    restored.close();

    rmSync(erasureRegisterPath(r));
    const out = output();
    await main(["restore", target, "--repo", r]);
    expect(process.exitCode).toBe(1);
    expect(out.lines.join("\n")).toMatch(/erasure register .* is missing/);
  });
});

describe("SEC-50: erasing a secret the scanner missed", () => {
  it("asks for rotation first and erases nothing until the person confirms it", async () => {
    const r = repo();
    const { db, log } = initLocalKernel(r);
    await log.append({ actor: "system", type: "x", payload: {}, private: { t: SECRET } });
    db.close();
    const secretFile = join(r, "..", `${r.split("/").at(-1)}-s.txt`);
    dirs.push(secretFile);
    writeFileSync(secretFile, SECRET);
    const out = output();
    await main(["erase", "--secret-file", secretFile, "--repo", r]);
    expect(process.exitCode).toBe(2);
    expect(out.lines.join("\n")).toMatch(/Rotate the secret first/);
    const again = initLocalKernel(r);
    expect(again.log.findPrivate(SECRET)).toHaveLength(1);
    again.db.close();
  });

  it("erases the private fields and every blob holding it with reason secret; the chain verifies", async () => {
    const r = repo();
    const { db, log } = initLocalKernel(r);
    const a = await log.append({ actor: "system", type: "x", payload: {}, private: { t: SECRET } });
    await log.append({ actor: "system", type: "x", payload: {}, private: { t: "clean" } });
    const blobs = new BlobStore(r);
    const pack = blobs.put(JSON.stringify({ prompt: `export KEY=${SECRET}` }));
    const clean = blobs.put(JSON.stringify({ prompt: "nothing" }));
    db.close();
    const secretFile = join(r, "..", `${r.split("/").at(-1)}-s2.txt`);
    dirs.push(secretFile);
    writeFileSync(secretFile, SECRET);
    const out = output();
    await main(["erase", "--secret-file", secretFile, "--rotated", "--repo", r]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(out.lines.join("\n")).not.toContain(SECRET);
    const after = initLocalKernel(r);
    const erased = (await after.log.getEventsByTypes(["ledger/erased"]))[0];
    expect(erased?.payload).toMatchObject({ eventIds: [a.id], blobIds: [pack], reason: "secret" });
    expect(blobs.has(pack)).toBe(false);
    expect(blobs.has(clean)).toBe(true);
    expect(await after.log.verifyHashChain({ full: true })).toMatchObject({ valid: true });
    after.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    after.db.close();
    expect(readFileSync(join(r, ".sekhemet", "events.db")).toString("latin1")).not.toContain(
      SECRET,
    );
  });
});

describe("SEC-50: a secret in a structural payload is named, not erased", () => {
  it("names the seqs whose payload holds it as not erasable, says rotation is the remedy, and exits 1", async () => {
    const r = repo();
    const { db, log } = initLocalKernel(r);
    const leaked = await log.append({ actor: "system", type: "x", payload: { note: SECRET } });
    const a = await log.append({ actor: "system", type: "x", payload: {}, private: { t: SECRET } });
    db.close();
    const secretFile = join(r, "..", `${r.split("/").at(-1)}-s3.txt`);
    dirs.push(secretFile);
    writeFileSync(secretFile, SECRET);
    const out = output();
    await main(["erase", "--secret-file", secretFile, "--rotated", "--repo", r]);
    expect(process.exitCode).toBe(1);
    const text = out.lines.join("\n");
    expect(text).not.toContain(SECRET);
    expect(text).toMatch(new RegExp(`seq ${leaked.seq}\\b[^\\n]*cannot be erased`));
    expect(text).toMatch(/rotat/i);
    const after = initLocalKernel(r);
    expect(after.log.findPrivate(SECRET).map((e) => e.id)).not.toContain(a.id);
    after.db.close();
  });

  it("names them even when no private field or blob holds the secret", async () => {
    const r = repo();
    const { db, log } = initLocalKernel(r);
    const leaked = await log.append({ actor: "system", type: "x", payload: { note: SECRET } });
    db.close();
    const secretFile = join(r, "..", `${r.split("/").at(-1)}-s4.txt`);
    dirs.push(secretFile);
    writeFileSync(secretFile, SECRET);
    const out = output();
    await main(["erase", "--secret-file", secretFile, "--rotated", "--repo", r]);
    expect(process.exitCode).toBe(1);
    expect(out.lines.join("\n")).toMatch(new RegExp(`seq ${leaked.seq}\\b[^\\n]*cannot be erased`));
  });
});

describe("K-N6-6: the migrated `human` is the install's person, with git's email", () => {
  it("records the local person with the email from git when migration 15 creates it", async () => {
    const r = repo();
    mkdirSync(join(r, ".sekhemet"), { recursive: true });
    const legacy = new DatabaseSync(join(r, ".sekhemet", "events.db"));
    initSchema(legacy);
    const store = new CardStore(legacy, new EventLog(legacy));
    await store.createCard({ id: "tmpl", tier: "task", title: "T" });
    const [created] = await store.cardEvents("tmpl", ["card/created"]);
    store.applyEvent(
      new EventLog(legacy).appendNow({
        actor: "planner",
        type: "card/created",
        cardId: "h",
        payload: { ...(created?.payload as object), id: "h", assignee: "human" },
      }) as never,
    );
    legacy.exec("PRAGMA user_version = 14");
    legacy.close();
    const { db, log, cardStore } = initLocalKernel(r);
    const persons = (await log.getEventsByTypes(["person/created"])).filter(
      (e) => (e.payload as { local?: boolean }).local === true,
    );
    expect(persons).toHaveLength(1);
    expect(persons[0]?.private).toEqual({ email: EMAIL });
    expect((await cardStore.getCard("h"))?.owner).toBe(persons[0]?.principal);
    db.close();
  });
});

describe("K-N7-8: an erased blob left behind by a crash", () => {
  it("is deleted when the ledger is next opened", async () => {
    const r = repo();
    const { db, log } = initLocalKernel(r);
    const blobs = new BlobStore(r);
    const content = JSON.stringify({ prompt: `export KEY=${SECRET}` });
    const pack = blobs.put(content);
    await log.erase({
      eventIds: [],
      blobIds: [pack],
      blobs,
      reason: "secret",
      principal: log.localPrincipal(),
    });
    blobs.put(content); // the unlink never happened
    db.close();
    const again = initLocalKernel(r);
    expect(blobs.has(pack)).toBe(false);
    again.db.close();
  });

  it("RUN-57: an erased run file a crash left on disk is deleted when the ledger is next opened", async () => {
    const r = repo();
    const { db, log } = initLocalKernel(r);
    const root = join(r, ".sekhemet");
    const file = join(root, "transcripts", "card_x-2026-01-01T00-00-00-000Z.jsonl");
    mkdirSync(join(root, "transcripts"), { recursive: true });
    writeFileSync(file, "{}");
    await log.erase({
      eventIds: [],
      files: ["transcripts/card_x-2026-01-01T00-00-00-000Z.jsonl"],
      fileRoot: root,
      reason: "retention",
      principal: log.localPrincipal(),
    });
    writeFileSync(file, "{}"); // the unlink never happened
    db.close();
    const again = initLocalKernel(r);
    expect(existsSync(file)).toBe(false);
    again.db.close();
  });
});

describe("RUN-42, RUN-43: `sekhemet dev export --ledger`", () => {
  it("writes NDJSON a verifier checks alone, and --no-private leaves every private part out", async () => {
    const r = repo();
    const { db, log } = initLocalKernel(r);
    await log.append({ actor: "system", type: "x", payload: {}, private: { t: SECRET } });
    db.close();
    const full = join(r, "..", `${r.split("/").at(-1)}-full.ndjson`);
    const bare = join(r, "..", `${r.split("/").at(-1)}-bare.ndjson`);
    dirs.push(full, bare);
    output();
    await main(["dev", "export", "--ledger", "--out", full, "--repo", r]);
    await main(["dev", "export", "--ledger", "--no-private", "--out", bare, "--repo", r]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(readFileSync(full, "utf8")).toContain(SECRET);
    expect(readFileSync(bare, "utf8")).not.toContain(SECRET);
    expect(readFileSync(bare, "utf8")).not.toContain(EMAIL);
    expect(verifyLedgerExport(readFileSync(full, "utf8")).valid).toBe(true);
    expect(verifyLedgerExport(readFileSync(bare, "utf8")).valid).toBe(true);
  });
});

describe("RUN-44: a schema newer than the harness", () => {
  it("refuses to start and names the version needed", async () => {
    const r = repo();
    const { db } = initLocalKernel(r);
    db.exec("PRAGMA user_version = 99");
    db.close();
    output();
    await expect(main(["log", "--repo", r])).rejects.toThrow(/schema version 99.*version \d+/);
  });
});

describe("NEW-kernel-12: one ledger, several projects (K-N12-2, K-N12-4)", () => {
  async function twoProjects(): Promise<{ a: string; b: string }> {
    const a = repo();
    const b = repo();
    const { db, log } = initLocalKernel(a);
    const store = new CardStore(db, log);
    const alpha = await store.ensureProject({ rootPath: a, name: "Alpha" });
    const beta = await registerProject(store, log, a, { rootPath: b, name: "Beta" });
    await store.createCard({ id: "a1", tier: "task", title: "A", projectId: alpha.id });
    await store.createCard({ id: "b1", tier: "task", title: "B", projectId: beta.id });
    await log.append({ actor: "system", type: "x", cardId: "b1", payload: { n: 1 } });
    db.close();
    return { a, b };
  }

  it("K-N12-2: both projects' events are one sequence and one chain, which one `sekhemet log` pass verifies — a change to either is caught", async () => {
    const { a, b } = await twoProjects();
    const db = new DatabaseSync(join(a, ".sekhemet", "events.db"));
    const rows = db
      .prepare(
        "SELECT e.seq, c.project_id AS project FROM events e JOIN cards c ON c.id = e.card_id ORDER BY e.seq",
      )
      .all() as { seq: number; project: string }[];
    expect(new Set(rows.map((r) => r.project)).size).toBe(2);
    db.close();
    output();
    await main(["log", "--repo", b]);
    expect(process.exitCode ?? 0).toBe(0);
    // Tamper with an event of project Beta; the pass run from Alpha's folder fails.
    const raw = new DatabaseSync(join(a, ".sekhemet", "events.db"));
    raw.exec("DROP TRIGGER IF EXISTS events_no_update");
    const tampered = raw
      .prepare("SELECT seq FROM events WHERE card_id = 'b1' AND type = 'x'")
      .get() as { seq: number };
    raw.prepare("UPDATE events SET payload = '{\"n\":2}' WHERE seq = ?").run(tampered.seq);
    raw.close();
    const out = output();
    await main(["log", "--repo", a]);
    expect(process.exitCode).toBe(1);
    expect(out.lines.join("\n")).toContain(`CORRUPTED at seq ${tampered.seq}`);
  });

  it("K-N12-4: the newest Ledger-Head anchor is read across every project's repository, whichever carried it", async () => {
    const { a, b } = await twoProjects();
    // Project Beta's merge carried the newest anchor; Alpha's repository has none.
    execFileSync(
      "git",
      ["commit", "-q", "--allow-empty", "-m", `feat: b\n\nLedger-Head: 999:${"a".repeat(64)}`],
      { cwd: b },
    );
    const { db } = initLocalKernel(a);
    expect(checkLedgerAnchor(a, db)).toMatchObject({
      status: "truncated",
      seq: 999,
      root: realpathSync(b),
    });
    db.close();
    const out = output();
    await main(["log", "--repo", a]);
    expect(process.exitCode).toBe(1);
    expect(out.lines.join("\n")).toMatch(/truncated/i);
  });
});
