import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { loadGatesConfig } from "@sekhemet/gates";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { ledgerEvidenceSummary } from "../src/ledger_evidence.js";
import { runResearchCard } from "../src/research/cards.js";
import { withClaims } from "../src/research/researcher.js";

// GT-N5-3 wired into the product: a research card writes its claims report
// where `gates.toml [claims]` says, and the claim gate — declared in the
// hash-pinned file, run by the built-in layers with the card's id — decides
// whether the note reaches Review. Real SQLite and the production board.

async function setup(claims: string | undefined) {
  const repo = mkdtempSync(join(tmpdir(), "rclaims-"));
  if (claims !== undefined) {
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    writeFileSync(join(repo, ".sekhemet", "gates.toml"), claims);
  }
  const db = new DatabaseSync(join(repo, "events.db"));
  initSchema(db);
  const cards = new CardStore(db, new EventLog(db));
  const board = new BoardServiceImpl(cards, {
    entryConditions: true,
    evidenceFor: (id) => ledgerEvidenceSummary(cards, repo, id),
  });
  const card = await cards.createCard({
    id: "card_q",
    tier: "task",
    title: "Which CSV parser should we use?",
    labels: ["research"],
    status: "ready",
  });
  return { cards, card, repo, board };
}

const answer = (text: string) =>
  withClaims({
    answer: text,
    sources: ["https://csv.js.org/parse/"],
    evidence: [],
    grounded: true,
    confidence: 0.6,
    badCitations: [],
  } as Parameters<typeof withClaims>[0]);

const EXECUTABLE =
  "Use csv-parse [1]. The `parse()` function returns a stream of records [1].\n\nReferences:\n[1] https://csv.js.org/parse/";

describe("a research card's claim gate (GT-N5-3)", () => {
  it("writes the claims report and parks the note when an executable claim is neither reproduced nor marked unreproducible", async () => {
    const { cards, card, repo, board } = await setup("[claims]\n");
    const r = await runResearchCard(card, async () => answer(EXECUTABLE), cards, repo, board);
    const report = JSON.parse(
      readFileSync(join(repo, ".sekhemet", "research", "card_q.claims.json"), "utf8"),
    );
    expect(report.claims).toContainEqual({
      id: "1",
      kind: "executable",
      text: "The `parse()` function returns a stream of records [1].",
    });
    expect(r.passed).toBe(false);
    expect((await cards.getCard("card_q"))?.status).toBe("parked");
    const ev = JSON.parse(
      readFileSync(join(repo, ".sekhemet", "evidence", "latest-card_q.json"), "utf8"),
    );
    // The gate ran under the pinned gates.toml, and named the claim.
    expect(ev.gatesSha256).toBe(loadGatesConfig(repo).sha256);
    expect(ev.failures.map((f: { gate: string }) => f.gate)).toEqual(["claims"]);
    expect(ev.failures[0].errorExcerpt).toBe(
      "[1] neither reproduced nor marked unreproducible with a reason",
    );
    expect(ev.rungResults.find((x: { gate: string }) => x.gate === "claims")).toMatchObject({
      passed: false,
    });
  });

  it("moves a note whose claims the gate passes to Review, reading the report path gates.toml names", async () => {
    const { cards, card, repo, board } = await setup(
      '[claims]\nreport = "notes/{card}-claims.json"\n',
    );
    const r = await runResearchCard(
      card,
      async () => answer("Use csv-parse, it streams well in production today [1]."),
      cards,
      repo,
      board,
    );
    expect(JSON.parse(readFileSync(join(repo, "notes", "card_q-claims.json"), "utf8")).card).toBe(
      "card_q",
    );
    expect(r.passed).toBe(true);
    expect((await cards.getCard("card_q"))?.status).toBe("review");
    const ev = JSON.parse(
      readFileSync(join(repo, ".sekhemet", "evidence", "latest-card_q.json"), "utf8"),
    );
    expect(ev.rungResults.find((x: { gate: string }) => x.gate === "claims")).toMatchObject({
      passed: true,
      detail: "the claim gate passed",
    });
  });

  it("without a declared claim gate keeps the pipeline's own check and says so in the evidence", async () => {
    const { cards, card, repo, board } = await setup(undefined);
    const r = await runResearchCard(card, async () => answer(EXECUTABLE), cards, repo, board);
    expect(r.passed).toBe(false);
    const ev = JSON.parse(
      readFileSync(join(repo, ".sekhemet", "evidence", "latest-card_q.json"), "utf8"),
    );
    expect(ev.rungResults.find((x: { gate: string }) => x.gate === "claims").detail).toMatch(
      /no claim gate declared in gates\.toml/,
    );
  });
});
