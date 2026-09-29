import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startNotifier, writePush } from "../src/notify.js";
import { audienceFromAccess } from "../src/pm/audience.js";
import { startDashboardServer } from "../src/server.js";
import { Access } from "../src/team/access.js";
import { type InboxDeps, inboxNotifier, markInboxItem } from "../src/team/inbox.js";
import { allMembers, personName } from "../src/team/members.js";
import { identitySettings } from "../src/team/settings.js";

/**
 * B4.11, teams NEW-teams-7 (items 22–24; TEAM-21, -22, -23, -43) and
 * dashboard DB-N9-14, -15, on a real Team server over a Team ledger with
 * five people signed in at four levels (DoD §2A): who is subscribed to an
 * issue, what reaches each person's Inbox and under which reason, a mention
 * of someone who cannot see the project, the Inbox's marks, My issues, and
 * the notices a watcher is pushed within their own budget.
 */

const PASSWORD = "correct horse battery staple";

let root: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;
let dir: string;
let base: string;
let server: { port: number; close: () => Promise<void> } | undefined;

interface Person {
  principal: string;
  headers: Record<string, string>;
}
const nobody: Person = { principal: "", headers: {} };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sek-inbox-"));
  mkdirSync(join(root, ".sekhemet"), { recursive: true });
  writeFileSync(join(root, "noop.mjs"), "");
  process.env.SEKHEMET_CLI = join(root, "noop.mjs");
  process.env.SEKHEMET_CONFIG_DIR = mkdtempSync(join(tmpdir(), "sek-inbox-cfg-"));
  db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db, { setup: "team" });
  store = new CardStore(db, log);
  dir = join(root, "identity");
  writeFileSync(join(root, "list.txt"), "passwordpassword1\n");
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  Reflect.deleteProperty(process.env, "SEKHEMET_CLI");
  Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function start() {
  vi.spyOn(console, "log").mockImplementation(() => {});
  server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(store),
    cardStore: store,
    repoPath: root,
    port: 0,
    streamIntervalMs: 10_000,
    pressureLevel: () => 1,
    pmAdapter: () => new MockInferenceAdapter("dirk-27b", []),
    identity: {
      dir,
      passwordList: join(root, "list.txt"),
      settings: identitySettings({ mode: "team", workspace: "Northwind" }),
    },
  });
  vi.mocked(console.log).mockRestore();
  base = `http://127.0.0.1:${server.port}`;
}

