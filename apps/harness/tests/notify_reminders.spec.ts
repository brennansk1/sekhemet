import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { remindersFor, startNotifier, writePush } from "../src/notify.js";

// planner-pm PM-N9-6: "Update due" and "N issues waiting for review" come in
// the product's neutral text, only to the owner of the item, within the
// notification budget. Real SQLite on disk.

describe("PM-N9-6: neutral reminders, to the owner, within the budget", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "notify-rem-"));
    process.env.SEKHEMET_CONFIG_DIR = mkdtempSync(join(tmpdir(), "notify-rem-cfg-"));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  function ledger() {
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    return { db, log, cards: new CardStore(db, log) };
  }

  const toReview = async (cards: CardStore, id: string, owner?: string) => {
    await cards.createCard({ id, tier: "task", title: id, ...(owner ? { owner } : {}) });
    await cards.updateCardStatus(id, "verify", "test setup", "harness", { override: true });
    await cards.updateCardStatus(id, "review", "gates passed");
  };

  /** Ten in the morning two days on: the reviews below have waited over a day. */
  const later = () => {
    const d = new Date(Date.now() + 2 * 86_400_000);
    d.setHours(10, 0, 0, 0);
    return d;
  };

  it("counts only the recipient's own issues, in neutral text, once a day", async () => {
    const { log, cards } = ledger();
    const me = log.localPrincipal();
    writePush(repo, { kind: "ntfy", url: "https://ntfy.sh", topic: "t", events: ["reminder"] });
    const sent: { title: string; body: string }[] = [];
    const fetch = (async (_u: string, init?: RequestInit) => {
      const h = init?.headers as Record<string, string>;
      sent.push({ title: h.Title ?? "", body: String(init?.body) });
      return new Response("ok");
    }) as typeof globalThis.fetch;
    await toReview(cards, "card_a", me);
    await toReview(cards, "card_b", me);
    await toReview(cards, "card_bob", "p_bob");
    const n = await startNotifier(log, repo, {
      intervalMs: 60_000,
      fetch,
      now: later,
      standupAt: "09:00",
    });
    await n.tick();
    expect(sent).toEqual([{ title: "2 issues waiting for review", body: "card_a, card_b" }]);
    // Not in Seshat's voice: no first person.
    expect(sent[0]?.body).not.toMatch(/\bI\b|Seshat/);
    await n.tick();
    expect(sent).toHaveLength(1);
    n.stop();
  });

  it("past the day's budget a reminder is held for the standup, not sent", async () => {
    const { log, cards } = ledger();
    const me = log.localPrincipal();
    writePush(repo, { kind: "ntfy", url: "https://ntfy.sh", topic: "t", dailyBudget: 0 });
    let sends = 0;
    const fetch = (async () => {
      sends++;
      return new Response("ok");
    }) as typeof globalThis.fetch;
    const n = await startNotifier(log, repo, {
      intervalMs: 60_000,
      fetch,
      now: later,
      standupAt: "09:00",
    });
    await toReview(cards, "card_a", me);
    await n.tick();
    expect(sends).toBe(0);
    const held = await log.getEventsByTypes(["pm/notice_held"]);
    expect(held.map((e) => (e.payload as { kind: string }).kind)).toContain("reminder");
    n.stop();
  });

  it("a review notice for an issue someone else owns is not sent to this person", async () => {
    const { log, cards } = ledger();
    writePush(repo, { kind: "ntfy", url: "https://ntfy.sh", topic: "t", events: ["review"] });
    const bodies: string[] = [];
    const fetch = (async (_u: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response("ok");
    }) as typeof globalThis.fetch;
    const n = await startNotifier(log, repo, { intervalMs: 60_000, fetch });
    await toReview(cards, "card_theirs", "p_bob");
    await toReview(cards, "card_mine", log.localPrincipal());
    await n.tick();
    expect(bodies).toEqual(["card_mine passed its checks and waits for you."]);
    n.stop();
  });

  it("in the Team setup, an unowned issue's review reminder goes to the project's lead", async () => {
    const { log, cards } = ledger();
    const project = (await cards.ensureProject({ rootPath: repo, name: "Fixture" })).id;
    await cards.createCard({
      id: "card_unowned",
      tier: "task",
      title: "card_unowned",
      projectId: project,
    });
    await cards.updateCardStatus("card_unowned", "verify", "test setup", "harness", {
      override: true,
    });
    await cards.updateCardStatus("card_unowned", "review", "gates passed");
    await log.append({
      actor: "human",
      type: "project/settings_changed",
      principal: log.localPrincipal(),
      payload: { project, lead: "p_lee" },
    });
    const forLee = await remindersFor(log, "p_lee", {
      day: "2026-09-28",
      now: later(),
      setup: "team",
    });
    expect(forLee.map((n) => n.title)).toContain("1 issue waiting for review");
    const forOther = await remindersFor(log, "p_other", {
      day: "2026-09-28",
      now: later(),
      setup: "team",
    });
    expect(forOther).toEqual([]);
  });
});
