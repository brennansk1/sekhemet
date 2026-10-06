import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { DecisionStore } from "@sekhemet/planner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSettings } from "../src/integrations.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * The one notifier through the dashboard server (integrations items 20-23a,
 * INT-17 to INT-20; planner-pm PM-P6-3, PM-P6-10, PM-N9-6; FINISH_LINE_PLAN
 * C2d): a real server started on port 0 over a real repository and an
 * on-disk ledger, its own notifier tailing the ledger, and Slack a local
 * HTTP stub reached as the Web API (`SEKHEMET_SLACK_API_URL`). Cards move as
 * the runner moves them, on the ledger; what reaches Slack is read from the
 * stub, and what was recorded from the ledger. No model is loaded and no
 * request leaves the machine.
 */

interface Post {
  channel: string;
  text: string;
}

let root: string;
let repo: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;
let server: { port: number; close: () => Promise<void> } | undefined;
let slack: {
  port: number;
  posts: Post[];
  failNext: (n: number, status: number) => void;
  hangNext: (n: number) => void;
  close: () => Promise<void>;
};
let base: string;

async function slackStub(): Promise<typeof slack> {
  const posts: Post[] = [];
  let failing = 0;
  let failStatus = 404;
  let hanging = 0;
  const s = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      if (req.url !== "/chat.postMessage" || req.headers.authorization !== "Bearer xoxb-test") {
        res.writeHead(404).end();
        return;
      }
      if (hanging > 0) {
        // Slack never answers this one: the request times out.
        hanging--;
        return;
      }
      if (failing > 0) {
        failing--;
        res.writeHead(failStatus, { "content-type": "application/json" }).end('{"ok":false}');
        return;
      }
      posts.push(JSON.parse(raw) as Post);
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return {
    port: (s.address() as AddressInfo).port,
    posts,
    failNext: (n, status) => {
      failing = n;
      failStatus = status;
    },
    hangNext: (n) => {
      hanging = n;
    },
    close: () =>
      new Promise<void>((r) => {
        s.closeAllConnections();
        s.close(() => r());
      }),
  };
}

/** Slack connected with a bot token and a channel, reached at the local stub. */
function connectSlack(): void {
  vi.stubEnv("SEKHEMET_SLACK_BOT_TOKEN", "xoxb-test");
  vi.stubEnv("SEKHEMET_SLACK_CHANNEL", "#team");
  vi.stubEnv("SEKHEMET_SLACK_API_URL", `http://127.0.0.1:${slack.port}`);
}

async function serve(): Promise<void> {
  server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(store),
    cardStore: store,
    repoPath: repo,
    port: 0,
    streamIntervalMs: 1000,
    pressureLevel: () => 1,
  });
  base = `http://127.0.0.1:${server.port}`;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "sek-notify-http-"));
  repo = join(root, "repo");
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, ".gitignore"), ".sekhemet/\n");
  vi.stubEnv("SEKHEMET_CONFIG_DIR", join(root, "config"));
  vi.stubEnv("SEKHEMET_USER_CONFIG", join(root, "config", "config.toml"));
  vi.stubEnv("SEKHEMET_KEYCHAIN", "off");
  for (const k of Object.keys(process.env).filter((x) => /^SEKHEMET_(SLACK|GITHUB|PUSH)/.test(x)))
    vi.stubEnv(k, "");
  slack = await slackStub();
  db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db);
  store = new CardStore(db, log);
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await slack.close();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** What the Activity log shows of the notices sent (`GET /api/events?type=pm/notify`). */
const notified = async () =>
  (
    (await (await fetch(`${base}/api/events?type=pm/notify&order=asc&limit=100`)).json()) as {
      events: { payload: { channel: string; kind: string; ok: boolean } }[];
    }
  ).events.map((e) => e.payload);
/** Wait for the notifier's tick (every five seconds) to have done `check`. */
const settled = (check: () => Promise<void> | void, timeout = 15_000) =>
  vi.waitFor(check, { timeout, interval: 200 });

/** A card in To do, then moved to In review as the runner moves it. */
async function reviewed(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const c = await store.createCard({ tier: "task", title, status: "ready", ...extra });
  await store.updateCardStatus(c.id, "in_progress", "run", "harness");
  await store.updateCardStatus(c.id, "review", "gates passed", "harness", { override: true });
  return c.id;
}