const call = (method: string, path: string, who: Person, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Sekhemet-Action": "1", ...who.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function signedIn(res: Response): Promise<Person> {
  const body = (await res.json()) as { principal: string; csrf: string; error?: string };
  expect(res.status, body.error).toBe(200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { principal: body.principal, headers: { Cookie: cookie, "X-Sekhemet-CSRF": body.csrf } };
}

async function invited(by: Person, level: string, name: string, email: string) {
  const res = await call("POST", "/api/invites", by, { level, email });
  expect(res.status).toBe(200);
  const id = ((await res.json()) as { id: string }).id;
  return signedIn(
    await call("POST", `/api/invites/${id}/accept`, nobody, { name, email, password: PASSWORD }),
  );
}

const asPerson = <T>(who: Person, fn: () => T): T => EventLog.actingFor(who.principal, fn);

async function ok(who: Person, method: string, path: string, body?: unknown) {
  const res = await call(method, path, who, body);
  const data = (await res.json()) as Record<string, unknown>;
  expect(res.status, `${method} ${path}: ${JSON.stringify(data)}`).toBeLessThan(400);
  return data;
}

interface Item {
  id: string;
  reason: string;
  kind: string;
  cardId?: string;
  title: string;
  count: number;
  unread: boolean;
  saved: boolean;
  done: boolean;
  snoozedUntil?: string;
  change?: { type: string; by?: string; byAi?: string; status?: string; to?: string };
  ai?: { who: string; state: string }[];
  request?: { requestedBy: string };
  mention?: { people: string[]; project?: string };
  link: string;
}

const inboxOf = async (who: Person, filter = "inbox") =>
  (await ok(who, "GET", `/api/inbox?filter=${filter}`)) as { items: Item[]; unread: number };

const rowFor = async (who: Person, cardId: string, filter = "inbox") =>
  (await inboxOf(who, filter)).items.find((i) => i.cardId === cardId && i.kind === "issue");

const watching = async (who: Person, cardId: string) =>
  ((await ok(who, "GET", `/api/issues/${cardId}/watch`)) as { watching: boolean }).watching;

/** Five people at four levels on one project, Chronicle, led by Lee. */
async function team() {
  await start();
  const token = readFileSync(join(dir, "setup-token"), "utf8").trim();
  const ada = await signedIn(
    await call("POST", "/api/setup", nobody, {
      token,
      name: "Ada Admin",
      email: "ada@northwind.test",
      password: PASSWORD,
    }),
  );
  const project = (
    await asPerson(ada, () =>
      store.ensureProject({ rootPath: join(root, "chronicle"), name: "Chronicle" }),
    )
  ).id;
  const mo = await invited(ada, "member", "Mo Member", "mo@northwind.test");
  const lee = await invited(ada, "member", "Lee Lead", "lee@northwind.test");
  const sam = await invited(ada, "stakeholder", "Sam Stakeholder", "sam@northwind.test");
  const vic = await invited(ada, "viewer", "Vic Viewer", "vic@northwind.test");
  await ok(ada, "PATCH", `/api/projects/${project}/settings`, { lead: lee.principal });
  /** Ada creates the issue, as the board's *New issue* does; `owner`, when given, owns it. */
  const issue = async (title: string, owner?: Person) => {
    const card = await asPerson(ada, () =>
      store.createCard({ tier: "task", title, status: "ready", projectId: project }, "human"),
    );
    if (owner)
      await asPerson(ada, () => store.changeOwner(card.id, owner.principal, ada.principal));
    return card.id;
  };
  return { ada, mo, lee, sam, vic, project, issue };
}

describe("TEAM-21: who is subscribed to an issue", () => {
  it("its creator, owner, delegate, commenters, the people mentioned and the reviewers — no one else", async () => {
    const t = await team();
    const card = await t.issue("Login", t.mo);
    // Created by Ada, owned by Mo.
    expect(await watching(t.ada, card)).toBe(true);
    expect(await watching(t.mo, card)).toBe(true);
    expect(await watching(t.sam, card)).toBe(false);
    expect(await watching(t.vic, card)).toBe(false);
    expect(await watching(t.lee, card)).toBe(false);

    // Commenting subscribes Sam; a mention subscribes Vic.
    await ok(t.sam, "POST", `/api/cards/${card}/comments`, { text: "Looks good @VicViewer" });
    expect(await watching(t.sam, card)).toBe(true);
    expect(await watching(t.vic, card)).toBe(true);

    // Asked to review: with no Accept rule set the lead accepts (DEC-42), so
    // the issue reaching Review subscribes Lee.
    await store.updateCardStatus(card, "review", "checks passed", "executor", { override: true });
    expect(await watching(t.lee, card)).toBe(true);

    // Delegated to a person subscribes them.
    const other = await t.issue("Export");
    expect(await watching(t.vic, other)).toBe(false);
    await asPerson(t.ada, () =>
      store.delegateCard(other, { kind: "person", id: t.vic.principal }, t.ada.principal),
    );
    expect(await watching(t.vic, other)).toBe(true);

    // The watchers are named, and the toggle turns it off and on.
    const state = (await ok(t.mo, "GET", `/api/issues/${card}/watch`)) as {
      watchers: { name: string }[];
    };
    expect(state.watchers.map((w) => w.name).sort()).toEqual(
      ["Ada Admin", "Lee Lead", "Sam Stakeholder", "Vic Viewer", "You"].sort(),
    );
    await ok(t.vic, "POST", `/api/issues/${card}/watch`, { watch: false });
    expect(await watching(t.vic, card)).toBe(false);
    const recorded = (await log.getEventsByTypes(["issue/unwatched"])).at(-1);
    expect(recorded?.principal).toBe(t.vic.principal);
    expect(recorded?.payload).toEqual({ cardId: card });
  });
});

describe("TEAM-43 (the Inbox half), DB-N9-14: a watched issue's change reaches each watcher", () => {
  it("files each change under its reason, never in the Inbox of the person who made it", async () => {
    const t = await team();
    const card = await t.issue("Login", t.mo);

    // Sam comments and mentions Vic: Vic is Mentioned, Mo and Ada are Watching, Sam gets nothing.
    await ok(t.sam, "POST", `/api/cards/${card}/comments`, { text: "@VicViewer can you look" });
    const vic = await rowFor(t.vic, card);
    expect(vic).toMatchObject({
      reason: "mentioned",
      unread: true,
      title: "Login",
      change: { type: "mentioned", by: "Sam Stakeholder" },
    });
    expect(await rowFor(t.mo, card)).toMatchObject({
      reason: "watching",
      change: { type: "commented", by: "Sam Stakeholder" },
    });
    // Mo was made owner by Ada: that change reached Mo too, so two updates.
    expect((await rowFor(t.mo, card))?.count).toBe(2);
    expect(await rowFor(t.sam, card)).toBeUndefined();
    expect(await rowFor(t.lee, card)).toBeUndefined();

    // The issue reaching Review asks the lead to review it.
    await store.updateCardStatus(card, "review", "checks passed", "executor", { override: true });
    expect(await rowFor(t.lee, card)).toMatchObject({
      reason: "review_requested",
      change: { type: "status", status: "review" },
    });
  });

  it("a review, a reply in its thread, a resolve and a dismissed accept reach the issue's watchers (TEAM-21, -43)", async () => {
    const t = await team();
    const card = await t.issue("Payroll export", t.lee);
    await store.updateCardStatus(card, "review", "checks passed", "executor", { override: true });

    // Mo leaves a Comment review with a line thread: Lee, the owner, hears of it.
    const review = (await ok(t.mo, "POST", `/api/cards/${card}/reviews`, {
      body: "Two questions.",
      comments: [{ file: "src/export.ts", line: 3, text: "Why a string here?" }],
    })) as { threads: { id: string }[] };
    expect(await rowFor(t.lee, card)).toMatchObject({
      change: { type: "reviewed", by: "Mo Member" },
    });
    // Commenting in a review subscribes the reviewer (TEAM-21).
    expect(await watching(t.mo, card)).toBe(true);
    expect(await rowFor(t.mo, card)).toBeUndefined();

    // Lee replies in the thread: Mo hears of it.
    const thread = review.threads.find((th) => th.id)?.id as string;
    await ok(t.lee, "POST", `/api/cards/${card}/threads/${thread}/replies`, {
      text: "It is an id.",
    });
    expect(await rowFor(t.mo, card)).toMatchObject({
      change: { type: "replied", by: "Lee Lead" },
    });
    // Lee resolves it: Mo hears that too.
    await ok(t.lee, "POST", `/api/cards/${card}/threads/${thread}/resolve`);
    expect(await rowFor(t.mo, card)).toMatchObject({
      change: { type: "resolved", by: "Lee Lead" },
    });

    // An accept dismissed by new commits reaches the accepter and the watchers.
    await store.recordPullRequestOpened(card, {
      pr: 9,
      url: "https://github.com/octo-org/octo-repo/pull/9",
      headSha: "a".repeat(40),
      accepter: t.ada.principal,
    });
    await store.dismissAccept(card, { pr: 9, headSha: "b".repeat(40) }, "github");
    expect(await rowFor(t.ada, card)).toMatchObject({ change: { type: "accept_dismissed" } });
    expect(await rowFor(t.mo, card)).toMatchObject({ change: { type: "accept_dismissed" } });
  });

  it("the Agent finishing an issue reaches the person who delegated it, with its state", async () => {
    const t = await team();
    const card = await t.issue("Search", t.lee);
    await ok(t.mo, "POST", `/api/cards/${card}/comments`, { text: "@Agent take this" });
    expect(store.delegatorOf(card)).toBe(t.mo.principal);
    await store.updateCardStatus(card, "in_progress", "claimed", "executor", { override: true });
    await store.updateCardStatus(card, "review", "checks passed", "executor", { override: true });
    const row = await rowFor(t.mo, card);
    expect(row).toMatchObject({
      reason: "agent_finished",
      change: { type: "status", byAi: "agent", status: "review" },
    });
    expect(row?.ai?.find((a) => a.who === "agent")?.state).toBe("done");
    // The lead is asked to review the same change; the owner, Lee, is also the lead.
    expect((await rowFor(t.lee, card))?.reason).toBe("review_requested");
  });

  it("a Stakeholder's @Agent waits in the owner's Needs you with the Agent's state", async () => {
    const t = await team();
    const card = await t.issue("Maps", t.mo);
    await ok(t.sam, "POST", `/api/cards/${card}/comments`, { text: "@Agent add the map" });
    const needs = (await inboxOf(t.mo)).items.filter((i) => i.reason === "needs_you");
    expect(needs).toEqual([
      expect.objectContaining({
        kind: "start_request",
        cardId: card,
        request: expect.objectContaining({ requestedBy: "Sam Stakeholder" }),
        ai: [expect.objectContaining({ who: "agent", state: "needs you" })],
      }),
    ]);
    // Once Mo starts it, the request leaves Needs you.
    const id = needs[0]?.id as string;
    await ok(t.mo, "POST", `/api/cards/${card}/agent-requests/${id}/start`);
    expect((await inboxOf(t.mo)).items.some((i) => i.id === id)).toBe(false);
  });
});

describe("TEAM-22: a mention of someone who cannot see the project", () => {
  it("asks the author whether to invite them and notifies no one until they answer", async () => {
    const t = await team();
    const rae = await invited(t.ada, "member", "Rae Removed", "rae@northwind.test");
    const del = await call("DELETE", `/api/members/${rae.principal}`, t.ada);
    expect(del.status).toBeLessThan(400);
    const card = await t.issue("Login", t.mo);

    const posted = (await ok(t.lee, "POST", `/api/cards/${card}/comments`, {
      text: "@RaeRemoved @VicViewer this is yours",
    })) as { invite?: { commentId: string; people: string[]; project?: string } };
    expect(posted.invite).toMatchObject({ people: ["Rae Removed"], project: "Chronicle" });
    const recorded = (await log.getEventsByTypes(["issue/commented"])).at(-1);
    expect(recorded?.payload).toMatchObject({ people: [t.vic.principal], held: [rae.principal] });

    // Nobody hears of it yet: not Vic, whom it mentions, nor Mo, who watches.
    expect(await rowFor(t.vic, card)).toBeUndefined();
    expect((await rowFor(t.mo, card))?.change?.type).toBe("owner");
    // The author is asked, in their Needs you and on the comment.
    const asked = (await inboxOf(t.lee)).items.find((i) => i.kind === "mention_invite");
    expect(asked).toMatchObject({ mention: { people: ["Rae Removed"], project: "Chronicle" } });
    const comments = (await ok(t.lee, "GET", `/api/cards/${card}/comments`)) as {
      comments: { invite?: { people: string[] } }[];
    };
    expect(comments.comments[0]?.invite).toEqual({ people: ["Rae Removed"], project: "Chronicle" });
    // Nobody else is asked.
    const seen = (await ok(t.mo, "GET", `/api/cards/${card}/comments`)) as {
      comments: { invite?: unknown }[];
    };
    expect(seen.comments[0]?.invite).toBeUndefined();

    // Only the author answers.
    const commentId = posted.invite?.commentId as string;
    const refused = await call("POST", `/api/cards/${card}/comments/${commentId}/mention`, t.mo, {
      answer: "skip",
    });
    expect(refused.status).toBe(403);

    // Invite: now it reaches Vic and Mo, and the Admins are asked to invite Rae.
    await ok(t.lee, "POST", `/api/cards/${card}/comments/${commentId}/mention`, {
      answer: "invite",
    });
    expect((await rowFor(t.vic, card))?.reason).toBe("mentioned");
    expect((await rowFor(t.mo, card))?.change?.type).toBe("commented");
    expect((await inboxOf(t.lee)).items.some((i) => i.kind === "mention_invite")).toBe(false);
    const request = (await inboxOf(t.ada)).items.find((i) => i.kind === "invite_request");
    expect(request).toMatchObject({
      reason: "needs_you",
      mention: { people: ["Rae Removed"], project: "Chronicle" },
      link: "#/members",
    });
    // Answered once.
    const again = await call("POST", `/api/cards/${card}/comments/${commentId}/mention`, t.lee, {
      answer: "skip",
    });
    expect(again.status).toBe(409);
  });

  it("Don't invite: the others hear of it, the person held back never does", async () => {
    const t = await team();
    const rae = await invited(t.ada, "member", "Rae Removed", "rae@northwind.test");
    await call("DELETE", `/api/members/${rae.principal}`, t.ada);
    const card = await t.issue("Login", t.mo);
    const posted = (await ok(t.lee, "POST", `/api/cards/${card}/comments`, {
      text: "@RaeRemoved over to you",
    })) as { invite: { commentId: string } };
    await ok(t.lee, "POST", `/api/cards/${card}/comments/${posted.invite.commentId}/mention`, {
      answer: "skip",
    });
    expect((await rowFor(t.mo, card))?.change?.type).toBe("commented");
    expect((await inboxOf(t.ada)).items.some((i) => i.kind === "invite_request")).toBe(false);
  });
});

describe("TEAM-23: read, Done, Snooze and Save are recorded", () => {
  it("each mark is the person's own event; a later change brings a done row back", async () => {
    const t = await team();
    const card = await t.issue("Login", t.mo);
    await ok(t.sam, "POST", `/api/cards/${card}/comments`, { text: "first" });
    const id = `issue:${card}`;
    const path = (action: string) => `/api/inbox/items/${encodeURIComponent(id)}/${action}`;

    // Read.
    expect((await rowFor(t.mo, card))?.unread).toBe(true);
    const unreadBefore = (await inboxOf(t.mo)).unread;
    await ok(t.mo, "POST", path("read"));
    expect((await rowFor(t.mo, card))?.unread).toBe(false);
    expect((await inboxOf(t.mo)).unread).toBe(unreadBefore - 1);

    // Save: in Saved, still in the Inbox.
    await ok(t.mo, "POST", path("save"));
    expect((await rowFor(t.mo, card, "saved"))?.saved).toBe(true);

    // Done: out of the Inbox, in Done and still Saved.
    await ok(t.mo, "POST", path("done"));
    expect(await rowFor(t.mo, card)).toBeUndefined();
    expect((await rowFor(t.mo, card, "done"))?.done).toBe(true);
    expect((await rowFor(t.mo, card, "saved"))?.saved).toBe(true);

    // A new change brings it back, unread, counting only what came after Done.
    await ok(t.vic, "POST", `/api/cards/${card}/comments`, { text: "second" });
    expect(await rowFor(t.mo, card)).toMatchObject({ unread: true, count: 1, done: false });

    // Snooze: gone until the time; a time is required.
    const bad = await call("POST", path("snooze"), t.mo, {});
    expect(bad.status).toBe(400);
    await ok(t.mo, "POST", path("snooze"), {
      until: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(await rowFor(t.mo, card)).toBeUndefined();
    await ok(t.mo, "POST", path("snooze"), { until: new Date(Date.now() - 1000).toISOString() });
    expect(await rowFor(t.mo, card)).toBeDefined();

    // Each is Mo's own event; nobody else's Inbox changed.
    const marks = await log.getEventsByTypes([
      "inbox/read",
      "inbox/done",
      "inbox/snoozed",
      "inbox/saved",
    ]);
    expect(marks.map((e) => e.type)).toEqual([
      "inbox/read",
      "inbox/saved",
      "inbox/done",
      "inbox/snoozed",
      "inbox/snoozed",
    ]);
    expect(new Set(marks.map((e) => e.principal))).toEqual(new Set([t.mo.principal]));
    expect((await rowFor(t.ada, card))?.saved).toBe(false);
    // An item that is not in your Inbox cannot be marked.
    const none = await call(
      "POST",
      `/api/inbox/items/${encodeURIComponent("issue:card_nope")}/read`,
      t.mo,
    );
    expect(none.status).toBe(404);
  });

  it("every level marks its own Inbox and watches; the marks need no Member", async () => {
    const t = await team();
    const card = await t.issue("Login", t.mo);
    await ok(t.mo, "POST", `/api/cards/${card}/comments`, { text: "@VicViewer fyi" });
    await ok(t.vic, "POST", `/api/inbox/items/${encodeURIComponent(`issue:${card}`)}/done`);
    await ok(t.vic, "POST", `/api/issues/${card}/watch`, { watch: false });
    expect(await watching(t.vic, card)).toBe(false);
  });
});

describe("DB-N9-15: My issues", () => {
  it("lists what the person owns, is delegated or is asked to review, grouped by project", async () => {
    const t = await team();
    const owned = await t.issue("Login", t.mo);
    const delegated = await t.issue("Export");
    await asPerson(t.ada, () =>
      store.delegateCard(delegated, { kind: "person", id: t.mo.principal }, t.ada.principal),
    );
    const review = await t.issue("Search", t.vic);
    await store.updateCardStatus(review, "review", "checks passed", "executor", { override: true });
    await t.issue("Unrelated", t.sam);

    const mine = (await ok(t.mo, "GET", "/api/my-issues")) as {
      issues: { id: string; why: string[]; project?: { name: string } }[];
    };
    expect(mine.issues.map((i) => [i.id, i.why])).toEqual(
      expect.arrayContaining([
        [owned, ["owner"]],
        [delegated, ["delegated"]],
      ]),
    );
    expect(mine.issues).toHaveLength(2);
    expect(mine.issues[0]?.project?.name).toBe("Chronicle");
    // The lead reviews what reaches Review with no Accept rule set (DEC-42).
    const lee = (await ok(t.lee, "GET", "/api/my-issues")) as {
      issues: { id: string; why: string[] }[];
    };
    expect(lee.issues).toEqual([expect.objectContaining({ id: review, why: ["review"] })]);
  });
});

describe("TEAM-43: pushed within each watcher's own notification budget", () => {
  it("3 a day each, a posted update counts, the 4th is held, and the digest holds only unread items", async () => {
    const t = await team();
    const card = await t.issue("Login", t.mo);
    const people = () =>
      allMembers(db).flatMap((m) => {
        const name = personName(db, m.principal);
        return name ? [{ principal: m.principal, name }] : [];
      });
    // The server's own notifier stops with it; this test's is the only one.
    await server?.close();
    server = undefined;
    const access = new Access({ db, setup: "team", localPrincipal: () => log.localPrincipal() });
    const deps: InboxDeps = {
      cardStore: store,
      log,
      access,
      audience: audienceFromAccess(() => access, db),
      projectOf: (c) => c.projectId ?? undefined,
      people,
    };
    writePush(root, { kind: "ntfy", url: "https://push.example.test", topic: "t" });
    const bodies: { title: string; body: string }[] = [];
    const fetch = (async (_u: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      bodies.push({ title: headers.get("Title") ?? "", body: String(init?.body) });
      return new Response("ok");
    }) as typeof globalThis.fetch;
    const now = new Date();
    now.setHours(10, 0, 0, 0);
    const notifier = await startNotifier(log, root, {
      intervalMs: 60_000,
      fetch,
      now: () => now,
      recipient: t.ada.principal,
      setup: "team",
      inbox: inboxNotifier(deps),
    });
    // Sam comments three times, mentioning Vic in the first: Mo (owner) and
    // Ada (creator) watch; Vic is mentioned once, then watches.
    for (const text of ["@VicViewer one", "two", "three"]) {
      await asPerson(t.sam, () =>
        store.recordEvent({
          type: "issue/commented",
          cardId: card,
          actor: "human",
          principal: t.sam.principal,
          payload: {
            id: `cmt_${text.replace(/\W/g, "")}`,
            cardId: card,
            ...(text.startsWith("@") ? { people: [t.vic.principal] } : {}),
          },
          private: { text },
        }),
      );
    }
    await notifier.tick();
    // The channel is the install's, shared: one message per change, naming
    // everyone it is for, never a copy each (B4.11 review T3).
    const lineFor = (name: string, body: string) =>
      body
        .split("\n")
        .map((l) => /^For (.+?): (.*)$/.exec(l))
        .find((m) => m?.[1]?.split(/, | and /).includes(name))?.[2];
    const said = (name: string) =>
      bodies.flatMap((b) => {
        const line = b.title === "Login" ? lineFor(name, b.body) : undefined;
        return line ? [line] : [];
      });
    expect(bodies.filter((b) => b.title === "Login")).toHaveLength(3);
    const toMo = () => said("Mo Member");
    expect(toMo()).toEqual([
      "Sam Stakeholder commented.",
      "Sam Stakeholder commented.",
      "Sam Stakeholder commented.",
    ]);
    expect(said("Vic Viewer")).toEqual([
      "Sam Stakeholder mentioned you.",
      "Sam Stakeholder commented.",
      "Sam Stakeholder commented.",
    ]);

    // Ada posts a project update: Mo is past his 3, so it is held for him.
    await asPerson(t.ada, () =>
      log.append({
        actor: "human",
        type: "project/update_posted",
        principal: t.ada.principal,
        payload: { project: t.project },
        private: { text: "All on track." },
      }),
    );
    await notifier.tick();
    expect(toMo()).toHaveLength(3);
    const held = await log.getEventsByTypes(["pm/notice_held"]);
    expect(held.filter((e) => (e.payload as { to?: string }).to === t.mo.principal)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ kind: "project_update" }) }),
    ]);
    // The update reached the project's lead within his own budget: Lee had room.
    const updates = bodies.filter((b) => b.title === "Chronicle");
    expect(updates).toHaveLength(1);
    expect(lineFor("Lee Lead", updates[0]?.body ?? "")).toBe("Ada Admin posted a project update.");
    expect(lineFor("Mo Member", updates[0]?.body ?? "")).toBeUndefined();

    // A fourth comment: held for Mo; its row stays unread, so the day's digest carries it.
    await asPerson(t.sam, () =>
      store.recordEvent({
        type: "issue/commented",
        cardId: card,
        actor: "human",
        principal: t.sam.principal,
        payload: { id: "cmt_four", cardId: card },
        private: { text: "four" },
      }),
    );
    // Vic reads Login before the day's digest; Mo does not.
    await markInboxItem(deps, {
      principal: t.vic.principal,
      item: `issue:${card}`,
      action: "read",
    });
    await notifier.tick();
    const digests = bodies.filter(
      (b) => b.title.startsWith("For Mo Member") && /unread/.test(b.title),
    );
    expect(digests).toHaveLength(1);
    expect(digests[0]?.title).toBe("For Mo Member: 1 unread in your Inbox");
    expect(digests[0]?.body).toMatch(/^Login: Sam Stakeholder commented\./);
    // Vic is past the budget too, but gets no digest: nothing is unread.
    expect(bodies.some((b) => b.title.startsWith("For Vic Viewer") && /unread/.test(b.title))).toBe(
      false,
    );

    // A fifth comment after the day's digest went out: held for Mo, and
    // carried by the next standup's digest rather than dropped (INT-20a).
    await asPerson(t.sam, () =>
      store.recordEvent({
        type: "issue/commented",
        cardId: card,
        actor: "human",
        principal: t.sam.principal,
        payload: { id: "cmt_five", cardId: card },
        private: { text: "five" },
      }),
    );
    await notifier.tick();
    expect(
      bodies.filter((b) => b.title.startsWith("For Mo Member") && /unread/.test(b.title)),
    ).toHaveLength(1);
    now.setDate(now.getDate() + 1);
    await notifier.tick();
    expect(
      bodies.filter((b) => b.title.startsWith("For Mo Member") && /unread/.test(b.title)),
    ).toHaveLength(2);
    notifier.stop();
  });
});

