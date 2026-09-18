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
    stepBudget: 24,
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
    acceptanceTests: ["hasher.spec.ts"],
    stepBudget: 32,
    spec: "Implement canonicalJson, GENESIS_HASH and hashEvent in src/hasher.ts so tests/hasher.spec.ts passes.",
    acceptanceCriteria: [
      "canonicalJson sorts object keys recursively so key order cannot change a hash",
      "GENESIS_HASH is 64 zero characters",
      "hashEvent takes ONE argument: an event without its own hash field, typed Omit<ChronicleEvent<T>, 'hash'>. It cannot require hash, because hash is what it computes.",
      "hashEvent incorporates previousHash so event N depends on event N-1",
      "tests/hasher.spec.ts passes without modification, and tsc -b reports no errors in tests/",
    ],
  },
  {
    id: "card_chron_db",
    title: "Initialize node:sqlite WAL database with strict constraints (SPIDR: Data)",
    scopeFiles: ["src/db.ts"],
    acceptanceTests: ["db.spec.ts"],
    stepBudget: 32,
    spec: "Implement src/db.ts exporting openDatabase(path: string): DatabaseSync using node:sqlite. Enable WAL. Create table chronicle_events (sequence_number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, timestamp INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL, idempotency_key TEXT UNIQUE) and index idx_chronicle_hash on hash, both IF NOT EXISTS.",
    acceptanceCriteria: [
      "journal_mode is WAL and synchronous is NORMAL",
      "sequence_number is INTEGER PRIMARY KEY AUTOINCREMENT; id is UNIQUE NOT NULL",
      "idempotency_key is UNIQUE when present",
      "tsc -b and biome check both pass",
    ],
  },
  {
    id: "card_chron_verifier",
    title: "Implement tamper detection over the hash chain (SPIDR: Rule)",
    scopeFiles: ["src/verifier.ts"],
    acceptanceTests: ["verifier.spec.ts"],
    stepBudget: 32,
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
    id: "card_chron_ledger",
    title: "Implement append-only ledger with idempotency (SPIDR: Rule & Path)",
    scopeFiles: ["src/ledger.ts"],
    acceptanceTests: ["ledger.spec.ts"],
    stepBudget: 40,
    spec: "Implement class Ledger in src/ledger.ts: constructor(dbPath), append({ type, payload, idempotencyKey? }) returning the ChronicleEvent, get(id), list(), audit() returning an AuditReport, close(). Use openDatabase from src/db.ts, hashEvent/GENESIS_HASH from src/hasher.ts and verifyChain from src/verifier.ts. Replaying an idempotency key returns the existing event.",
    acceptanceCriteria: [
      "Sequence numbers are monotonic starting at 1",
      "First event links to GENESIS_HASH; each later event links to its predecessor",
      "Replaying an idempotency key returns the original event and appends nothing",
      "Events persist across reopening the database file",
      "tests/ledger.spec.ts passes without modification",
    ],
  },
  {
    id: "card_chron_api",
    title: "Expose the ledger over an HTTP micro-API (SPIDR: Interface & Integration)",
    scopeFiles: ["src/server.ts"],
    acceptanceTests: ["e2e_api.spec.ts"],
    stepBudget: 40,
    spec: 'Implement src/server.ts exporting startServer({ dbPath, port }) that returns Promise<{ port, close }>. Use node:http. Routes: POST /events (201 + created event), GET /events/:id (200 or 404), GET /audit (AuditReport), GET /health ({ status: "ok" }). Build on Ledger from src/ledger.ts.',
    acceptanceCriteria: [
      "startServer({ dbPath, port: 0 }) resolves with the bound port and a close() function",
      "POST /events returns 201 with the created event; invalid JSON returns 400 with an error message",
      "GET /events/:id returns the event or 404",
      "GET /audit returns { valid, totalEvents } and reports corruptedAtSequence after on-disk tampering",
      "tests/e2e_api.spec.ts passes without modification",
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
