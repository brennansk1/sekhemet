import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BoardServiceImpl } from "@sekhemet/board";
import type { CardStore, EventLog } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initLocalKernel } from "../src/index.js";
import { createMcpServer } from "../src/mcp.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * The transition law, the entry conditions and the requirement links,
 * reached the way a person or a tool reaches them (C2d,
 * FINDINGS_C1 TST-01; kernel.md rules 26, 27, 36): a real dashboard
 * server started on port 0 over a real git repository and SQLite ledger,
 * asked over HTTP as the board's page asks it, and the MCP server as a tool
 * calls it. Real gate processes for a take-over; no model is loaded.
 *
 * Two requests "at once" are made deterministic by holding a request's body:
 * the board's triage route reads the card, then waits for the body, so a
 * request whose body is held has read the stored status and not yet moved.
 */

const GATES = (code: string) =>
  `[project]\nmax_files = 5\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", ${JSON.stringify(code)}]\ntimeout_s = 30\nparser = "generic"\n`;

let repo: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;
let board: BoardServiceImpl;
let server: Awaited<ReturnType<typeof startDashboardServer>> | undefined;
let base: string;

const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "sek-kernel-moves-")));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "ada@example.com");
  git("config", "user.name", "Ada Lovelace");
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, ".sekhemet"));
  writeFileSync(join(repo, "src", "a.ts"), "");
  writeFileSync(join(repo, ".sekhemet", "gates.toml"), GATES("process.exit(0)"));
  writeFileSync(
    join(repo, ".gitignore"),
    ".sekhemet/events.db*\n.sekhemet/worktrees\n.sekhemet/evidence\n.sekhemet/transcripts\n.sekhemet/traces.db*\n",
  );
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  // The kernel the server command opens: entry conditions on, the Planner wired (index.ts).
  const k = initLocalKernel(repo);
  db = k.db;
  log = k.log;
  store = k.cardStore;
  board = k.boardService;
  server = undefined;
});

