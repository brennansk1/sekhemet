import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { startDashboardServer } from "../src/server.js";
import {
  ACTIONS,
  Access,
  recordLabelChange,
  recordLevelChange,
  routePermissions,
} from "../src/team/access.js";

/**
 * teams NEW-teams-2 (TEAM-4, 5, 6, 7, 32) and integrations INT-22 to INT-25:
 * what a person may do, from the member projection on a real ledger, enforced
 * on a real HTTP server in both setups.
 */

let repo: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;
let server: { port: number; close: () => Promise<void> } | undefined;

const ADMIN = "p_admin";
const LEAD = "p_lead";
const MEMBER = "p_member";
const STAKE = "p_stake";
const VIEWER = "p_viewer";

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

function joined(principal: string, level: string, pending = false): void {
  log.appendNow({
    actor: "system",
    type: "member/joined",
    principal,
    payload: { principal, level, via: "invite", pending },
  });
}

async function refusals(): Promise<
  { principal: string | null; payload: Record<string, unknown> }[]
> {
  return (await log.getEventsByTypes(["access/refused"])).map((e) => ({
    principal: e.principal ?? null,
    payload: e.payload as Record<string, unknown>,
  }));
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "sek-team-access-"));
  // A run the server would launch starts an empty script, never a Worker.
  writeFileSync(join(repo, "noop.mjs"), "");
  process.env.SEKHEMET_CLI = join(repo, "noop.mjs");
  db = new DatabaseSync(join(repo, "events.db"));
  initSchema(db);
  log = new EventLog(db);
  store = new CardStore(db, log);
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  Reflect.deleteProperty(process.env, "SEKHEMET_CLI");
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

describe("the member projection and the action table", () => {
  it("reads levels, approval, removal and a per-project override from the ledger (TEAM-6)", async () => {
    joined(ADMIN, "admin");
    joined(MEMBER, "member");
    joined(VIEWER, "viewer");
    joined("p_pending", "member", true);
    const access = new Access({ db, setup: "team", localPrincipal: () => log.localPrincipal() });
    expect(access.level(MEMBER)).toBe("member");
    expect(access.level("p_pending")).toBeUndefined();
    expect(access.can("p_pending", "read")).toBe(false);

    log.appendNow({
      actor: "human",
      type: "member/approved",
      principal: ADMIN,
      payload: { principal: "p_pending" },
    });
    expect(access.level("p_pending")).toBe("member");

    // An Admin raises the Viewer to Member on one project only.
    await recordLevelChange(log, access, {
      by: ADMIN,
      principal: VIEWER,
      level: "member",
      project: "proj_a",
    });
    expect(access.level(VIEWER, "proj_a")).toBe("member");
    expect(access.level(VIEWER, "proj_b")).toBe("viewer");
    expect(access.level(VIEWER)).toBe("viewer");
    expect(access.can(VIEWER, "review", "proj_a")).toBe(true);
    expect(access.can(VIEWER, "review", "proj_b")).toBe(false);
    const changed = (await log.getEventsByTypes(["member/level_changed"])).at(-1);
    expect(changed?.payload).toEqual({ principal: VIEWER, level: "member", project: "proj_a" });
    expect(changed?.principal).toBe(ADMIN);

    log.appendNow({
      actor: "human",
      type: "member/removed",
      principal: ADMIN,
      payload: { principal: MEMBER },
    });
    expect(access.level(MEMBER)).toBeUndefined();
    expect(access.can(MEMBER, "read")).toBe(false);
  });

  it("refuses a level override from a person who is neither an Admin nor the lead", async () => {
    joined(MEMBER, "member");
    joined(VIEWER, "viewer");
    const access = new Access({ db, setup: "team", localPrincipal: () => log.localPrincipal() });
    await expect(
      recordLevelChange(log, access, { by: MEMBER, principal: VIEWER, level: "admin" }),
    ).rejects.toThrow(/An Admin can/);
    expect(await log.getEventsByTypes(["member/level_changed"])).toEqual([]);
  });

  it("changes no permission when a profile label changes (TEAM-7)", async () => {
    joined(ADMIN, "admin");
    joined(STAKE, "stakeholder");
    const access = new Access({ db, setup: "team", localPrincipal: () => log.localPrincipal() });
    const before = Object.keys(ACTIONS).map((p) => access.can(STAKE, p as never, "proj_a"));
    await recordLabelChange(log, access, { by: ADMIN, principal: STAKE, label: "Product owner" });
    await recordLabelChange(log, access, { by: ADMIN, principal: STAKE, label: "Developer" });
    const after = Object.keys(ACTIONS).map((p) => access.can(STAKE, p as never, "proj_a"));
    expect(after).toEqual(before);
    expect(access.projection().members.get(STAKE)?.label).toBe("Developer");
    expect(access.level(STAKE)).toBe("stakeholder");
  });

  it("holds the table of teams item 6 as data", () => {
    expect(ACTIONS["issue.file"].level).toBe("stakeholder");
    expect(ACTIONS["agent.start"].level).toBe("member");
    expect(ACTIONS["proposal.apply"].level).toBe("member");
    expect(ACTIONS["project.archive"]).toMatchObject({ level: "admin", lead: true });
    expect(ACTIONS["project.lead"]).toMatchObject({ level: "admin" });
    expect(ACTIONS["project.lead"].lead).toBeUndefined();
    expect(ACTIONS["integration.connect"].level).toBe("admin");
    expect(ACTIONS.accept.acceptRule).toBe("only");
    expect(ACTIONS["run.start"].level).toBe("member");
    // Every write route the server serves maps to a permission in the table.
    for (const [method, url] of [
      ["POST", "/api/cards/card_1/park"],
      ["POST", "/api/cards/card_1/accept"],
      ["POST", "/api/cards/card_1/run"],
      ["PATCH", "/api/cards/card_1"],
      ["POST", "/api/pm/messages"],
      ["POST", "/api/pm/proposals/abc/apply"],
      ["PUT", "/api/integrations/slack"],
      ["PATCH", "/api/projects/proj_a/settings"],
      ["POST", "/api/projects/proj_a/cards"],
      ["POST", "/api/decisions/dec_1"],
    ] as const) {
      const rule = routePermissions(method, url, {});
      expect(rule, `${method} ${url}`).toBeDefined();
      for (const p of rule?.permissions ?? []) expect(ACTIONS[p]).toBeDefined();
    }
    expect(routePermissions("GET", "/api/board", {})).toBeUndefined();
  });
});

