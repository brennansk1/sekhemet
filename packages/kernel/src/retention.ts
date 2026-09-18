import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 30-day retention (K27, design: "Context packs and raw observations are
 * retained for active attempts and pruned 30 days after card closure,
 * keeping only the EvidenceBundle, final diff, and gate pass events
 * permanently").
 *
 * Pruned for cards closed (done or rejected) longer than `days` ago: their
 * context packs, masked observations and transcripts. Never pruned: evidence
 * bundles (which hold the final diff and gate results), the ledger, and
 * anything belonging to a card that is still open.
 */
export interface RetentionCard {
  id: string;
  status: string;
  updatedAt: string;
  /** Context-pack ids this card's steps referenced. */
  packIds: string[];
}

export interface RetentionReport {
  closedCards: string[];
  removed: { packs: number; observations: number; transcripts: number };
  keptForOpenCards: number;
}

export const RETENTION_DAYS = 30;

export function pruneRetention(
  repoRoot: string,
  cards: RetentionCard[],
  options: { days?: number; now?: number } = {},
): RetentionReport {
  const days = options.days ?? RETENTION_DAYS;
  const cutoff = (options.now ?? Date.now()) - days * 24 * 3600 * 1000;
  const closed = cards.filter(
    (c) => (c.status === "done" || c.status === "rejected") && Date.parse(c.updatedAt) < cutoff,
  );
  const closedIds = new Set(closed.map((c) => c.id));
  // A pack shared with an open card (identical prompts) stays.
  const openPacks = new Set(cards.filter((c) => !closedIds.has(c.id)).flatMap((c) => c.packIds));
  const root = join(repoRoot, ".sekhemet");
  const removed = { packs: 0, observations: 0, transcripts: 0 };
  let keptForOpenCards = 0;

  for (const card of closed) {
    for (const id of card.packIds) {
      if (openPacks.has(id)) {
        keptForOpenCards++;
        continue;
      }
      const path = join(root, "blobs", id.slice(0, 2), `${id}.json`);
      if (existsSync(path)) {
        rmSync(path, { force: true });
        removed.packs++;
      }
    }
  }

  const transcripts = join(root, "transcripts");
  if (existsSync(transcripts)) {
    for (const name of readdirSync(transcripts)) {
      const cardId = name.replace(/-\d{4}-\d{2}-\d{2}T[\d-]+Z\.jsonl$/, "");
      if (closedIds.has(cardId)) {
        rmSync(join(transcripts, name), { force: true });
        removed.transcripts++;
      }
    }
  }

  const observations = join(root, "observations");
  if (existsSync(observations)) {
    for (const name of readdirSync(observations)) {
      if (!name.endsWith(".json")) continue;
      const header = join(observations, name);
      let cardId: string | undefined;
      try {
        cardId = (JSON.parse(readFileSync(header, "utf8")) as { meta?: { cardId?: string } }).meta
          ?.cardId;
      } catch {
        cardId = undefined;
      }
      // Observations of no card are pruned by age alone.
      const stale = cardId ? closedIds.has(cardId) : statSync(header).mtimeMs < cutoff;
      if (!stale) continue;
      rmSync(header, { force: true });
      rmSync(join(observations, `${name.slice(0, -5)}.txt`), { force: true });
      removed.observations++;
    }
  }

  return { closedCards: [...closedIds], removed, keptForOpenCards };
}
