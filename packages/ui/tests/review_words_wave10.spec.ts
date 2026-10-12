import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activityItems } from "../src/issue.js";
import { tipFor } from "../src/learn.js";
import { PROFILE_SOURCE_LABELS, RULE_SOURCE_LABELS } from "../src/pm.js";
import { eventSentence } from "../src/vocabulary.js";
import { literals, words } from "./copy_scan.js";

/**
 * The test-and-refine loop's wave 10 B (sweep5_kernel_reviewgit.json,
 * review-git and NAMING): each finding reduced to the function or the
 * literals its words come from.
 */

const HERE = new URL(".", import.meta.url).pathname;
const WEB = join(HERE, "../web");
const SRC = join(HERE, "../src");
const at = (m: number) => new Date(Date.UTC(2026, 9, 12, 9, m)).toISOString();

describe("Won't do on the issue's Activity (B1, B2)", () => {
  const moved = (seq: number, fromStatus: string, toStatus: string, reason: string) => ({
    seq,
    type: "card/status_changed",
    actor: "human",
    createdAt: at(seq),
    payload: { fromStatus, toStatus, reason },
  });

  it("B2: a move to Won't do and back says Won't do, the board's word, never the stored Rejected", () => {
    const items = activityItems({
      cardId: "card_a",
      events: [
        moved(1, "review", "rejected", "rejected: Duplicate of the weekly total card"),
        moved(2, "rejected", "ready", "reopened"),
        moved(3, "backlog", "rejected", "rejected: Out of scope"),
      ],
      messages: [],
      decisions: [],
    });
    expect(items.map((i) => i.text)).toEqual([
      "moved from In review to Won't do",
      "moved from Won't do to To do",
      "moved from Backlog to Won't do",
    ]);
  });

  it("B1: the reason the Won't do dialog asks for is quoted with the move", () => {
    const [item] = activityItems({
      cardId: "card_a",
      events: [moved(1, "review", "rejected", "rejected: Duplicate of the weekly total card")],
      messages: [],
      decisions: [],
    });
    expect(item?.quote).toBe("Duplicate of the weekly total card");
    expect(
      eventSentence({
        type: "card/status_changed",
        actor: "human",
        cardId: "card_a",
        payload: { fromStatus: "review", toStatus: "rejected", reason: "rejected: Out of scope" },
      }).quote,
    ).toBe("Out of scope");
    // Other moves quote nothing they did not ask for.
    const [plain] = activityItems({
      cardId: "card_a",
      events: [moved(1, "rejected", "ready", "reopened")],
      messages: [],
      decisions: [],
    });
    expect(plain?.quote).toBeUndefined();
  });
});

/** Every person-facing literal of the dashboard's page modules and view models. */
function copy(dir: string, ext: RegExp): { at: string; text: string }[] {
  const out: { at: string; text: string }[] = [];
  for (const f of readdirSync(dir).filter((n) => ext.test(n)))
    for (const { line, text } of literals(readFileSync(join(dir, f), "utf8")))
      out.push({ at: `${f}:${line}`, text: words(text) });
  return out;
}

describe("the board's columns, never the retired state names, as a place (B3)", () => {
  // NAMING: *Working*, *Checking* and *Closed* are retired; a person who read
  // one could not find a column by that name. Said as a place an issue waits in
  // or moves to, they are a column that does not exist.
  const PLACE = /\b(?:in|to|from|into) (?:Working|Checking|Closed)\b/;

  it("no dashboard literal sends an issue to, or keeps it in, Working, Checking or Closed", () => {
    const hits = [...copy(WEB, /\.js$/), ...copy(SRC, /\.ts$/)]
      .filter((c) => PLACE.test(c.text))
      .map((c) => `${c.at}: ${c.text.match(PLACE)?.[0]}`);
    expect(hits).toEqual([]);
  });

  it("the scan finds one (a negative case)", () => {
    expect(PLACE.test(words("Finished issues will wait in Checking until you clear one."))).toBe(
      true,
    );
  });
});

describe("Request changes asks for a reason, as the CLI and Won't do do (B5, NAMING)", () => {
  const NOTE = /\bnotes?\b/i;

  it("the Request changes composer, its refusal and its result say reason, never note", () => {
    const hits = copy(WEB, /^triage\.js$/)
      .filter((c) => NOTE.test(c.text))
      .map((c) => `${c.at}: ${c.text.slice(0, 80)}`);
    expect(hits).toEqual([]);
    const src = readFileSync(join(WEB, "triage.js"), "utf8");
    expect(src).toContain("Add a reason for the Agent. It's what it reads next.");
  });

  it("Tips and the Playbook name what a person typed on Request changes a reason", () => {
    const lesson = tipFor("practice:request_changes", {}).concept;
    expect(lesson).not.toMatch(NOTE);
    expect(lesson).toMatch(/\breason\b/);
    expect(RULE_SOURCE_LABELS.send_back).toBe("From your reason when you requested changes");
    expect(PROFILE_SOURCE_LABELS.send_back).toBe("From your reasons when you requested changes");
    const playbook = [...copy(WEB, /^(playbook|pm_view)\.js$/), ...copy(SRC, /^playbook\.ts$/)]
      .filter((c) => /\bnotes? when you request/i.test(c.text))
      .map((c) => c.at);
    expect(playbook).toEqual([]);
  });
});
