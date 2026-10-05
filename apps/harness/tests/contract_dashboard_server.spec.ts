import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * Dashboard ↔ server contract tests (FINISH_LINE_PLAN C.1, W8): the JSON
 * shapes `docs/design/PM_CONTRACT.md` publishes, asserted against the live
 * routes of a real Solo server over a real SQLite ledger. Each shape below
 * is the document's, field for field, with the section it comes from; a
 * field the document marks optional may be absent, and when present it must
 * have the documented type. A route that drifts from the document fails
 * here, whichever side moved.
 */

// ── a small shape language: the document's types, checked at run time ──
type Shape =
  | "string"
  | "number"
  | "boolean"
  | "any"
  | { oneOf: readonly unknown[] }
  | { arrayOf: Shape }
  | { object: Record<string, Shape>; optional?: readonly string[] }
  | { nullable: Shape };

const str: Shape = "string";
const num: Shape = "number";
const bool: Shape = "boolean";
const any: Shape = "any";
const arr = (s: Shape): Shape => ({ arrayOf: s });
const obj = (o: Record<string, Shape>, optional: readonly string[] = []): Shape => ({
  object: o,
  optional,
});
const oneOf = (...v: unknown[]): Shape => ({ oneOf: v });

/** Every place `value` departs from `shape`, as `path: what`. */
function violations(value: unknown, shape: Shape, path = "$"): string[] {
  if (shape === "any") return value === undefined ? [`${path}: missing`] : [];
  if (shape === "string" || shape === "number" || shape === "boolean") {
    const ok =
      shape === "string"
        ? typeof value === "string"
        : shape === "number"
          ? typeof value === "number"
          : typeof value === "boolean";
    return ok ? [] : [`${path}: expected ${shape}, got ${JSON.stringify(value)}`];
  }
  if ("nullable" in shape) return value === null ? [] : violations(value, shape.nullable, path);
  if ("oneOf" in shape)
    return shape.oneOf.includes(value)
      ? []
      : [`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(shape.oneOf)}`];
  if ("arrayOf" in shape) {
    if (!Array.isArray(value)) return [`${path}: expected an array`];
    return value.flatMap((v, i) => violations(v, shape.arrayOf, `${path}[${i}]`));
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return [`${path}: expected an object`];
  const o = value as Record<string, unknown>;
  return Object.entries(shape.object).flatMap(([k, s]) =>
    o[k] === undefined
      ? (shape.optional ?? []).includes(k)
        ? []
        : [`${path}.${k}: missing`]
      : violations(o[k], s, `${path}.${k}`),
  );
}

// ── the document's shapes ──

/** §2: the card fields, all optional, and DEC-26's three stored fields. */
const CARD = obj(
  {
    id: str,
    title: str,
    status: str,
    priority: oneOf(0, 1, 2, 3, 4),
    estimate: num,
    labels: arr(str),
    epicId: str,
    cycleId: str,
    assignee: str,
    dueDate: str,
    externalRef: obj({ system: oneOf("github", "forgejo"), id: str }, []),
    kind: str,
    change: oneOf("feature", "fix", "characterize", "refactor", "upgrade"),
    split: oneOf("spike", "path", "interface", "data", "rules"),
    hold: obj({ kind: str }),
  },
  [
    "priority",
    "estimate",
    "labels",
    "epicId",
    "cycleId",
    "assignee",
    "dueDate",
    "externalRef",
    "kind",
    "change",
    "split",
    "hold",
  ],
);
/** §3 Cycles. */
const CYCLE = obj(
  {
    id: str,
    name: str,
    startsOn: str,
    endsOn: str,
    goal: str,
    state: oneOf("planned", "active", "closed"),
    projectId: str,
  },
  ["goal", "projectId"],
);
/** §3 Board practices: `GET /api/board` gains `epics`, `cycles`, and (one project's board) `estimation`. */
const BOARD = obj(
  {
    cards: arr(CARD),
    epics: arr(
      obj({
        id: str,
        title: str,
        progress: obj({ done: num, total: num, points: num, pointsDone: num }),
      }),
    ),
    cycles: arr(CYCLE),
    estimation: oneOf("off", "points"),
  },
  ["estimation"],
);
/** §3 Chat: `PmMessage` and `PmStatus`. */
const PM_MESSAGE = obj(
  {
    id: str,
    seq: num,
    role: oneOf("user", "pm", "system"),
    text: str,
    createdAt: str,
    state: oneOf("queued", "thinking", "done", "error"),
  },
  [],
);
const PM_STATUS = obj(
  {
    phase: oneOf("idle", "waiting_for_step", "loading_pm", "thinking", "resuming_worker"),
    detail: str,
    workerPaused: bool,
    since: str,
    step: num,
    etaSeconds: num,
  },
  ["detail", "workerPaused", "since", "step", "etaSeconds"],
);
const THREAD = obj({ messages: arr(PM_MESSAGE), status: PM_STATUS });
/** §3 Approving a plan's criteria. */
const APPROVAL = obj({
  id: str,
  profile: any,
  sha256: str,
  cards: arr(
    obj(
      {
        id: str,
        title: str,
        status: str,
        approved: bool,
        blockedReason: str,
        criteria: arr(obj({ id: str, text: str })),
        examples: arr(str),
        tests: arr(
          obj({ path: str, what: oneOf("examples", "file"), approved: bool, sha256: str }),
        ),
      },
      ["blockedReason"],
    ),
  ),
});
/** §3 What Accept will ask. */
const REVIEW = obj(
  {
    findings: arr(
      obj({ id: str, verdict: str, text: str, filesRead: arr(str), modelId: str }, [
        "verdict",
        "filesRead",
        "modelId",
      ]),
    ),
    implementationFiles: arr(str),
    filesShown: arr(str),
    accept: any,
    testApprovals: any,
    review: any,
    suggestedAccepters: any,
    builtBy: any,
    escalation: any,
  },
  ["builtBy", "escalation"],
);
/** §3 Review verdicts and threads. */
const THREADS = obj(
  {
    threads: arr(
      obj(
        {
          id: str,
          cardId: str,
          at: str,
          resolved: bool,
          comments: arr(obj({ id: str, text: str, at: str }, [])),
        },
        [],
      ),
    ),
    requireResolvedThreads: bool,
  },
  [],
);
/** §3 Presence: in Solo, no viewers and no one active. */
const PRESENCE = obj({
  viewers: arr(obj({ principal: str, name: str, initials: str })),
  active: arr(str),
});
/** §3 Suggestions on an issue. */
const SUGGESTIONS = obj({
  suggestions: arr(
    obj(
      {
        id: str,
        cardId: str,
        kind: oneOf("assignee", "label", "priority", "duplicate", "split", "hold", "remove"),
        value: any,
        suggested: str,
        state: str,
      },
      [],
    ),
  ),
});

describe("the dashboard ↔ server contract (PM_CONTRACT.md; C.1)", () => {
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: { port: number; close: () => Promise<void> };
  const base = () => `http://127.0.0.1:${server.port}`;
  const get = async (path: string) => {
    const r = await fetch(`${base()}${path}`, { headers: { Accept: "application/json" } });
    return { status: r.status, body: (await r.json()) as unknown };
  };
  const send = async (method: string, path: string, body: unknown) => {
    const r = await fetch(`${base()}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base())) },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as unknown };
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-contract-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    store = new CardStore(db, log);
    await store.createCard({ id: "card_epic", tier: "epic", title: "Timesheets" });
    await store.createCard({
      id: "card_shift",
      tier: "story",
      title: "Record a shift",
      epicId: "card_epic",
      priority: 2,
      spec: "Record a shift's start and end",
    });
    await store.createCard({ id: "card_csv", tier: "task", title: "Export the week" });
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 50,
      pressureLevel: () => 1,
    });
  });
  afterAll(async () => {
    await server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("GET /api/session carries the page's write token as csrf (§3)", async () => {
    const r = await get("/api/session");
    expect(r.status).toBe(200);
    expect(violations(r.body, obj({ csrf: str }))).toEqual([]);
  });

  it("PATCH /api/cards/:id takes the section 2 fields, and GET /api/board returns them in the documented shape (§2, §3 Board practices)", async () => {
    const patched = await send("PATCH", "/api/cards/card_shift", {
      estimate: 3,
      labels: ["payroll"],
      dueDate: "2026-10-30",
      assignee: "worker",
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const cycle = await send("POST", "/api/cycles", {
      name: "Sprint 1",
      startsOn: "2026-10-05",
      endsOn: "2026-10-16",
      goal: "Shifts",
    });
    expect(cycle.status, JSON.stringify(cycle.body)).toBeLessThan(300);
    const board = await get("/api/board");
    expect(board.status).toBe(200);
    expect(violations(board.body, BOARD)).toEqual([]);
    const cards = (board.body as { cards: Record<string, unknown>[] }).cards;
    expect(cards.find((c) => c.id === "card_shift")).toMatchObject({
      priority: 2,
      estimate: 3,
      labels: ["payroll"],
      dueDate: "2026-10-30",
      epicId: "card_epic",
    });
    expect((board.body as { cycles: { name: string }[] }).cycles.map((c) => c.name)).toContain(
      "Sprint 1",
    );
    const cycles = await get("/api/cycles");
    expect(violations(cycles.body, obj({ cycles: arr(CYCLE) }))).toEqual([]);
  });

  it("GET /api/pm/thread returns { messages: PmMessage[], status: PmStatus } (§3 Chat)", async () => {
    const r = await get("/api/pm/thread?since=0");
    expect(r.status).toBe(200);
    expect(violations(r.body, THREAD)).toEqual([]);
  });

  it("GET /api/cards/:id/approval returns the plan and its hash, and 404 for an unknown card (§3 Approving)", async () => {
    const r = await get("/api/cards/card_epic/approval");
    expect(r.status).toBe(200);
    expect(violations(r.body, APPROVAL)).toEqual([]);
    expect((await get("/api/cards/card_nope/approval")).status).toBe(404);
  });

  it("GET /api/cards/:id/review returns what Accept will ask (§3 What Accept will ask)", async () => {
    const r = await get("/api/cards/card_shift/review");
    expect(r.status).toBe(200);
    expect(violations(r.body, REVIEW)).toEqual([]);
  });

  it("GET /api/cards/:id/threads returns the threads and the project's rule (§3 Review verdicts and threads)", async () => {
    const r = await get("/api/cards/card_shift/threads");
    expect(r.status).toBe(200);
    expect(violations(r.body, THREADS)).toEqual([]);
  });

  it("GET /api/presence answers no viewers in Solo (§3 Presence)", async () => {
    const r = await get("/api/presence?issue=card_shift");
    expect(r.status).toBe(200);
    expect(violations(r.body, PRESENCE)).toEqual([]);
    expect(r.body).toEqual({ viewers: [], active: [] });
  });

  it("GET /api/cards/:id/suggestions returns { suggestions } (§3 Suggestions)", async () => {
    const r = await get("/api/cards/card_shift/suggestions");
    expect(r.status).toBe(200);
    expect(violations(r.body, SUGGESTIONS)).toEqual([]);
  });

  it("GET /api/decisions returns { decisions } (§0, P2)", async () => {
    const r = await get("/api/decisions");
    expect(r.status).toBe(200);
    expect(violations(r.body, obj({ decisions: arr(obj({ id: str }, [])) }))).toEqual([]);
  });

  it("the shape checker itself catches a drift: a missing field, a wrong type and a value outside its choices", () => {
    expect(violations({ messages: [], status: { phase: "napping" } }, THREAD)).toEqual([
      '$.status.phase: "napping" is not one of ["idle","waiting_for_step","loading_pm","thinking","resuming_worker"]',
    ]);
    expect(
      violations({ cards: [{ id: 1, title: "t", status: "ready" }], epics: [], cycles: [] }, BOARD),
    ).toEqual(["$.cards[0].id: expected string, got 1"]);
    expect(violations({ viewers: [] }, PRESENCE)).toEqual(["$.active: missing"]);
  });
});
