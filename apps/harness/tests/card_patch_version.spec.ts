import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { cardVersion } from "@sekhemet/ui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * DB-N16-4 (C4; FINDINGS REL-08, unhappy UH-4): two people editing one issue
 * lost an update silently — two PATCHes from one base both answered 200, and
 * `If-Match: stale-version` was ignored. Now the issue has a version (its
 * `ETag`), a PATCH carrying a stale one is answered 409 with the current
 * values and applies nothing. A real server over real SQLite (DoD §2A).
 */
describe("PATCH /api/cards/:id with a version (DB-N16-4)", () => {
  let repo: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: { port: number; close: () => Promise<void> };
  const base = () => `http://127.0.0.1:${server.port}`;
  const patch = async (id: string, body: unknown, ifMatch?: string) =>
    fetch(`${base()}/api/cards/${id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(await pageWriteHeaders(base())),
        ...(ifMatch !== undefined ? { "If-Match": ifMatch } : {}),
      },
      body: JSON.stringify(body),
    });
  const updates = (id: string) =>
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE card_id = ? AND type = 'card/updated'")
        .get(id) as { n: number }
    ).n;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "sek-patch-version-"));
    db = new DatabaseSync(join(repo, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    store = new CardStore(db, log);
    for (const id of ["card_a", "card_b", "card_c", "card_d"])
      await store.createCard({ id, tier: "story", title: `Issue ${id}`, priority: 3 });
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 50,
      pressureLevel: () => 1,
    });
  });
  afterAll(async () => {
    await server.close();
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it("GET answers the issue's version as its ETag", async () => {
    const r = await fetch(`${base()}/api/cards/card_a`);
    expect(r.status).toBe(200);
    const card = await store.getCard("card_a");
    expect(r.headers.get("etag")).toBe(`"${cardVersion(card as never)}"`);
  });

  it("of two PATCHes from the same base, the second is refused with 409 and the current value, and applies nothing", async () => {
    const etag = (await fetch(`${base()}/api/cards/card_b`)).headers.get("etag") as string;
    const before = updates("card_b");
    // Ana sets High from the version she read.
    const first = await patch("card_b", { priority: 2 }, etag);
    expect(first.status).toBe(200);
    const next = first.headers.get("etag");
    expect(next).not.toBe(etag);
    expect(next).toBe(`"${cardVersion((await store.getCard("card_b")) as never)}"`);
    expect((await first.json()).version).toBe(next?.slice(1, -1));
    // Ben, from the same version, sets Low: refused, Ana's High kept.
    const second = await patch("card_b", { priority: 4 }, etag);
    expect(second.status).toBe(409);
    expect(second.headers.get("etag")).toBe(next);
    const body = await second.json();
    expect(body).toMatchObject({
      current: { priority: 2 },
      version: next?.slice(1, -1),
      card: { id: "card_b", priority: 2 },
    });
    expect(body.error).toMatch(/changed since/);
    expect((await store.getCard("card_b"))?.priority).toBe(2);
    expect(updates("card_b")).toBe(before + 1);
    // From the current version his change applies.
    expect((await patch("card_b", { priority: 4 }, next as string)).status).toBe(200);
    expect((await store.getCard("card_b"))?.priority).toBe(4);
  });

  it("refuses the probe's If-Match: 'stale-version', and accepts a weak or listed match", async () => {
    expect((await patch("card_c", { priority: 1 }, "stale-version")).status).toBe(409);
    expect((await patch("card_c", { priority: 1 }, '"0000000000000000"')).status).toBe(409);
    const v = cardVersion((await store.getCard("card_c")) as never);
    expect((await patch("card_c", { priority: 1 }, `"nope", W/"${v}"`)).status).toBe(200);
    expect((await patch("card_c", { priority: 2 }, "*")).status).toBe(200);
  });

  it("a run's step count between the read and the edit is no conflict; no If-Match applies as before", async () => {
    const etag = (await fetch(`${base()}/api/cards/card_d`)).headers.get("etag") as string;
    await store.updateCard("card_d", { stepsUsed: 3 }, "executor");
    expect((await patch("card_d", { priority: 1 }, etag)).status).toBe(200);
    expect((await patch("card_d", { priority: 2 })).status).toBe(200);
    expect((await store.getCard("card_d"))?.priority).toBe(2);
  });
});
