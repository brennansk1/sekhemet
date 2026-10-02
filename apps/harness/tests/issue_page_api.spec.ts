import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

// The issue page's server half over HTTP (C2a; FINDINGS ISS-01, ISS-02):
// the card detail names the issue's branch for the properties rail, and a
// run a person stopped is the Agent's paused state, resumed by hand-back.
// A real server over real SQLite and a real git repository.

describe("the issue page's server half (ISS-01, ISS-02)", () => {
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: { port: number; close: () => Promise<void> };
  let base: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-issue-api-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    writeFileSync(join(dir, "README.md"), "x\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    git("branch", "sekhemet/timesheets/card_br-flag-overtime");
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    store = new CardStore(db, log);
    await store.createCard({
      id: "card_br",
      tier: "story",
      title: "Flag overtime",
      status: "ready",
    });
    await store.createCard({ id: "card_nb", tier: "story", title: "No run yet", status: "ready" });
    await store.createCard({
      id: "card_st",
      tier: "story",
      title: "Pay period",
      status: "ready",
      delegate: { kind: "worker" },
    });
    await store.updateCardStatus("card_st", "in_progress", "setup", "harness", { override: true });
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 60_000,
    });
    base = `http://127.0.0.1:${server.port}`;
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const detail = async (id: string) =>
    (await (await fetch(`${base}/api/cards/${id}`)).json()) as {
      branch?: string;
      card: { status: string };
      ai: { who: string; state: string; stopped?: boolean }[];
    };

  it("names the issue's branch once a run made one, and none before", async () => {
    expect((await detail("card_br")).branch).toBe("sekhemet/timesheets/card_br-flag-overtime");
    expect((await detail("card_nb")).branch).toBeUndefined();
  });

  it("a stopped run is paused, not working; hand-back resumes it from Verify", async () => {
    const headers = { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) };
    expect(
      (await fetch(`${base}/api/cards/card_st/abort`, { method: "POST", headers, body: "{}" }))
        .status,
    ).toBe(200);
    await store.updateCardStatus("card_st", "verify", "the run stopped", "executor", {
      override: true,
    });
    // Before the stop is recorded on the card, Verify is the checks running.
    expect((await detail("card_st")).ai[0]).toMatchObject({ state: "working" });
    await store.updateCard("card_st", { stopReason: "human_abort", stepsUsed: 2 }, "executor");
    expect((await detail("card_st")).ai[0]).toEqual({
      who: "agent",
      state: "paused",
      stopped: true,
    });
    const resumed = await fetch(`${base}/api/cards/card_st/hand-back`, {
      method: "POST",
      headers,
      body: JSON.stringify({ note: "" }),
    });
    expect(resumed.status).toBe(200);
    expect((await detail("card_st")).card.status).toBe("ready");
    const moves = await store.cardEvents("card_st", ["card/status_changed"]);
    expect((moves.at(-1)?.payload as { reason?: string }).reason).toBe("resumed after a stop");
  });
});
