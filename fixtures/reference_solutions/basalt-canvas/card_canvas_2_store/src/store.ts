import type { CanvasCard, CardClass, CardStatus, GateName, GateState } from "./tokens.js";

export interface BoardFilter {
  text: string;
  cardClass: CardClass | null;
}

export interface BoardState {
  cards: CanvasCard[];
  filter: BoardFilter;
  selectedId: string | null;
  history: string[];
}

export type Action =
  | { type: "addCard"; card: CanvasCard }
  | { type: "moveCard"; id: string; status: CardStatus }
  | { type: "updateGate"; id: string; gate: GateName; state: GateState }
  | { type: "select"; id: string | null }
  | { type: "back" }
  | { type: "setFilter"; filter: Partial<BoardFilter> };

export const HISTORY_LIMIT = 10;

export function createInitialState(cards: CanvasCard[] = []): BoardState {
  return {
    cards: [...cards],
    filter: { text: "", cardClass: null },
    selectedId: null,
    history: [],
  };
}

function indexOf(state: BoardState, id: string): number {
  const at = state.cards.findIndex((c) => c.id === id);
  if (at < 0) throw new Error(`unknown card: ${id}`);
  return at;
}

function replaceCard(state: BoardState, at: number, card: CanvasCard): BoardState {
  const cards = [...state.cards];
  cards[at] = card;
  return { ...state, cards };
}

/** Pure; returns the same object when nothing changes. */
export function reduce(state: BoardState, action: Action): BoardState {
  switch (action.type) {
    case "addCard":
      if (state.cards.some((c) => c.id === action.card.id)) {
        throw new Error(`duplicate card: ${action.card.id}`);
      }
      return { ...state, cards: [...state.cards, action.card] };
    case "moveCard": {
      const at = indexOf(state, action.id);
      const card = state.cards[at] as CanvasCard;
      if (card.status === action.status) return state;
      return replaceCard(state, at, { ...card, status: action.status });
    }
    case "updateGate": {
      const at = indexOf(state, action.id);
      const card = state.cards[at] as CanvasCard;
      if (card.gates[action.gate] === action.state) return state;
      return replaceCard(state, at, {
        ...card,
        gates: { ...card.gates, [action.gate]: action.state },
      });
    }
    case "select": {
      if (action.id !== null) indexOf(state, action.id);
      if (action.id === state.selectedId) return state;
      const history =
        state.selectedId === null
          ? state.history
          : [...state.history, state.selectedId].slice(-HISTORY_LIMIT);
      return { ...state, selectedId: action.id, history };
    }
    case "back": {
      if (state.history.length === 0) return state;
      const history = state.history.slice(0, -1);
      return { ...state, selectedId: state.history[state.history.length - 1] ?? null, history };
    }
    case "setFilter":
      return { ...state, filter: { ...state.filter, ...action.filter } };
  }
}

export function visibleCards(state: BoardState): CanvasCard[] {
  const text = state.filter.text.trim().toLowerCase();
  return state.cards.filter(
    (c) =>
      c.title.toLowerCase().includes(text) &&
      (state.filter.cardClass === null || c.cardClass === state.filter.cardClass),
  );
}

export interface Store {
  getState(): BoardState;
  dispatch(action: Action): void;
  subscribe(listener: (state: BoardState) => void): () => void;
}

export function createStore(initial: BoardState): Store {
  let state = initial;
  const listeners = new Set<(state: BoardState) => void>();
  return {
    getState: () => state,
    dispatch: (action) => {
      const next = reduce(state, action);
      if (next === state) return;
      state = next;
      for (const listener of [...listeners]) listener(state);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
