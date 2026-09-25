import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { SCHEMA_VERSION, initSchema } from "../src/schema.js";
import type { EventRecord } from "../src/types.js";
import { openDiskDb } from "./support/disk_db.js";

// kernel.md NEW-kernel-6, K-N6-6: the legacy `assignee` string is mapped to
// the owner and delegate on migration, replayably, and no longer written.
// Real SQLite files.

describe("K-N6-6: the legacy assignee", () => {
  it("maps worker, human and a person's name on migration; replay agrees", async () => {
    const disk = openDiskDb("sekhemet-assignee-");
    const log = new EventLog(disk.db);
    const store = new CardStore(disk.db, log);
    const local = log.ensureLocalPerson({ email: "me@example.com" });
    log.appendNow({
      actor: "system",
      type: "person/created",
      payload: { principal: "p_alice" },
      private: { name: "Alice" },
    });
    await store.createCard({ id: "tmpl", tier: "task", title: "Template" });
    const [created] = await store.cardEvents("tmpl", ["card/created"]);
    // Cards written by an older build, which stored `assignee`.
    for (const [id, assignee] of [
      ["w", "worker"],
      ["h", "human"],
      ["a", "alice"],
      ["b", "Bob"],
    ] as const) {
      const payload = { ...(created?.payload as object), id, assignee };
      store.applyEvent(
        log.appendNow({
          actor: "planner",
          type: "card/created",
          cardId: id,
          payload,
        }) as EventRecord,
      );
    }
    expect((await store.getCard("w"))?.assignee).toBe("worker");
    disk.db.exec("PRAGMA user_version = 14");
    disk.close();

    const db = new DatabaseSync(disk.path);
    const report = initSchema(db, { backupDir: dirname(disk.path) });
    expect(report.applied).toContain(15);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(15);
    const again = new CardStore(db, new EventLog(db));
    expect((await again.getCard("w"))?.delegate).toEqual({ kind: "worker" });
    expect((await again.getCard("h"))?.owner).toBe(local);
    expect((await again.getCard("a"))?.owner).toBe("p_alice");
    // A name no person carries becomes a person, with the name off the chain.
    const bob = (await again.getCard("b"))?.owner;
    expect(bob).toMatch(/^p_[0-9a-z]+$/);
    const [bobPerson] = (await new EventLog(db).getEventsByTypes(["person/created"])).filter(
      (e) => e.principal === bob,
    );
    expect(bobPerson?.private).toEqual({ name: "Bob" });
    expect(JSON.stringify(bobPerson?.payload)).not.toContain("Bob");
    expect((await again.verifyProjections()).identical).toBe(true);
    expect((await new EventLog(db).verifyHashChain()).valid).toBe(true);
    db.close();
    disk.dispose();
  });

  it("no longer writes the assignee column; a given assignee becomes the delegate or owner", async () => {
    const disk = openDiskDb("sekhemet-assignee-new-");
    const log = new EventLog(disk.db);
    const store = new CardStore(disk.db, log);
    await store.createCard({ id: "n", tier: "task", title: "New", assignee: "worker" });
    const row = disk.db.prepare("SELECT assignee, delegate FROM cards WHERE id = 'n'").get() as {
      assignee: string | null;
      delegate: string | null;
    };
    expect(row.assignee).toBeNull();
    expect(JSON.parse(row.delegate ?? "null")).toEqual({ kind: "worker" });
    await store.updateCard("n", { assignee: "human" });
    const after = disk.db.prepare("SELECT assignee, owner FROM cards WHERE id = 'n'").get() as {
      assignee: string | null;
      owner: string | null;
    };
    expect(after.assignee).toBeNull();
    expect(after.owner).toBe(log.localPrincipal());
    expect((await store.verifyProjections()).identical).toBe(true);
    disk.dispose();
  });
});

describe("rule 19: the solo install's person is only the local person record", () => {
  it("migrating a legacy ledger holding bob and `human` creates the local person, with git's email, never adopting bob", async () => {
    const disk = openDiskDb("sekhemet-assignee-bob-");
    const log = new EventLog(disk.db);
    const store = new CardStore(disk.db, log);
    // The ledger's earliest principal is a named person, not the install's.
    log.appendNow({
      actor: "system",
      type: "person/created",
      payload: { principal: "p_bob" },
      principal: "p_bob",
      private: { name: "bob" },
    });
    await store.createCard({ id: "tmpl", tier: "task", title: "Template" });
    const [created] = await store.cardEvents("tmpl", ["card/created"]);
    for (const [id, assignee] of [
      ["h", "human"],
      ["b", "bob"],
    ] as const) {
      store.applyEvent(
        log.appendNow({
          actor: "planner",
          type: "card/created",
          cardId: id,
          payload: { ...(created?.payload as object), id, assignee },
        }) as EventRecord,
      );
    }
    disk.db.exec("PRAGMA user_version = 14");
    disk.close();

    const db = new DatabaseSync(disk.path);
    initSchema(db, { backupDir: dirname(disk.path), localPerson: { email: "me@example.com" } });
    const again = new CardStore(db, new EventLog(db));
    const human = (await again.getCard("h"))?.owner;
    expect(human).toMatch(/^p_[0-9a-z]+$/);
    expect(human).not.toBe("p_bob");
    expect((await again.getCard("b"))?.owner).toBe("p_bob");
    const [local] = (await new EventLog(db).getEventsByTypes(["person/created"])).filter(
      (e) => (e.payload as { local?: boolean }).local === true,
    );
    expect(local?.principal).toBe(human);
    expect(local?.private).toEqual({ email: "me@example.com" });
    expect(new EventLog(db).localPrincipal()).toBe(human);
    expect((await again.verifyProjections()).identical).toBe(true);
    expect((await new EventLog(db).verifyHashChain()).valid).toBe(true);
    db.close();
    disk.dispose();
  });

  it("an append for the install's person on a ledger whose first principal is bob records a new local person", async () => {
    const disk = openDiskDb("sekhemet-solo-bob-");
    const log = new EventLog(disk.db);
    log.appendNow({
      actor: "system",
      type: "person/created",
      payload: { principal: "p_bob" },
      principal: "p_bob",
      private: { name: "bob" },
    });
    const moved = await log.append({ actor: "human", type: "x/by_person", payload: {} });
    expect(moved.principal).toMatch(/^p_[0-9a-z]+$/);
    expect(moved.principal).not.toBe("p_bob");
    const locals = (await log.getEventsByTypes(["person/created"])).filter(
      (e) => (e.payload as { local?: boolean }).local === true,
    );
    expect(locals.map((e) => e.principal)).toEqual([moved.principal]);
    // Stable across a second log over the same database.
    expect(new EventLog(disk.db).localPrincipal()).toBe(moved.principal);
    expect((await log.verifyHashChain()).valid).toBe(true);
    disk.dispose();
  });
});
