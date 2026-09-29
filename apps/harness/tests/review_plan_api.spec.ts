import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { toProposals, withProjectGroups } from "../src/pm/agent.js";
import { type ProjectGroup, draftProjectGroup } from "../src/pm/pipeline.js";
import { PmStore } from "../src/pm/store.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * design-stage DS-P2-7 through the server (PM_CONTRACT §3): Review plan
 * sends the person's choices with Apply, and the project created honours
 * them. A real git repository, an on-disk ledger and the real HTTP server
 * (DEFINITION_OF_DONE §2A); no model is loaded.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanup.length) await (cleanup.pop() as () => Promise<void> | void)();
});

describe("POST /api/pm/proposals/:id/apply carries Review plan's choices", () => {
  it("a candidate the person removed is not planned", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "sek-rp-api-"));
    cleanup.push(() => rmSync(repoPath, { recursive: true, force: true }));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repoPath, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "e@x");
    git("config", "user.name", "E");
    git("commit", "-q", "--allow-empty", "-m", "chore: empty");
    mkdirSync(join(repoPath, ".sekhemet"), { recursive: true });
    const db = new DatabaseSync(join(repoPath, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const cardStore = new CardStore(db, log);
    const pmStore = new PmStore(log);
    const [draft] = await withProjectGroups(
      toProposals(
        [
          {
            id: "1",
            name: "start_project",
            arguments: {
              brief:
                "A CLI that syncs my notes to S3. It lists what changed. It restores a deleted note.",
              reason: "you asked for it",
            },
          },
        ],
        [],
      ),
      (x) => draftProjectGroup({ repoPath, cardStore, log }, x),
    );
    const group = draft?.patch?.group as ProjectGroup;
    const removed = group.candidates.at(-1);
    const kept = group.candidates[0];
    if (!removed || !kept || removed === kept) throw new Error("expected two candidates");
    const reply = await pmStore.appendReply({
      replyTo: [],
      text: "x",
      proposals: draft ? [draft] : [],
    });
    const id = reply.proposals?.[0]?.id as string;

    const server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cardStore),
      cardStore,
      repoPath,
      port: 0,
      streamIntervalMs: 50,
      pressureLevel: () => 1,
    });
    cleanup.push(() => server.close());
    const res = await fetch(`http://127.0.0.1:${server.port}/api/pm/proposals/${id}/apply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await pageWriteHeaders(`http://127.0.0.1:${server.port}`)),
      },
      body: JSON.stringify({ choices: { remove: [removed.key], releaseLine: 1 } }),
    });
    expect(res.status).toBe(200);
    const titles = (await cardStore.requirements.list()).map((r) => r.title);
    expect(titles).toContain(kept.title);
    expect(titles).not.toContain(removed.title);
  });

  it("refuses choices that are not the documented shape", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "sek-rp-api-"));
    cleanup.push(() => rmSync(repoPath, { recursive: true, force: true }));
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    const cardStore = new CardStore(db, log);
    const pmStore = new PmStore(log);
    const [draft] = toProposals(
      [{ id: "1", name: "start_project", arguments: { brief: "a calculator", reason: "r" } }],
      [],
    );
    const reply = await pmStore.appendReply({
      replyTo: [],
      text: "x",
      proposals: draft ? [draft] : [],
    });
    const server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cardStore),
      cardStore,
      repoPath,
      port: 0,
      streamIntervalMs: 50,
      pressureLevel: () => 1,
    });
    cleanup.push(() => server.close());
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/pm/proposals/${reply.proposals?.[0]?.id}/apply`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await pageWriteHeaders(`http://127.0.0.1:${server.port}`)),
        },
        body: JSON.stringify({ choices: { remove: "everything" } }),
      },
    );
    expect(res.status).toBe(400);
    expect(await cardStore.listCards()).toHaveLength(0);
    // A Type that is not one of the depth profiles is refused, never replaced silently.
    const typed = await fetch(
      `http://127.0.0.1:${server.port}/api/pm/proposals/${reply.proposals?.[0]?.id}/apply`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await pageWriteHeaders(`http://127.0.0.1:${server.port}`)),
        },
        body: JSON.stringify({ choices: { type: "enterprise grade" } }),
      },
    );
    expect(typed.status).toBe(400);
    expect(((await typed.json()) as { error: string }).error).toMatch(/type/);
    expect(await cardStore.listCards()).toHaveLength(0);
  });
});
