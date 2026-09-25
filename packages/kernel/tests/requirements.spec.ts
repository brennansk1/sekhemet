import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// kernel.md rule 36, NEW-kernel-8: requirement versions and suspect links
// (K-N8-1, K-N8-2). Real SQLite files.

describe("requirement versions and suspect links (K-N8-1, K-N8-2)", () => {
  let disk: DiskDb;
  let log: EventLog;
  let store: CardStore;
  beforeEach(async () => {
    disk = openDiskDb("sekhemet-reqs-");
    log = new EventLog(disk.db);
    store = new CardStore(disk.db, log);
    await store.createCard({ id: "c1", tier: "task", title: "Show results" });
    await store.createCard({ id: "c2", tier: "task", title: "Load data" });
  });
  afterEach(() => disk.dispose());

  it("K-N8-1: a revision appends requirement/revised and marks earlier-version links suspect", async () => {
    const reqs = store.requirements;
    const r = await reqs.create({ title: "Show results" }, "p_owner");
    expect(r).toEqual({ id: "REQ-1", version: 1 });
    await reqs.link({ requirementId: r.id, from: "card", ref: "c1" });
    await reqs.link({ requirementId: r.id, from: "test", ref: "tests/show.test.ts > shows rows" });
    expect(reqs.links(r.id).every((l) => !l.suspect)).toBe(true);

    await reqs.revise(r.id, { title: "Show results, paged" }, "p_owner");
    const [revised] = await log.getEventsByTypes(["requirement/revised"]);
    expect(revised?.payload).toEqual({ id: "REQ-1", version: 2 });
    expect(JSON.stringify(revised?.payload)).not.toContain("paged");
    const links = reqs.links(r.id);
    expect(links).toHaveLength(2);
    expect(links.every((l) => l.suspect && l.version === 1)).toBe(true);
    // A link made after the revision is not suspect.
    await reqs.link({ requirementId: r.id, from: "card", ref: "c2" });
    expect(reqs.links(r.id).find((l) => l.ref === "c2")?.suspect).toBe(false);
  });

  it("K-N8-2: suspect until a principal confirms it or the card is superseded; ids never reused", async () => {
    const reqs = store.requirements;
    const r = await reqs.create({ title: "Load data" }, "p_owner");
    await reqs.link({ requirementId: r.id, from: "card", ref: "c1" });
    await reqs.link({ requirementId: r.id, from: "card", ref: "c2" });
    await reqs.revise(r.id, { title: "Load data from CSV" }, "p_owner");
    // Re-linking by the machine does not clear it; only a principal's confirmation does.
    await expect(
      reqs.confirm({ requirementId: r.id, from: "card", ref: "c1" }, undefined as never),
    ).rejects.toThrow(/principal/);
    await reqs.confirm({ requirementId: r.id, from: "card", ref: "c1" }, "p_owner");
    const [confirmed] = await log.getEventsByTypes(["trace/confirmed"]);
    expect(confirmed?.principal).toBe("p_owner");
    expect(reqs.links(r.id).find((l) => l.ref === "c1")?.suspect).toBe(false);
    // The linked card superseded (rejected): no longer suspect.
    expect(reqs.links(r.id).find((l) => l.ref === "c2")?.suspect).toBe(true);
    await store.updateCardStatus("c2", "rejected", "superseded by c1", "human");
    expect(reqs.links(r.id).find((l) => l.ref === "c2")?.suspect).toBe(false);

    // An id used before is never used again, not even one given explicitly.
    await expect(reqs.create({ id: "REQ-1", title: "Again" }, "p_owner")).rejects.toThrow(
      /REQ-1.*used/,
    );
    expect((await reqs.create({ title: "Next" }, "p_owner")).id).toBe("REQ-2");
    // The state is read from the ledger: a second store over a new connection agrees.
    const db2 = new DatabaseSync(disk.path);
    const other = new CardStore(db2, new EventLog(db2));
    expect(other.requirements.links(r.id)).toEqual(reqs.links(r.id));
    db2.close();
  });
});
