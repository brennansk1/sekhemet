import { type CanvasCard, GATE_ORDER, type GateName, type GateState } from "./tokens.js";

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

export function budgetPercent(stepsUsed: number, stepBudget: number): number {
  if (stepBudget <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round((stepsUsed / stepBudget) * 100)));
}

export function renderGateStrip(gates: Record<GateName, GateState>): string {
  const boxes = GATE_ORDER.map(
    (name) =>
      `<span class="gate gate-${gates[name]}" data-gate="${name}" title="${name}: ${gates[name]}"></span>`,
  ).join("");
  return `<div class="gate-strip">${boxes}</div>`;
}

export function renderCardTile(card: CanvasCard, options: { selected?: boolean } = {}): string {
  const classes = options.selected === true ? "card-tile is-selected" : "card-tile";
  const barClass = card.stepsUsed > card.stepBudget ? "budget-bar is-over" : "budget-bar";
  return [
    `<article class="${classes}" data-id="${escapeHtml(card.id)}" data-status="${card.status}">`,
    `<span class="chip chip-${card.cardClass}">${card.cardClass}</span>`,
    `<span class="difficulty">D${card.difficulty}</span>`,
    `<h3 class="title">${escapeHtml(card.title)}</h3>`,
    `<div class="budget"><div class="${barClass}" style="width: ${budgetPercent(card.stepsUsed, card.stepBudget)}%"></div>`,
    `<span class="budget-label">${card.stepsUsed}/${card.stepBudget}</span></div>`,
    renderGateStrip(card.gates),
    "</article>",
  ].join("");
}
