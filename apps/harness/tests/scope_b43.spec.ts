import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { handlePlanApprovalRoute } from "../src/plan_approval.js";
import { handleProjectDoneRoute } from "../src/project_done.js";

// PM-N9-8 (B4.3 review B): in the Team setup the story map, a slice's report
// and a card's approval view answer only for projects the person can see; a
// hidden one reads exactly as a missing one (404, nothing of it in the body).
const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function setup() {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-scope-"));
  dirs.push(repoPath);
  const db = new DatabaseSync(join(repoPath, "events.db"));
  dbs.push(db);
  initSchema(db);
  const log = new EventLog(db);
  return { repoPath, log, cardStore: new CardStore(db, log) };
}

function call() {
  const out: { status?: number; body?: unknown } = {};
  const json = (_res: ServerResponse, status: number, body: unknown) => {
    out.status = status;
    out.body = body;
  };
  const req = { method: "GET", headers: {} } as IncomingMessage;
  return { out, json, req, res: {} as ServerResponse };
}

describe("PM-N9-8: the planning views are scoped to what the person can see", () => {
  it("answers a hidden project's story map and slice report as missing", async () => {
    const k = setup();
    const hidden = (await k.cardStore.ensureProject({ rootPath: k.repoPath, name: "Secret" })).id;
    const slice = await k.cardStore.slices.create(
      { projectId: hidden, title: "Secret slice", appetite: { cards: 3 } },
      "p_owner",
    );
    const canSee = (_req: IncomingMessage, project: string | undefined) => project !== hidden;
    for (const url of [`/api/story-map/${hidden}`, `/api/slices/${slice.id}/report`]) {
      const c = call();
      await handleProjectDoneRoute(c.req, c.res, url, {
        repoPath: k.repoPath,
        kernel: k,
        json: c.json,
        isTrustedMutation: () => true,
        readJsonBody: async () => ({}),
        canSee,
      });
      expect({ url, status: c.out.status }).toEqual({ url, status: 404 });
      expect(JSON.stringify(c.out.body)).not.toMatch(/Secret/);
    }
  });

  it("answers a hidden card's approval view as a missing card", async () => {
    const k = setup();
    const hidden = (await k.cardStore.ensureProject({ rootPath: k.repoPath, name: "Secret" })).id;
    await k.cardStore.createCard({
      id: "card_secret",
      tier: "story",
      title: "Secret card",
      status: "planning",
      projectId: hidden,
    });
    const c = call();
    await handlePlanApprovalRoute(c.req, c.res, "/api/cards/card_secret/approval", {
      repoPath: k.repoPath,
      cardStore: k.cardStore,
      log: k.log,
      boardService: new BoardServiceImpl(k.cardStore),
      json: c.json,
      readJsonBody: async () => ({}),
      trusted: () => true,
      principalOf: () => "p_viewer",
      canSee: (_req, project) => project !== hidden,
    });
    expect(c.out.status).toBe(404);
    expect(c.out.body).toEqual({ error: "No card card_secret" });
  });
});
