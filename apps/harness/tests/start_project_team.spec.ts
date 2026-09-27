import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { toProposals, withProjectGroups } from "../src/pm/agent.js";
import { draftProjectGroup } from "../src/pm/pipeline.js";
import { PmStore } from "../src/pm/store.js";
import { startDashboardServer } from "../src/server.js";

/**
 * Teams item 6 and design-stage §2.9 item 7 (B4.4 review): in the Team setup
 * applying a new project's group accepts its brief, so it needs `brief.accept`
 * (an Admin, before any project has a lead) as well as `proposal.apply`; a
 * Member's Apply creates nothing. A real git repository, an on-disk ledger and
 * the real HTTP server (DEFINITION_OF_DONE §2A); no model is loaded.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanup.length) await (cleanup.pop() as () => Promise<void> | void)();
});

async function setup() {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-start-team-"));
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
  for (const [principal, level] of [
    ["p_admin", "admin"],
    ["p_member", "member"],
  ]) {
    log.appendNow({
      actor: "system",
      type: "member/joined",
      principal,
      payload: { principal, level, via: "invite", pending: false },
    });
  }
  const [draft] = await withProjectGroups(
    toProposals(
      [
        {
          id: "1",
          name: "start_project",
          arguments: { brief: "build me a calculator", reason: "r" },
        },
      ],
      [],
    ),
    (x) => draftProjectGroup({ repoPath, cardStore, log }, x),
  );
  const reply = await new PmStore(log).appendReply({
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
    streamIntervalMs: 10_000,
    setup: "team",
    requester: (req) => {
      const h = req.headers["x-test-principal"];
      return typeof h === "string" && h ? h : undefined;
    },
    pressureLevel: () => 1,
  });
  cleanup.push(() => server.close());
  const apply = (who: string) =>
    fetch(`http://127.0.0.1:${server.port}/api/pm/proposals/${reply.proposals?.[0]?.id}/apply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sekhemet-Action": "1",
        "X-Test-Principal": who,
      },
      body: JSON.stringify({ choices: {} }),
    });
  return { cardStore, log, apply };
}

describe("Team setup: a new project's group is created by one who may accept its brief", () => {
  it("refuses a Member's Apply with 403 naming brief.accept, and creates nothing", async () => {
    const s = await setup();
    const res = await s.apply("p_member");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { permission?: string }).permission).toBe("brief.accept");
    expect(await s.cardStore.listCards()).toHaveLength(0);
    expect(await s.log.getEventsByTypes(["brief/accepted"])).toHaveLength(0);
  });

  it("an Admin's Apply creates the project", async () => {
    const s = await setup();
    const res = await s.apply("p_admin");
    expect(res.status).toBe(200);
    expect(await s.log.getEventsByTypes(["brief/accepted"])).toHaveLength(1);
  });
});
