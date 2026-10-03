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
 * teams TEAM-20 and TEAM-42 (B4.11, NEW-teams-6; design-stage §2.9 item 7):
 * a Stakeholder's finished project conversation is sent for approval to a
 * named person who may create a project — an Admin, or a person who leads a
 * project (TEAM-57 amends TEAM-20's Member or Admin; DEC-57) — instead of
 * being created; nothing exists until that
 * person approves it, and the issues the approved plan creates are theirs,
 * their owner changeable afterwards. A real git repository, an on-disk
 * ledger and the real Team-configured HTTP server with five people at four
 * levels (DEFINITION_OF_DONE §2A); no model is loaded.
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

const NOTHING = { cards: 0, projects: 0, briefs: 0 };

describe("TEAM-20: a Stakeholder sends the plan for approval; nothing exists before it", () => {
  it("records the send to a named approver, and creates no project, issue or brief", async () => {
    const s = await setup();
    // A Stakeholder cannot create the project directly.
    const direct = await s.call("p_stake", "POST", `/api/pm/proposals/${s.proposalId}/apply`, {
      choices: {},
    });
    expect(direct.status).toBe(403);
    // The approver does not see a draft that was not sent (design-stage §2.9 item 1).
    expect(await s.threadProposal("p_mo")).toBeUndefined();

    const res = await s.send("p_stake", {
      approver: "p_mo",
      choices: { type: "prototype", releaseLine: 1 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proposal: { approval: Record<string, unknown> } };
    expect(body.proposal.approval).toMatchObject({
      state: "sent",
      approver: "p_mo",
      approverName: "Mo Admin",
      requestedBy: "p_stake",
    });
    const [sent] = await s.log.getEventsByTypes(["plan/sent_for_approval"]);
    expect(sent?.principal).toBe("p_stake");
    expect(sent?.payload).toMatchObject({ proposalId: s.proposalId, approver: "p_mo" });
    expect(await s.created()).toEqual(NOTHING);

    // Both see it, with its state; the named approver now reads it in their thread.
    expect((await s.threadProposal("p_stake"))?.approval).toMatchObject({ state: "sent" });
    expect((await s.threadProposal("p_mo"))?.approval).toMatchObject({
      state: "sent",
      requestedByName: "Sam Stakeholder",
    });
    // Another Member does not.
    expect(await s.threadProposal("p_member2")).toBeUndefined();
  });

  it("refuses an approver below Member or who may not create a project, a second send, and a Viewer's send", async () => {
    const s = await setup();
    // TEAM-57: a Member who leads no project cannot approve a new project's plan.
    for (const approver of ["p_viewer", "p_stake", "p_nobody", "p_member2"]) {
      const r = await s.send("p_stake", { approver });
      expect(r.status).toBe(400);
    }
    expect((await s.send("p_viewer", { approver: "p_mo" })).status).toBe(403);
    expect((await s.send("p_stake", { approver: "p_mo" })).status).toBe(200);
    expect((await s.send("p_stake", { approver: "p_admin" })).status).toBe(409);
    expect(await s.log.getEventsByTypes(["plan/sent_for_approval"])).toHaveLength(1);
    expect(await s.created()).toEqual(NOTHING);
  });

  it("cannot be applied or discarded around the named approver (T2)", async () => {
    const s = await setup();
    await s.send("p_stake", { approver: "p_mo" });
    const act = (who: string, verb: "apply" | "discard") =>
      s.call(who, "POST", `/api/pm/proposals/${s.proposalId}/${verb}`, { choices: {} });
    // An Admin holds proposal.apply and brief.accept, yet the plan is Mo's to approve.
    const applied = await act("p_admin", "apply");
    expect(applied.status).toBe(409);
    expect(((await applied.json()) as { error: string }).error).toMatch(/Mo Admin/);
    // The approver too: Approve, not Apply, creates it (refused by level or by the send).
    expect([403, 409]).toContain((await act("p_mo", "apply")).status);
    expect((await act("p_admin", "discard")).status).toBe(403);
    expect((await act("p_member2", "discard")).status).toBe(403);
    expect(await s.created()).toEqual(NOTHING);
    expect((await s.threadProposal("p_mo"))?.approval).toMatchObject({ state: "sent" });
    // The approver may decline it.
    expect((await act("p_mo", "discard")).status).toBe(200);
  });

  it("refuses to send a plan that is no one's conversation in the Team setup (T2)", async () => {
    const s = await setup();
    const r = await s.call(
      "p_stake",
      "POST",
      `/api/pm/proposals/${s.unaddressedId}/send-for-approval`,
      { approver: "p_mo" },
    );
    expect(r.status).toBe(403);
    expect(await s.log.getEventsByTypes(["plan/sent_for_approval"])).toHaveLength(0);
  });

  it("is approved only by the person it names, at Member or above", async () => {
    const s = await setup();
    expect((await s.approve("p_mo")).status).toBe(409); // not sent yet
    await s.send("p_stake", { approver: "p_mo" });
    expect((await s.approve("p_member2")).status).toBe(403);
    expect((await s.approve("p_stake")).status).toBe(403);
    expect(await s.created()).toEqual(NOTHING);
    expect(await s.log.getEventsByTypes(["plan/approved"])).toHaveLength(0);
  });
});

describe("TEAM-42: the approver owns the issues the approved plan creates", () => {
  it("creates the project with the Stakeholder's choices, each issue owned by the approver", async () => {
    const s = await setup();
    await s.send("p_stake", { approver: "p_mo", choices: { type: "prototype" } });
    const res = await s.approve("p_mo");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      proposal: { state: string; approval: Record<string, unknown> };
      cards: { id: string }[];
    };
    expect(body.proposal.state).toBe("applied");
    expect(body.proposal.approval).toMatchObject({ state: "approved", approvedBy: "p_mo" });
    const after = await s.created();
    expect(after.projects).toBe(1);
    expect(after.briefs).toBe(1);
    const [approved] = await s.log.getEventsByTypes(["plan/approved"]);
    expect(approved?.principal).toBe("p_mo");
    const project = s.cardStore.listProjects()[0];
    expect(approved?.payload).toMatchObject({ proposalId: s.proposalId, projectId: project?.id });
    // The Stakeholder's Type was kept.
    expect(s.cardStore.depthProfiles.of(project?.id).profile).toBe("prototype");
    const cards = await s.cardStore.listCards();
    expect(cards.length).toBeGreaterThan(2);
    for (const c of cards) expect(c.owner).toBe("p_mo");
    // A second approval creates nothing more.
    expect((await s.approve("p_mo")).status).toBe(409);
    expect((await s.cardStore.listCards()).length).toBe(cards.length);
  });

  it("the approver's edits are what is created, and the owner can be changed afterwards", async () => {
    const s = await setup();
    await s.send("p_stake", { approver: "p_admin", choices: { type: "prototype" } });
    expect((await s.approve("p_admin", { choices: { type: "internal tool" } })).status).toBe(200);
    const project = s.cardStore.listProjects()[0];
    expect(s.cardStore.depthProfiles.of(project?.id).profile).toBe("internal tool");
    const card = (await s.cardStore.listCards()).find((c) => c.tier !== "epic");
    expect(card?.owner).toBe("p_admin");
    // The assignee picker sends the person as it reads them: their principal.
    const moved = await s.call("p_admin", "PATCH", `/api/cards/${card?.id}`, {
      assignee: "p_member2",
    });
    expect(moved.status).toBe(200);
    expect((await s.cardStore.getCard(card?.id as string))?.owner).toBe("p_member2");
    const [changed] = await s.log
      .getEventsByTypes(["card/owner_changed"])
      .then((e) => e.filter((x) => (x.payload as { to?: string }).to === "p_member2"));
    expect(changed?.principal).toBe("p_admin");
  });
});
