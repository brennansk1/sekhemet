import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter, type ToolCall } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import type { Audience } from "../src/pm/audience.js";
import { answerQueued } from "../src/pm/service.js";
import { PmStore } from "../src/pm/store.js";
import { SuggestionError, applySuggestion, dismissSuggestion } from "../src/pm/suggest.js";

// planner-pm PM-N9-1, -3, -9 (the pm side) and teams TEAM-18, -19, -40:
// Seshat's changes to an issue's assignee, labels, priority, duplicate link or
// a split are suggestions on the issue; nothing changes until a person
// applies one, and Apply performs every kind. Real SQLite on disk.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };

function setup() {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-pm-sug-"));
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
  return { repoPath, db, log, cardStore, boardService, pmStore };
}

type S = ReturnType<typeof setup>;

/** A Team workspace: Amy and Bob are Members, Vic a Viewer; Lee leads the project. */
function team(levels: Record<string, "viewer" | "member" | "admin"> = {}): Audience {
  const names: Record<string, string> = {
    p_amy: "Amy",
    p_bob: "Bob",
    p_vic: "Vic",
    p_lee: "Lee",
  };
  const all = { p_amy: "member", p_bob: "member", p_vic: "viewer", p_lee: "member", ...levels };
  return {
    setup: "team",
    nameOf: (p) => names[p],
    levelOf: (p) => all[p as keyof typeof all] as never,
    canSee: () => true,
    leadOf: () => "p_lee",
  };
}

async function ask(
  s: S,
  text: string,
  calls: ToolCall[],
  options: { as?: string; audience?: Audience; replyText?: string; cardId?: string } = {},
) {
  const model = new MockInferenceAdapter("pm", [
    { text: options.replyText ?? "Here is what I found.", toolCalls: calls, usage },
  ]);
  const send = () =>
    s.pmStore.appendUserMessage(text, options.cardId ? { cardId: options.cardId } : undefined);
  if (options.as) await EventLog.actingFor(options.as, send);
  else await send();
  await answerQueued({
    repoPath: s.repoPath,
    cardStore: s.cardStore,
    pmStore: s.pmStore,
    pmModel: "pm",
    acquire: async () => ({ role: "chat", adapter: model, release: () => {} }),
    ...(options.audience ? { audience: options.audience } : {}),
  });
  return (await s.pmStore.thread()).filter((m) => m.role === "pm").at(-1);
}

const ctx = (s: S, principal: string, audience?: Audience) => ({
  cardStore: s.cardStore,
  boardService: s.boardService,
  pmStore: s.pmStore,
  repoPath: s.repoPath,
  actor: "human",
  principal,
  ...(audience ? { audience } : {}),
});

describe("PM-N9-1: triage changes are suggestions on the issue", () => {
  it("posts Suggested and Why on the issue, changes nothing, and applies on a person's Apply", async () => {
    const s = setup();
    const card = await s.cardStore.createCard({
      id: "card_api",
      tier: "task",
      title: "Api",
      status: "ready",
    });
    const reply = await ask(s, "What should come first?", [
      {
        id: "1",
        name: "propose_update_card",
        arguments: { card_id: card.id, priority: 1, estimate: 3, reason: "two issues wait on it" },
      },
    ]);
    // The estimate stays a proposal; the priority is a suggestion on the issue.
    const open = await s.cardStore.suggestions.open(card.id);
    expect(open).toEqual([
      expect.objectContaining({ kind: "priority", value: 1, why: "Two issues wait on it" }),
    ]);
    const suggested = reply?.proposals?.find((p) => p.suggestionId);
    expect(suggested?.summary).toMatch(/^Suggested: .*Why: Two issues wait on it\.$/);
    expect(reply?.proposals?.find((p) => !p.suggestionId)?.patch).toEqual({ estimate: 3 });
    expect((await s.cardStore.getCard(card.id))?.priority).toBe(0);

    await applySuggestion(open[0]?.id as string, ctx(s, s.log.localPrincipal()));
    expect((await s.cardStore.getCard(card.id))?.priority).toBe(1);
    const [applied] = await s.log.getEventsByTypes(["suggestion/applied"]);
    expect(applied?.principal).toBe(s.log.localPrincipal());
    // The chat's copy of it is applied too.
    expect((await s.pmStore.proposal(suggested?.id as string))?.state).toBe("applied");
  });

  it("TEAM-19: a dismissed suggestion is not proposed again", async () => {
    const s = setup();
    const card = await s.cardStore.createCard({
      id: "card_ui",
      tier: "task",
      title: "Ui",
      status: "ready",
    });
    const call: ToolCall = {
      id: "1",
      name: "propose_update_card",
      arguments: { card_id: card.id, labels: ["bug"], reason: "it crashes on load" },
    };
    await ask(s, "Triage it", [call]);
    const [first] = await s.cardStore.suggestions.open(card.id);
    await dismissSuggestion(first?.id as string, ctx(s, s.log.localPrincipal()));
    const again = await ask(s, "Triage it again", [call]);
    expect(again?.proposals ?? []).toEqual([]);
    expect(await s.cardStore.suggestions.open(card.id)).toEqual([]);
    expect(again?.text).not.toMatch(/why/i);
  });
});

