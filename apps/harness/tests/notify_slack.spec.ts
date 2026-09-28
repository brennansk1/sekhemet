import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSettings } from "../src/integrations.js";
import { MAX_DAILY_BUDGET, startNotifier } from "../src/notify.js";
import { dailyStandup } from "../src/pm/service.js";
import { PmStore } from "../src/pm/store.js";

/**
 * One notifier, Slack a channel of it (integrations items 20-23a, INT-17 to
 * INT-20a): a real SQLite ledger on disk, and a local HTTP server standing in
 * for Slack's incoming webhook and Web API.
 */

interface Hit {
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

describe("the one notifier with Slack as a channel (P9)", () => {
  let dir: string;
  let db: DatabaseSync;
  let log: EventLog;
  let cards: CardStore;
  let slack: Server;
  let hits: Hit[];
  /** How the stand-in answers the next request: a status, or `hang` to time out. */
  let answer: (n: number) => number | "hang";
  let hook: string;
  let clock: Date;
  const now = () => clock;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "notify-slack-"));
    process.env.SEKHEMET_CONFIG_DIR = mkdtempSync(join(tmpdir(), "notify-slack-cfg-"));
    db = new DatabaseSync(join(dir, "ledger.db"));
    initSchema(db);
    log = new EventLog(db);
    cards = new CardStore(db, log);
    hits = [];
    answer = () => 200;
    slack = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        hits.push({ path: req.url ?? "", headers: req.headers, body });
        const a = answer(hits.length);
        if (a === "hang") return;
        res.writeHead(a, { "Content-Type": "application/json" });
        res.end(req.url?.startsWith("/api/") ? JSON.stringify({ ok: a === 200 }) : "ok");
      });
    });
    await new Promise<void>((r) => slack.listen(0, "127.0.0.1", r));
    const port = (slack.address() as { port: number }).port;
    hook = `http://127.0.0.1:${port}/services/T000/B000/XXXX`;
    clock = new Date(2026, 8, 25, 10, 0, 0);
  });

  afterEach(async () => {
    slack.closeAllConnections();
    await new Promise<void>((r) => slack.close(() => r()));
    db.close();
    Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
    Reflect.deleteProperty(process.env, "SEKHEMET_SLACK_BOT_TOKEN");
    Reflect.deleteProperty(process.env, "SEKHEMET_SLACK_CHANNEL");
    Reflect.deleteProperty(process.env, "SEKHEMET_SLACK_API_URL");
    rmSync(dir, { recursive: true, force: true });
  });

  const toReview = async (id: string) => {
    await cards.createCard({ id, tier: "task", title: id });
    await cards.updateCardStatus(id, "verify", "test setup", "harness", { override: true });
    await cards.updateCardStatus(id, "review", "gates passed");
  };
  /** Every row of every table, and every blob on disk: where a secret must not be. */
  const everywhere = () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];
    const rows = tables.map(({ name }) =>
      JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()),
    );
    const blobs = join(dir, ".sekhemet", "blobs");
    const files = existsSync(blobs)
      ? readdirSync(blobs, { recursive: true }).map((f) => {
          try {
            return readFileSync(join(blobs, String(f)), "utf8");
          } catch {
            return "";
          }
        })
      : [];
    return [...rows, ...files].join("\n");
  };
  const notifies = async () =>
    (await log.getEventsByTypes(["pm/notify"])).map((e) => e.payload as Record<string, unknown>);

  it("INT-17: a card entering Review posts once to Slack and records pm/notify slack", async () => {
    writeSettings(dir, { slackWebhookUrl: hook, slackEvents: ["review"] });
    const n = await startNotifier(log, dir, { intervalMs: 60_000, now });
    await toReview("card_a");
    expect(await n.tick()).toBe(1);
    await n.tick();
    n.stop();
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("/services/T000/B000/XXXX");
    expect(JSON.parse(hits[0]?.body ?? "{}").text).toMatch(/card_a/);
    expect(await notifies()).toEqual([
      expect.objectContaining({ channel: "slack", kind: "review", ok: true }),
    ]);
    // Through the one network policy: the request is a recorded egress.
    const egress = await log.getEventsByTypes(["harness/egress"]);
    expect(egress.map((e) => (e.payload as { purpose: string }).purpose)).toEqual([
      "integration:slack",
    ]);
    // The webhook URL is a secret: never in a chained payload.
    const chained = (await log.getEvents(1, 1000)).map((e) => JSON.stringify(e.payload));
    expect(chained.some((p) => p.includes("XXXX"))).toBe(false);
    // B1: nor in the private part, a blob or any table: the egress keeps the origin only.
    expect((egress[0]?.private as { url?: string } | undefined)?.url).toBe(
      `${new URL(hook).origin}/…`,
    );
    const all = everywhere();
    expect(all).not.toContain("XXXX");
    expect(all).not.toContain("/services/T000");
  });

  it("INT-19: a decision request sends a `decision` notice to the channels that accept it", async () => {
    await cards.createCard({ id: "card_d", tier: "task", title: "Pick a store" });
    writeSettings(dir, { slackWebhookUrl: hook, slackEvents: ["review"] });
    const n = await startNotifier(log, dir, { intervalMs: 60_000, now });
    await cards.runs.requestDecision({
      cardId: "card_d",
      kind: "planner",
      question: "SQLite or Postgres?",
      context: "{}",
      options: ["SQLite", "Postgres"],
    });
    await n.tick();
    expect(hits).toHaveLength(0);
    writeSettings(dir, { slackEvents: ["decision"] });
    await cards.runs.requestDecision({
      cardId: "card_d",
      kind: "planner",
      question: "Keep the cache?",
      context: "{}",
      options: ["Yes", "No"],
    });
    expect(await n.tick()).toBe(1);
    n.stop();
    expect(hits).toHaveLength(1);
    expect(JSON.parse(hits[0]?.body ?? "{}").text).toMatch(/Keep the cache\?/);
    expect(await notifies()).toEqual([
      expect.objectContaining({ channel: "slack", kind: "decision", ok: true }),
    ]);
  });

  it("INT-20: a 4xx or a timeout records ok: false and the notifier goes on", async () => {
    writeSettings(dir, { slackWebhookUrl: hook });
    answer = (n) => (n === 1 ? 404 : n === 2 ? "hang" : 200);
    const n = await startNotifier(log, dir, { intervalMs: 60_000, now, timeoutMs: 300 });
    await toReview("card_1");
    await toReview("card_2");
    await toReview("card_3");
    expect(await n.tick()).toBe(1);
    n.stop();
    expect(hits).toHaveLength(3);
    expect((await notifies()).map((p) => p.ok)).toEqual([false, false, true]);
    // A failed send is not an interruption: the budget still has room.
    await toReview("card_4");
    const again = await startNotifier(log, dir, { intervalMs: 60_000, now });
    await toReview("card_5");
    expect(await again.tick()).toBe(1);
    again.stop();
  });

  it("INT-20: a bot token posts through the Web API, and Slack's own ok: false is a failure", async () => {
    process.env.SEKHEMET_SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SEKHEMET_SLACK_CHANNEL = "C0123";
    process.env.SEKHEMET_SLACK_API_URL = hook.replace(/\/services\/.*$/, "/api");
    answer = (n) => (n === 1 ? 200 : 400);
    const n = await startNotifier(log, dir, { intervalMs: 60_000, now });
    await toReview("card_b1");
    await toReview("card_b2");
    expect(await n.tick()).toBe(1);
    n.stop();
    expect(hits[0]?.path).toBe("/api/chat.postMessage");
    expect(hits[0]?.headers.authorization).toBe("Bearer xoxb-test-token");
    expect(JSON.parse(hits[0]?.body ?? "{}")).toMatchObject({ channel: "C0123" });
    expect((await notifies()).map((p) => p.ok)).toEqual([true, false]);
    // The token is never on the ledger: not in a payload, a private part, a table or a blob.
    const all = (await log.getEvents(1, 1000)).map((e) => JSON.stringify(e.payload));
    expect(all.some((p) => p.includes("xoxb"))).toBe(false);
    expect(everywhere()).not.toContain("xoxb");
  });

  it("INT-20a: the fourth unsolicited notice of the day is held for the standup, sending nothing", async () => {
    writeSettings(dir, { slackWebhookUrl: hook });
    const n = await startNotifier(log, dir, {
      intervalMs: 60_000,
      now,
      standupAt: "09:00",
      standup: async () => "Working: nothing.",
    });
    // The standup of the day goes first (it is due at 10:00), and counts.
    expect(await n.tick()).toBe(1);
    for (const id of ["card_1", "card_2", "card_3"]) await toReview(id);
    expect(await n.tick()).toBe(2);
    expect(hits).toHaveLength(3);
    const held = await log.getEventsByTypes(["pm/notice_held"]);
    expect(held.map((e) => e.cardId)).toEqual(["card_3"]);
    expect(held[0]?.payload).toMatchObject({ kind: "review" });
    // Nothing more today; the next day's standup carries the held notice.
    await toReview("card_4");
    expect(await n.tick()).toBe(0);
    expect(hits).toHaveLength(3);
    clock = new Date(2026, 8, 26, 9, 5, 0);
    expect(await n.tick()).toBe(1);
    n.stop();
    const standup = JSON.parse(hits[3]?.body ?? "{}").text as string;
    expect(standup).toMatch(/Working: nothing\./);
    expect(standup).toMatch(/card_3/);
    expect(standup).toMatch(/card_4/);
    expect((await notifies()).filter((p) => p.kind === "standup")).toHaveLength(2);
  });

  it("INT-20a: a channel configured above 5 a day still sends no more than 5", async () => {
    expect(MAX_DAILY_BUDGET).toBe(5);
    writeSettings(dir, { slackWebhookUrl: hook, slackDailyBudget: 9 });
    const n = await startNotifier(log, dir, { intervalMs: 60_000, now });
    for (let i = 1; i <= 7; i++) await toReview(`card_${i}`);
    expect(await n.tick()).toBe(5);
    n.stop();
    expect(hits).toHaveLength(5);
    expect(await log.getEventsByTypes(["pm/notice_held"])).toHaveLength(2);
    // A restarted notifier counts today's sends from the ledger.
    const again = await startNotifier(log, dir, { intervalMs: 60_000, now });
    await toReview("card_8");
    expect(await again.tick()).toBe(0);
    again.stop();
    expect(hits).toHaveLength(5);
  });

  it("INT-18: the daily standup is sent once, when due, through a channel that accepts it", async () => {
    writeSettings(dir, { slackWebhookUrl: hook, slackEvents: ["review"] });
    clock = new Date(2026, 8, 25, 9, 30, 0);
    await cards.createCard({ id: "card_x", tier: "task", title: "Ledger", status: "ready" });
    // Seshat's ledger standup, as the product builds it, without a model.
    const standup = () =>
      dailyStandup({ repoPath: dir, cardStore: cards, pmStore: new PmStore(log) });
    const n = await startNotifier(log, dir, {
      intervalMs: 60_000,
      now,
      standupAt: "09:00",
      standup,
    });
    expect(await n.tick()).toBe(0);
    expect(hits).toHaveLength(0);
    writeSettings(dir, { slackEvents: ["review", "standup"] });
    clock = new Date(2026, 8, 25, 8, 59, 0);
    expect(await n.tick()).toBe(0);
    clock = new Date(2026, 8, 25, 9, 1, 0);
    expect(await n.tick()).toBe(1);
    clock = new Date(2026, 8, 25, 17, 0, 0);
    expect(await n.tick()).toBe(0);
    n.stop();
    expect(hits).toHaveLength(1);
    const text = JSON.parse(hits[0]?.body ?? "{}").text as string;
    // PM-P6-3: the one standup builder, plain: the issue by its title, never its id.
    expect(text).toMatch(/Next up: Ledger \(/);
    expect(text).not.toMatch(/card_x/);
    expect(text).toMatch(/Done: nothing since yesterday\./);
    expect(text).not.toMatch(/without loading a model/);
    expect(await notifies()).toEqual([
      expect.objectContaining({ channel: "slack", kind: "standup", ok: true }),
    ]);
  });
  it("B2: two notifiers on one ledger send each notice and the standup once, and the budget holds", async () => {
    writeSettings(dir, { slackWebhookUrl: hook });
    // One person on the ledger, as the server and a queue run both see it.
    log.ensureLocalPerson({ name: "Jane" });
    // A second process: its own connection to the same ledger file.
    const db2 = new DatabaseSync(join(dir, "ledger.db"));
    const log2 = new EventLog(db2);
    const opts = {
      intervalMs: 60_000,
      now,
      standupAt: "09:00",
      standup: async () => "Working: nothing.",
    };
    const a = await startNotifier(log, dir, opts);
    const b = await startNotifier(log2, dir, opts);
    // Both find the standup due at once: it goes once.
    const first = await Promise.all([a.tick(), b.tick()]);
    expect(first[0] + first[1]).toBe(1);
    expect(hits).toHaveLength(1);
    for (const id of ["card_1", "card_2", "card_3", "card_4"]) await toReview(id);
    const second = await Promise.all([a.tick(), b.tick()]);
    // The standup counted: two more under the default budget of 3, the rest held once each.
    expect(second[0] + second[1]).toBe(2);
    expect(await Promise.all([a.tick(), b.tick()])).toEqual([0, 0]);
    a.stop();
    b.stop();
    db2.close();
    expect(hits).toHaveLength(3);
    const texts = hits.slice(1).map((h) => JSON.parse(h.body).text as string);
    expect(new Set(texts).size).toBe(2);
    const held = await log.getEventsByTypes(["pm/notice_held"]);
    expect(held.map((e) => e.cardId).sort()).toEqual(["card_3", "card_4"]);
    const ok = (await notifies()).filter((p) => p.ok);
    expect(ok.filter((p) => p.kind === "standup")).toHaveLength(1);
    expect(ok.filter((p) => p.kind === "review")).toHaveLength(2);
  });

  it("a failed standup is retried that day, and sent once when it goes", async () => {
    writeSettings(dir, { slackWebhookUrl: hook });
    answer = (n) => (n === 1 ? 500 : 200);
    const n = await startNotifier(log, dir, {
      intervalMs: 60_000,
      now,
      standupAt: "09:00",
      standup: async () => "Working: nothing.",
    });
    expect(await n.tick()).toBe(0);
    expect(hits).toHaveLength(1);
    // Not at once: a retry waits a while.
    clock = new Date(2026, 8, 25, 10, 1, 0);
    expect(await n.tick()).toBe(0);
    expect(hits).toHaveLength(1);
    clock = new Date(2026, 8, 25, 10, 15, 0);
    expect(await n.tick()).toBe(1);
    clock = new Date(2026, 8, 25, 17, 0, 0);
    expect(await n.tick()).toBe(0);
    n.stop();
    expect(hits).toHaveLength(2);
    expect((await notifies()).filter((p) => p.kind === "standup").map((p) => p.ok)).toEqual([
      false,
      true,
    ]);
  });
});
