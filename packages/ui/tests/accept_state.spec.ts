import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acceptVerdict } from "../src/review_desk.js";

/**
 * DB-N2-2: WHEN the ledger fails verification, Accept is disabled on Review,
 * the issue page and the peek drawer, with the reason beside it. The three
 * surfaces render Accept only through `triageBarHtml`, whose state is
 * `acceptVerdict` — asserted here on the model and on the page modules.
 */

const passing = { passed: true };
const review = { status: "review" };
const intact = { triage: true, offline: false, ledger: { valid: true } };

describe("acceptVerdict", () => {
  it("allows Accept on a passing issue in Review over an intact ledger", () => {
    expect(acceptVerdict(intact, review, passing)).toEqual({ ok: true, reason: "" });
  });

  it("disables Accept when the ledger fails verification, naming the entry", () => {
    expect(
      acceptVerdict({ ...intact, ledger: { valid: false, corruptedSeq: 12 } }, review, passing),
    ).toEqual({
      ok: false,
      reason: "Activity log altered at entry #12. Inspect before accepting.",
    });
    // Even when nothing else would stop it, and before any other reason.
    expect(
      acceptVerdict({ ...intact, ledger: { valid: false } }, { status: "verify" }, undefined)
        .reason,
    ).toBe("Activity log altered at entry #?. Inspect before accepting.");
  });

  it("says the other reasons in order, and passes the review desk's reason through", () => {
    expect(acceptVerdict({ ...intact, triage: false }, review, passing).reason).toBe("Read-only.");
    expect(acceptVerdict({ ...intact, offline: true }, review, passing).reason).toBe("Offline.");
    expect(acceptVerdict(intact, review, undefined).reason).toBe(
      "Accept needs evidence from a run.",
    );
    expect(acceptVerdict(intact, review, { passed: false }).reason).toBe(
      "Accept needs every check passing.",
    );
    expect(acceptVerdict(intact, { status: "done" }, passing).reason).toBe(
      "Only issues in Review can be accepted.",
    );
    expect(acceptVerdict(intact, review, passing, "Open 2 more files first.")).toEqual({
      ok: false,
      reason: "Open 2 more files first.",
    });
    // No verification yet (the page's first frame) is not a failure.
    expect(acceptVerdict({ ...intact, ledger: null }, review, passing).ok).toBe(true);
  });
});

describe("every Accept goes through it (Review, the issue page, the peek)", () => {
  const web = (f: string) => readFileSync(join(import.meta.dirname, "..", "web", f), "utf8");

  it("triage.js takes Accept's state from acceptVerdict, with the ledger's verification", () => {
    const triage = web("triage.js");
    expect(triage).toContain('from "./lib/review_desk.js"');
    expect(triage).toContain("ledger: s.verification");
    expect(triage).toContain("acceptVerdict(ctx, card, evidence");
    // The toolbar disables Accept from that state, its reasons adjacent — a
    // checklist above the buttons, one line each (FINDINGS REV-02).
    expect(triage).toMatch(/const st = acceptState\(card, evidence, detail\);/);
    expect(triage).toContain('<ul class="blockers plain" id="accept-why"');
  });

  it("Review, the issue page and the peek render Accept only through triageBarHtml", () => {
    for (const f of ["review.js", "card.js", "peek.js"]) {
      const src = web(f);
      expect(src, f).toContain("triageBarHtml(");
      // No Accept button of its own.
      expect(src, f).not.toMatch(/<button[^>]*data-accept/);
    }
  });
});
