import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { handleProjectDoneRoute } from "../src/project_done.js";

// The story map before any brief is accepted (sweep 2 of the dashboard, wave 2
// B8; S1A-A28): `GET /api/story-map` answered 404, so every visit to the
// story map logged a failed request in the browser's console (§2.15.5 asks for
// an empty one). No accepted brief yet is an answer, `null`, not a missing
// resource; a named project that is missing, or hidden, is still 404 (PM-N9-8).
const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function setup() {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-storymap-"));
  dirs.push(repoPath);
  const db = new DatabaseSync(join(repoPath, "events.db"));
  dbs.push(db);
  initSchema(db);
  const log = new EventLog(db);
  return { repoPath, log, cardStore: new CardStore(db, log) };
}

async function get(k: ReturnType<typeof setup>, url: string, canSee?: (p?: string) => boolean) {
  const out: { status?: number; body?: unknown } = {};
  await handleProjectDoneRoute(
    { method: "GET", headers: {} } as IncomingMessage,
    {} as ServerResponse,
    url,
    {
      repoPath: k.repoPath,
      kernel: k,
      json: (_res, status, body) => {
        out.status = status;
        out.body = body;
      },
      isTrustedMutation: () => true,
      readJsonBody: async () => ({}),
      ...(canSee ? { canSee: (_req: IncomingMessage, p: string | undefined) => canSee(p) } : {}),
    },
  );
  return out;
}

describe("GET /api/story-map with no accepted brief (wave 2 B8)", () => {
  it("answers 200 with null, so the story map's first read is no failed request", async () => {
    const k = setup();
    await k.cardStore.ensureProject({ rootPath: k.repoPath, name: "Timesheets" });
    expect(await get(k, "/api/story-map")).toEqual({ status: 200, body: null });
  });

  it("still answers 404 for a named project that does not exist", async () => {
    const k = setup();
    const r = await get(k, "/api/story-map/proj_missing");
    expect(r.status).toBe(404);
  });
});
