import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isStatusShaped } from "../src/pm/agent.js";
import { seshatFailure } from "../src/pm/failure.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * K3 item 12 (FINDINGS PM-01, PM-02) over HTTP against a real Solo server
 * with no model configured and model loads off (DoD §2A; no model is
 * loaded): "How is it going?" is answered from the Activity log, as
 * `/status` is; any other question gets a plain sentence saying why Seshat
 * could not reply, with no environment variable, loopback address or API
 * path in it, and the cause the page links to Configuration › Models.
 */

type Message = {
  id: string;
  role: string;
  text: string;
  state: string;
  model?: string;
  cause?: string;
  replyTo?: string[];
};

let repo: string;
let db: DatabaseSync;
let store: CardStore;
let server: { port: number; close: () => Promise<void> };
const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;

async function say(text: string): Promise<string> {
  const res = await fetch(url("/api/pm/messages"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(url(""))) },
    body: JSON.stringify({ text, context: { view: "status" } }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { message?: { id: string }; id?: string };
  return String(body.message?.id ?? body.id);
}

async function replyTo(id: string): Promise<Message> {
  for (let i = 0; i < 100; i++) {
    const thread = (await (await fetch(url("/api/pm/thread"))).json()) as { messages: Message[] };
    const at = thread.messages.findIndex((m) => m.id === id);
    const user = thread.messages[at];
    if (user && user.state === "done") {
      const reply = thread.messages.slice(at + 1).find((m) => m.role === "pm");
      if (reply) return reply;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no reply to ${id}`);
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "sek-seshat-nomodel-"));
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  store = new CardStore(db, log);
  await store.createCard({ id: "c1", tier: "story", title: "Export a week as CSV" });
  await store.createCard({ id: "c2", tier: "story", title: "Flag overtime", status: "ready" });
  server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(store),
    cardStore: store,
    repoPath: repo,
    port: 0,
    streamIntervalMs: 10_000,
    pressureLevel: () => 1,
  });
});

afterEach(async () => {
  await server.close();
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

describe("PM-02: 'How is it going?' with no model answers from the Activity log", () => {
  it("answers the standup /status gives, from the ledger, with no error", async () => {
    const reply = await replyTo(await say("How is it going?"));
    expect(reply.state).toBe("done");
    expect(reply.model).toBe("ledger");
    expect(reply.text).toMatch(/Answered from the Activity log/);
    expect(reply.text).toMatch(/No model is answering for Seshat right now/);
    expect(reply.text).not.toMatch(/could not answer|couldn't reply/i);
  });

  it("knows the common ways of asking how the project is going", () => {
    for (const q of [
      "How is it going?",
      "how's it going",
      "How are things going?",
      "How is the project going?",
      "How's the project doing?",
      "Any updates?",
      "What's the latest?",
    ]) {
      expect(isStatusShaped(q), q).toBe(true);
    }
    // A question about one thing is for Seshat's judgement, not the standup.
    expect(isStatusShaped("How is it going with the CSV export?")).toBe(false);
  });
});

describe("PM-01: Seshat's failure reply is a plain sentence, never a raw exception", () => {
  it("says no model is answering, with the cause the page links to Configuration, and nothing raw", async () => {
    const id = await say("Why is the CSV export taking so long?");
    const reply = await replyTo(id);
    expect(reply.state).toBe("error");
    expect(reply.cause).toBe("no_model");
    expect(reply.replyTo).toEqual([id]);
    expect(reply.text).toMatch(/Your message is kept/);
    expect(reply.text).toMatch(/Configuration › Models/);
    expect(reply.text).not.toMatch(/SEKHEMET_|https?:\/\/|127\.0\.0\.1|\/api\/|Error:/);
  });

  it("words each kind of failure without the exception's text", () => {
    const loadsOff = seshatFailure(
      new Error(
        "Model loads are off in this process (SEKHEMET_MODEL_LOADS=off): refused a request to http://127.0.0.1:11434/api/generate",
      ),
    );
    expect(loadsOff.cause).toBe("no_model");
    const refused = seshatFailure(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8098"), { code: "ECONNREFUSED" }),
    );
    expect(refused.cause).toBe("no_model");
    const missing = seshatFailure(new Error("model not installed"));
    expect(missing.cause).toBe("no_model");
    const slow = seshatFailure(new Error("The operation was aborted due to timeout"));
    expect(slow.cause).toBe("timeout");
    const other = seshatFailure(new Error("Unexpected token < in JSON at position 0"));
    expect(other.cause).toBe("other");
    for (const f of [loadsOff, refused, missing, slow, other]) {
      expect(f.text).not.toMatch(/SEKHEMET_|https?:\/\/|127\.0\.0\.1|\/api\/|ECONN|JSON|token </);
      expect(f.text).toMatch(/Your message is kept/);
    }
    expect(slow.text).toMatch(/took too long/);
  });
});
