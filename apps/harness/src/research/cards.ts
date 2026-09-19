import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CardRecord, CardStore } from "@sekhemet/kernel";
import type { ResearchAnswer } from "./researcher.js";

/**
 * Research cards (X7): a card labelled `research` asks a question rather
 * than asking for code. The queue gives it to the Researcher (deep research:
 * a team of sub-researchers and a verifier), not the Worker, and the result
 * is a cited note:
 *
 * - `.sekhemet/research/<card>.md`: the answer, its numbered sources, and
 *   the verdict (grounded, confidence, unverified citations);
 * - the card's dossier (the ledger), through the research service;
 * - an evidence bundle, so Review shows it like any other card;
 * - the card moves to Review when the answer is grounded, and is parked with
 *   the reason when it is not. A person accepts the note; nothing merges.
 */

export function isResearchCard(card: Pick<CardRecord, "labels">): boolean {
  return (card.labels ?? []).some((l) => l.toLowerCase() === "research");
}

export function researchQuestion(card: CardRecord): string {
  const criteria = (card.acceptanceCriteria ?? []).map((c) => `- ${c}`).join("\n");
  return [card.title, card.spec ?? "", criteria ? `The answer must cover:\n${criteria}` : ""]
    .filter(Boolean)
    .join("\n\n");
}

export function researchNote(card: CardRecord, r: ResearchAnswer, at = new Date()): string {
  const verdict = r.grounded
    ? `Grounded, confidence ${r.confidence.toFixed(2)}${r.badCitations.length ? `; citations [${r.badCitations.join(", ")}] point at nothing read` : ""}.`
    : "Not grounded: the evidence did not settle it.";
  return [
    `# ${card.title}`,
    "",
    `Research note for \`${card.id}\`, ${at.toISOString().slice(0, 10)}. ${verdict}`,
    "",
    r.answer.trim(),
    "",
    ...(r.sources.length
      ? ["## Sources read", "", ...r.sources.map((s, i) => `${i + 1}. ${s}`), ""]
      : []),
  ].join("\n");
}

export async function runResearchCard(
  card: CardRecord,
  ask: (question: string, cardId: string) => Promise<ResearchAnswer>,
  cardStore: CardStore,
  repoPath: string,
): Promise<{ passed: boolean; notePath: string; answer: ResearchAnswer }> {
  const started = Date.now();
  if (card.status !== "in_progress") {
    await cardStore.updateCardStatus(
      card.id,
      "in_progress",
      "research: the Researcher started",
      "researcher",
    );
  }
  const answer = await ask(researchQuestion(card), card.id);
  const dir = join(repoPath, ".sekhemet", "research");
  mkdirSync(dir, { recursive: true });
  const notePath = join(dir, `${card.id}.md`);
  writeFileSync(notePath, researchNote(card, answer));
  const passed = answer.grounded && answer.badCitations.length === 0;
  const evDir = join(repoPath, ".sekhemet", "evidence");
  mkdirSync(evDir, { recursive: true });
  const evidence = {
    id: `ev_research_${card.id}_${started.toString(36)}`,
    cardId: card.id,
    kind: "research",
    createdAt: new Date().toISOString(),
    passed,
    note: `.sekhemet/research/${card.id}.md`,
    sources: answer.sources,
    confidence: answer.confidence,
    badCitations: answer.badCitations,
    rungResults: [
      { gate: "grounded", rung: "research", passed: answer.grounded },
      { gate: "citations", rung: "research", passed: answer.badCitations.length === 0 },
    ],
    failures: [],
    durationMs: Date.now() - started,
    diff: "",
    filesTouched: [],
    linesAdded: 0,
    linesRemoved: 0,
  };
  writeFileSync(join(evDir, `latest-${card.id}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  if (passed) {
    await cardStore.updateCardStatus(card.id, "verify", "research: note written", "researcher");
    await cardStore.updateCardStatus(
      card.id,
      "review",
      "research: cited note ready for review",
      "researcher",
    );
  } else {
    await cardStore.updateCardStatus(
      card.id,
      "parked",
      `parked: research not settled (${answer.grounded ? `unverified citations ${answer.badCitations.join(", ")}` : "not grounded"})`,
      "researcher",
    );
  }
  return { passed, notePath, answer };
}