describe("DB-N9-14 in Solo: the Inbox is both setups'", () => {
  it("the one person's Inbox has the Agent's finished work and nothing they did themselves", async () => {
    db.close();
    db = new DatabaseSync(join(root, ".sekhemet", "solo.db"));
    initSchema(db);
    log = new EventLog(db);
    store = new CardStore(db, log);
    vi.spyOn(console, "log").mockImplementation(() => {});
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: root,
      port: 0,
      streamIntervalMs: 10_000,
      pressureLevel: () => 1,
    });
    vi.mocked(console.log).mockRestore();
    base = `http://127.0.0.1:${server.port}`;
    const me: Person = { principal: log.localPrincipal(), headers: {} };
    const card = await store.createCard(
      { tier: "task", title: "Search", status: "ready" },
      "human",
    );
    await ok(me, "POST", `/api/cards/${card.id}/comments`, { text: "a note to self" });
    // The person's own comment reaches no one.
    expect(await rowFor(me, card.id)).toBeUndefined();
    await store.updateCardStatus(card.id, "in_progress", "claimed", "executor", { override: true });
    await store.updateCardStatus(card.id, "verify", "attempt ended", "executor");
    await store.updateCardStatus(card.id, "review", "checks passed", "executor");
    expect(await rowFor(me, card.id)).toMatchObject({
      reason: "agent_finished",
      unread: true,
      change: { type: "status", byAi: "agent", status: "review" },
    });
    // Solo has no My issues page; the route answers the same way: the one person reviews.
    expect(((await ok(me, "GET", "/api/my-issues")) as { issues: unknown[] }).issues).toEqual([
      expect.objectContaining({ id: card.id, why: ["review"] }),
    ]);
  });
});