describe("Slack through the server's notifier", () => {
  beforeEach(() => {
    // Standups and reminders are due late, so these tests see the notices alone.
    writeSettings(repo, { standupAt: "23:59" });
  });

  it("INT-17: a card entering Review is posted to Slack once, and recorded as pm/notify on the slack channel", async () => {
    connectSlack();
    await serve();
    const id = await reviewed("Show the weekly total");
    await settled(() => expect(slack.posts).toHaveLength(1));
    expect(slack.posts[0]?.channel).toBe("#team");
    expect(slack.posts[0]?.text).toContain("*Ready for review*");
    expect(slack.posts[0]?.text).toContain(id);
    expect(await notified()).toEqual([
      expect.objectContaining({ channel: "slack", kind: "review", ok: true }),
    ]);
    // Once: the next ticks send it again to no one.
    await new Promise((r) => setTimeout(r, 6000));
    expect(slack.posts).toHaveLength(1);
  }, 30_000);

  it("INT-19: a decision request is sent to the channels that accept decisions", async () => {
    connectSlack();
    await serve();
    await store.createCard({ id: "c1", tier: "task", title: "Pick a store", status: "ready" });
    await new DecisionStore({ store, log }).request({
      id: "r1",
      cardId: "c1",
      question: "Which store should the timesheets use?",
      options: [
        { label: "SQLite", consequence: "local", effortDelta: "0", riskNote: "Low." },
        { label: "Postgres", consequence: "server", effortDelta: "+1h", riskNote: "Server." },
      ],
      previewSketches: [],
      recommendation: { optionIndex: 0, rationale: "local" },
      policy: "default_deny",
      defaultIfNoAnswer: { deadline: "2099-01-01T00:00:00Z" },
      category: "storage",
      createdAt: "",
    });
    const decisions = () => slack.posts.filter((p) => p.text.includes("A decision waits for you"));
    await settled(() => expect(decisions()).toHaveLength(1));
    expect(decisions()[0]?.text).toContain("Which store should the timesheets use?");
    expect((await notified()).filter((n) => n.kind === "decision")).toEqual([
      expect.objectContaining({ channel: "slack", kind: "decision", ok: true }),
    ]);
  }, 30_000);

  it("INT-20: Slack answering 4xx is recorded ok: false and the notifier goes on to the next notice", async () => {
    connectSlack();
    slack.failNext(1, 403);
    await serve();
    await reviewed("First, refused by Slack");
    await settled(async () =>
      expect(await notified()).toEqual([expect.objectContaining({ kind: "review", ok: false })]),
    );
    const second = await reviewed("Second, delivered");
    await settled(() => expect(slack.posts).toHaveLength(1));
    expect(slack.posts[0]?.text).toContain(second);
    expect((await notified()).map((n) => n.ok)).toEqual([false, true]);
  }, 30_000);

  it("INT-20: Slack timing out is recorded ok: false and the notifier goes on to the next notice", async () => {
    connectSlack();
    slack.hangNext(1);
    await serve();
    await reviewed("First, never answered");
    // Slack may take ten seconds before the post counts as failed.
    await settled(
      async () =>
        expect(await notified()).toEqual([expect.objectContaining({ kind: "review", ok: false })]),
      30_000,
    );
    const second = await reviewed("Second, delivered");
    await settled(() => expect(slack.posts).toHaveLength(1));
    expect(slack.posts[0]?.text).toContain(second);
    expect((await notified()).map((n) => n.ok)).toEqual([false, true]);
  }, 60_000);

  it("PM-P6-10: past three unsolicited notices in a day the rest are held for the standup; at most five are ever sent; at the board, the item goes to the panel instead", async () => {
    connectSlack();
    await serve();
    for (const t of ["One", "Two", "Three", "Four"]) await reviewed(t);
    await settled(async () =>
      expect(await log.getEventsByTypes(["pm/notice_held"])).toHaveLength(1),
    );
    expect(slack.posts).toHaveLength(3);
    // The person raises the day's limit as far as it goes: still never a sixth.
    writeSettings(repo, { slackDailyBudget: 10 });
    for (const t of ["Five", "Six", "Seven"]) await reviewed(t);
    await settled(async () =>
      expect(await log.getEventsByTypes(["pm/notice_held"])).toHaveLength(2),
    );
    expect(slack.posts).toHaveLength(5);
    // The board in focus: the next item is shown in Seshat's panel, and Slack hears nothing.
    const focus = await fetch(`${base}/api/pm/focus`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
      body: "{}",
    });
    expect(focus.status).toBe(200);
    const shown = await reviewed("Eight, at the board");
    await settled(async () =>
      expect(await log.getEventsByTypes(["pm/notice_shown"])).toHaveLength(1),
    );
    expect(slack.posts).toHaveLength(5);
    const thread = (await (await fetch(`${base}/api/pm/thread`)).json()) as {
      messages: { role: string; text: string }[];
    };
    expect(thread.messages.some((m) => m.role === "pm" && m.text.includes(shown))).toBe(true);
  }, 60_000);
});