afterEach(async () => {
  await server?.close();
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

async function serve(): Promise<void> {
  server = await startDashboardServer({
    db,
    log,
    boardService: board,
    cardStore: store,
    repoPath: repo,
    port: 0,
    streamIntervalMs: 60_000,
  });
  base = `http://127.0.0.1:${server.port}`;
}

type Reply = { status: number; body: Record<string, unknown> };

async function post(path: string, body: unknown): Promise<Reply> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

/**
 * A POST whose body is held: the headers and the first byte are sent at
 * once, the rest only when `release()` is called. Resolves with the reply.
 */
async function heldPost(
  path: string,
  body: unknown,
): Promise<{ release: () => void; reply: Promise<Reply> }> {
  const text = JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(text)),
    ...(await pageWriteHeaders(base)),
  };
  const url = new URL(path, base);
  let release = () => {};
  const reply = new Promise<Reply>((ok, fail) => {
    const req = request(
      { host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers },
      (res) => {
        let raw = "";
        res.on("data", (d: Buffer) => {
          raw += String(d);
        });
        res.on("end", () => {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(raw) as Record<string, unknown>;
          } catch {}
          ok({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", fail);
    req.write(text.slice(0, 1));
    release = () => req.end(text.slice(1));
  });
  // Let the server read the card and start waiting for the body.
  await new Promise((r) => setTimeout(r, 300));
  return { release, reply };
}

const statusChanges = (cardId: string) =>
  db
    .prepare(
      "SELECT payload FROM events WHERE card_id = ? AND type = 'card/status_changed' ORDER BY seq",
    )
    .all(cardId)
    .map(
      (r) =>
        JSON.parse((r as { payload: string }).payload) as { fromStatus: string; toStatus: string },
    );
const eventCount = () => (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
const overrides = (cardId: string) =>
  db
    .prepare("SELECT payload FROM events WHERE card_id = ? AND type = 'card/override' ORDER BY seq")
    .all(cardId)
    .map(
      (r) =>
        JSON.parse((r as { payload: string }).payload) as {
          from: string;
          to: string;
          overrode: string;
        },
    );

describe("a move that read a stale status over the board (K-S4-1, K-S4-8)", () => {
  it("K-S4-1: a Park that read the card in To do is refused with stale_from once a Won't do moved it, and appends nothing", async () => {
    await store.createCard({ id: "card_stale", tier: "task", title: "Stale", status: "ready" });
    await serve();
    // The Park reads the card in Ready, then waits for its body.
    const park = await heldPost("/api/cards/card_stale/park", { reason: "later" });
    // Meanwhile a person marks it Won't do.
    const rejected = await post("/api/cards/card_stale/reject", { reason: "not needed" });
    expect(rejected.status).toBe(200);
    expect((await store.getCard("card_stale"))?.status).toBe("rejected");
    const before = eventCount();
    park.release();
    const parked = await park.reply;
    // The Park names its fromStatus (Ready) against the stored Rejected: refused.
    expect(parked.status).toBe(409);
    expect(String(parked.body.error)).toMatch(/is in 'rejected', not 'ready'; nothing was changed/);
    expect(eventCount()).toBe(before);
    expect((await store.getCard("card_stale"))?.status).toBe("rejected");
    expect(statusChanges("card_stale").map((e) => e.toStatus)).toEqual(["rejected"]);
  });

  it("K-S4-8: two Parks of one card from the same stored status — exactly one succeeds, the other is refused with stale_from, and one card/status_changed is appended", async () => {
    await store.createCard({ id: "card_race", tier: "task", title: "Race", status: "ready" });
    await serve();
    const first = await heldPost("/api/cards/card_race/park", { reason: "first tab" });
    const second = await heldPost("/api/cards/card_race/park", { reason: "second tab" });
    first.release();
    second.release();
    const replies = await Promise.all([first.reply, second.reply]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
    const refused = replies.find((r) => r.status === 409);
    expect(String(refused?.body.error)).toMatch(/is in 'parked', not 'ready'; nothing was changed/);
    expect(statusChanges("card_race")).toEqual([
      expect.objectContaining({ fromStatus: "ready", toStatus: "parked" }),
    ]);
    expect((await store.getCard("card_race"))?.status).toBe("parked");
    expect(log.verifyHashChainSync({ full: true }).valid).toBe(true);
  });
});

describe("the entry conditions a move must meet (K-N5-2, K-S4-6)", () => {
  it("K-N5-2: a tool's Park over MCP with no reason is refused with the entry condition and appends nothing; with a reason it parks", async () => {
    await store.createCard({ id: "card_park", tier: "task", title: "Park me", status: "ready" });
    const mcp = createMcpServer({ db, log, cardStore: store, boardService: board, repoPath: repo });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    const client = new Client({ name: "probe", version: "1" });
    await client.connect(clientSide);
    try {
      const before = eventCount();
      const res = (await client.callTool({
        name: "sekhemet_move_card",
        arguments: { card_id: "card_park", to: "parked", reason: "   " },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toMatch(
        /card_park has no reason to park: a stop reason that parks, a person's reason, or an open decision request on the card/,
      );
      expect(eventCount()).toBe(before);
      expect((await store.getCard("card_park"))?.status).toBe("ready");
      const parked = (await client.callTool({
        name: "sekhemet_move_card",
        arguments: { card_id: "card_park", to: "parked", reason: "waiting on the payroll rules" },
      })) as { isError?: boolean };
      expect(parked.isError).toBeFalsy();
      expect((await store.getCard("card_park"))?.status).toBe("parked");
    } finally {
      await client.close();
    }
  });

  it("K-S4-6: a taken-over card with no finished attempt enters Verify from the board only as an override, which records the entry condition it overrode: no recorded stop reason", async () => {
    await store.createCard({
      id: "card_verify",
      tier: "story",
      title: "Card verify",
      status: "ready",
      scopeFiles: ["src/a.ts"],
      stepBudget: 6,
      spec: "Write src/a.ts exporting the constant a.",
    });
    await serve();
    expect((await post("/api/cards/card_verify/take-over", {})).status).toBe(200);
    expect((await store.getCard("card_verify"))?.status).toBe("in_progress");
    expect(store.runs.listAttempts("card_verify")).toEqual([]);
    const moved = await post("/api/cards/card_verify/override", {
      toStatus: "verify",
      reason: "I checked it by hand",
    });
    expect(moved.status).toBe(200);
    // In Progress → Verify is a legal edge: what the override carried is the entry condition.
    expect(overrides("card_verify")).toEqual([
      expect.objectContaining({
        from: "in_progress",
        to: "verify",
        overrode:
          "entry condition: card_verify has no attempt with a recorded stop reason; Verify takes a finished attempt",
      }),
    ]);
  }, 60_000);
});

describe("requirement revisions and suspect links over the dashboard (K-N8-1, K-N8-2)", () => {
  it("K-N8-1, K-N8-2: a revision posted from the dashboard appends requirement/revised {id, version} and marks the earlier links suspect; a person's confirmation clears one, the rest stay suspect", async () => {
    await store.createCard({
      id: "card_req1",
      tier: "task",
      title: "Show hours",
      status: "backlog",
    });
    await store.createCard({
      id: "card_req2",
      tier: "task",
      title: "Sum hours",
      status: "backlog",
    });
    // The planned state the dashboard acts on: a requirement, and the cards traced to it.
    const reqs = store.requirements;
    const r = await reqs.create({ title: "Show the week's hours" }, store.localPrincipal());
    await reqs.link({ requirementId: r.id, from: "card", ref: "card_req1" });
    await reqs.link({ requirementId: r.id, from: "card", ref: "card_req2" });
    expect(reqs.links(r.id).every((l) => !l.suspect)).toBe(true);
    await serve();
    const revised = await post(`/api/requirements/${r.id}/revise`, {
      title: "Show the week's hours, overtime apart",
    });
    expect(revised.status, JSON.stringify(revised.body)).toBe(200);
    const [event] = await log.getEventsByTypes(["requirement/revised"]);
    expect(event?.payload).toMatchObject({ id: r.id, version: 2 });
    expect(event?.principal).toBe(store.localPrincipal());
    expect(reqs.links(r.id).map((l) => [l.ref, l.suspect, l.version])).toEqual([
      ["card_req1", true, 1],
      ["card_req2", true, 1],
    ]);
    // K-N8-2: suspect until a principal re-confirms it.
    const confirmed = await post(`/api/requirements/${r.id}/confirm`, {
      from: "card",
      ref: "card_req1",
    });
    expect(confirmed.status).toBe(200);
    const [trace] = await log.getEventsByTypes(["trace/confirmed"]);
    expect(trace?.principal).toBe(store.localPrincipal());
    const links = reqs.links(r.id);
    expect(links.find((l) => l.ref === "card_req1")?.suspect).toBe(false);
    expect(links.find((l) => l.ref === "card_req2")?.suspect).toBe(true);
    // A confirmation without its link is refused and records nothing.
    const before = eventCount();
    expect((await post(`/api/requirements/${r.id}/confirm`, { from: "card" })).status).toBe(400);
    expect(eventCount()).toBe(before);
  });
});
