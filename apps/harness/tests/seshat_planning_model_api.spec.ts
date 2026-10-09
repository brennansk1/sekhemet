import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { ModelRegistry, hostFingerprintHash } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seshatModelName, seshatSetupGap } from "../src/pm/seshat_model.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * N0 (c6 #2, #3) over HTTP against a real Solo server, model loads off and a
 * model list of this file's own (DoD §2A; nothing is loaded):
 *
 * - `serve`'s Seshat runs on the person's Planning model assignment, not the
 *   shipped default (c6 #2);
 * - when Seshat's model is missing from the model list, or not verified for
 *   the Planning role, the reply says which and points to Configuration ›
 *   Models at once, instead of the thread saying *The model is still
 *   loading* for ever (c6 #3).
 */

type Message = { id: string; role: string; text: string; state: string; cause?: string };

let dir: string;
let db: DatabaseSync | undefined;
let server: { port: number; close: () => Promise<void> } | undefined;
const url = (path: string) => `http://127.0.0.1:${server?.port}${path}`;

async function start(pressure = 1): Promise<void> {
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  const opened = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  db = opened;
  initSchema(opened);
  const log = new EventLog(opened);
  const store = new CardStore(opened, log);
  await store.createCard({ id: "c1", tier: "story", title: "Export a week as CSV" });
  server = await startDashboardServer({
    db: opened,
    log,
    boardService: new BoardServiceImpl(store),
    cardStore: store,
    repoPath: repo,
    port: 0,
    streamIntervalMs: 10_000,
    pressureLevel: () => pressure,
  });
}

async function ask(text: string): Promise<Message> {
  const res = await fetch(url("/api/pm/messages"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(url(""))) },
    body: JSON.stringify({ text, context: { view: "status" } }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { message?: { id: string }; id?: string };
  const id = String(body.message?.id ?? body.id);
  for (let i = 0; i < 100; i++) {
    const thread = (await (await fetch(url("/api/pm/thread"))).json()) as { messages: Message[] };
    const at = thread.messages.findIndex((m) => m.id === id);
    const reply = thread.messages.slice(at + 1).find((m) => m.role === "pm");
    if (thread.messages[at]?.state === "done" && reply) return reply;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no reply to ${id}`);
}

function assignPlanner(model: string): void {
  const registry = new ModelRegistry();
  registry.upsert(model, { contextWindow: 32_768 });
  registry.recordRoleAssignment(hostFingerprintHash(), {
    role: "planner",
    model,
    scope: "personal",
    by: "p_owner",
    date: "2026-10-08T00:00:00Z",
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sek-seshat-planning-"));
  vi.stubEnv("SEKHEMET_MODEL_REGISTRY", join(dir, "models.json"));
});

afterEach(async () => {
  await server?.close();
  db?.close();
  server = undefined;
  db = undefined;
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("N0 (c6 #2): serve's Seshat runs on the person's Planning model", () => {
  it("names the assigned Planning model as Seshat's, not the shipped default", async () => {
    assignPlanner("my-planner");
    await start();
    const thread = (await (await fetch(url("/api/pm/thread"))).json()) as { model: string };
    expect(thread.model).toBe("my-planner");
  });
});

describe("N0 (c6 #3): a Seshat model that is not set up is said, never loading for ever", () => {
  it("an assigned Planning model whose memory cannot be measured: says so at once and points to Configuration › Models (chat needs no Planning qualification)", async () => {
    assignPlanner("my-planner");
    await start();
    const reply = await ask("Why is the CSV export taking so long?");
    expect(reply.state).toBe("error");
    expect(reply.cause).toBe("no_model");
    expect(reply.text).toMatch(
      /Seshat's model, my-planner, is not set up on this machine: Sekhemet cannot measure the memory it needs/,
    );
    expect(reply.text).toMatch(/Configuration › Models/);
    // The dashboard's words: no command for a person who has no terminal.
    expect(reply.text).not.toMatch(/sekhemet [a-z]/);
  });

  it("under memory pressure too: saying what is missing loads nothing, so it is said at once", async () => {
    await start(4);
    const reply = await ask("Why is the CSV export taking so long?");
    expect(reply.cause).toBe("no_model");
    expect(reply.text).toMatch(/dirk-27b:latest, is not set up on this machine/);
  });

  it("no model list entry for the default: names the model as missing from the list", async () => {
    await start();
    const reply = await ask("Why is the CSV export taking so long?");
    expect(reply.cause).toBe("no_model");
    expect(reply.text).toMatch(
      /Seshat's model, dirk-27b:latest, is not set up on this machine: it is not in Sekhemet's model list/,
    );
    expect(reply.text).toMatch(/Your message is kept/);
  });
});

describe("N0: the terminal's words, and the order the Planning model resolves in", () => {
  it("`ask` and the editor bridge name `sekhemet doctor` beside Configuration › Models", () => {
    const gap = seshatSetupGap("absent-planner", new ModelRegistry(), "terminal");
    expect(gap).toMatch(/absent-planner, is not set up on this machine/);
    expect(gap).toMatch(/Configuration › Models, or run `sekhemet doctor`/);
  });

  it("the assignment, then the shipped default when nothing is assigned or configured", () => {
    const repo = join(dir, "plain");
    mkdirSync(repo);
    expect(seshatModelName(repo, { registry: new ModelRegistry() })).toBe("dirk-27b:latest");
    assignPlanner("my-planner");
    expect(seshatModelName(repo, { registry: new ModelRegistry() })).toBe("my-planner");
  });
});
