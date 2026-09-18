#!/usr/bin/env node
/**
 * Seed a fixture project's cards onto a target repository's board.
 *
 * Usage: node scripts/seed_project.mjs <fixtureDir> <targetRepo>
 *
 * Reads `<fixtureDir>/cards.json` (an array of cards in dependency order, each
 * with id, title, scopeFiles, optional acceptanceTests, stepBudget, spec and
 * acceptanceCriteria) and creates every card that is not already present, exactly
 * as scripts/seed_chronicle.mjs does for Project Chronicle.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [fixtureArg, targetArg] = process.argv.slice(2);
if (!fixtureArg || !targetArg) {
  console.error("usage: node scripts/seed_project.mjs <fixtureDir> <targetRepo>");
  process.exit(2);
}

const fixtureDir = resolve(fixtureArg);
const repoPath = resolve(targetArg);
const cardsPath = join(fixtureDir, "cards.json");
if (!existsSync(cardsPath)) {
  console.error(`No cards.json in ${fixtureDir}`);
  process.exit(1);
}

const CARDS = JSON.parse(readFileSync(cardsPath, "utf8"));
if (!Array.isArray(CARDS) || CARDS.length === 0) {
  console.error(`${cardsPath} must be a non-empty array of cards`);
  process.exit(1);
}
for (const card of CARDS) {
  for (const field of ["id", "title", "scopeFiles", "stepBudget", "spec", "acceptanceCriteria"]) {
    if (card[field] === undefined) {
      console.error(`${cardsPath}: card ${card.id ?? "(no id)"} is missing ${field}`);
      process.exit(1);
    }
  }
}

const { CardStore, EventLog, initSchema } = await import(
  join(root, "packages/kernel/dist/index.js")
);

const dbDir = join(repoPath, ".sekhemet");
if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

const db = new DatabaseSync(join(dbDir, "events.db"));
initSchema(db);
const log = new EventLog(db);
const store = new CardStore(db, log);

let created = 0;
for (const card of CARDS) {
  if (await store.getCard(card.id)) {
    console.log(`  = ${card.id} already present`);
    continue;
  }
  await store.createCard({ ...card, tier: "story", status: "ready" });
  console.log(`  + ${card.id}  [${card.scopeFiles.join(", ")}]  budget ${card.stepBudget}`);
  created++;
}

console.log(`\nSeeded ${created} new card(s); ${CARDS.length} cards total from ${cardsPath}.`);
console.log(`Run one with:  node apps/harness/dist/index.js run ${CARDS[0].id}`);
db.close();
