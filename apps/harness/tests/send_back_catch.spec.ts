import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MIN_REASONS,
  R8_THRESHOLD,
  findingCatches,
  reasonAnchors,
  sendBackCatches,
  sendBackReport,
} from "../src/learning/send_back_catch.js";

// RG-P8-14 (RESEARCH_REGISTER R8): the share of send-back reasons the AI
// review had already found before a person opened the issue, read from a
// real ledger.

let repo: string;
let db: DatabaseSync;
let store: CardStore;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "sekhemet-send-back-catch-"));
  db = new DatabaseSync(join(repo, "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  store = new CardStore(db, log);
});
afterEach(() => {
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

async function card(id: string): Promise<void> {
  await store.createCard({ id, tier: "story", title: `Cart ${id}`, status: "ready" });
}
const finding = (cardId: string, text: string, verdict = "unmet") =>
  store.recordDossierEntry({ cardId, kind: "review", actor: "reviewer", verdict, text });
const sentBack = (cardId: string, text: string) =>
  store.recordDossierEntry({ cardId, kind: "send_back", actor: "human", text });
const opened = (cardId: string) =>
  store.recordEvent({
    type: "review/opened",
    cardId,
    actor: "human",
    payload: { id: cardId, principal: store.localPrincipal(), filesShown: [] },
  });

describe("what a send-back reason names", () => {
  it("reads files with their lines and symbols, and nothing from a vague note", () => {
    expect(reasonAnchors("rounding is wrong in src/cart.ts:42, see `sumCart`")).toEqual({
      files: [{ path: "src/cart.ts", line: 42 }],
      symbols: ["sumCart"],
    });
    expect(reasonAnchors("not quite what I wanted")).toEqual({ files: [], symbols: [] });
  });

  it("matches a finding cited near the named line, or naming the symbol", () => {
    const a = reasonAnchors("src/cart.ts:42 rounds down");
    expect(findingCatches("1. totals round half up — rounds down (src/cart.ts:41)", a)).toBe(true);
    expect(findingCatches("1. totals — wrong (src/cart.ts:60)", a)).toBe(false);
    expect(
      findingCatches(
        "2. cap — applyDiscount skips it (src/y.ts:9)",
        reasonAnchors("`applyDiscount` ignores the cap"),
      ),
    ).toBe(true);
  });
});

describe("the share over a real ledger (RG-P8-14)", () => {
  it("counts each reason once, only findings recorded before the person opened the issue", async () => {
    // A: the AI review cited the line the person later sent back.
    await card("A");
    await finding("A", "1. totals round half up — rounds down (src/cart.ts:41)");
    await opened("A");
    await sentBack("A", "rounding is wrong in src/cart.ts:42");
    // B: the finding names the symbol the note names.
    await card("B");
    await finding("B", "2. the discount is capped — applyDiscount skips the cap (src/y.ts:9)");
    await sentBack("B", "`applyDiscount` ignores the cap");
    // C: a vague note names nothing to match.
    await card("C");
    await finding("C", "1. totals — wrong (src/cart.ts:41)");
    await sentBack("C", "not quite what I wanted");
    // D: the second attempt's finding came after the person opened it.
    await card("D");
    await sentBack("D", "redo it");
    await opened("D");
    await finding("D", "1. export — wrong header (src/export.ts:3)");
    await sentBack("D", "src/export.ts:3 has the wrong header");
    // E: the note and a line comment are two reasons; only the note is caught.
    await card("E");
    await finding("E", "1. totals — sumCart drops the tax (src/cart.ts:41)");
    await finding("E", "coverage", "coverage");
    await sentBack("E", "`sumCart` drops the tax");
    await sentBack("E", "src/cart.ts:90 — off by one");

    const r = await sendBackCatches(store);
    const caught = r.reasons.filter((x) => x.caught).map((x) => `${x.cardId}: ${x.text}`);
    expect(caught).toEqual([
      "A: rounding is wrong in src/cart.ts:42",
      "B: `applyDiscount` ignores the cap",
      "E: `sumCart` drops the tax",
    ]);
    expect([r.total, r.caught, r.unanchored]).toEqual([7, 3, 2]);
    expect(r.verdict).toBe("meets");
    expect(r.line).toMatch(/3 of 7 send-back reasons.*Meets R8's threshold of one in five/);
  });

  it("credits only a finding the model wrote and cited, matched on its note and location", async () => {
    await store.createCard({
      id: "F",
      tier: "story",
      title: "Config",
      status: "ready",
      acceptanceCriteria: ["`parseConfig` returns defaults for an empty file"],
    });
    // The harness's own entry for a criterion the model skipped: no citation.
    await finding(
      "F",
      "`parseConfig` returns defaults for an empty file — AI review cited no changed line that decides this criterion.",
      "unclear",
    );
    // The harness's fail-only test check, at the criterion's location.
    await finding(
      "F",
      "no test: `parseConfig` returns defaults for an empty file — No staged test case names this criterion, so no check exercises it. (src/cfg.ts:3)",
    );
    // A cited model finding whose criterion names the symbol, and its note does not.
    await finding(
      "F",
      "`parseConfig` returns defaults for an empty file — the empty branch returns null (src/z.ts:9)",
    );
    await sentBack("F", "`parseConfig` crashes on an empty file");
    await sentBack("F", "src/cfg.ts:3 reads the wrong key");
    // G: a preference finding the model cited catches the reason, and is counted apart.
    await card("G");
    await finding("G", "preference: Never use any — c is typed any (src/b.ts:2)");
    await sentBack("G", "src/b.ts:2 uses any");
    const r = await sendBackCatches(store);
    expect(r.reasons.map((x) => [x.cardId, x.caught])).toEqual([
      ["F", false],
      ["F", false],
      ["G", true],
    ]);
    expect(r.caughtByPreference).toBe(1);
    expect(r.line).toMatch(/1 by a preference finding/);
  });

  it("gives no verdict below the minimum, and is below the threshold under one in five", () => {
    const reason = (caught: boolean) => ({
      cardId: "x",
      entryId: "e",
      text: "t",
      anchored: true,
      caught,
      by: [],
    });
    expect(sendBackReport([reason(true)]).verdict).toBe("too_few");
    expect(MIN_REASONS).toBe(5);
    expect(R8_THRESHOLD).toBe(0.2);
    const r = sendBackReport([
      reason(false),
      reason(false),
      reason(false),
      reason(false),
      reason(false),
      reason(true),
    ]);
    expect(r.share).toBeCloseTo(1 / 6);
    expect(r.verdict).toBe("below");
    expect(sendBackReport([]).line).toMatch(/No send-backs yet/);
  });
});
