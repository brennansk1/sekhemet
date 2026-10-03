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
import { pageWriteHeaders } from "./page_headers.js";

/**
 * design-stage §2.9 item 7 (close-out C3): the approver of a Stakeholder's
 * plan can approve it, edit it, or ask a question in the plan's thread. A
 * question and its answer are messages between the two of them on the sent
 * plan — the words private to the ledger, each with its author — shown with
 * the plan to both, and the question waits in the sender's Inbox under
 * *Needs you* until they answer. Nothing is created by a question. A real
 * git repository, an on-disk ledger and the real Team-configured HTTP server
 * with five people at four levels (the approver one who may create a project, an
 * Admin, since TEAM-57) (DEFINITION_OF_DONE §2A); no model is loaded.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanup.length) await (cleanup.pop() as () => Promise<void> | void)();
});

const PEOPLE = [
  ["p_admin", "admin", "Ada Admin"],
  ["p_mo", "admin", "Mo Admin"],
  ["p_member2", "member", "Mia Member"],
  ["p_stake", "stakeholder", "Sam Stakeholder"],
  ["p_viewer", "viewer", "Vic Viewer"],
] as const;

async function setup() {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-plan-approval-"));
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
  for (const [principal, level, name] of PEOPLE) {
    log.appendNow({
      actor: "system",
      type: "person/created",
      principal,
      payload: { principal },
      private: { name },
    });
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
  // The Stakeholder's own conversation: Seshat's reply is to them (PM-N9-8).
  const reply = await new PmStore(log).appendReply({
    replyTo: [],
    text: "Here is the plan.",
    proposals: draft ? [draft] : [],
    to: "p_stake",
  });
  const proposalId = reply.proposals?.[0]?.id as string;
  // A reply recorded without the person it answers: no one's conversation.
  const unaddressed = await new PmStore(log).appendReply({
    replyTo: [],
    text: "A plan.",
    proposals: draft ? [draft] : [],
  });
  const unaddressedId = unaddressed.proposals?.[0]?.id as string;
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
  const call = async (who: string, method: string, path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(await pageWriteHeaders(`http://127.0.0.1:${server.port}`)),
        "X-Test-Principal": who,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const send = (who: string, body: unknown) =>
    call(who, "POST", `/api/pm/proposals/${proposalId}/send-for-approval`, body);
  const approve = (who: string, body: unknown = {}) =>
    call(who, "POST", `/api/pm/proposals/${proposalId}/approve`, body);
  const threadProposal = async (who: string) => {
    const r = await call(who, "GET", "/api/pm/thread");
    const { messages } = (await r.json()) as {
      messages: { proposals?: { id: string; approval?: Record<string, unknown> }[] }[];
    };
    return messages.flatMap((m) => m.proposals ?? []).find((p) => p.id === proposalId);
  };
  const created = async () => ({
    cards: (await cardStore.listCards()).length,
    projects: cardStore.listProjects().length,
    briefs: (await log.getEventsByTypes(["brief/accepted"])).length,
  });
  return {
    cardStore,
    log,
    call,
    send,
    approve,
    threadProposal,
    created,
    proposalId,
    unaddressedId,
  };
}

type Thread = { id: string; by: string; byName?: string; text: string; at: string }[];

const ask = (s: Awaited<ReturnType<typeof setup>>, who: string, text: unknown) =>
  s.call(who, "POST", `/api/pm/proposals/${s.proposalId}/comments`, { text });

describe("design-stage §2.9 item 7: the approver asks a question in the plan's thread", () => {
  it("records the approver's question and the sender's answer, shown to both with the plan", async () => {
    const s = await setup();
    // Not sent yet: there is no thread.
    expect((await ask(s, "p_stake", "Anything?")).status).toBe(409);
    expect((await s.send("p_stake", { approver: "p_mo" })).status).toBe(200);

    const q = await ask(s, "p_mo", "Why is search in the first release?");
    expect(q.status).toBe(200);
    const body = (await q.json()) as { proposal: { approval: { thread: Thread } } };
    expect(body.proposal.approval.thread).toEqual([
      expect.objectContaining({
        by: "p_mo",
        byName: "Mo Admin",
        text: "Why is search in the first release?",
      }),
    ]);
    // The words are private: the hashed payload names the plan and the message only.
    const [recorded] = await s.log.getEventsByTypes(["plan/commented"]);
    expect(recorded?.principal).toBe("p_mo");
    expect(recorded?.actor).toBe("human");
    expect(recorded?.payload).toEqual({
      proposalId: s.proposalId,
      id: expect.stringMatching(/^pcm_/),
    });
    expect(JSON.stringify(recorded?.payload)).not.toContain("search");

    // The sender reads it with the plan, and it waits in their Inbox until they answer.
    expect((await s.threadProposal("p_stake"))?.approval?.thread).toMatchObject([
      { byName: "Mo Admin", text: "Why is search in the first release?" },
    ]);
    const inbox = async (who: string) =>
      (
        (await (await s.call(who, "GET", "/api/inbox?filter=inbox")).json()) as {
          items: { kind: string; reason: string; by?: string; answered?: boolean }[];
        }
      ).items;
    expect((await inbox("p_stake")).find((i) => i.kind === "plan_question")).toMatchObject({
      reason: "needs_you",
      by: "Mo Admin",
    });

    const a = await ask(s, "p_stake", "Customers asked for it first.");
    expect(a.status).toBe(200);
    const thread = (await s.threadProposal("p_mo"))?.approval?.thread as Thread;
    expect(thread.map((m) => [m.by, m.text])).toEqual([
      ["p_mo", "Why is search in the first release?"],
      ["p_stake", "Customers asked for it first."],
    ]);
    // Answered: it leaves the sender's Needs you; the approver's item says it was answered.
    expect((await inbox("p_stake")).some((i) => i.kind === "plan_question")).toBe(false);
    expect((await inbox("p_mo")).find((i) => i.kind === "plan_approval")).toMatchObject({
      answered: true,
      by: "Sam Stakeholder",
    });
    // A question creates nothing.
    expect(await s.created()).toEqual({ cards: 0, projects: 0, briefs: 0 });
  });

  it("is the approver's and the sender's alone, needs words, and closes once approved", async () => {
    const s = await setup();
    expect((await s.send("p_stake", { approver: "p_mo" })).status).toBe(200);
    for (const who of ["p_member2", "p_admin", "p_viewer"]) {
      const r = await ask(s, who, "Me too?");
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error: string }).error).toBe(
        "Only Mo Admin and Sam Stakeholder write in this plan's thread.",
      );
    }
    for (const text of ["", "   ", 42, undefined]) {
      expect((await ask(s, "p_mo", text)).status).toBe(400);
    }
    expect(await s.log.getEventsByTypes(["plan/commented"])).toEqual([]);
    expect((await s.approve("p_mo")).status).toBe(200);
    const closed = await ask(s, "p_mo", "One more thing");
    expect(closed.status).toBe(409);
    expect(((await closed.json()) as { error: string }).error).toBe(
      "This plan is already approved.",
    );
  });
});
