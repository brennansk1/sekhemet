import { escapeHtml } from "./card_tile.js";

export interface PaletteItem {
  id: string;
  label: string;
  kind: "card" | "dependency" | "setting";
}

export interface PaletteState {
  open: boolean;
  query: string;
  items: PaletteItem[];
  results: PaletteItem[];
  activeIndex: number;
}

export type PaletteKey = "Mod+K" | "Escape" | "ArrowDown" | "ArrowUp" | "Enter";

const SEPARATORS = new Set([" ", "-", "_"]);

/** Greedy subsequence score: 1 per char, +2 consecutive, +3 at a word start; null if absent. */
export function fuzzyScore(query: string, label: string): number | null {
  const q = query.toLowerCase();
  const l = label.toLowerCase();
  let score = 0;
  let previous = -1;
  for (const ch of q) {
    const index = l.indexOf(ch, previous + 1);
    if (index < 0) return null;
    score += 1;
    if (previous >= 0 && index === previous + 1) score += 2;
    if (index === 0 || SEPARATORS.has(l[index - 1] ?? "")) score += 3;
    previous = index;
  }
  return score;
}

const byLabel = (a: PaletteItem, b: PaletteItem): number =>
  a.label < b.label ? -1 : a.label > b.label ? 1 : 0;

export function search(items: PaletteItem[], query: string): PaletteItem[] {
  if (query === "") return [...items].sort(byLabel);
  return items
    .map((item) => ({ item, score: fuzzyScore(query, item.label) }))
    .filter((x): x is { item: PaletteItem; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || byLabel(a.item, b.item))
    .map((x) => x.item);
}

export function createPalette(items: PaletteItem[]): PaletteState {
  return { open: false, query: "", items, results: search(items, ""), activeIndex: 0 };
}

export function setQuery(state: PaletteState, query: string): PaletteState {
  return { ...state, query, results: search(state.items, query), activeIndex: 0 };
}

export function paletteKey(
  state: PaletteState,
  key: PaletteKey,
): { state: PaletteState; chosen: PaletteItem | null } {
  if (key === "Mod+K") {
    return {
      state: state.open ? { ...state, open: false } : { ...setQuery(state, ""), open: true },
      chosen: null,
    };
  }
  if (!state.open) return { state, chosen: null };
  const count = state.results.length;
  switch (key) {
    case "Escape":
      return { state: { ...state, open: false }, chosen: null };
    case "ArrowDown":
    case "ArrowUp": {
      if (count === 0) return { state, chosen: null };
      const step = key === "ArrowDown" ? 1 : -1;
      return {
        state: { ...state, activeIndex: (state.activeIndex + step + count) % count },
        chosen: null,
      };
    }
    case "Enter": {
      const chosen = state.results[state.activeIndex];
      if (chosen === undefined) return { state, chosen: null };
      return { state: { ...state, open: false }, chosen };
    }
  }
}

export function renderPalette(state: PaletteState): string {
  if (!state.open) return "";
  const active = state.results[state.activeIndex];
  const activeAttr = active ? ` aria-activedescendant="opt-${escapeHtml(active.id)}"` : "";
  const options = state.results
    .map(
      (item, i) =>
        `<li id="opt-${escapeHtml(item.id)}" role="option" aria-selected="${i === state.activeIndex}" data-kind="${item.kind}">${escapeHtml(item.label)}</li>`,
    )
    .join("");
  return `<div class="palette" role="dialog" aria-modal="true" aria-label="Command palette"><input class="palette-input" role="combobox" aria-expanded="true" aria-controls="palette-list"${activeAttr} value="${escapeHtml(state.query)}"><ul id="palette-list" role="listbox">${options}</ul></div>`;
}
