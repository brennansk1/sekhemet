import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";

/**
 * PM-N9-8 on the take-over's records (B4.4 review): `GET /api/takeover`
 * carries the repository's private text (the inventory's recon, the brief as
 * found, the backlog's titles), so, like Seshat's snapshot, it answers only a
 * person who can see every project. The real HTTP server on an on-disk
 * ledger (DEFINITION_OF_DONE §2A).
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanup.length) await (cleanup.pop() as () => Promise<void> | void)();
});

describe("GET /api/takeover in the Team setup", () => {
  it("answers a member who sees every project, and withholds the records from anyone else", async () => {
    const repo = mkdtempSync(join(tmpdir(), "sek-to-vis-"));
    cleanup.push(() => rmSync(repo, { recursive: true, force: true }));
    const db = new DatabaseSync(join(repo, "events.db"));
    cleanup.push(() => db.close());
    initSchema(db);
    const log = new EventLog(db);
    const cardStore = new CardStore(db, log);
    log.appendNow({
      actor: "system",
      type: "member/joined",
      principal: "p_member",
      payload: { principal: "p_member", level: "member", via: "invite", pending: false },
    });
    await cardStore.ensureProject({ rootPath: repo, name: "Chronicle" });
    const server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cardStore),
      cardStore,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 10_000,
      setup: "team",
      requester: (req) => {
        const h = req.headers["x-test-principal"];
        return typeof h === "string" && h ? h : undefined;
      },
      pressureLevel: () => 1,
    });
    cleanup.push(() => server.close());
    const get = (who: string) =>
      fetch(`http://127.0.0.1:${server.port}/api/takeover`, {
        headers: { "X-Test-Principal": who },
      });
    expect((await get("p_member")).status).toBe(200);
    const stranger = await get("p_stranger");
    expect(stranger.status).toBe(404);
    expect(await stranger.json()).not.toHaveProperty("inventory");
  });
});
