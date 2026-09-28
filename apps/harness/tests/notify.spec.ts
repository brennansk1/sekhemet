import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { beforeEach, describe, expect, it } from "vitest";
import { egressEvent } from "../src/egress_event.js";
import {
  noticeFor,
  pushRequest,
  readPush,
  sendPush,
  startNotifier,
  validatePush,
  writePush,
} from "../src/notify.js";

describe("push notifications (H20)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "notify-"));
    process.env.SEKHEMET_CONFIG_DIR = mkdtempSync(join(tmpdir(), "notify-cfg-"));
  });

  it("validates settings and keeps them out of the repository", () => {
    expect(validatePush({ kind: "ntfy", url: "https://ntfy.sh" })).toMatch(/topic/);
    expect(validatePush({ kind: "gotify", url: "http://10.0.0.5:8080" })).toMatch(/token/);
    expect(validatePush({ kind: "ntfy", url: "ftp://x", topic: "a" })).toMatch(/http/);
    writePush(repo, { kind: "ntfy", url: "https://ntfy.sh", topic: "sekhemet-test" });
    expect(readPush(repo)?.topic).toBe("sekhemet-test");
    expect(
      process.env.SEKHEMET_CONFIG_DIR && !repo.startsWith(process.env.SEKHEMET_CONFIG_DIR),
    ).toBe(true);
    writePush(repo, undefined);
    expect(readPush(repo)).toBeUndefined();
  });

  it("builds ntfy and Gotify requests the way each server expects", () => {
    const n = {
      event: "review" as const,
      title: "Ready for review",
      message: "card_a passed",
      click: "http://127.0.0.1:4800/#/card/card_a",
    };
    const ntfy = pushRequest(
      { kind: "ntfy", url: "https://ntfy.sh/", topic: "t1", token: "tk" },
      n,
    );
    expect(ntfy.url).toBe("https://ntfy.sh/t1");
    expect(ntfy.init.headers).toMatchObject({
      Title: "Ready for review",
      Priority: "3",
      Tags: "review",
      Click: n.click,
      Authorization: "Bearer tk",
    });
    expect(ntfy.init.body).toBe("card_a passed");
    const gotify = pushRequest(
      { kind: "gotify", url: "http://10.0.0.5:8080", token: "g" },
      { ...n, priority: 5 },
    );
    expect(gotify.url).toBe("http://10.0.0.5:8080/message");
    expect(gotify.init.headers).toMatchObject({ "X-Gotify-Key": "g" });
    expect(JSON.parse(String(gotify.init.body))).toMatchObject({
      title: "Ready for review",
      priority: 10,
    });
  });

  it("maps ledger events to notices: review, parked, budget, question", () => {
    const ev = (type: string, payload: Record<string, unknown>) =>
      ({ seq: 1, type, cardId: "card_a", payload, actor: "x" }) as never;
    expect(noticeFor(ev("card/status_changed", { toStatus: "review" }))?.event).toBe("review");
    expect(noticeFor(ev("card/parked", { reason: "repair ladder exhausted" }))?.event).toBe(
      "parked",
    );
    expect(
      noticeFor(ev("card/status_changed", { toStatus: "parked", reason: "token budget exhausted" }))
        ?.event,
    ).toBe("budget");
    expect(noticeFor(ev("card/question", { text: "Which table?" }))?.message).toMatch(
      /Which table\?/,
    );
    expect(noticeFor(ev("card/status_changed", { toStatus: "working" }))).toBeUndefined();
    expect(noticeFor(ev("card/status_changed", { toStatus: "review" }), "http://h:1")?.click).toBe(
      "http://h:1/#/card/card_a",
    );
  });

  it("respects the chosen events and records each push on the ledger", async () => {
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    const sent: string[] = [];
    const fetch = (async (url: string) => {
      sent.push(url);
      return new Response("ok");
    }) as typeof globalThis.fetch;
    expect(
      (await sendPush(repo, { event: "review", title: "t", message: "m" }, { fetch })).skipped,
    ).toBe(true);
    writePush(repo, { kind: "ntfy", url: "https://ntfy.sh", topic: "t", events: ["parked"] });
    expect(
      (await sendPush(repo, { event: "review", title: "t", message: "m" }, { fetch })).skipped,
    ).toBe(true);
    expect(
      (
        await sendPush(
          repo,
          { event: "parked", title: "t", message: "m", cardId: "c" },
          { fetch, log },
        )
      ).ok,
    ).toBe(true);
    expect(sent).toEqual(["https://ntfy.sh/t"]);
    const last = await log.getLastEvent();
    expect(last?.type).toBe("pm/notify");
    expect(last?.payload).toMatchObject({ channel: "ntfy", kind: "parked", ok: true });
  });

  it("security item 33: a push goes through the one network policy and is recorded; offline refuses it before any connection", async () => {
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    // No fetch injected: the product's own path. The test config is offline.
    writePush(repo, { kind: "ntfy", url: "https://ntfy.example.test", topic: "secret-topic-42" });
    const r = await sendPush(repo, { event: "review", title: "t", message: "m" }, { log });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/network policy refused ntfy\.example\.test/);
    const egress = await log.getEventsByTypes(["harness/egress"]);
    expect(egress.map((e) => e.payload)).toMatchObject([
      { host: "ntfy.example.test", purpose: "integration:push", allowed: false },
    ]);
    // B1: the topic is the push credential: the ledger keeps the origin only.
    expect((egress[0]?.private as { url?: string }).url).toBe("https://ntfy.example.test/…");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];
    for (const { name } of tables) {
      expect(JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()), name).not.toContain(
        "secret-topic-42",
      );
    }
    const notify = await log.getEventsByTypes(["pm/notify"]);
    expect(notify.at(-1)?.payload).toMatchObject({ channel: "ntfy", ok: false });
  });

  it("tails the ledger: pushes new review and park events once, never history", async () => {
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    const cards = new CardStore(db, log);
    await cards.createCard({ id: "card_old", tier: "task", title: "Old" });
    await cards.updateCardStatus("card_old", "verify", "test setup", "harness", { override: true });
    await cards.updateCardStatus("card_old", "review", "old news");
    writePush(repo, { kind: "ntfy", url: "https://ntfy.sh", topic: "t" });
    const bodies: string[] = [];
    const fetch = (async (_u: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response("ok");
    }) as typeof globalThis.fetch;
    const n = await startNotifier(log, repo, { intervalMs: 60_000, fetch });
    await cards.createCard({ id: "card_new", tier: "task", title: "New" });
    await cards.updateCardStatus("card_new", "verify", "test setup", "harness", { override: true });
    await cards.updateCardStatus("card_new", "review", "gates passed");
    expect(await n.tick()).toBe(1);
    expect(bodies).toEqual(["card_new passed its checks and waits for you."]);
    // The same card reaching review again within ten minutes is not re-pushed.
    await cards.updateCardStatus("card_new", "in_progress", "sent back");
    await cards.updateCardStatus("card_new", "verify", "attempt ended");
    await cards.updateCardStatus("card_new", "review", "again");
    expect(await n.tick()).toBe(0);
    n.stop();
  });
});

