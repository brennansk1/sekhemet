import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { BlobStore } from "./blobs.js";
import type { EventLog } from "./log.js";

/**
 * 30-day retention (K27; runtime.md item 33, NEW-runtime-4).
 *
 * Selected for cards closed (done or rejected) longer than `days` ago: their
 * context packs, masked observations and transcripts. Never pruned: evidence
 * bundles (which hold the final diff and gate results), the ledger, and
 * anything belonging to a card that is still open; a pack shared with an
 * open card stays.
 *
 * **Pruning is a recorded erasure** (kernel rule 34, RUN-13, RUN-54, RUN-57):
 * everything selected is deleted by one `EventLog.erase` with reason
 * `retention`, whose `ledger/erased` event lists every pack's blob id and
 * every observation and transcript file, so a replay of a step whose pack was
 * pruned names the gap and that event's seq. The erasure's principal is the
 * person who set the retention period — on a solo install the install's one
 * person, who confirmed its first run and holds Accept; with no such person
 * (a team server where nobody set a period) nothing is pruned.
 */
export interface RetentionCard {
  id: string;
  status: string;
  updatedAt: string;
  /** Context-pack ids this card's steps referenced. */
  packIds: string[];
}

export type PrunedKind = "pack" | "observation" | "transcript";

export interface PrunedItem {
  kind: PrunedKind;
  /** The pack's blob id, the observation's ref, or the transcript's file name. */
  id: string;
  /** The closed card it belonged to; absent for an observation of no card. */
  cardId?: string;
}

export interface RetentionSelection {
  closedCards: string[];
  items: PrunedItem[];
  /** Pack blob ids, for `ledger/erased.blobIds`. */
  blobIds: string[];
  /** Observation and transcript files, relative to `.sekhemet/`. */
  files: string[];
  keptForOpenCards: number;
}

export interface RetentionReport {
  closedCards: string[];
  removed: { packs: number; observations: number; transcripts: number };
  keptForOpenCards: number;
  /** Every item pruned, with its card id (RUN-57). */
  pruned: PrunedItem[];
  /** The `ledger/erased` seq that recorded the pruning, when anything was pruned. */
  erasedBySeq?: number;
  /** Why nothing was pruned although something was due (no person set the period). */
  skipped?: string;
}

export const RETENTION_DAYS = 30;

/** What retention would prune now; reads only. */
export function selectRetention(
  repoRoot: string,
  cards: RetentionCard[],
  options: { days?: number; now?: number } = {},
): RetentionSelection {
  const days = options.days ?? RETENTION_DAYS;
  const cutoff = (options.now ?? Date.now()) - days * 24 * 3600 * 1000;
  const closed = cards.filter(
    (c) => (c.status === "done" || c.status === "rejected") && Date.parse(c.updatedAt) < cutoff,
  );
  const closedIds = new Set(closed.map((c) => c.id));
  // A pack shared with an open card (identical prompts) stays.
  const openPacks = new Set(cards.filter((c) => !closedIds.has(c.id)).flatMap((c) => c.packIds));
  const root = join(repoRoot, ".sekhemet");
  const blobs = new BlobStore(repoRoot);
  const items: PrunedItem[] = [];
  const blobIds: string[] = [];
  const files: string[] = [];
  let keptForOpenCards = 0;

  for (const card of closed) {
    for (const id of card.packIds) {
      if (openPacks.has(id)) {
        keptForOpenCards++;
        continue;
      }
      if (blobs.has(id) && !blobIds.includes(id)) {
        blobIds.push(id);
        items.push({ kind: "pack", id, cardId: card.id });
      }
    }
  }

  const transcripts = join(root, "transcripts");
  if (existsSync(transcripts)) {
    for (const name of readdirSync(transcripts).sort()) {
      const cardId = name.replace(/-\d{4}-\d{2}-\d{2}T[\d-]+Z\.jsonl$/, "");
      if (closedIds.has(cardId)) {
        files.push(`transcripts/${name}`);
        items.push({ kind: "transcript", id: name, cardId });
      }
    }
  }

  const observations = join(root, "observations");
  if (existsSync(observations)) {
    for (const name of readdirSync(observations).sort()) {
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
      const ref = name.slice(0, -5);
      files.push(`observations/${name}`);
      if (existsSync(join(observations, `${ref}.txt`))) files.push(`observations/${ref}.txt`);
      items.push({ kind: "observation", id: ref, ...(cardId ? { cardId } : {}) });
    }
  }

  return { closedCards: [...closedIds], items, blobIds, files, keptForOpenCards };
}

/**
 * The person a retention erasure is recorded for (rule 34): on a solo
 * install its one person, who holds Accept; otherwise no one, and nothing is
 * pruned until a person holding Accept sets a period.
 */
export function retentionPrincipal(log: EventLog): string | undefined {
  const principal = log.localPrincipal();
  return log.mayAccept(principal) ? principal : undefined;
}

/** Prune what retention selects, as one recorded erasure (RUN-13, RUN-54, RUN-57). */
export async function pruneRetention(
  repoRoot: string,
  log: EventLog,
  cards: RetentionCard[],
  options: { days?: number; now?: number; principal?: string } = {},
): Promise<RetentionReport> {
  const selection = selectRetention(repoRoot, cards, options);
  const count = (kind: PrunedKind) => selection.items.filter((i) => i.kind === kind).length;
  const none = { packs: 0, observations: 0, transcripts: 0 };
  const base = {
    closedCards: selection.closedCards,
    keptForOpenCards: selection.keptForOpenCards,
  };
  if (selection.items.length === 0) return { ...base, removed: none, pruned: [] };
  const principal = options.principal ?? retentionPrincipal(log);
  if (!principal) {
    return {
      ...base,
      removed: none,
      pruned: [],
      skipped: "no person holding Accept has set a retention period; nothing was pruned",
    };
  }
  const erased = await log.erase({
    eventIds: [],
    blobIds: selection.blobIds,
    blobs: new BlobStore(repoRoot),
    files: selection.files,
    fileRoot: join(repoRoot, ".sekhemet"),
    reason: "retention",
    principal,
  });
  return {
    ...base,
    removed: {
      packs: count("pack"),
      observations: count("observation"),
      transcripts: count("transcript"),
    },
    pruned: selection.items,
    erasedBySeq: erased.erasedBySeq,
  };
}