describe("PM-N9-3: assigning, someone else's issue, and health change nothing", () => {
  it("a request to assign names who can and offers a suggestion; the card is unchanged", async () => {
    const s = setup();
    const card = await s.cardStore.createCard({
      id: "card_auth",
      tier: "task",
      title: "Auth",
      status: "ready",
      owner: "p_bob",
    });
    const reply = await ask(s, "Assign this to Amy", [], {
      as: "p_amy",
      audience: team(),
      cardId: card.id,
    });
    expect((await s.cardStore.getCard(card.id))?.owner).toBe("p_bob");
    expect(reply?.text).toMatch(/Bob/);
    expect(reply?.text).toMatch(/can assign/i);
    expect(await s.cardStore.suggestions.open(card.id)).toEqual([
      expect.objectContaining({ kind: "assignee", value: "p_amy" }),
    ]);
  });

  it("a request to set health names the project lead and suggests nothing", async () => {
    const s = setup();
    await s.cardStore.createCard({ id: "card_x", tier: "task", title: "X", status: "ready" });
    const reply = await ask(s, "Set the project's health to at risk", [], {
      as: "p_amy",
      audience: team(),
    });
    expect(reply?.text).toMatch(/Lee/);
    expect(reply?.text).toMatch(/health/i);
    expect(reply?.proposals ?? []).toEqual([]);
    expect(await s.log.getEventsByTypes(["suggestion/proposed", "project/health_set"])).toEqual([]);
  });

  it("PM-N9-9: a change to an issue Bob owns reaches Bob; only Bob applies it", async () => {
    const s = setup();
    const card = await s.cardStore.createCard({
      id: "card_bill",
      tier: "task",
      title: "Billing",
      status: "ready",
      owner: "p_bob",
    });
    const reply = await ask(
      s,
      "Rename billing",
      [
        {
          id: "1",
          name: "propose_update_card",
          arguments: {
            card_id: card.id,
            title: "Billing history",
            reason: "the brief calls it that",
          },
        },
      ],
      { as: "p_amy", audience: team() },
    );
    const p = reply?.proposals?.[0];
    expect(p?.forOwner).toBe("p_bob");
    expect(reply?.text).toMatch(/Bob owns/);
    const { applyProposal, ProposalError } = await import("../src/pm/apply.js");
    await expect(applyProposal(p as never, ctx(s, "p_amy", team()))).rejects.toBeInstanceOf(
      ProposalError,
    );
    expect((await s.cardStore.getCard(card.id))?.title).toBe("Billing");
    await applyProposal(
      (await s.pmStore.proposal(p?.id as string)) as never,
      ctx(s, "p_bob", team()),
    );
    expect((await s.cardStore.getCard(card.id))?.title).toBe("Billing history");
  });

  it("TEAM-40: a Viewer gets an answer and no proposal or suggestion", async () => {
    const s = setup();
    const card = await s.cardStore.createCard({
      id: "card_v",
      tier: "task",
      title: "V",
      status: "ready",
    });
    const reply = await ask(
      s,
      "Should this be urgent?",
      [
        {
          id: "1",
          name: "propose_update_card",
          arguments: { card_id: card.id, priority: 1, reason: "it blocks the release" },
        },
      ],
      { as: "p_vic", audience: team() },
    );
    expect(reply?.proposals ?? []).toEqual([]);
    expect(await s.cardStore.suggestions.open(card.id)).toEqual([]);
  });
});

