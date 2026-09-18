import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CardRecord, type TomlTable, type TomlValue, parseToml } from "@sekhemet/kernel";
import { prioritize } from "./prioritization.js";
import type { PrioritizationItem, PrioritizationModel, PriorityScore } from "./types.js";

/**
 * Ordering Ready by WSJF or RICE from `config.toml` (P3, design
 * "Prioritization"). The planner never invents weightings: the value,
 * time-criticality and risk inputs come from the project's
 * `[prioritization]` table, mapped from fields the board already has
 * (priority, due date, labels). With no table the order is unchanged and
 * the result says so.
 *
 *   [prioritization]
 *   model = "wsjf"                      # or "rice"
 *   value_by_priority = { "1" = 8, "2" = 5, "3" = 3, "4" = 1 }
 *   due_soon_days = 3
 *   due_soon_criticality = 5
 *   risk_by_label = { security = 5, spike = 3 }
 *   # RICE: reach_by_label, impact_by_priority, confidence (0..1)
 */
export interface PrioritizationConfig {
  model: PrioritizationModel;
  valueByPriority: Record<string, number>;
  defaultValue?: number;
  dueSoonDays?: number;
  dueSoonCriticality?: number;
  riskByLabel?: Record<string, number>;
  reachByLabel?: Record<string, number>;
  impactByPriority?: Record<string, number>;
  confidence?: number;
}

function numbers(v: TomlValue | undefined): Record<string, number> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === "number") out[k] = x;
  return out;
}

export function parsePrioritizationConfig(
  table: TomlTable | undefined,
): PrioritizationConfig | undefined {
  const t = table?.prioritization;
  if (!t || typeof t !== "object" || Array.isArray(t)) return undefined;
  const model = t.model === "rice" ? "rice" : "wsjf";
  const valueByPriority = numbers(t.value_by_priority);
  if (model === "wsjf" && !valueByPriority) return undefined;
  const opt = <K extends keyof PrioritizationConfig>(
    k: K,
    v: PrioritizationConfig[K] | undefined,
  ) => (v === undefined ? {} : { [k]: v });
  return {
    model,
    valueByPriority: valueByPriority ?? {},
    ...opt("defaultValue", typeof t.default_value === "number" ? t.default_value : undefined),
    ...opt("dueSoonDays", typeof t.due_soon_days === "number" ? t.due_soon_days : undefined),
    ...opt(
      "dueSoonCriticality",
      typeof t.due_soon_criticality === "number" ? t.due_soon_criticality : undefined,
    ),
    ...opt("riskByLabel", numbers(t.risk_by_label)),
    ...opt("reachByLabel", numbers(t.reach_by_label)),
    ...opt("impactByPriority", numbers(t.impact_by_priority)),
    ...opt("confidence", typeof t.confidence === "number" ? t.confidence : undefined),
  } as PrioritizationConfig;
}

/** Read `[prioritization]` from `<repo>/.sekhemet/config.toml`. */
export function loadPrioritizationConfig(repoPath: string): PrioritizationConfig | undefined {
  const path = join(repoPath, ".sekhemet", "config.toml");
  if (!existsSync(path)) return undefined;
  return parsePrioritizationConfig(parseToml(readFileSync(path, "utf8")));
}

export interface OrderedCards {
  cards: CardRecord[];
  model: PrioritizationModel | "unconfigured";
  scores: PriorityScore[];
  unscored: string[];
}

function itemFor(card: CardRecord, cfg: PrioritizationConfig, now: Date): PrioritizationItem {
  const labels = card.labels ?? [];
  const pri = String(card.priority ?? 0);
  if (cfg.model === "rice") {
    const reach = labels.reduce((a, l) => a + (cfg.reachByLabel?.[l] ?? 0), 0) || 1;
    const impact = cfg.impactByPriority?.[pri];
    if (impact === undefined) return { itemId: card.id };
    return {
      itemId: card.id,
      rice: {
        reach,
        impact,
        confidence: cfg.confidence ?? 0.8,
        effort: card.stepBudget * (card.difficulty ?? 5),
      },
    };
  }
  const value = cfg.valueByPriority[pri] ?? cfg.defaultValue;
  if (value === undefined) return { itemId: card.id };
  const due = card.dueDate ? Date.parse(card.dueDate) : Number.NaN;
  const soon =
    Number.isFinite(due) &&
    cfg.dueSoonDays !== undefined &&
    due - now.getTime() <= cfg.dueSoonDays * 86_400_000;
  return {
    itemId: card.id,
    wsjf: {
      userBusinessValue: value,
      timeCriticality: soon ? (cfg.dueSoonCriticality ?? 0) : 0,
      riskReduction: labels.reduce((a, l) => a + (cfg.riskByLabel?.[l] ?? 0), 0),
      estimatedSteps: card.stepBudget,
      difficulty: card.difficulty ?? 5,
    },
  };
}

/**
 * Order cards (the queue's Ready list) by the configured model. Unscored
 * cards keep their relative order after the scored ones.
 */
export function orderReadyCards(
  cards: readonly CardRecord[],
  cfg: PrioritizationConfig | undefined,
  now: Date = new Date(),
): OrderedCards {
  if (!cfg) return { cards: [...cards], model: "unconfigured", scores: [], unscored: [] };
  const result = prioritize(
    cards.map((c) => itemFor(c, cfg, now)),
    { model: cfg.model },
  );
  const byId = new Map(cards.map((c) => [c.id, c]));
  const ranked = result.ranked.map((r) => byId.get(r.itemId) as CardRecord);
  const unscored = cards.filter((c) => !result.ranked.some((r) => r.itemId === c.id));
  return {
    cards: [...ranked, ...unscored],
    model: cfg.model,
    scores: result.ranked,
    unscored: unscored.map((c) => c.id),
  };
}
