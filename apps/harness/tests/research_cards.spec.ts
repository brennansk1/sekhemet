import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { isResearchCard, researchQuestion, runResearchCard } from "../src/research/cards.js";
import { withClaims } from "../src/research/researcher.js";

async function setup() {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const cards = new CardStore(db, new EventLog(db));
  const card = await cards.createCard({
    id: "card_q",
    tier: "task",
    title: "Which CSV parser should we use?",
    spec: "Streaming, permissive licence.",
    acceptanceCriteria: ["names one library", "gives its streaming API"],
    labels: ["research"],
    status: "ready",
  });
  return { cards, card, repo: mkdtempSync(join(tmpdir(), "rcard-")) };
}

// Built the way production builds one, so the note and the claim gate see
// the same shape the Researcher actually returns.
const answer = (over: Record<string, unknown> = {}) =>
  withClaims({
    answer: "Use csv-parse [1].\n\nReferences:\n[1] https://csv.js.org/parse/",
    sources: ["https://csv.js.org/parse/"],
    evidence: [],
    grounded: true,
    confidence: 0.6,
    badCitations: [],
    ...over,
  } as Parameters<typeof withClaims>[0]);

describe("research cards (X7)", () => {
  it("recognises research cards and asks the whole question", async () => {
    const { card } = await setup();
    expect(isResearchCard(card)).toBe(true);
    expect(isResearchCard({ labels: ["api"] })).toBe(false);
    expect(researchQuestion(card)).toBe(
      "Which CSV parser should we use?\n\nStreaming, permissive licence.\n\nThe answer must cover:\n- names one library\n- gives its streaming API",
    );
  });

  it("writes a cited note and evidence, and moves a grounded answer to Review", async () => {
    const { cards, card, repo } = await setup();
    const asked: string[] = [];
    const r = await runResearchCard(
      card,
      async (q, id) => {
        asked.push(id);
        return answer();
      },
      cards,
      repo,
    );
    expect(asked).toEqual(["card_q"]);
    expect(r.passed).toBe(true);
    const note = readFileSync(join(repo, ".sekhemet", "research", "card_q.md"), "utf8");
    expect(note).toMatch(
      /^# Which CSV parser should we use\?\n\nResearch note for `card_q`, \d{4}-\d{2}-\d{2}\. Grounded, confidence 0\.60\./,
    );
    expect(note).toMatch(/## Sources read\n\n1\. https:\/\/csv\.js\.org\/parse\//);
    const ev = JSON.parse(
      readFileSync(join(repo, ".sekhemet", "evidence", "latest-card_q.json"), "utf8"),
    );
    expect(ev).toMatchObject({
      kind: "research",
      passed: true,
      note: ".sekhemet/research/card_q.md",
    });
    expect((await cards.getCard("card_q"))?.status).toBe("review");
  });

  it("parks an answer that is not grounded, or that cites what it did not read", async () => {
    const a = await setup();
    await runResearchCard(
      a.card,
      async () => answer({ grounded: false, confidence: 0 }),
      a.cards,
      a.repo,
    );
    expect((await a.cards.getCard("card_q"))?.status).toBe("parked");
    const b = await setup();
    const r = await runResearchCard(
      b.card,
      async () => answer({ badCitations: [2] }),
      b.cards,
      b.repo,
    );
    expect(r.passed).toBe(false);
    expect(existsSync(r.notePath)).toBe(true);
    expect((await b.cards.getCard("card_q"))?.status).toBe("parked");
  });
});
