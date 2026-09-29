import { describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { openDiskDb } from "./support/disk_db.js";

// teams TEAM-42 (B4.11): an issue's owner can be changed. A reader sees a
// person's issue's `assignee` as that person's principal (K-N6-6), and the
// Team setup's assignee picker sends it back as it read it, so a principal
// the ledger already knows — a person created, or a member who joined —
// names that person, never a new person called "p_…". Real SQLite files.

describe("TEAM-42: the assignee given as a known principal", () => {
  it("makes that person the owner and creates no one", async () => {
    const disk = openDiskDb("sekhemet-assignee-principal-");
    const log = new EventLog(disk.db);
    const store = new CardStore(disk.db, log);
    log.appendNow({
      actor: "system",
      type: "member/joined",
      principal: "p_member2",
      payload: { principal: "p_member2", level: "member", via: "invite", pending: false },
    });
    log.appendNow({
      actor: "system",
      type: "person/created",
      payload: { principal: "p_alice" },
      private: { name: "Alice" },
    });
    await store.createCard({ id: "c1", tier: "task", title: "One" });
    const people = () => log.getEventsByTypes(["person/created"]).then((e) => e.length);
    const before = await people();

    await store.updateCard("c1", { assignee: "p_member2" }, "human", { principal: "p_alice" });
    expect((await store.getCard("c1"))?.owner).toBe("p_member2");
    await store.updateCard("c1", { assignee: "p_alice" }, "human", { principal: "p_member2" });
    expect((await store.getCard("c1"))?.owner).toBe("p_alice");
    expect(await people()).toBe(before);

    // A name still names a person, as before.
    await store.updateCard("c1", { assignee: "alice" }, "human", { principal: "p_member2" });
    expect((await store.getCard("c1"))?.owner).toBe("p_alice");
    disk.dispose();
  });
});
