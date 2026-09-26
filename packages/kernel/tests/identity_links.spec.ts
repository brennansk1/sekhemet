import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

/**
 * integrations item 6 and NEW-integrations-2: a person's login on a tracker,
 * linked to their principal on the ledger, the login private and erasable
 * (kernel rule 33) — the mapping the owner, delegate and CODEOWNERS need.
 */
describe("identity links: principal <-> tracker login", () => {
  let disk: DiskDb;
  let db: DatabaseSync;
  let log: EventLog;
  let store: CardStore;

  beforeEach(() => {
    disk = openDiskDb();
    db = disk.db;
    log = new EventLog(db, { acceptHolders: () => ["p_alice", "p_bob"] });
    store = new CardStore(db, log);
  });
  afterEach(() => disk.dispose());

  it("links a login to a principal, reads it both ways, case-insensitively, and the latest link wins", async () => {
    await store.linkIdentity("p_alice", "github", "Alice-GH", "p_alice");
    expect(store.principalForHandle("github", "alice-gh")).toBe("p_alice");
    expect(store.handleOf("p_alice", "github")).toBe("Alice-GH");
    expect(store.principalForHandle("github", "nobody")).toBeUndefined();
    expect(store.principalForHandle("forgejo", "alice-gh")).toBeUndefined();
    await store.linkIdentity("p_bob", "github", "alice-gh", "p_bob");
    expect(store.principalForHandle("github", "Alice-GH")).toBe("p_bob");
    expect(store.handleOf("p_alice", "github")).toBeUndefined();
  });

  it("keeps the login off the hashed payload: it is private and erasable", async () => {
    await store.linkIdentity("p_alice", "github", "alice-gh", "p_alice");
    const [event] = await log.getEventsByTypes(["person/identity_linked"]);
    expect(event?.payload).toEqual({ principal: "p_alice", system: "github" });
    expect(JSON.stringify(event?.payload)).not.toContain("alice-gh");
    expect(event?.private).toEqual({ handle: "alice-gh" });
    await log.erase({
      eventIds: [event?.id as string],
      reason: "erasure",
      principal: "p_alice",
    });
    expect(store.principalForHandle("github", "alice-gh")).toBeUndefined();
  });

  it("refuses a principal that is not an opaque id", async () => {
    await expect(store.linkIdentity("alice", "github", "alice-gh", "p_alice")).rejects.toThrow(
      /principal/,
    );
  });
});

describe("K-N3-4 with INT-13/14: the pull request's close names its merge commit and closer", () => {
  let disk: DiskDb;
  let db: DatabaseSync;
  let store: CardStore;

  beforeEach(() => {
    disk = openDiskDb();
    db = disk.db;
    store = new CardStore(db, new EventLog(db));
  });
  afterEach(() => disk.dispose());

  it("records mergeCommit and closedBy on card/pr_closed, the closer's login private", async () => {
    const card = await store.createCard({ tier: "task", title: "T" });
    await store.updateCardStatus(card.id, "review", "t", "harness", { override: true });
    await store.recordPullRequestOpened(card.id, { pr: 5, url: "u", headSha: "h" });
    await store.recordPullRequestClosed(
      card.id,
      {
        pr: 5,
        merged: true,
        mergeCommit: "c4295bd74fb0f4fda03689c3df3f2803b658fd85",
        closedBy: "p_bob",
        closedByHandle: "hubot",
      },
      "github",
    );
    const [closed] = await store.cardEvents(card.id, ["card/pr_closed"]);
    expect(closed?.payload).toEqual({
      id: card.id,
      pr: 5,
      merged: true,
      mergeCommit: "c4295bd74fb0f4fda03689c3df3f2803b658fd85",
      closedBy: "p_bob",
    });
    expect(closed?.private).toEqual({ closedByHandle: "hubot" });
  });
});
