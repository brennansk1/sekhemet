import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { retiredIn } from "../../../packages/ui/tests/copy_scan.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * The one-pass rename (C2a; dashboard NEW-dashboard-23, DEC-52, FINDINGS_C1
 * "Words and names") at the server's entry points, on a real server over real
 * SQLite (DoD §2A): a refusal names the board's columns, never a stored state
 * (R-06); Request changes, never a send-back (R-08); On hold, never parked
 * (R-04); the Agent with its capital (R-28); a settings error is a sentence,
 * never a config key (R-25); and the stop-reason table the page reads has no
 * retired word. No model is loaded.
 */
describe("the professional words over HTTP (C2a rename)", () => {
  let repo: string;
  let db: DatabaseSync;
  let server: { port: number; close: () => Promise<void> };
  const base = () => `http://127.0.0.1:${server.port}`;
  const send = async (method: string, path: string, body: unknown) => {
    const res = await fetch(`${base()}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base())) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { error?: string; ok?: boolean } };
  };

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "sekhemet-rename-c2a-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const store = new CardStore(db, log);
    await store.createCard({
      id: "card_b",
      tier: "task",
      title: "Export to CSV",
      status: "backlog",
    });
    await store.createCard({
      id: "card_r",
      tier: "task",
      title: "Search history",
      status: "ready",
    });
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store, { entryConditions: true }),
      cardStore: store,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 1000,
    });
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    db?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it("R-08, R-28: Request changes needs a reason the Agent reads", async () => {
    const r = await send("POST", "/api/cards/card_b/return", { reason: "  " });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Request changes needs a reason: it is what the Agent is told next");
  });

  it("R-06: a refused Request changes names the board's columns, never a stored state", async () => {
    const r = await send("POST", "/api/cards/card_b/return", { reason: "Sort the keys" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(
      "card_b is Backlog; request changes on an issue In review or On hold",
    );
  });

  it("R-04, R-06: Take off hold on an issue not on hold says where it is, in the board's words", async () => {
    const r = await send("POST", "/api/cards/card_r/unpark", {});
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("card_r is not On hold (it is To do)");
  });

  it("R-25: a notification setting is refused in a sentence, never a config key", async () => {
    const kind = await send("PUT", "/api/integrations/push", { kind: "pager", url: "https://x" });
    expect(kind).toEqual({ status: 400, body: { error: "Choose ntfy or Gotify." } });
    const url = await send("PUT", "/api/integrations/push", { kind: "ntfy", url: "nope" });
    expect(url).toEqual({ status: 400, body: { error: "That isn't a web address." } });
  });

  it("R-04, R-14, R-28: the stop reasons the page reads say no retired word", async () => {
    const res = await fetch(`${base()}/vocab.json`);
    expect(res.status).toBe(200);
    const vocab = (await res.json()) as {
      stopReasons: Record<string, { short: string; sentence: string; nextAction: string }>;
    };
    const words = Object.values(vocab.stopReasons).flatMap((r) => [
      r.short,
      r.sentence,
      r.nextAction,
    ]);
    expect(words.filter((w) => retiredIn(w).length > 0)).toEqual([]);
    expect(vocab.stopReasons.hook_veto?.nextAction).toBe(
      "See the hook and its reason; change the hook or the issue, then take it off hold.",
    );
  });
});