describe("B1: a credential-bearing URL is recorded redacted", () => {
  const at = "2026-09-25T10:00:00.000Z";
  const rec = (url: string) => ({
    url,
    host: new URL(url).hostname,
    purpose: "integration:test",
    allowed: true,
    payloadHash: "",
    at,
  });

  it("a URL with a token in its query or its userinfo keeps only its origin; any URL when asked", () => {
    for (const url of [
      "https://api.example.test/x?access_token=abc123secret",
      "https://api.example.test/x?sig=abc123secret&v=1",
      "https://bob:abc123secret@git.example.test/o/r.git",
    ]) {
      const e = egressEvent(rec(url));
      expect(e.private.url).toBe(`${new URL(url).protocol}//${new URL(url).host}/…`);
      expect(JSON.stringify(e)).not.toContain("abc123secret");
    }
    const hook = "https://hooks.slack.com/services/T0/B0/abc123secret";
    const redacted = egressEvent(rec(hook), { redactUrl: true });
    expect(redacted.private.url).toBe("https://hooks.slack.com/…");
    expect(JSON.stringify(redacted)).not.toContain("abc123secret");
    // A plain URL is kept, privately, as before.
    const plain = "https://api.github.com/repos/o/r/issues?page=2";
    expect(egressEvent(rec(plain)).private.url).toBe(plain);
  });
});