describe("the daily standup and reminders, sent when due", () => {
  it("INT-18, PM-P6-3: the standup goes to Slack; one builder with the chat's; only cards done since the previous standup under Done; the next cards in the queue's order; no stop-reason code or backticked id", async () => {
    writeSettings(repo, { standupAt: "00:00" });
    // Slack is connected after the board is set, so the first thing it hears is the standup.
    await serve();
    const before = await store.createCard({
      tier: "task",
      title: "Seed the database",
      status: "ready",
    });
    await store.updateCardStatus(before.id, "done", "accepted", "human", { override: true });
    // The person's standup in the chat: the previous standup.
    const asked = await fetch(`${base}/api/pm/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
      body: JSON.stringify({ text: "/status" }),
    });
    expect(asked.status).toBe(200);
    await settled(async () => {
      const t = (await (await fetch(`${base}/api/pm/thread`)).json()) as {
        messages: { role: string; text: string }[];
      };
      expect(t.messages.some((m) => m.role === "pm" && /^Since/.test(m.text))).toBe(true);
    });
    const after = await store.createCard({
      tier: "task",
      title: "Export the CSV",
      status: "ready",
    });
    await store.updateCardStatus(after.id, "done", "accepted", "human", { override: true });
    await store.createCard({ tier: "task", title: "Overtime rules", status: "ready", priority: 1 });
    await store.createCard({ tier: "task", title: "Night shifts", status: "ready", priority: 3 });
    const stuck = await store.createCard({
      tier: "task",
      title: "Payroll export",
      status: "ready",
    });
    await store.updateCardStatus(stuck.id, "parked", "stopped", "harness", { override: true });
    await store.updateCard(stuck.id, { stopReason: "scope_violation" });
    connectSlack();
    await settled(() => expect(slack.posts.length).toBeGreaterThanOrEqual(1), 20_000);
    const standup = slack.posts.find((p) => /Since the last standup/.test(p.text))?.text ?? "";
    expect(standup).toMatch(/^Since the last standup/);
    // Done: only what was done since the previous standup.
    expect(standup).toContain("Done: Export the CSV.");
    expect(standup).not.toContain("Seed the database");
    // Next up: the queue's order, Urgent first.
    expect(standup).toMatch(/Next up: Overtime rules.*, then Night shifts/);
    // Plain words: no stop-reason code, no backticked id.
    expect(standup).not.toContain("scope_violation");
    expect(standup).not.toMatch(/`[^`]*`/);
    expect(standup).toContain("Payroll export stopped:");
    expect(await notified()).toContainEqual(
      expect.objectContaining({ channel: "slack", kind: "standup", ok: true }),
    );
    // One builder: the chat's /status, asked now, says the same lines.
    await fetch(`${base}/api/pm/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
      body: JSON.stringify({ text: "/status" }),
    });
    let chat = "";
    await settled(async () => {
      const t = (await (await fetch(`${base}/api/pm/thread`)).json()) as {
        messages: { role: string; text: string }[];
      };
      chat = t.messages.filter((m) => m.role === "pm" && /^Since/.test(m.text)).at(-1)?.text ?? "";
      expect(chat).toContain("Next up:");
      expect(chat).not.toBe("");
    });
    const line = (text: string, head: string) =>
      text.split("\n").find((l) => l.startsWith(head)) ?? "";
    for (const head of ["In flight:", "Needs you:", "Next up:"])
      expect(line(chat, head), head).toBe(line(standup, head));
  }, 60_000);

  it("PM-N9-6: an issue waiting a day for review is reminded to its owner only, in neutral product text, within the budget", async () => {
    const me = store.localPrincipal();
    // A day ago, as the ledger records it: two issues entered Review.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 26 * 3_600_000);
    const mine = await reviewed("My issue", { owner: me });
    const theirs = await reviewed("Someone else's issue", { owner: "p_someone" });
    vi.useRealTimers();
    writeSettings(repo, { standupAt: "00:00" });
    connectSlack();
    await serve();
    await settled(async () =>
      expect((await notified()).some((n) => n.kind === "reminder")).toBe(true),
    );
    const reminder = slack.posts.find((p) => /waiting for review/.test(p.text))?.text ?? "";
    expect(reminder).toContain("*1 issue waiting for review*");
    expect(reminder).toContain(mine);
    expect(reminder).not.toContain(theirs);
    // The product's words, not Seshat's voice.
    expect(reminder).not.toMatch(/\bI\b|Seshat/);
    const claims = (await log.getEventsByTypes(["pm/notify_claimed"])).filter(
      (e) => (e.payload as { kind?: string }).kind === "reminder",
    );
    expect(claims).toHaveLength(1);
  }, 30_000);
});
