import { describe, expect, it } from "vitest";
import { UI_LIB_MODULES } from "../src/index.js";
import {
  NOTIFY_COPY,
  NOTIFY_WINDOW_MS,
  WaitBatch,
  inboxArrivals,
  notifyOfferVisible,
  notifyState,
  readNotifyPref,
  reviewArrivals,
  waitingCount,
  waitingLine,
} from "../src/notify.js";

// Dashboard NEW-dashboard-22 (§2.16.4; DEC-53 c4; FINDINGS PRC-11): the
// words, the per-browser setting, the one-time offer and the 60-second
// batching of the notification raised when work waits in Review.

const mem = (value?: string) => ({
  getItem: (k: string) => (k === "sekhemet-notify" ? (value ?? null) : null),
});

describe("the setting, kept per browser (DB-N22-1, -4)", () => {
  it("reads on, off and not-now, and nothing else", () => {
    expect(readNotifyPref(mem("on"))).toBe("on");
    expect(readNotifyPref(mem("off"))).toBe("off");
    expect(readNotifyPref(mem("not-now"))).toBe("not-now");
    expect(readNotifyPref(mem("yes"))).toBeUndefined();
    expect(readNotifyPref(mem())).toBeUndefined();
    expect(
      readNotifyPref({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBeUndefined();
  });

  it("is on only with the browser's permission granted", () => {
    expect(notifyState({ pref: "on", permission: "granted", supported: true })).toBe("on");
    expect(notifyState({ pref: "on", permission: "default", supported: true })).toBe("off");
    expect(notifyState({ pref: "off", permission: "granted", supported: true })).toBe("off");
  });

  it("says when the browser blocks notifications, and how to allow them", () => {
    expect(notifyState({ pref: "on", permission: "denied", supported: true })).toBe("blocked");
    expect(NOTIFY_COPY.blocked).toMatch(/blocks notifications/);
    expect(NOTIFY_COPY.blocked).toMatch(/site settings/);
    expect(notifyState({ pref: undefined, permission: "default", supported: false })).toBe(
      "unsupported",
    );
  });
});

describe("the one-time offer above the Review queue (DB-N22-1)", () => {
  const base = { supported: true, permission: "default" as const, queueSize: 2 };

  it("shows once the queue is non-empty and nothing was chosen in this browser", () => {
    expect(notifyOfferVisible({ ...base, pref: undefined })).toBe(true);
    expect(notifyOfferVisible({ ...base, pref: undefined, queueSize: 0 })).toBe(false);
  });

  it("is never shown again after Not now, or once a choice was made", () => {
    expect(notifyOfferVisible({ ...base, pref: "not-now" })).toBe(false);
    expect(notifyOfferVisible({ ...base, pref: "on" })).toBe(false);
    expect(notifyOfferVisible({ ...base, pref: "off" })).toBe(false);
  });

  it("is not offered where the browser cannot notify or blocks it", () => {
    expect(notifyOfferVisible({ ...base, pref: undefined, supported: false })).toBe(false);
    expect(notifyOfferVisible({ ...base, pref: undefined, permission: "denied" })).toBe(false);
  });

  it("words the offer and the setting as the spec does", () => {
    expect(NOTIFY_COPY.offer).toBe("Get a browser notification when work waits for you.");
    expect(NOTIFY_COPY.setting).toBe("Notify me in this browser when work waits for me");
    expect(NOTIFY_COPY.turnOn).toBe("Turn on");
    expect(NOTIFY_COPY.notNow).toBe("Not now");
  });
});

describe("what a notification says (DB-N22-2, -3)", () => {
  it("names the issue's key, title and where it waits, and nothing else", () => {
    expect(waitingLine({ key: "CHR-12", title: "Implement canonical JSON" })).toBe(
      "CHR-12 Implement canonical JSON · waiting in In review",
    );
    expect(waitingCount(3)).toBe("3 issues wait in In review");
  });

  it("raises the first at once and counts the rest within 60 seconds in the same notification", () => {
    const batch = new WaitBatch();
    const t0 = 1_000_000;
    const a = batch.add({ cardId: "c1", key: "CHR-12", title: "Implement canonical JSON" }, t0);
    expect(a).toEqual({
      title: "CHR-12 Implement canonical JSON · waiting in In review",
      cardId: "c1",
      count: 1,
    });
    const b = batch.add({ cardId: "c2", key: "CHR-13", title: "Hash the chain" }, t0 + 20_000);
    expect(b).toEqual({ title: "2 issues wait in In review", count: 2 });
    const c = batch.add({ cardId: "c3", key: "CHR-14", title: "Verify" }, t0 + 59_000);
    expect(c.title).toBe("3 issues wait in In review");
    // The same issue twice in a window is one.
    expect(batch.add({ cardId: "c3", key: "CHR-14", title: "Verify" }, t0 + 59_500).count).toBe(3);
    // After the window a new one starts.
    const d = batch.add(
      { cardId: "c4", key: "CHR-15", title: "Export" },
      t0 + NOTIFY_WINDOW_MS + 1,
    );
    expect(d).toMatchObject({ count: 1, cardId: "c4" });
  });
});

describe("what counts as work arriving (DB-N22-2)", () => {
  it("in Solo, an issue entering In review from another column", () => {
    expect(
      reviewArrivals([
        {
          type: "card/status_changed",
          cardId: "a",
          payload: { fromStatus: "in_progress", toStatus: "review" },
        },
        {
          type: "card/status_changed",
          cardId: "b",
          payload: { fromStatus: "review", toStatus: "done" },
        },
        { type: "card/updated", cardId: "c", payload: {} },
        {
          type: "card/status_changed",
          cardId: "d",
          payload: { fromStatus: "review", toStatus: "review" },
        },
      ]),
    ).toEqual(["a"]);
  });

  it("in the Team setup, an Inbox item newly under Needs you or Review requested", () => {
    const seen = new Map<string, number>([["i1", 10]]);
    const item = (id: string, reason: string, seq: number, extra = {}) => ({
      id,
      reason,
      seq,
      unread: true,
      done: false,
      title: `Issue ${id}`,
      kind: "issue",
      cardId: `card_${id}`,
      ...extra,
    });
    const arrived = inboxArrivals(seen, [
      item("i1", "review_requested", 10),
      item("i2", "review_requested", 12),
      item("i3", "needs_you", 13),
      item("i4", "watching", 14),
      item("i5", "needs_you", 15, { done: true }),
      item("i6", "needs_you", 16, { unread: false }),
    ]);
    expect(arrived.map((i) => i.id)).toEqual(["i2", "i3"]);
    // Seen now: the same items do not arrive twice.
    expect(inboxArrivals(seen, [item("i2", "review_requested", 12)])).toEqual([]);
    expect(inboxArrivals(seen, [item("i1", "review_requested", 18)]).map((i) => i.id)).toEqual([
      "i1",
    ]);
  });

  it("in the Team setup, only an issue: never a triage count, a rule notice, a plan or a question (DB-N22-2)", () => {
    const seen = new Map<string, number>();
    inboxArrivals(seen, []);
    const row = (id: string, kind: string, extra = {}) => ({
      id,
      kind,
      reason: "needs_you",
      seq: 20,
      unread: true,
      done: false,
      title: id,
      ...extra,
    });
    const arrived = inboxArrivals(seen, [
      row("triage:proj_x", "triage"),
      row("accept-rule:proj_x", "accept_rule"),
      row("plan:pmp_1", "plan_approval"),
      row("dec_1", "decision"),
      row("invite:x", "invite_request"),
      row("issue:card_1", "issue", { cardId: "card_1" }),
    ]);
    expect(arrived.map((i) => i.id)).toEqual(["issue:card_1"]);
  });

  it("is a module the browser imports", () => {
    expect(UI_LIB_MODULES).toContain("notify.js");
  });
});
