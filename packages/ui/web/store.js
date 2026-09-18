// One store for the page. Views subscribe and patch only what changed; nothing
// re-renders wholesale on an SSE frame.

const listeners = new Set();

export const store = {
  state: {
    /** connecting | live | reconnecting | offline */
    connection: "connecting",
    reconnectingSince: 0,
    offlineSince: 0,
    loaded: false,
    cards: [],
    wipLimits: {},
    backpressureActive: false,
    verification: null,
    meta: null,
    gates: null,
    doctor: null,
    queue: null,
    /** The card the keyboard is on, shared by board, peek and palette. */
    focusedId: null,
    /** Cards selected with `x`. */
    selected: new Set(),
    /** Card ids whose column changed in the last 10s: `just now`. */
    moved: new Map(),
    route: { name: "", params: [] },
    now: Date.now(),
  },
  set(patch) {
    Object.assign(this.state, patch);
    for (const fn of listeners) fn(this.state, patch);
  },
  on(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  card(id) {
    return this.state.cards.find((c) => c.id === id);
  },
};

/** Accept is only safe on an intact ledger, online, with triage enabled. */
export function triageBlocker(state) {
  if (state.meta && state.meta.triage === false) return "readonly";
  if (state.connection === "offline") return "offline";
  return null;
}

export function ledgerAltered(state) {
  return Boolean(state.verification && state.verification.valid === false);
}
