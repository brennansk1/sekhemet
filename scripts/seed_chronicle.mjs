#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
/**
 * Seed the six Project Chronicle verification cards onto the board.
 *
 * Chronicle is the public-release gate: the harness must drive a local model
 * through all six cards with Pass@1 >= 80%, repair any failure within three
 * rungs, touch only declared scope files, and never alter a test assertion.
 */
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { CardStore, EventLog, initSchema } = await import(
  join(root, "packages/kernel/dist/index.js")
);

const CARDS = [
  {
    id: "card_chron_iface",
    title: "Define Chronicle contract interfaces (SPIDR: Interface)",
    scopeFiles: ["src/types.ts"],
    stepBudget: 12,
    spec: "Define ChronicleEvent<T> and AuditReport interfaces in src/types.ts. Types only, no implementation logic.",
    acceptanceCriteria: [
      "ChronicleEvent has id, sequenceNumber, timestamp, type, payload, previousHash, hash, optional idempotencyKey",
      "AuditReport has valid, totalEvents, optional corruptedAtSequence, expectedHash, actualHash",
      "tsc -b and biome check both pass",
    ],
  },
  {
    id: "card_chron_hasher",
    title: "Implement canonical JSON and SHA-256 hash chaining (SPIDR: Rule)",
    scopeFiles: ["src/hasher.ts"],
    stepBudget: 16,
    spec: "Implement canonicalJson, GENESIS_HASH and hashEvent in src/hasher.ts so tests/hasher.spec.ts passes.",
    acceptanceCriteria: [
      "canonicalJson sorts object keys recursively so key order cannot change a hash",
      "GENESIS_HASH is 64 zero characters",
      "hashEvent incorporates previousHash so event N depends on event N-1",
      "tests/hasher.spec.ts passes without modification",
    ],
  },
  {
    id: "card_chron_db",
    title: "Initialize node:sqlite WAL database with strict constraints (SPIDR: Data)",
    scopeFiles: ["src/db.ts"],
    stepBudget: 16,
    spec: "Create the chronicle_events table with WAL journaling and the documented constraints in src/db.ts.",
    acceptanceCriteria: [
      "journal_mode is WAL and synchronous is NORMAL",
      "sequence_number is INTEGER PRIMARY KEY AUTOINCREMENT; id is UNIQUE NOT NULL",
      "idempotency_key is UNIQUE when present",
      "tsc -b and biome check both pass",
    ],
  },
  {
    id: "card_chron_ledger",
    title: "Implement append-only ledger with idempotency (SPIDR: Rule & Path)",
    scopeFiles: ["src/ledger.ts"],
    stepBudget: 20,
    spec: "Implement the Ledger class in src/ledger.ts: append, list, audit, close. Replaying an idempotency key returns the existing event.",
    acceptanceCriteria: [
      "Sequence numbers are monotonic starting at 1",
      "First event links to GENESIS_HASH; each later event links to its predecessor",
      "Replaying an idempotency key returns the original event and appends nothing",
      "Events persist across reopening the database file",
      "tests/ledger.spec.ts passes without modification",
    ],
  },
  {
    id: "card_chron_verifier",
    title: "Implement tamper detection over the hash chain (SPIDR: Rule)",
    scopeFiles: ["src/verifier.ts"],
    stepBudget: 16,
    spec: "Implement verifyChain in src/verifier.ts returning an AuditReport that names the exact corrupted sequence number.",
    acceptanceCriteria: [
      "An intact chain verifies as valid",
      "A tampered payload is detected and corruptedAtSequence names that event",
      "A rewritten previousHash is detected",
      "A non-monotonic sequence is rejected",
      "tests/verifier.spec.ts passes without modification",
    ],
  },
  {
    id: "card_chron_api",
    title: "Expose the ledger over an HTTP micro-API (SPIDR: Interface & Integration)",
    scopeFiles: ["src/api.ts"],
    stepBudget: 20,
    spec: "Implement an http server in src/api.ts exposing POST /events, GET /events and GET /audit over loopback.",
    acceptanceCriteria: [
      "POST /events appends and returns the created event as JSON",
      "GET /events returns the full chain",
      "GET /audit returns the AuditReport",
      "Unknown routes return 404 with a JSON body",
      "tsc -b, vitest run and biome check all pass",
    ],
  },
];

const repoPath = process.argv[2] ?? root;
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

console.log(`\nSeeded ${created} new card(s); ${CARDS.length} Chronicle cards total.`);
console.log("Run one with:  node apps/harness/dist/index.js run card_chron_hasher");
db.close();