describe("the 403 on every write endpoint (TEAM-4, TEAM-5, TEAM-32, INT-24)", () => {
  let project: string;
  let other: string;
  let cardId: string;
  let otherCard: string;
  const url = (path: string) => `http://127.0.0.1:${server?.port}${path}`;
  const send = async (who: string, path: string, body: unknown = {}, method = "POST") => {
    const res = await fetch(url(path), {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Sekhemet-Action": "1",
        "X-Test-Principal": who,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };

  beforeEach(async () => {
    joined(ADMIN, "admin");
    joined(LEAD, "member");
    joined(MEMBER, "member");
    joined(STAKE, "stakeholder");
    joined(VIEWER, "viewer");
    project = (await store.ensureProject({ rootPath: join(repo, "chronicle"), name: "Chronicle" }))
      .id;
    other = (await store.ensureProject({ rootPath: join(repo, "atlas"), name: "Atlas" })).id;
    cardId = (
      await store.createCard({ tier: "task", title: "Search", status: "ready", projectId: project })
    ).id;
    otherCard = (
      await store.createCard({ tier: "task", title: "Maps", status: "ready", projectId: other })
    ).id;
    log.appendNow({
      actor: "human",
      type: "project/settings_changed",
      principal: ADMIN,
      payload: { project, lead: LEAD },
    });
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
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
      pmAdapter: () =>
        new MockInferenceAdapter("dirk-27b", [
          {
            text: "I suggest making it High.",
            toolCalls: [
              {
                id: "1",
                name: "propose_update_card",
                arguments: { card_id: cardId, priority: 2, reason: "it blocks the API" },
              },
            ],
            usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
          },
        ]),
    });
  });

  it("answers 403 naming the permission and a level that has it, and records the refusal (TEAM-4)", async () => {
    const refused = await send(VIEWER, `/api/cards/${cardId}/park`, { reason: "later" });
    expect(refused.status).toBe(403);
    expect(refused.data).toMatchObject({ permission: "review", level: "viewer", needs: "member" });
    expect(String(refused.data.error)).toBe(
      "You're a Viewer on Chronicle. A Member can send back, park or reject this issue.",
    );
    expect((await store.getCard(cardId))?.status).toBe("ready");
    const recorded = await refusals();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      principal: VIEWER,
      payload: { permission: "review", level: "viewer", needs: "member", project },
    });
    // A Member may.
    expect((await send(MEMBER, `/api/cards/${cardId}/park`, { reason: "later" })).status).toBe(200);
  });

  it("answers 401 and records nothing when no person is signed in", async () => {
    const res = await fetch(url(`/api/cards/${cardId}/park`), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sekhemet-Action": "1" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(await refusals()).toEqual([]);
  });

  it("refuses a Stakeholder the Agent, scope, priority, proposals and accept, offering to ask a Member (TEAM-5)", async () => {
    const attempts: [string, unknown, string, string][] = [
      [`/api/cards/${cardId}/run`, {}, "POST", "agent.start"],
      [
        `/api/cards/${cardId}/split`,
        { parts: [{ title: "a" }, { title: "b" }] },
        "POST",
        "scope.change",
      ],
      [`/api/cards/${cardId}`, { priority: 1 }, "PATCH", "priority.change"],
      [`/api/cards/${cardId}/reorder`, {}, "POST", "priority.change"],
      ["/api/pm/proposals/nope/apply", {}, "POST", "proposal.apply"],
      [`/api/cards/${cardId}/accept`, {}, "POST", "accept"],
    ];
    for (const [path, body, method, permission] of attempts) {
      const r = await send(STAKE, path, body, method);
      expect(r.status, path).toBe(403);
      expect(r.data.permission, path).toBe(permission);
      expect(r.data.offer, path).toMatchObject({ kind: "ask_member" });
      // A proposal names no project in its URL: the workspace level answers.
      expect(String(r.data.error), path).toMatch(
        /^You're a Stakeholder (on Chronicle|in this workspace)\./,
      );
    }
    // The ask goes to the project lead (a Member), since the issue has no owner.
    const r = await send(STAKE, `/api/cards/${cardId}/run`);
    expect(r.data.offer).toMatchObject({ kind: "ask_member", to: LEAD });
    expect((await store.getCard(cardId))?.priority).not.toBe(1);
    // What a Stakeholder may do: file an issue.
    const filed = await send(STAKE, `/api/projects/${project}/cards`, { title: "A bug" });
    expect(filed.status).toBe(201);
  });

  it("GT-N4-6: what a card declares to its gates needs Accept as well as the edit permission, and names who changed it", async () => {
    log.appendNow({
      actor: "human",
      type: "project/settings_changed",
      principal: ADMIN,
      payload: { project, accept_rule: [LEAD] },
    });
    const gateChecks = { visualAssertions: [{ selector: "#title", text: "Board" }] };
    // A Member holds issue.edit but the Accept rule does not name them.
    const refused = await send(MEMBER, `/api/cards/${cardId}`, { gateChecks }, "PATCH");
    expect(refused.status).toBe(403);
    expect(refused.data.permission).toBe("accept");
    expect((await store.getCard(cardId))?.gateChecks).toBeUndefined();
    // Filing a card or splitting one cannot carry gate checks past the rule either.
    const filed = await send(MEMBER, `/api/projects/${project}/cards`, { title: "X", gateChecks });
    expect(filed.status).toBe(403);
    expect(filed.data.permission).toBe("accept");
    const split = await send(MEMBER, `/api/cards/${cardId}/split`, {
      parts: [{ title: "a", gateChecks }, { title: "b" }],
    });
    expect(split.status).toBe(403);
    expect(split.data.permission).toBe("accept");
    // Accept never replaces the route's own permission: a Stakeholder is refused it too.
    expect(routePermissions("PATCH", `/api/cards/${cardId}`, { gateChecks })?.permissions).toEqual([
      "issue.edit",
      "accept",
    ]);

    const ok = await send(LEAD, `/api/cards/${cardId}`, { gateChecks }, "PATCH");
    expect(ok.status).toBe(200);
    expect((await store.getCard(cardId))?.gateChecks).toEqual(gateChecks);
    const event = (await log.getEventsByTypes(["card/updated"])).at(-1);
    expect(event?.principal).toBe(LEAD);
    expect((event?.payload as { patch: unknown }).patch).toEqual({ gateChecks });
  });

  it("answers a Stakeholder's message and holds the proposal for a Member (INT-24)", async () => {
    const sent = await send(STAKE, "/api/pm/messages", { text: "What's next?" });
    expect(sent.status).toBe(200);
    let proposalId: string | undefined;
    for (let i = 0; i < 100 && !proposalId; i++) {
      await new Promise((r) => setTimeout(r, 20));
      // PM-N9-8: a person reads their own part of Seshat's thread.
      const thread = (await (
        await fetch(url("/api/pm/thread"), { headers: { "X-Test-Principal": STAKE } })
      ).json()) as {
        messages: { proposals?: { id: string; state: string }[] }[];
      };
      proposalId = thread.messages.flatMap((m) => m.proposals ?? [])[0]?.id;
    }
    expect(proposalId).toBeDefined();
    const byStake = await send(STAKE, `/api/pm/proposals/${proposalId}/apply`);
    expect(byStake.status).toBe(403);
    expect((await store.getCard(cardId))?.priority).not.toBe(2);
    const byMember = await send(MEMBER, `/api/pm/proposals/${proposalId}/apply`);
    expect(byMember.status).toBe(200);
    expect((await store.getCard(cardId))?.priority).toBe(2);
  });

  it("applies a per-project override to that project only, over HTTP (TEAM-6)", async () => {
    const byMember = await send(MEMBER, `/api/members/${VIEWER}/level`, {
      level: "member",
      project,
    });
    expect(byMember.status).toBe(403);
    const byLead = await send(LEAD, `/api/members/${VIEWER}/level`, { level: "member", project });
    expect(byLead.status).toBe(200);
    expect((await send(VIEWER, `/api/cards/${cardId}/park`)).status).toBe(200);
    expect((await send(VIEWER, `/api/cards/${otherCard}/park`)).status).toBe(403);
    // A workspace level is an Admin's to change, not a lead's.
    expect((await send(LEAD, `/api/members/${VIEWER}/level`, { level: "admin" })).status).toBe(403);
    const events = await log.getEventsByTypes(["member/level_changed"]);
    expect(events.map((e) => e.payload)).toEqual([{ principal: VIEWER, level: "member", project }]);
  });

  it("lets only the action table's people change a project's settings, recording only what changed (TEAM-32)", async () => {
    const path = `/api/projects/${project}/settings`;
    // A Member who does not lead the project is refused.
    const refused = await send(MEMBER, path, { require_resolved_threads: true }, "PATCH");
    expect(refused.status).toBe(403);
    expect(refused.data).toMatchObject({ permission: "project.settings" });
    expect(String(refused.data.error)).toContain("An Admin or the project lead");

    // The lead changes the Accept rule and required threads; only those are recorded.
    const ok = await send(
      LEAD,
      path,
      { accept_rule: [MEMBER, LEAD], require_resolved_threads: true },
      "PATCH",
    );
    expect(ok.status).toBe(200);
    expect(ok.data.changed).toEqual(["accept_rule", "require_resolved_threads"]);
    // Sending the same values again changes nothing and records nothing.
    const same = await send(LEAD, path, { accept_rule: [MEMBER, LEAD] }, "PATCH");
    expect(same.status).toBe(200);
    expect(same.data.changed).toEqual([]);
    // Naming a lead and auto-apply are an Admin's.
    expect((await send(LEAD, path, { lead: MEMBER }, "PATCH")).status).toBe(403);
    expect((await send(LEAD, path, { auto_apply: { label: true } }, "PATCH")).status).toBe(403);
    // Auto-apply is never offered for the assignee or health (TEAM-18).
    expect((await send(ADMIN, path, { auto_apply: { assignee: true } }, "PATCH")).status).toBe(400);
    expect((await send(ADMIN, path, { auto_apply: { label: true } }, "PATCH")).status).toBe(200);

    const changes = (await log.getEventsByTypes(["project/settings_changed"])).map(
      (e) => e.payload,
    );
    expect(changes.slice(1)).toEqual([
      { project, accept_rule: [MEMBER, LEAD], require_resolved_threads: true },
      { project, auto_apply: { label: true } },
    ]);
    // Archiving: the lead may, another Member may not.
    expect((await send(MEMBER, `/api/projects/${project}`, { status: "archived" })).status).toBe(
      403,
    );
    expect((await send(LEAD, `/api/projects/${project}`, { status: "archived" })).status).toBe(200);
    // Connecting an integration is an Admin's.
    expect((await send(LEAD, "/api/integrations/slack", {}, "PUT")).status).toBe(403);
  });

  it("records the Worker's question as the Worker's and the answer as the person's (INT-25)", async () => {
    const question = await store.runs.requestDecision({
      cardId,
      kind: "permission",
      question: "Allow npm install?",
      context: "",
      options: ["deny", "allow"],
    });
    const asked = (await log.getEventsByTypes(["decision/requested"])).at(-1);
    expect(asked?.actor).toBe("executor");
    expect(asked?.principal ?? null).toBeNull();
    // A permission question is answered by a person the Accept rule names.
    expect((await send(MEMBER, `/api/decisions/${question.id}`, { option: 0 })).status).toBe(403);
    log.appendNow({
      actor: "human",
      type: "project/settings_changed",
      principal: LEAD,
      payload: { project, accept_rule: [MEMBER] },
    });
    expect((await send(MEMBER, `/api/decisions/${question.id}`, { option: 0 })).status).toBe(200);
    const answered = (await log.getEventsByTypes(["decision/answered"])).at(-1);
    expect(answered?.principal).toBe(MEMBER);
  });

  describe("B4.3's write routes resolve their project, so a per-project level applies (TEAM-4, TEAM-6)", () => {
    let sliceId: string;
    let reqId: string;
    let suggestionId: string;
    beforeEach(async () => {
      sliceId = await store.slices.create(
        { projectId: project, title: "Skeleton", appetite: { cards: 3 } },
        ADMIN,
      );
      reqId = (await store.requirements.create({ title: "Search by word", sliceId }, ADMIN)).id;
      suggestionId = (await store.suggestions.propose({
        cardId,
        kind: "priority",
        value: 1,
        why: "it blocks the API",
      })) as string;
      // The Member is named by the project's Accept rule, then lowered to Viewer there.
      log.appendNow({
        actor: "human",
        type: "project/settings_changed",
        principal: LEAD,
        payload: { project, accept_rule: [MEMBER] },
      });
      log.appendNow({
        actor: "human",
        type: "member/level_changed",
        principal: LEAD,
        payload: { principal: MEMBER, level: "viewer", project },
      });
    });

    it("refuses each route to a Member lowered to Viewer on the project, naming the project", async () => {
      const attempts: [string, unknown, string][] = [
        [`/api/slices/${sliceId}/accept`, {}, "accept"],
        [`/api/slices/${sliceId}/extend`, { cards: 5 }, "scope.change"],
        [`/api/requirements/${reqId}/cut`, { reason: "later" }, "scope.change"],
        [`/api/requirements/${reqId}/revise`, { title: "Search" }, "scope.change"],
        [`/api/requirements/${reqId}/confirm`, { from: "card", ref: cardId }, "accept"],
        [`/api/suggestions/${suggestionId}/apply`, {}, "proposal.apply"],
        [`/api/suggestions/${suggestionId}/dismiss`, {}, "proposal.apply"],
        [`/api/projects/${project}/update`, { text: "Week 1" }, "project.update"],
        ["/api/brief/accept", { projectId: project, requirements: [] }, "brief.accept"],
      ];
      for (const [path, body, permission] of attempts) {
        const r = await send(MEMBER, path, body);
        expect(r.status, path).toBe(403);
        expect(r.data.permission, path).toBe(permission);
        expect(r.data.level, path).toBe("viewer");
      }
      const recorded = await refusals();
      expect(recorded).toHaveLength(attempts.length);
      for (const r of recorded) expect(r.payload.project).toBe(project);
      expect((await store.slices.get(sliceId))?.extensions ?? 0).toBe(0);
      expect((await store.suggestions.get(suggestionId))?.state).toBe("open");
    });

    it("lets a Member on another project do what the level there allows", async () => {
      // On Atlas the Member is still a Member: a suggestion there is theirs to apply.
      const there = (await store.suggestions.propose({
        cardId: otherCard,
        kind: "priority",
        value: 2,
        why: "a customer asked",
      })) as string;
      expect((await send(MEMBER, `/api/suggestions/${there}/apply`)).status).toBe(200);
    });

    it("accepts a brief only from the project's Admin or lead (teams item 6)", async () => {
      const brief = { projectId: other, requirements: [] };
      const byMember = await send(MEMBER, "/api/brief/accept", brief);
      expect(byMember.status).toBe(403);
      expect(String(byMember.data.error)).toContain("An Admin or the project lead");
      // The lead of Chronicle is not refused there; an unknown project is not a project.
      const byLead = await send(LEAD, "/api/brief/accept", {
        projectId: project,
        requirements: [],
      });
      expect(byLead.status).not.toBe(403);
      const unknown = await send(ADMIN, "/api/brief/accept", { projectId: "proj_nope" });
      expect(unknown.status).toBe(404);
    });
  });
});

