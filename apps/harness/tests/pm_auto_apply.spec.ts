import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter, type ToolCall } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { respondToSignals } from "../src/planner_live.js";
import type { Audience } from "../src/pm/audience.js";
import { answerQueued } from "../src/pm/service.js";
import { PmStore } from "../src/pm/store.js";
import {
  SuggestionError,
  autoApplySuggestion,
  suggestionsOn,
  undoSuggestion,
} from "../src/pm/suggest.js";
import { startDashboardServer } from "../src/server.js";
import { Access, recordSettingsChange } from "../src/team/access.js";

// planner-pm PM-N9-2, teams TEAM-18 and TEAM-41: an Admin's auto-apply rule,
// per project and per property, applies Seshat's suggestion for labels, the
// duplicate link, priority or a split with the Admin as principal, shows
// "Applied by <Admin>'s rule" on the issue and is undone in one action. The
// assignee, a hold and a removal are never auto-applied. Real SQLite, git and
// an HTTP server; scripted model replies through the mock adapter.

const dirs: string[] = [];
const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  while (servers.length) await (servers.pop() as { close: () => Promise<void> }).close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
const ADA = "p_ada";
const AMY = "p_amy";
const BOB = "p_bob";
const VIC = "p_vic";

function setup() {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-auto-apply-"));
  dirs.push(repoPath);
  const w = (rel: string, text: string) => {
    mkdirSync(dirname(join(repoPath, rel)), { recursive: true });
    writeFileSync(join(repoPath, rel), text);
  };
  w("src/ledger.ts", "export const x = 1;\n");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repoPath, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  git("add", "-A");
  git("commit", "-q", "-m", "feat: init");
  mkdirSync(join(repoPath, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(repoPath, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const cardStore = new CardStore(db, log);
  const boardService = new BoardServiceImpl(cardStore, { entryConditions: true });
  const pmStore = new PmStore(log);
  const access = new Access({ db, setup: "team", localPrincipal: () => log.localPrincipal() });
  const joined = (principal: string, level: string) =>
    log.appendNow({
      actor: "system",
      type: "member/joined",
      principal,
      payload: { principal, level, via: "invite", pending: false },
    });
  joined(ADA, "admin");
  joined(AMY, "member");
  joined(BOB, "member");
  joined(VIC, "viewer");
  return { repoPath, db, log, cardStore, boardService, pmStore, access };
}

type S = ReturnType<typeof setup>;

async function project(s: S, name = "Chronicle"): Promise<string> {
  return (await s.cardStore.ensureProject({ rootPath: join(s.repoPath, name), name })).id;
}

async function rule(s: S, projectId: string, on: Record<string, boolean>, by = ADA) {
  await recordSettingsChange(s.log, s.access, {
    by,
    project: projectId,
    patch: { auto_apply: on },
  });
}

/** The Team audience the product builds from the access module, with the names recorded here. */
function audienceOf(s: S): Audience {
  const names: Record<string, string> = { [ADA]: "Ada", [AMY]: "Amy", [BOB]: "Bob", [VIC]: "Vic" };
  return {
    setup: "team",
    nameOf: (p) => names[p],
    levelOf: (p, proj) => s.access.level(p, proj),
    canSee: (p, proj) => s.access.level(p, proj) !== undefined,
    leadOf: () => undefined,
    autoApplier: (proj, kind) => s.access.autoApplier(proj, kind),
  };
}

const ctx = (s: S, principal: string) => ({
  cardStore: s.cardStore,
  boardService: s.boardService,
  pmStore: s.pmStore,
  repoPath: s.repoPath,
  actor: "human",
  principal,
  audience: audienceOf(s),
});

async function ask(s: S, text: string, calls: ToolCall[], as = AMY) {
  const model = new MockInferenceAdapter("pm", [
    { text: "Here is what I found.", toolCalls: calls, usage },
  ]);
  await EventLog.actingFor(as, () => s.pmStore.appendUserMessage(text));
  await answerQueued({
    repoPath: s.repoPath,
    cardStore: s.cardStore,
    pmStore: s.pmStore,
    pmModel: "pm",
    acquire: async () => ({ role: "chat", adapter: model, release: () => {} }),
    audience: audienceOf(s),
  });
  return (await s.pmStore.thread()).filter((m) => m.role === "pm").at(-1);
}

describe("TEAM-18, -41: whose rule is on, for which property", () => {
  it("names the Admin who turned a property on, only for labels, priority, the duplicate link and a split", async () => {
    const s = setup();
    const p = await project(s);
    expect(s.access.autoApplier(p, "priority")).toBeUndefined();
    await rule(s, p, { priority: true, label: true });
    expect(s.access.autoApplier(p, "priority")).toBe(ADA);
    expect(s.access.autoApplier(p, "label")).toBe(ADA);
    expect(s.access.autoApplier(p, "duplicate")).toBeUndefined();
    // Never the assignee, a hold or a removal, whatever the ledger says.
    expect(s.access.autoApplier(p, "assignee")).toBeUndefined();
    expect(s.access.autoApplier(p, "hold")).toBeUndefined();
    // Another project has no rule; an issue with no project has none either.
    expect(s.access.autoApplier(await project(s, "Atlas"), "priority")).toBeUndefined();
    expect(s.access.autoApplier(undefined, "priority")).toBeUndefined();
    // Turned off, it is gone; an Admin no longer Admin applies nothing by rule.
    await rule(s, p, { priority: false });
    expect(s.access.autoApplier(p, "priority")).toBeUndefined();
    joinedAdminDemoted(s);
    expect(s.access.autoApplier(p, "label")).toBeUndefined();
  });
});

/** Ada is demoted to Member (another Admin's act, recorded directly). */
function joinedAdminDemoted(s: S) {
  s.log.appendNow({
    actor: "human",
    type: "member/level_changed",
    principal: AMY,
    payload: { principal: ADA, level: "member" },
  });
}

describe("PM-N9-2: Seshat's suggestion applied by an Admin's rule", () => {
  it("applies a priority suggestion under the Admin's principal, says so, and undoes it in one action", async () => {
    const s = setup();
    const p = await project(s);
    await rule(s, p, { priority: true });
    const card = await s.cardStore.createCard({
      id: "card_api",
      tier: "task",
      title: "Api",
      status: "ready",
      projectId: p,
    });
    const reply = await ask(s, "What comes first?", [
      {
        id: "1",
        name: "propose_update_card",
        arguments: { card_id: card.id, priority: 1, reason: "two issues wait on it" },
      },
    ]);
    // Applied by the rule: the Admin is the principal, and the chat offers nothing to apply.
    expect((await s.cardStore.getCard(card.id))?.priority).toBe(1);
    const [applied] = await s.log.getEventsByTypes(["suggestion/applied"]);
    expect(applied?.principal).toBe(ADA);
    expect(applied?.payload).toMatchObject({ auto: true, kind: "priority" });
    expect(reply?.proposals ?? []).toEqual([]);
    expect(reply?.text).toMatch(/Applied by Ada's rule: priority Urgent for Api\./);
    // On the issue: the line, with Undo.
    const shown = await suggestionsOn(s.cardStore, card.id, audienceOf(s));
    expect(shown).toEqual([
      expect.objectContaining({
        state: "applied",
        rule: ADA,
        suggested: "Applied by Ada's rule: priority Urgent for Api.",
        why: "Two issues wait on it",
      }),
    ]);
    // Undo: one action, the issue as it was, recorded under the person.
    const id = shown[0]?.id as string;
    await undoSuggestion(id, ctx(s, AMY));
    expect((await s.cardStore.getCard(card.id))?.priority).toBe(0);
    const [undone] = await s.log.getEventsByTypes(["suggestion/undone"]);
    expect(undone?.principal).toBe(AMY);
    expect(await suggestionsOn(s.cardStore, card.id, audienceOf(s))).toEqual([]);
    // Undone is final: not undone twice, and the same change is not raised again (TEAM-19).
    await expect(undoSuggestion(id, ctx(s, AMY))).rejects.toThrow(SuggestionError);
    expect(
      await s.cardStore.suggestions.propose({
        cardId: card.id,
        kind: "priority",
        value: 1,
        why: "again",
      }),
    ).toBeNull();
  });

  it("on an issue Bob owns, the rule applies it; Bob or Ada undoes it, Amy may not", async () => {
    const s = setup();
    const p = await project(s);
    await rule(s, p, { label: true });
    const card = await s.cardStore.createCard({
      id: "card_own",
      tier: "task",
      title: "Search",
      status: "ready",
      projectId: p,
      owner: BOB,
    });
    const reply = await ask(s, "Triage it", [
      {
        id: "1",
        name: "propose_update_card",
        arguments: { card_id: card.id, labels: ["bug"], reason: "it crashes on load" },
      },
    ]);
    expect((await s.cardStore.getCard(card.id))?.labels).toEqual(["bug"]);
    // The rule applied it: no "for Bob to apply" line, and nothing left to apply.
    expect(reply?.text).toMatch(/Applied by Ada's rule: label Search bug\./);
    expect(reply?.text).not.toMatch(/for Bob to apply/);
    const [shown] = await suggestionsOn(s.cardStore, card.id, audienceOf(s));
    const id = shown?.id as string;
    await expect(undoSuggestion(id, ctx(s, AMY))).rejects.toThrow(/Bob owns Search/);
    await undoSuggestion(id, ctx(s, BOB));
    expect((await s.cardStore.getCard(card.id))?.labels ?? []).toEqual([]);
  });

  it("labels and the duplicate link: undo restores the labels and brings a duplicate back from Won't do", async () => {
    const s = setup();
    const p = await project(s);
    await rule(s, p, { label: true, duplicate: true });
    const ui = await s.cardStore.createCard({
      id: "card_ui",
      tier: "task",
      title: "Ui",
      status: "ready",
      projectId: p,
      labels: ["web"],
    });
    const other = await s.cardStore.createCard({
      id: "card_ui2",
      tier: "task",
      title: "Ui again",
      status: "backlog",
      projectId: p,
    });
    const lab = (await s.cardStore.suggestions.propose({
      cardId: ui.id,
      kind: "label",
      value: ["web", "bug"],
      why: "it crashes",
    })) as string;
    expect(await autoApplySuggestion(lab, ctx(s, AMY))).toMatchObject({ by: ADA });
    expect((await s.cardStore.getCard(ui.id))?.labels).toEqual(["web", "bug"]);
    await undoSuggestion(lab, ctx(s, AMY));
    expect((await s.cardStore.getCard(ui.id))?.labels).toEqual(["web"]);

    const dup = (await s.cardStore.suggestions.propose({
      cardId: other.id,
      kind: "duplicate",
      value: ui.id,
      why: "same crash",
    })) as string;
    await autoApplySuggestion(dup, ctx(s, AMY));
    expect((await s.cardStore.getCard(other.id))?.status).toBe("rejected");
    await undoSuggestion(dup, ctx(s, BOB));
    const back = await s.cardStore.getCard(other.id);
    expect(back?.status).toBe("backlog");
    expect(back?.blockedReason ?? null).toBeNull();
  });

  it("a split: the parts are made under the rule, and Undo withdraws them and restores the issue", async () => {
    const s = setup();
    const p = await project(s);
    await rule(s, p, { split: true });
    await s.cardStore.createCard({
      id: "c_split",
      tier: "task",
      title: "Log",
      status: "ready",
      projectId: p,
      spec: "The log behaviour.",
      acceptanceCriteria: [
        "Given an empty log, appending an event leaves 1 event",
        "Given a key seen before, dedupe returns the first result",
      ],
    });
    const id = (await s.cardStore.suggestions.propose({
      cardId: "c_split",
      kind: "split",
      value: ["Append an event", "Dedupe by key"],
      why: "two behaviours",
    })) as string;
    const auto = await autoApplySuggestion(id, ctx(s, AMY));
    expect(auto?.cards.length).toBe(2);
    expect((await s.cardStore.getCard("c_split"))?.status).toBe("rejected");
    const parts = auto?.cards.map((c) => c.id) ?? [];
    await undoSuggestion(id, ctx(s, ADA));
    expect((await s.cardStore.getCard("c_split"))?.status).toBe("ready");
    for (const part of parts) expect((await s.cardStore.getCard(part))?.status).toBe("rejected");
  });

  it("a split whose part has started is not undone", async () => {
    const s = setup();
    const p = await project(s);
    await rule(s, p, { split: true });
    await s.cardStore.createCard({
      id: "c_run",
      tier: "task",
      title: "Run",
      status: "ready",
      projectId: p,
      spec: "The run behaviour.",
      acceptanceCriteria: [
        "Given a card, running it records a step",
        "Given a stop, it records why",
      ],
    });
    const id = (await s.cardStore.suggestions.propose({
      cardId: "c_run",
      kind: "split",
      value: ["Record a step", "Record a stop"],
      why: "two behaviours",
    })) as string;
    const auto = await autoApplySuggestion(id, ctx(s, AMY));
    const first = auto?.cards[0];
    if (!first) throw new Error("no parts");
    // The first part is picked up by the Agent.
    await s.cardStore.updateCardStatus(first.id, "in_progress", "picked up", "executor");
    expect((await s.cardStore.getCard(first.id))?.status).toBe("in_progress");
    await expect(undoSuggestion(id, ctx(s, AMY))).rejects.toThrow(/has started/);
    expect((await s.cardStore.suggestions.get(id))?.state).toBe("applied");
  });

  it("never auto-applies the assignee, a hold or a removal, nor anything without a rule", async () => {
    const s = setup();
    const p = await project(s);
    await rule(s, p, { priority: true });
    const card = await s.cardStore.createCard({
      id: "card_q",
      tier: "task",
      title: "Queue",
      status: "ready",
      projectId: p,
    });
    for (const [kind, value] of [
      ["assignee", AMY],
      ["hold", "scope drift"],
      ["remove", "re-plan"],
      ["label", ["x"]],
    ] as const) {
      const id = (await s.cardStore.suggestions.propose({
        cardId: card.id,
        kind,
        value: value as never,
        why: "w",
      })) as string;
      expect(await autoApplySuggestion(id, ctx(s, AMY))).toBeUndefined();
      expect((await s.cardStore.suggestions.get(id))?.state).toBe("open");
    }
    expect(await s.log.getEventsByTypes(["suggestion/applied"])).toEqual([]);
  });

  it("the queue's blocked-issue signal suggests Urgent, applied by the rule", async () => {
    const s = setup();
    const p = await project(s);
    await rule(s, p, { priority: true });
    await s.cardStore.createCard({
      id: "card_blk",
      tier: "task",
      title: "Blocked",
      status: "ready",
      projectId: p,
    });
    const said: string[] = [];
    await respondToSignals(
      { repoPath: s.repoPath, cardStore: s.cardStore, log: s.log, boardService: s.boardService },
      [
        {
          id: "blocked_time",
          value: 30,
          threshold: 24,
          triggered: true,
          detail: "1 issue blocked over 24 h",
          response: { action: "escalate_blockers", mode: "proposal", targets: ["card_blk"] },
        },
      ],
      {
        setup: "team",
        now: new Date(),
        say: (l) => said.push(l),
        autoApply: (proj, kind) => s.access.autoApplier(proj, kind),
      },
    );
    expect((await s.cardStore.getCard("card_blk"))?.priority).toBe(1);
    expect(said.join("\n")).toMatch(/Applied Urgent for card_blk by an Admin's rule/);
  });
});

describe("the routes: the rule's line on the issue and Undo (PM_CONTRACT §3)", () => {
  it("GET lists it with its rule; POST undo restores it; a Viewer may not undo", async () => {
    const s = setup();
    const p = await project(s);
    await rule(s, p, { priority: true });
    const card = await s.cardStore.createCard({
      id: "card_r",
      tier: "task",
      title: "Routes",
      status: "ready",
      projectId: p,
    });
    const id = (await s.cardStore.suggestions.propose({
      cardId: card.id,
      kind: "priority",
      value: 2,
      why: "it blocks the API",
    })) as string;
    await autoApplySuggestion(id, ctx(s, AMY));
    const server = await startDashboardServer({
      db: s.db,
      log: s.log,
      boardService: s.boardService,
      cardStore: s.cardStore,
      repoPath: s.repoPath,
      port: 0,
      streamIntervalMs: 10_000,
      setup: "team",
      requester: (req) => {
        const h = req.headers["x-test-principal"];
        return typeof h === "string" && h ? h : undefined;
      },
      pressureLevel: () => 1,
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const send = (who: string, path: string, method = "POST") =>
      fetch(`${base}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-sekhemet-action": "1",
          "x-test-principal": who,
        },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
    const listed = (await (await send(AMY, `/api/cards/${card.id}/suggestions`, "GET")).json()) as {
      suggestions: { id: string; state: string; suggested: string }[];
    };
    expect(listed.suggestions).toEqual([
      expect.objectContaining({ id, state: "applied", suggested: expect.stringMatching(/rule/) }),
    ]);
    expect((await send(VIC, `/api/suggestions/${id}/undo`)).status).toBe(403);
    expect((await s.cardStore.getCard(card.id))?.priority).toBe(2);
    const ok = await send(AMY, `/api/suggestions/${id}/undo`);
    expect(ok.status).toBe(200);
    expect((await s.cardStore.getCard(card.id))?.priority).toBe(0);
    expect((await send(AMY, `/api/suggestions/${id}/undo`)).status).toBe(409);
  });
});
