#!/usr/bin/env node
/**
 * The writer B3's crash trial kills (`ledger.mjs` `crashTrial`): it opens a
 * repository's ledger the way the CLI does (`initLocalKernel`: schema,
 * person, WAL) and, without pausing, creates issues and moves them between
 * Ready and Backlog — each a ledger event and its projection in one
 * transaction — printing the ledger's last seq after each write. It never
 * stops by itself; it is meant to die by SIGKILL.
 *
 *   node scripts/milestones/ledger_writer.mjs <repo>
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.argv[2];
if (!repo) {
  console.error("usage: ledger_writer.mjs <repo>");
  process.exit(2);
}
const root = join(import.meta.dirname, "..", "..");
const { initLocalKernel } = await import(
  pathToFileURL(join(root, "apps", "harness", "dist", "index.js")).href
);
const { db, cardStore, boardService } = initLocalKernel(repo);
const last = db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events");
const say = () => process.stdout.write(`${last.get().s}\n`);

for (let i = 1; ; i++) {
  const id = `card_crash_${i}`;
  await cardStore.createCard({
    id,
    tier: "story",
    title: `Crash issue ${i}`,
    status: "ready",
    scopeFiles: [`src/crash_${i}.ts`],
    acceptanceCriteria: [`src/crash_${i}.ts exports crash${i}`],
  });
  say();
  for (const [from, to] of [
    ["ready", "backlog"],
    ["backlog", "ready"],
    // Each ends in Backlog, so Ready's WIP limit never stops the writer.
    ["ready", "backlog"],
  ]) {
    await boardService.transitionCard({
      cardId: id,
      fromStatus: from,
      toStatus: to,
      actor: "human",
      reason: "crash trial",
    });
    say();
  }
}
