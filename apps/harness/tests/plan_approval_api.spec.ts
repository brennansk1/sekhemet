import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { routePermissions } from "../src/team/access.js";
import { planCommand } from "../src/wave2.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * PM-N7-5 on the dashboard (planner-pm §2.17): a person who plans with Seshat
 * or the dashboard approves a plan's criteria there, as `sekhemet approve`
 * does — `GET /api/cards/:id/approval` shows what is to be approved with its
 * SHA-256, `POST /api/cards/:id/approve` records the person's approval at
 * that SHA-256 and moves the cards out of Planning. A Member's `issue.edit`;
 * a stale hash is a 409. Real git repository, real ledger, real HTTP server.
 */
const MEMBER = "p_member";
const STAKE = "p_stake";
const VIEWER = "p_viewer";

let repo: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;
let server: { port: number; close: () => Promise<void> } | undefined;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "sek-approve-api-"));
  const w = (rel: string, text: string) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
  };
  w("package.json", JSON.stringify({ name: "recipes", devDependencies: { vitest: "^3.0.0" } }));
  w("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: init");
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db);
  store = new CardStore(db, log);
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

function joined(principal: string, level: string): void {
  log.appendNow({
    actor: "system",
    type: "member/joined",
    principal,
    payload: { principal, level, via: "invite", pending: false },
  });
}

async function planned(): Promise<string> {
  const boardService = new BoardServiceImpl(store, { entryConditions: true });
  const r = await planCommand(
    { repoPath: repo, log, cardStore: store, boardService },
    "Save a recipe with its title and list the saved recipes.",
    { print: () => undefined },
  );
  expect(r.created).toBeGreaterThan(0);
  return r.epicId;
}

async function start(): Promise<void> {
  joined("p_admin", "admin");
  joined(MEMBER, "member");
  joined(STAKE, "stakeholder");
  joined(VIEWER, "viewer");
  server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(store, { entryConditions: true }),
    cardStore: store,
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
}

const url = (path: string) => `http://127.0.0.1:${server?.port}${path}`;
async function send(who: string, path: string, body: unknown, action = true) {
  const res = await fetch(url(path), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Test-Principal": who,
      ...(action ? await pageWriteHeaders(url("")) : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}
async function shown(who: string, id: string) {
  const res = await fetch(url(`/api/cards/${id}/approval`), {
    headers: { "X-Test-Principal": who },
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

describe("PM-N7-5 on the dashboard: GET /approval, POST /approve", () => {
  it("shows the criteria to approve with their SHA-256, and a Member's approval at that SHA-256 releases the plan", async () => {
    const epicId = await planned();
    await start();
    const planned0 = await store.listCards({ parentId: epicId });
    expect(planned0.every((c) => c.status === "planning")).toBe(true);

    const view = await shown(VIEWER, epicId);
    expect(view.status).toBe(200);
    expect(view.data.profile).toBe("internal tool");
    expect(view.data.sha256).toMatch(/^[0-9a-f]{64}$/);
    const cards = view.data.cards as {
      id: string;
      criteria: { id: string }[];
      approved: boolean;
    }[];
    expect(cards.map((c) => c.id).sort()).toEqual(planned0.map((c) => c.id).sort());
    expect(cards[0]?.criteria[0]?.id).toMatch(/\.c1$/);
    expect(cards.every((c) => !c.approved)).toBe(true);

    // A stale hash: nothing is recorded.
    const stale = await send(MEMBER, `/api/cards/${epicId}/approve`, { sha256: "0".repeat(64) });
    expect(stale.status).toBe(409);
    expect((stale.data.current as { sha256: string }).sha256).toBe(view.data.sha256);
    for (const c of planned0) expect(store.stagedTests.criteriaApproval(c.id).approved).toBe(false);

    // Without the hash it saw, no approval either.
    expect((await send(MEMBER, `/api/cards/${epicId}/approve`, {})).status).toBe(400);

    const ok = await send(MEMBER, `/api/cards/${epicId}/approve`, { sha256: view.data.sha256 });
    expect(ok.status).toBe(200);
    expect((ok.data.approved as string[]).sort()).toEqual(planned0.map((c) => c.id).sort());
    for (const c of await store.listCards({ parentId: epicId })) {
      // Recorded with the principal of the person who approved.
      expect(store.stagedTests.criteriaApproval(c.id)).toMatchObject({
        approved: true,
        principal: MEMBER,
      });
      if (c.status === "planning") expect(c.blockedReason).not.toMatch(/approval of its criteria/);
    }
    const after = await shown(MEMBER, planned0[0]?.id as string);
    expect((after.data.cards as { approved: boolean }[])[0]?.approved).toBe(true);
  });

  it("refuses a Viewer and a Stakeholder with 403, and a write without the dashboard's header", async () => {
    const epicId = await planned();
    await start();
    const { data } = await shown(MEMBER, epicId);
    for (const who of [VIEWER, STAKE]) {
      const r = await send(who, `/api/cards/${epicId}/approve`, { sha256: data.sha256 });
      expect(r.status, who).toBe(403);
      expect(r.data.permission, who).toBe("issue.edit");
    }
    const forged = await send(
      MEMBER,
      `/api/cards/${epicId}/approve`,
      { sha256: data.sha256 },
      false,
    );
    expect(forged.status).toBe(403);
    for (const c of await store.listCards({ parentId: epicId })) {
      expect(store.stagedTests.criteriaApproval(c.id).approved).toBe(false);
      expect(c.status).toBe("planning");
    }
    expect(routePermissions("POST", `/api/cards/${epicId}/approve`, {})?.permissions).toEqual([
      "issue.edit",
    ]);
  });

  it("answers 404 for a card that does not exist", async () => {
    await start();
    expect((await shown(MEMBER, "card_nope")).status).toBe(404);
    expect((await send(MEMBER, "/api/cards/card_nope/approve", { sha256: "x" })).status).toBe(404);
  });
});
