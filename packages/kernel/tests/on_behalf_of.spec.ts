import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// kernel.md NEW-kernel-10, K-N10-1: the Worker's events name the person who
// delegated the card to it in `on_behalf_of`, never as `principal`. Real SQLite.

describe("K-N10-1: on_behalf_of on the Worker's events", () => {
  let disk: DiskDb;
  let log: EventLog;
  let store: CardStore;
  beforeEach(async () => {
    disk = openDiskDb("sekhemet-obo-");
    log = new EventLog(disk.db);
    store = new CardStore(disk.db, log);
    await store.createCard({ id: "c", tier: "task", title: "C" });
  });
  afterEach(() => disk.dispose());

  it("stores the delegating principal on the Worker's events and leaves principal null", async () => {
    // Before any delegation by a person: no on_behalf_of.
    await store.recordDossierEntry({ cardId: "c", kind: "question", text: "Which?" });
    const [q0] = await store.cardEvents("c", ["card/question"]);
    expect(q0?.actor).toBe("worker");
    expect(q0?.onBehalfOf).toBeUndefined();

    await store.delegateCard("c", { kind: "worker" }, "p_alice");
    await store.recordDossierEntry({ cardId: "c", kind: "question", text: "Which one?" });
    const q1 = (await store.cardEvents("c", ["card/question"])).at(-1);
    expect(q1?.onBehalfOf).toBe("p_alice");
    expect(q1?.principal).toBeUndefined();
    const row = disk.db
      .prepare("SELECT principal, on_behalf_of FROM events WHERE id = ?")
      .get(q1?.id ?? "") as { principal: string | null; on_behalf_of: string | null };
    expect(row).toEqual({ principal: null, on_behalf_of: "p_alice" });

    // The latest delegation to the Worker decides.
    await store.delegateCard("c", { kind: "person", id: "p_bob" }, "p_bob");
    await store.delegateCard("c", { kind: "worker" }, "p_carol");
    await store.recordDossierEntry({ cardId: "c", kind: "question", text: "And now?" });
    expect((await store.cardEvents("c", ["card/question"])).at(-1)?.onBehalfOf).toBe("p_carol");

    // A Worker event never carries a principal.
    await expect(
      log.append({
        actor: "worker",
        type: "card/step",
        cardId: "c",
        payload: {},
        principal: "p_x",
      }),
    ).rejects.toThrow(/principal/);
    expect((await store.verifyProjections()).identical).toBe(true);
    expect((await log.verifyHashChain()).valid).toBe(true);
  });
});
