import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { estimatePromptTokens } from "./allocator.js";
import type { TurnHistoryItem } from "./prompts.js";

/**
 * The exemplar store (C13, E11; design "Exemplars" and "In-domain few-shot
 * trajectory retrieval"): successful trajectories from this repository,
 * kept per card class, and the top two of the card's class retrieved into
 * the prompt's static zone. A small model imitates a worked trajectory from
 * the same repo far better than it follows a generic instruction.
 *
 * Deterministic: ranking is by steps, then tokens, then card id, so the same
 * store yields the same exemplars (and the same prompt bytes).
 */
export interface Exemplar {
  cardId: string;
  cardClass: string;
  title: string;
  /** Compact trajectory: one line per step. */
  trajectory: string[];
  steps: number;
  tokens: number;
  date: string;
}

export interface CardClassInput {
  tier: string;
  title: string;
  scopeFiles: string[];
}

const KIND_WORDS: [RegExp, string][] = [
  [/\b(test|spec|coverage)\b/i, "test"],
  [/\b(fix|bug|repair|regression)\b/i, "fix"],
  [/\b(refactor|rename|extract|move)\b/i, "refactor"],
  [/\b(doc|readme|comment)\b/i, "docs"],
  [/\b(ui|view|component|page|css|style)\b/i, "ui"],
];

/**
 * A card's class: tier, dominant file kind and intent keyword, e.g.
 * `task:ts:fix`. Coarse on purpose, so classes fill up quickly.
 */
export function cardClassOf(card: CardClassInput): string {
  const exts = card.scopeFiles.map((f) => (/\.([a-z0-9]+)$/i.exec(f)?.[1] ?? "none").toLowerCase());
  const counts = new Map<string, number>();
  for (const e of exts) counts.set(e, (counts.get(e) ?? 0) + 1);
  const ext =
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "none";
  const kind = KIND_WORDS.find(([re]) => re.test(card.title))?.[1] ?? "feature";
  return `${card.tier}:${ext}:${kind}`;
}

/** A compact trajectory from the session's turn history. */
export function trajectoryFromTurns(turns: readonly TurnHistoryItem[], maxLines = 12): string[] {
  const lines = turns.map((t) => {
    const result = t.result.split("\n")[0]?.slice(0, 100) ?? "";
    return `${t.action}${result ? ` -> ${result}` : ""}`;
  });
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines - 1), `... ${lines.length - maxLines + 1} more steps`];
}

function rank(a: Exemplar, b: Exemplar): number {
  return a.steps - b.steps || a.tokens - b.tokens || a.cardId.localeCompare(b.cardId);
}

export class ExemplarStore {
  constructor(
    public readonly dir: string,
    private readonly keepPerClass = 5,
  ) {}

  private fileFor(cardClass: string): string {
    const safe = cardClass.replace(/[^\w.-]/g, "_");
    const hash = createHash("sha256").update(cardClass).digest("hex").slice(0, 8);
    return join(this.dir, `${safe}-${hash}.json`);
  }

  public list(cardClass: string): Exemplar[] {
    const path = this.fileFor(cardClass);
    if (!existsSync(path)) return [];
    return (JSON.parse(readFileSync(path, "utf8")) as Exemplar[]).sort(rank);
  }

  /**
   * Record a card that passed its gates. Keeps the best `keepPerClass` per
   * class; a newer run of the same card replaces its older one.
   */
  public record(exemplar: Exemplar): void {
    const current = this.list(exemplar.cardClass).filter((e) => e.cardId !== exemplar.cardId);
    const next = [...current, exemplar].sort(rank).slice(0, this.keepPerClass);
    mkdirSync(this.dir, { recursive: true });
    const path = this.fileFor(exemplar.cardClass);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, path);
  }

  /** The top `n` (default 2) for a class, excluding the card itself. */
  public topFor(cardClass: string, n = 2, excludeCardId?: string): Exemplar[] {
    return this.list(cardClass)
      .filter((e) => e.cardId !== excludeCardId)
      .slice(0, n);
  }
}

/** Render exemplars for the prompt's static zone within a token cap. */
export function renderExemplars(exemplars: readonly Exemplar[], maxTokens = 400): string {
  const blocks: string[] = [];
  for (const e of exemplars) {
    const block = `Example (${e.cardClass}, ${e.steps} steps): ${e.title}\n${e.trajectory
      .map((l, i) => `  ${i + 1}. ${l}`)
      .join("\n")}`;
    if (estimatePromptTokens([...blocks, block].join("\n\n")) > maxTokens) break;
    blocks.push(block);
  }
  return blocks.join("\n\n");
}
