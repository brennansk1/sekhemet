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
    playbook: null,
    /** Latest memory sample from the stream's `machine` event. */
    machine: null,
    /** Ledger events carried by the most recent stream frame. */
    feed: [],
    /** The card the keyboard is on, shared by board, peek and palette. */
    focusedId: null,
    /** Cards selected with `x`. */
    selected: new Set(),
    /** Card ids whose column changed in the last 10s: `just now`. */
    moved: new Map(),
    /** Epics and cycles from /api/board (PM_CONTRACT §3); empty until served. */
    epics: [],
    cycles: [],
    /**
     * The project manager (PM_DESIGN §2). `available` is null until the first
     * thread fetch, false when the server has no /api/pm endpoints.
     */
    pm: {
      available: null,
      messages: [],
      status: { phase: "idle" },
      error: null,
      /** Client-side first sighting of each phase, for timers without `since`. */
      phaseSeenAt: {},
      /** A Worker phase was seen for the pending reply. */
      workerInvolved: false,
      step: undefined,
    },
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
