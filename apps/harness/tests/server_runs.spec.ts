import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

// Run records, decisions and integrity over the dashboard API (K6, K8, K16-K20, S8).
describe("@sekhemet/harness dashboard: run records, decisions, integrity", () => {
  let repo: string;
  let db: DatabaseSync;
  let log: EventLog;
  let cardStore: CardStore;
  let server: { port: number; close: () => Promise<void> };
  const base = () => `http://127.0.0.1:${server.port}`;
  const post = async (path: string, body: unknown) =>
    fetch(`${base()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base())) },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "sekhemet-server-runs-"));
    db = new DatabaseSync(join(repo, "events.db"));
    initSchema(db);
    log = new EventLog(db);
    cardStore = new CardStore(db, log);
    await cardStore.createCard({ id: "card_s", tier: "story", title: "S" });
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cardStore),
      cardStore,
      repoPath: repo,
      port: 0,
      // The timer fallback is slow on purpose: a frame that arrives quickly
      // came through the log subscription.
      streamIntervalMs: 60_000,
    });
  });
  afterAll(async () => {
    await server.close();
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it("lists pending decisions and records a person's answer (K20, S8)", async () => {
    const d = await cardStore.runs.requestDecision({
      cardId: "card_s",
      kind: "permission",
      question: "Allow rm -rf dist?",
      context: "run_cmd",
      options: ["deny", "allow"],
    });
    const listed = await (await fetch(`${base()}/api/decisions?status=pending`)).json();
    expect(listed.decisions.map((x: { id: string }) => x.id)).toEqual([d.id]);

    const untrusted = await fetch(`${base()}/api/decisions/${d.id}`, {
      method: "POST",
      body: JSON.stringify({ answer: "allow" }),
    });
    expect(untrusted.status).toBe(403);

    const res = await post(`/api/decisions/${d.id}`, { answer: "allow" });
    expect(res.status).toBe(200);
    expect(cardStore.runs.getDecision(d.id)).toMatchObject({
      status: "answered",
      selectedOptionIndex: 1,
      answeredBy: "human",
    });
    expect((await post(`/api/decisions/${d.id}`, { answer: "deny" })).status).toBe(409);
  });

  it("serves a card's attempts with steps and gate results (K16-K18)", async () => {
    const a = await cardStore.runs.startAttempt({
      cardId: "card_s",
      attemptNumber: 1,
      modelId: "m",
    });
    await cardStore.runs.recordStep({
      attemptId: a.id,
      cardId: "card_s",
      stepIndex: 1,
      calls: [],
      promptTokens: 1,
      completionTokens: 1,
      durationMs: 1,
    });
    const data = await (await fetch(`${base()}/api/cards/card_s/attempts`)).json();
    expect(data.attempts[0]).toMatchObject({ id: a.id, attemptNumber: 1 });
    expect(data.attempts[0].steps).toHaveLength(1);
  });

  it("reports the hash chain and the byte-identical projection rebuild (K8)", async () => {
    const data = await (await fetch(`${base()}/api/integrity`)).json();
    expect(data.chain.valid).toBe(true);
    expect(data.projections).toMatchObject({ identical: true, mismatched: [] });
  });

  it("pushes an in-process append to the stream through the log subscription (K6)", async () => {
    const res = await fetch(`${base()}/api/stream`);
    const reader = res.body?.getReader();
    // Let the stream register before the append.
    let text = "";
    const first = await reader?.read();
    text += new TextDecoder().decode(first?.value);
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    await cardStore.updateCard("card_s", { title: "S renamed" });
    // Wait for the rename itself, not merely for an append: the stream
    // replays the log from genesis, so the first `event: append` is history
    // and arrives before the update being tested.
    while (reader && !text.includes("S renamed") && Date.now() - started < 3000) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader?.cancel();
    expect(text).toContain("event: append");
    expect(text).toContain("S renamed");
    // Well inside the 60 s timer: it was the subscription, not the poll.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("streams a running card's decoded tokens from its live file (M2)", async () => {
    const fast = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cardStore),
      cardStore,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 50,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${fast.port}/api/stream`);
      const reader = res.body?.getReader();
      mkdirSync(join(repo, ".sekhemet", "live"), { recursive: true });
      writeFileSync(join(repo, ".sekhemet", "live", "card_s.txt"), "export const tok");
      let text = "";
      const deadline = Date.now() + 3000;
      while (reader && !text.includes("event: tokens") && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      await reader?.cancel();
      expect(text).toContain("event: tokens");
      expect(text).toContain('"cardId":"card_s"');
      expect(text).toContain("export const tok");
    } finally {
      await fast.close();
    }
  });
});
