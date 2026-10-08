import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { BoardServiceImpl } from "@sekhemet/board";
import type { CardStore, EventLog } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initLocalKernel } from "../src/index.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * The New issue form and the split route over HTTP (kernel K-N6-1; C2d
 * findings routed to C5): a real Solo dashboard server
 * (`startDashboardServer`) over the kernel the server command opens
 * (`initLocalKernel`: entry conditions on), in a real git repository.
 */

let repo: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;
let board: BoardServiceImpl;
let server: Awaited<ReturnType<typeof startDashboardServer>> | undefined;
let base: string;

beforeEach(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "sek-c5-routes-")));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "ada@example.com");
  git("config", "user.name", "Ada Lovelace");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "");
  writeFileSync(join(repo, ".gitignore"), ".sekhemet/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  const k = initLocalKernel(repo);
  db = k.db;
  log = k.log;
  store = k.cardStore;
  board = k.boardService;
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
});

afterEach(async () => {
  await server?.close();
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

async function post(path: string, body: unknown) {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("an issue filed from the New issue form has an owner (K-N6-1)", () => {
  it("K-N6-1: the New issue form outside triage (POST /api/pm/create-card, then Apply): the person who filed it is the planned issue's owner, recorded in card/created", async () => {
    const asked = await post("/api/pm/create-card", {
      title: "Export the monthly totals as CSV",
      description: "One CSV file with a row per month and its total in cents.",
    });
    expect(asked.status).toBe(200);
    const proposal = asked.body.proposal as { id: string };
    const applied = await post(`/api/pm/proposals/${proposal.id}/apply`, {});
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const made = (await store.listCards()).find(
      (c) => c.title === "Export the monthly totals as CSV" && c.tier !== "epic",
    );
    expect(made).toBeDefined();
    const [created] = await store.cardEvents(made?.id as string, ["card/created"]);
    expect((created?.payload as { owner?: string | null }).owner).toBe(log.localPrincipal());
    expect((await store.getCard(made?.id as string))?.owner).toBe(log.localPrincipal());
  });

  it("K-N6-1: an issue filed through the project's card route (the form in triage, the API) has its filer as owner, recorded in card/created, with no delegate", async () => {
    const project =
      store.listProjects()[0]?.id ??
      (await store.ensureProject({ name: "repo", rootPath: repo })).id;
    const filed = await post(`/api/projects/${project}/cards`, { title: "Round minutes" });
    expect(filed.status).toBe(201);
    const id = (filed.body.card as { id: string }).id;
    const [created] = await store.cardEvents(id, ["card/created"]);
    const payload = created?.payload as { owner?: string | null; delegate?: unknown };
    expect(payload.owner).toBe(log.localPrincipal());
    expect(payload.delegate ?? null).toBeNull();
    expect((await store.getCard(id))?.owner).toBe(log.localPrincipal());
  });
});

describe("a refused split answers with its reason, not a server error", () => {
  it("PM-P1-7: a split whose parts leave a criterion uncovered answers 409 with the refusal sentence, and nothing is created", async () => {
    await store.createCard({
      id: "card_split",
      tier: "story",
      title: "Timesheet totals",
      status: "backlog",
      acceptanceCriteria: ["Totals round to the nearest minute"],
    });
    const before = (await store.listCards()).length;
    const r = await post("/api/cards/card_split/split", {
      parts: [{ title: "Alpha" }, { title: "Beta" }],
    });
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toMatch(/doesn't cover every criterion/);
    expect((await store.listCards()).length).toBe(before);
  });
});
