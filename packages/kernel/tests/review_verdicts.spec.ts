import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { PAYLOAD_SCHEMAS, checkEventPayload } from "../src/payload_registry.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

/**
 * B4.11 (teams NEW-teams-8, TEAM-24, -25; review-git §2 item 4; teams §3
 * events): the review verdicts' events. A review with no verdict and its
 * threads, a thread resolved or reopened, and an accept dismissed because
 * new commits landed on the issue's branch before its merge. The comments'
 * text is private; files, lines, threads and people are structural.
 */

describe("the review verdicts' events are registered with their data classes", () => {
  it("names every one", () => {
    for (const type of [
      "review/commented",
      "review/thread_resolved",
      "review/thread_reopened",
      "review/accept_dismissed",
    ])
      expect(PAYLOAD_SCHEMAS[type], type).toBeDefined();
  });

  it("a Comment review opens threads on lines or on the whole change; its text is private", () => {
    expect(() =>
      checkEventPayload(
        "review/commented",
        {
          id: "rvc_1",
          cardId: "card_1",
          threads: [{ id: "thr_1", file: "src/a.ts", line: 12 }, { id: "thr_2" }],
        },
        { texts: ["Rename this", "Looks close"] },
      ),
    ).not.toThrow();
    // A reply names the thread it answers.
    expect(() =>
      checkEventPayload(
        "review/commented",
        { id: "rvc_2", cardId: "card_1", replyTo: "thr_1" },
        { texts: ["Done in the next attempt"] },
      ),
    ).not.toThrow();
    // Text in the hashed payload is refused.
    expect(() =>
      checkEventPayload(
        "review/commented",
        { id: "rvc_3", cardId: "card_1", replyTo: "thr_1", texts: ["leak"] },
        undefined,
      ),
    ).toThrow();
    // A line is a positive whole number.
    expect(() =>
      checkEventPayload(
        "review/commented",
        { id: "rvc_4", cardId: "card_1", threads: [{ id: "thr_3", file: "a.ts", line: 0 }] },
        { texts: ["x"] },
      ),
    ).toThrow(/fails its schema/);
  });

  it("resolving or reopening names the issue and the thread", () => {
    expect(() =>
      checkEventPayload("review/thread_resolved", { cardId: "card_1", thread: "thr_1" }, undefined),
    ).not.toThrow();
    expect(() =>
      checkEventPayload("review/thread_reopened", { cardId: "card_1" }, undefined),
    ).toThrow(/fails its schema/);
  });

  it("a dismissal says why: new commits", () => {
    expect(() =>
      checkEventPayload(
        "review/accept_dismissed",
        {
          id: "card_1",
          reason: "new_commits",
          pr: 7,
          headSha: "b".repeat(40),
          accepter: "p_lee",
        },
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      checkEventPayload("review/accept_dismissed", { id: "card_1", reason: "bored" }, undefined),
    ).toThrow(/fails its schema/);
  });
});

describe("TEAM-24: new commits on an accepted issue's branch before its merge dismiss the accept", () => {
  let disk: DiskDb;
  let db: DatabaseSync;
  let log: EventLog;
  let store: CardStore;

  beforeEach(() => {
    disk = openDiskDb();
    db = disk.db;
    log = new EventLog(db);
    store = new CardStore(db, log);
  });
  afterEach(() => disk.dispose());

  async function awaitingMerge() {
    const card = await store.createCard({ tier: "task", title: "Login" });
    await store.updateCardStatus(card.id, "review", "checks passed", "harness", { override: true });
    await store.recordPullRequestOpened(card.id, {
      pr: 7,
      url: "https://github.com/acme/app/pull/7",
      headSha: "a".repeat(40),
      accepter: "p_lee",
    });
    return card.id;
  }

  it("clears the accepter, keeps the still-open pull request as a dismissed hold, and records why", async () => {
    const id = await awaitingMerge();
    expect((await store.getCard(id))?.hold?.kind).toBe("awaitingMerge");
    expect((await store.getCard(id))?.accepter).toBe("p_lee");

    const after = await store.dismissAccept(id, { pr: 7, headSha: "b".repeat(40) });
    expect(after.status).toBe("review");
    // B4.11 review T4: the pull request is still open on GitHub, so the hold
    // keeps it — dismissed, at its new head — for a later merge or a new Accept.
    const dismissedHold = {
      kind: "awaitingMerge",
      pr: 7,
      url: "https://github.com/acme/app/pull/7",
      headSha: "b".repeat(40),
      dismissed: true,
    };
    expect(after.hold).toMatchObject(dismissedHold);
    expect(after.accepter).toBeUndefined();
    const event = (await store.cardEvents(id, ["review/accept_dismissed"])).at(-1);
    expect(event?.payload).toEqual({
      id,
      reason: "new_commits",
      pr: 7,
      headSha: "b".repeat(40),
      accepter: "p_lee",
    });
    expect(event?.actor).toBe("harness");

    // A replay of the ledger gives the same issue: the dismissed hold, no accepter.
    await store.rebuildProjections();
    const replayed = await store.getCard(id);
    expect(replayed?.hold).toMatchObject(dismissedHold);
    expect(replayed?.accepter).toBeUndefined();
    expect(replayed?.status).toBe("review");
  });

  it("refuses an issue that is not awaiting that pull request's merge, recording nothing", async () => {
    const id = await awaitingMerge();
    await expect(store.dismissAccept(id, { pr: 8, headSha: "c".repeat(40) })).rejects.toThrow(
      /does not await pull request #8/,
    );
    const plain = await store.createCard({ tier: "task", title: "Other" });
    await expect(store.dismissAccept(plain.id, { pr: 7, headSha: "c".repeat(40) })).rejects.toThrow(
      /does not await/,
    );
    expect(await store.cardEvents(id, ["review/accept_dismissed"])).toHaveLength(0);
    expect((await store.getCard(id))?.hold?.kind).toBe("awaitingMerge");
  });
});