describe("Apply performs every kind of suggestion", () => {
  it("assignee, label, priority, duplicate, split, hold and remove", async () => {
    const s = setup();
    const me = s.log.localPrincipal();
    const make = (id: string, extra: Record<string, unknown> = {}) =>
      s.cardStore.createCard({
        id,
        tier: "task",
        title: id,
        status: "ready",
        spec: `The ${id} behaviour.`,
        ...extra,
      });
    const sug = s.cardStore.suggestions;
    const apply = async (cardId: string, kind: never, value: unknown) => {
      const id = await sug.propose({ cardId, kind, value: value as never, why: "because" });
      return applySuggestion(id as string, ctx(s, me));
    };

    await make("c_assign");
    await apply("c_assign", "assignee" as never, "p_bob");
    expect((await s.cardStore.getCard("c_assign"))?.owner).toBe("p_bob");

    await make("c_label", { labels: ["ui"] });
    await apply("c_label", "label" as never, "bug");
    expect((await s.cardStore.getCard("c_label"))?.labels).toEqual(["ui", "bug"]);

    await make("c_prio");
    await apply("c_prio", "priority" as never, 2);
    expect((await s.cardStore.getCard("c_prio"))?.priority).toBe(2);

    await make("c_orig");
    await make("c_dup");
    await apply("c_dup", "duplicate" as never, "c_orig");
    const dup = await s.cardStore.getCard("c_dup");
    expect(dup?.status).toBe("rejected");
    expect(dup?.blockedReason).toBe("Duplicate of c_orig");

    await make("c_split", {
      acceptanceCriteria: [
        "Given an empty log, appending an event leaves 1 event",
        "Given a key seen before, dedupe returns the first result",
      ],
    });
    const split = await apply("c_split", "split" as never, ["Append an event", "Dedupe by key"]);
    expect(split.cards.length).toBe(2);
    expect((await s.cardStore.getCard("c_split"))?.status).toBe("rejected");

    await make("c_hold", { difficulty: 3 });
    await apply(
      "c_hold",
      "hold" as never,
      "scope drift on epic_1: held until decision dec_1 is answered",
    );
    const held = await s.cardStore.getCard("c_hold");
    expect(held?.status).toBe("planning");
    expect(held?.blockedReason).toMatch(/dec_1/);

    await make("c_remove");
    await apply("c_remove", "remove" as never, "Removed by the re-plan of epic_1: rung 3 on c_x");
    const removed = await s.cardStore.getCard("c_remove");
    expect(removed?.status).toBe("rejected");
    expect(removed?.blockedReason).toBe("Removed by the re-plan of epic_1: rung 3 on c_x");

    expect(await sug.open()).toEqual([]);
    expect((await s.log.getEventsByTypes(["suggestion/applied"])).length).toBe(7);
  });

  it("in the Team setup only the issue's owner applies a suggestion on it", async () => {
    const s = setup();
    await s.cardStore.createCard({
      id: "c_owned",
      tier: "task",
      title: "Owned",
      status: "ready",
      owner: "p_bob",
    });
    const id = await s.cardStore.suggestions.propose({
      cardId: "c_owned",
      kind: "priority",
      value: 1,
      why: "blocked for two days",
    });
    await expect(applySuggestion(id as string, ctx(s, "p_amy", team()))).rejects.toThrow(
      SuggestionError,
    );
    await expect(applySuggestion(id as string, ctx(s, "p_amy", team()))).rejects.toThrow(/Bob/);
    await applySuggestion(id as string, ctx(s, "p_bob", team()));
    expect((await s.cardStore.getCard("c_owned"))?.priority).toBe(1);
  });
});
