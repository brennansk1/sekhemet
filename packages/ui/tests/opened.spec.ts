import { describe, expect, it } from "vitest";
// The browser modules are imported as-is: the same code the page runs.
import { diffOnScreen, shownFiles } from "../web/diff_parse.js";
import { reportOpened } from "../web/opened.js";

/**
 * review-git RG-N5-5 and RG-S6-6 on the dashboard: Accept is refused until the
 * files the person was shown are recorded, so the page records what it showed
 * (`POST /api/cards/<id>/opened`) — the expanded diffs, never a collapsed one.
 */
const DIFF = [
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -0,0 +1 @@",
  "+export const b = 2;",
  "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
  "--- a/pnpm-lock.yaml",
  "+++ b/pnpm-lock.yaml",
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "",
].join("\n");
const card = { id: "c1", scopeFiles: ["src/**"], acceptanceTests: [] };
const evidence = { id: "ev_c1", diff: DIFF, failures: [] };

describe("RG-N5-5: the dashboard records the files it showed", () => {
  it("counts an expanded diff as shown, and a collapsed or structural one as not", () => {
    expect(shownFiles(evidence, { card })).toEqual(["src/b.ts"]);
    expect(shownFiles(evidence, { card, open: new Map([["src/b.ts", false]]) })).toEqual([]);
    expect(
      shownFiles(evidence, { card, open: new Map([["pnpm-lock.yaml", true]]) }).sort(),
    ).toEqual(["pnpm-lock.yaml", "src/b.ts"]);
    expect(shownFiles(evidence, { card, mode: "structural" })).toEqual([]);
  });

  it("DB-N5-3: on the page, an expanded diff counts only once it has been on screen", () => {
    // Nothing scrolled into view yet: nothing is shown, however many are expanded.
    expect(shownFiles(evidence, { card, seen: new Set() })).toEqual([]);
    expect(shownFiles(evidence, { card, seen: new Set(["src/b.ts"]) })).toEqual(["src/b.ts"]);
    // A collapsed file on screen shows only its header, so it is still not shown.
    expect(shownFiles(evidence, { card, seen: new Set(["pnpm-lock.yaml", "src/b.ts"]) })).toEqual([
      "src/b.ts",
    ]);
  });

  it("DB-N5-3: a diff is on screen when half of it, or a screenful of it, is in view", () => {
    const view = { height: 800 };
    expect(diffOnScreen({ isIntersecting: false, ratio: 0, height: 0 }, view)).toBe(false);
    // The header peeking at the bottom edge is not a look.
    expect(diffOnScreen({ isIntersecting: true, ratio: 0.05, height: 30 }, view)).toBe(false);
    expect(diffOnScreen({ isIntersecting: true, ratio: 0.5, height: 60 }, view)).toBe(true);
    // A long diff never gets to half, but filling most of the screen is a look.
    expect(diffOnScreen({ isIntersecting: true, ratio: 0.1, height: 400 }, view)).toBe(true);
    expect(diffOnScreen({ isIntersecting: true, ratio: 0.1, height: 150 }, view)).toBe(false);
  });

  it("posts the shown files once per evidence, and again only when more are shown", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const post = async (path: string, body: unknown) => {
      calls.push({ path, body });
      return { ok: true, status: 200, data: { ok: true } };
    };
    expect(await reportOpened("c 1", "ev_1", ["src/b.ts"], post)).toBe(true);
    expect(await reportOpened("c 1", "ev_1", ["src/b.ts"], post)).toBe(false);
    expect(await reportOpened("c 1", "ev_1", ["src/b.ts", "src/c.ts"], post)).toBe(true);
    expect(await reportOpened("c 1", "ev_1", [], post)).toBe(false);
    expect(calls).toEqual([
      { path: "/api/cards/c%201/opened", body: { filesShown: ["src/b.ts"] } },
      { path: "/api/cards/c%201/opened", body: { filesShown: ["src/b.ts", "src/c.ts"] } },
    ]);
  });

  it("retries a file whose report failed", async () => {
    let ok = false;
    const post = async () => ({ ok, status: ok ? 200 : 0, data: null });
    expect(await reportOpened("c2", "ev_2", ["src/x.ts"], post)).toBe(false);
    ok = true;
    expect(await reportOpened("c2", "ev_2", ["src/x.ts"], post)).toBe(true);
  });
});