describe("Accept by the project's Accept rule (INT-22, INT-23)", () => {
  const url = (path: string) => `http://127.0.0.1:${server?.port}${path}`;
  const send = async (who: string | undefined, path: string, body: unknown = {}) => {
    const res = await fetch(url(path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sekhemet-Action": "1",
        ...(who ? { "X-Test-Principal": who } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };

  async function reviewedCard(projectId?: string): Promise<void> {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Jane Doe");
    git("config", "user.email", "jane@example.com");
    write(repo, "src/a.ts", "export const a = 1;\n");
    write(repo, ".gitignore", ".sekhemet/\nevents.db*\nnoop.mjs\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
    const adapter = new NodeGitSyncAdapter(repo);
    await store.createCard({
      id: "d1",
      tier: "story",
      title: "Card d1",
      scopeFiles: ["src/**"],
      ...(projectId ? { projectId } : {}),
    });
    const wt = await adapter.createWorktree("d1", "main", "Card d1");
    write(wt, "src/b.ts", "export const b = 2;\n");
    await adapter.commitCheckpoint({
      cardId: "d1",
      step: 1,
      gateStatus: "pass",
      agentModel: "nail",
      agentHarness: "sekhemet",
      agentRole: "implementer",
    });
    const evidence = {
      id: "ev_d1",
      cardId: "d1",
      attempt: 1,
      passed: true,
      rungResults: [{ gate: "unit", rung: "test", layer: "functional", passed: true, exitCode: 0 }],
      filesTouched: ["src/b.ts"],
      linesAdded: 1,
      linesRemoved: 0,
      diff: "",
      settings: { modelId: "nail" },
      stopReason: "gate_passed",
      repoState: await adapter.getRepoStateHash("d1"),
    };
    const body = `${JSON.stringify(evidence, null, 2)}\n`;
    writeFileSync(join(repo, ".sekhemet", "evidence", "ev_d1.json"), body);
    writeFileSync(join(repo, ".sekhemet", "evidence", "latest-d1.json"), body);
    await recordLedgerRun(store, {
      cardId: "d1",
      modelId: "nail",
      passed: true,
      stopReason: "gate_passed",
      evidenceId: "ev_d1",
      path: join(".sekhemet", "evidence", "ev_d1.json"),
      body,
      filesTouched: ["src/b.ts"],
    });
    await store.updateCardStatus("d1", "review", "verified", "harness", { override: true });
  }

  it("refuses a person the Accept rule does not name, and records the accepter who is named (Team)", async () => {
    joined(ADMIN, "admin");
    joined(MEMBER, "member");
    joined("p_bob", "member");
    const project = (await store.ensureProject({ rootPath: repo, name: "Chronicle" })).id;
    await reviewedCard(project);
    log.appendNow({
      actor: "human",
      type: "project/settings_changed",
      principal: ADMIN,
      payload: { project, accept_rule: ["p_bob"] },
    });
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
    });
    const head = git("rev-parse", "main");
    // An Admin is not an accepter unless the rule names them (teams item 7).
    for (const who of [MEMBER, ADMIN]) {
      const refused = await send(who, "/api/cards/d1/accept");
      expect(refused.status).toBe(403);
      expect(String(refused.data.error)).toContain(
        "This project's Accept rule doesn't include you",
      );
    }
    expect(git("rev-parse", "main")).toBe(head);
    expect((await store.getCard("d1"))?.status).toBe("review");
    expect((await refusals()).map((r) => [r.principal, r.payload.permission])).toEqual([
      [MEMBER, "accept"],
      [ADMIN, "accept"],
    ]);

    expect((await send("p_bob", "/api/cards/d1/opened", { filesShown: ["src/b.ts"] })).status).toBe(
      200,
    );
    const accepted = await send("p_bob", "/api/cards/d1/accept");
    expect(accepted.data.error).toBeUndefined();
    expect(accepted.status).toBe(200);
    const event = (await log.getEventsByTypes(["card/accepted"])).at(-1);
    expect(event?.payload).toMatchObject({ id: "d1", principal: "p_bob" });
  });

  it("keeps Solo unchanged: the install's person is Admin and accepts with no rule recorded", async () => {
    await reviewedCard();
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store, { entryConditions: true }),
      cardStore: store,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 10_000,
      setup: "solo",
    });
    expect(
      (await send(undefined, "/api/cards/d1/opened", { filesShown: ["src/b.ts"] })).status,
    ).toBe(200);
    const accepted = await send(undefined, "/api/cards/d1/accept");
    expect(accepted.data.error).toBeUndefined();
    expect(accepted.status).toBe(200);
    const event = (await log.getEventsByTypes(["card/accepted"])).at(-1);
    expect(event?.payload).toMatchObject({ id: "d1", principal: log.localPrincipal() });
    expect(await refusals()).toEqual([]);
  });
});
