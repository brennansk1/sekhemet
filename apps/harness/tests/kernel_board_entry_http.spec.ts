import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initLocalKernel } from "../src/index.js";
import { createMcpServer } from "../src/mcp.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * The transition law and the card's stored fields reached the way a person
 * or a tool reaches them (C2d, FINDINGS_C1 TST-01; kernel.md rules 23–28,
 * 33, NEW-kernel-6, NEW-kernel-9): a real dashboard server started on port
 * 0 over a real git repository and SQLite ledger, asked over HTTP as the
 * board's page asks it, and the MCP server as a tool calls it. Real gate
 * processes for a take-over; no model is loaded.
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

beforeEach(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "sek-kernel-http-")));
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

async function post(
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

const eventCount = () => (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;

describe("the transition law over the board's routes (K-S4, K-N5)", () => {
  it("K-S4-2: an override to the state the card is already in appends nothing and leaves it unchanged", async () => {
    await store.createCard({ id: "card_same", tier: "task", title: "Same", status: "ready" });
    await serve();
    await pageWriteHeaders(base); // the page's session, recorded before the move
    const before = eventCount();
    const res = await post("/api/cards/card_same/override", {
      toStatus: "ready",
      reason: "already there",
    });
    expect(res.status).toBe(200);
    expect(eventCount()).toBe(before);
    expect((await store.getCard("card_same"))?.status).toBe("ready");
    expect(await store.cardEvents("card_same", ["card/status_changed", "card/override"])).toEqual(
      [],
    );
  });

  it("K-S4-5: an `override:` reason from a tool over MCP is refused with override_forbidden and appends nothing", async () => {
    await store.createCard({
      id: "card_mcp",
      tier: "task",
      title: "Tool",
      status: "backlog",
      acceptanceCriteria: ["The tool can move it"],
    });
    const mcp = createMcpServer({ db, log, cardStore: store, boardService: board, repoPath: repo });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    const client = new Client({ name: "probe", version: "1" });
    await client.connect(clientSide);
    try {
      const before = eventCount();
      const res = (await client.callTool({
        name: "sekhemet_move_card",
        arguments: { card_id: "card_mcp", to: "parked", reason: "override: the tool decided" },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toMatch(/Only a person may override \(the actor was mcp\)/);
      expect(eventCount()).toBe(before);
      expect((await store.getCard("card_mcp"))?.status).toBe("backlog");
      // The same move without the override word is a plain, legal move.
      const moved = (await client.callTool({
        name: "sekhemet_move_card",
        arguments: { card_id: "card_mcp", to: "ready", reason: "groomed" },
      })) as { isError?: boolean };
      expect(moved.isError).toBeFalsy();
      expect((await store.getCard("card_mcp"))?.status).toBe("ready");
    } finally {
      await client.close();
    }
  });

  it("K-N5-1: an unscored card unparked back into Planning from the board is scored 1–10 by the Planner as part of the move", async () => {
    await store.createCard({ id: "card_plan", tier: "task", title: "Unscored", status: "backlog" });
    // Set up as a card in Planning that was never scored (the move itself is setup).
    await store.updateCardStatus("card_plan", "planning", "setup", "harness", { override: true });
    await serve();
    expect(
      (await post("/api/cards/card_plan/park", { reason: "the brief is unclear" })).status,
    ).toBe(200);
    expect((await store.getCard("card_plan"))?.difficulty).toBeUndefined();
    const res = await post("/api/cards/card_plan/unpark", {});
    expect(res.status).toBe(200);
    const card = await store.getCard("card_plan");
    expect(card?.status).toBe("planning");
    expect(Number.isInteger(card?.difficulty)).toBe(true);
    expect(card?.difficulty).toBeGreaterThanOrEqual(1);
    expect(card?.difficulty).toBeLessThanOrEqual(10);
    // The score is recorded by the Planner before the move, on the ledger.
    const events = (
      db
        .prepare("SELECT actor, type, payload FROM events WHERE card_id = 'card_plan' ORDER BY seq")
        .all() as {
        actor: string;
        type: string;
        payload: string;
      }[]
    ).map((e) => ({ ...e, payload: JSON.parse(e.payload) as unknown }));
    const scored = events.findIndex(
      (e) => e.actor === "planner" && JSON.stringify(e.payload).includes("difficulty"),
    );
    const moved = events.findIndex(
      (e) =>
        e.type === "card/status_changed" &&
        (e.payload as { toStatus?: string }).toStatus === "planning" &&
        e.actor === "human",
    );
    expect(scored).toBeGreaterThanOrEqual(0);
    expect(moved).toBeGreaterThan(scored);
  });
});

describe("what the board's routes record on the card (K-N1-6, K-N6, K-N9, K-S7-4)", () => {
  it("K-N1-6: two identical messages posted from the issue page get fresh salts and different commitments", async () => {
    await store.createCard({ id: "card_msg", tier: "task", title: "Talk", status: "ready" });
    await serve();
    const text = "Use the payroll calendar for public holidays.";
    expect((await post("/api/cards/card_msg/message", { text })).status).toBe(200);
    expect((await post("/api/cards/card_msg/message", { text })).status).toBe(200);
    const rows = db
      .prepare(
        "SELECT e.commitment, p.salt, p.body FROM events e JOIN event_private p ON p.event_id = e.id WHERE e.card_id = 'card_msg' ORDER BY e.seq",
      )
      .all() as { commitment: string; salt: string; body: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.body).toBe(rows[1]?.body);
    expect(rows[0]?.body).toContain(text);
    for (const r of rows) expect(r.salt).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes
    expect(rows[0]?.salt).not.toBe(rows[1]?.salt);
    expect(rows[0]?.commitment).not.toBe(rows[1]?.commitment);
    // The text is not in the hashed, structural payload.
    const payloads = db.prepare("SELECT payload FROM events WHERE card_id = 'card_msg'").all();
    expect(JSON.stringify(payloads)).not.toContain(text);
    expect(log.verifyHashChainSync({ full: true }).valid).toBe(true);
  });

  it("K-N9-1: an issue filed from the New issue form stores its kind in card/created, once", async () => {
    await serve();
    const project =
      store.listProjects()[0]?.id ??
      (await store.ensureProject({ name: "repo", rootPath: repo })).id;
    const spike = await post(`/api/projects/${project}/cards`, {
      title: "Try a CSV library",
      type: "spike",
    });
    expect(spike.status).toBe(201);
    const task = await post(`/api/projects/${project}/cards`, {
      title: "Round minutes",
      type: "task",
    });
    expect(task.status).toBe(201);
    for (const [res, kind] of [
      [spike, "spike"],
      [task, undefined],
    ] as const) {
      const id = (res.body.card as { id: string }).id;
      const [created] = await store.cardEvents(id, ["card/created"]);
      const payload = created?.payload as { kind?: string; owner?: string; delegate?: unknown };
      // K-N9-1: the kind is in the payload, stored once; replay never re-derives it.
      expect(typeof payload.kind).toBe("string");
      if (kind) expect(payload.kind).toBe(kind);
      expect((await store.getCard(id))?.kind).toBe(payload.kind);
      expect(payload.delegate ?? null).toBeNull();
    }
    expect((await store.verifyProjections()).identical).toBe(true);
  });

  it("PM-P1-13: a story at split depth 1 split from the board gives parts at depth 2 under the same epic, no subtask level; one at the depth limit is not split again", async () => {
    await serve();
    await store.createCard({ id: "epic_e1", tier: "epic", title: "Timesheets", status: "backlog" });
    await store.createCard({
      id: "card_s1",
      tier: "story",
      title: "Total and export a week",
      status: "backlog",
      parentId: "epic_e1",
      splitDepth: 1,
      spec: "Total a week's hours and export the week as CSV.",
      acceptanceCriteria: [
        "Given 8 hours on each of 5 days, the week totals 40 hours",
        "Given a week, the CSV export has one row per day",
      ],
    });
    const split = await post("/api/cards/card_s1/split", {
      parts: [
        { title: "Total a week's hours", spec: "the week totals the days' hours" },
        { title: "Export a week as CSV", spec: "the CSV export has one row per day" },
      ],
    });
    expect(split.status, JSON.stringify(split.body)).toBe(200);
    const parts = split.body.subtasks as { id: string }[];
    expect(parts).toHaveLength(2);
    for (const { id } of parts) {
      const part = await store.getCard(id);
      expect(part?.splitDepth, id).toBe(2);
      expect(part?.parentId, id).toBe("epic_e1");
      expect(part?.tier, id).toBe("story");
    }
    expect((await store.getCard("card_s1"))?.status).toBe("rejected");
    // At the depth limit the story is held where it is, never split again.
    await store.createCard({
      id: "card_s4",
      tier: "story",
      title: "Total and export a month",
      status: "planning",
      parentId: "epic_e1",
      splitDepth: 4,
      acceptanceCriteria: ["Given a month, the CSV export has one row per day"],
    });
    const before = eventCount();
    const again = await post("/api/cards/card_s4/split", {
      parts: [
        { title: "Total a month", spec: "the month totals" },
        { title: "Export a month", spec: "the CSV export has one row per day" },
      ],
    });
    // Refused, and nothing recorded. (The route answers the pipeline's
    // refusal as a 500 "Something went wrong" rather than its sentence: a
    // C2d finding for the lead, not part of this criterion.)
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect((await store.getCard("card_s4"))?.status).toBe("planning");
    expect(eventCount()).toBe(before);
  });

  it("K-S7-4: an override naming a principal that fails card/override's payload schema is refused, naming the event type and the field, and nothing is appended", async () => {
    await store.createCard({
      id: "card_bad",
      tier: "task",
      title: "Bad principal",
      status: "backlog",
    });
    await serve();
    await pageWriteHeaders(base);
    const before = eventCount();
    // Backlog to Done is an illegal edge, so the override is recorded — with this principal.
    const res = await post("/api/cards/card_bad/override", {
      toStatus: "done",
      reason: "ship it",
      principal: "Mallory",
    });
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toContain("card/override");
    expect(String(res.body.error)).toContain("principal");
    expect(eventCount()).toBe(before);
    expect((await store.getCard("card_bad"))?.status).toBe("backlog");
  });
});

describe("a person's take-over over the board (K-N6-4, K-N6-5)", () => {
  it("K-N6-4, K-N6-5: a person-built card meets the same gates to enter Review, its attempts are built by the person and add nothing to competence", async () => {
    await store.createCard({
      id: "card_take",
      tier: "story",
      title: "Card take",
      scopeFiles: ["src/a.ts"],
      stepBudget: 6,
      spec: "Write src/a.ts exporting the constant a.",
    });
    await serve();
    const taken = await post("/api/cards/card_take/take-over", {});
    expect(taken.status).toBe(200);
    const worktree = String(taken.body.worktreePath);
    writeFileSync(join(worktree, "src", "a.ts"), "export const a = 5;\n");
    // K-N6-5: a failing blocking gate keeps the person's work out of Review.
    writeFileSync(join(repo, ".sekhemet", "gates.toml"), GATES("process.exit(1)"));
    const failed = await post("/api/cards/card_take/submit-take-over", {});
    expect(failed.status).toBe(200);
    expect(failed.body.passed).toBe(false);
    expect((await store.getCard("card_take"))?.status).toBe("in_progress");
    writeFileSync(join(repo, ".sekhemet", "gates.toml"), GATES("process.exit(0)"));
    const passed = await post("/api/cards/card_take/submit-take-over", {});
    expect(passed.body.passed).toBe(true);
    expect((await store.getCard("card_take"))?.status).toBe("review");
    // K-N6-4: builtBy names the person on each attempt; none is competence.
    const person = store.localPrincipal();
    const attempts = store.runs.listAttempts("card_take");
    expect(attempts.map((a) => a.builtBy)).toEqual([
      { kind: "person", id: person },
      { kind: "person", id: person },
    ]);
    expect(store.runs.listCompetence()).toEqual([]);
  }, 60_000);
});

describe("a server opening a ledger an earlier build wrote (K-N12-1)", () => {
  it("K-N12-1: serves the v21 ledger without rewriting it or adopting it into a new project, keeps its project's id and root, and names the workspace by its first event's hash", async () => {
    // The ledger of the release before (written by the code of its day).
    db.close();
    const fixture = resolve(
      import.meta.dirname,
      "../../../packages/kernel/tests/fixtures/schemas/v21-previous-release.db",
    );
    copyFileSync(fixture, join(repo, ".sekhemet", "events.db"));
    db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    log = new EventLog(db);
    store = new CardStore(db, log);
    board = new BoardServiceImpl(store);
    const rows = () =>
      db
        .prepare(
          "SELECT seq, id, type, payload, hash, prev_hash, created_at FROM events WHERE seq <= 9 ORDER BY seq",
        )
        .all()
        .map((r) => ({ ...r }));
    const first = db.prepare("SELECT hash FROM events ORDER BY seq ASC LIMIT 1").get() as {
      hash: string;
    };
    const before = rows();
    expect(before).toHaveLength(9);
    await serve();
    const ws = (await (await fetch(`${base}/api/workspaces`)).json()) as { current: string };
    expect(ws.current).toBe(`ws_${first.hash.slice(0, 12)}`);
    const space = (await (await fetch(`${base}/api/workspace`)).json()) as {
      projects: { id: string; rootPath: string }[];
    };
    expect(space.projects.map((p) => [p.id, p.rootPath])).toEqual([
      ["proj_2d3ebad7", "/fixture/repo"],
    ]);
    const boardState = await fetch(`${base}/api/board`);
    expect(boardState.status).toBe(200);
    // Every event the earlier build wrote is as it wrote it, and nothing adopted the
    // ledger: no project or card event was appended, and the chain still verifies.
    expect(rows()).toEqual(before);
    const appended = db.prepare("SELECT type FROM events WHERE seq > 9").all() as {
      type: string;
    }[];
    expect(appended.filter((e) => /^(project|card|workspace)\//.test(e.type))).toEqual([]);
    expect(store.listProjects().map((p) => p.id)).toEqual(["proj_2d3ebad7"]);
    expect(log.verifyHashChainSync({ full: true }).valid).toBe(true);
  });
});
