import { WIP_LIMITS, renderBoard } from "./board.js";
import { type DagLayout, layoutDag } from "./dag_layout.js";
import { type BoardState, reduce, visibleCards } from "./store.js";
import type { CanvasCard, CardStatus, ThemeTokens } from "./tokens.js";

function luminance(color: string): number {
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) throw new Error(`invalid color: ${color}`);
  const channel = (at: number): number => {
    const c = Number.parseInt(color.slice(at, at + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2.1 contrast ratio, rounded to two decimals. */
export function contrastRatio(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  return Math.round(ratio * 100) / 100;
}

export interface ContrastCheck {
  pair: string;
  ratio: number;
  required: number;
  pass: boolean;
}

const PAIRS: [keyof ThemeTokens, keyof ThemeTokens, number][] = [
  ["textPrimary", "bgBase", 4.5],
  ["textPrimary", "bgSurface", 4.5],
  ["textPrimary", "bgRaised", 4.5],
  ["textPrimary", "bgOverlay", 4.5],
  ["textMuted", "bgBase", 4.5],
  ["textMuted", "bgSurface", 4.5],
  ["textMuted", "bgRaised", 4.5],
  ["gold", "bgRaised", 3],
  ["nile", "bgRaised", 3],
  ["ochre", "bgRaised", 3],
  ["lapis", "bgRaised", 3],
];

export function auditTheme(theme: ThemeTokens): ContrastCheck[] {
  return PAIRS.map(([fg, bg, required]) => {
    const ratio = contrastRatio(theme[fg], theme[bg]);
    return { pair: `${fg}/${bg}`, ratio, required, pass: ratio >= required };
  });
}

export interface DragResult {
  state: BoardState;
  ok: boolean;
  reason: string | null;
}

export function dragCard(state: BoardState, id: string, to: CardStatus): DragResult {
  const card = state.cards.find((c) => c.id === id);
  if (!card) return { state, ok: false, reason: `unknown card: ${id}` };
  if (card.status === to) return { state, ok: true, reason: null };
  const limit = WIP_LIMITS[to];
  if (limit !== null && state.cards.filter((c) => c.status === to).length >= limit) {
    return { state, ok: false, reason: `WIP limit reached for ${to}` };
  }
  if (to === "doing") {
    const blocker = card.dependsOn.find(
      (dep) => !state.cards.some((c) => c.id === dep && c.status === "done"),
    );
    if (blocker !== undefined) return { state, ok: false, reason: `blocked by ${blocker}` };
  }
  return { state: reduce(state, { type: "moveCard", id, status: to }), ok: true, reason: null };
}

export function clickCard(state: BoardState, id: string): BoardState {
  return reduce(state, { type: "select", id: state.selectedId === id ? null : id });
}

export function buildDag(cards: CanvasCard[]): DagLayout {
  return layoutDag(
    cards.map((c) => c.id),
    cards.flatMap((c) => c.dependsOn.map((dep) => ({ from: dep, to: c.id }))),
  );
}

export function renderApp(state: BoardState): string {
  return `<main class="app">${renderBoard(visibleCards(state), state.selectedId)}</main>`;
}
