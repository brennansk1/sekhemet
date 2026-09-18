import { describe, expect, it } from "vitest";
import {
  type BoardState,
  HISTORY_LIMIT,
  createInitialState,
  createStore,
  reduce,
  visibleCards,
} from "../src/store.js";
import type { CanvasCard } from "../src/tokens.js";

function card(id: string, overrides: Partial<CanvasCard> = {}): CanvasCard {
  return {
    id,
    title: `Card ${id}`,
    status: "ready",
    cardClass: "feature",
    difficulty: 2,
    stepsUsed: 0,
    stepBudget: 32,
    gates: {
      typecheck: "pending",
      lint: "pending",
      test: "pending",
      bounds: "pending",
      visual: "pending",
    },
    dependsOn: [],
    ...overrides,
  };
}

function seeded(): BoardState {
  return createInitialState([
    card("a", { title: "Parse gate output", cardClass: "feature" }),
    card("b", { title: "Fix WAL checkpoint", cardClass: "bug" }),
    card("c", { title: "Parse TOML playbook", cardClass: "chore" }),
  ]);
}

describe("basalt store: reducer", () => {
  it("creates an empty initial state", () => {
    expect(createInitialState()).toEqual({
      cards: [],
      filter: { text: "", cardClass: null },
      selectedId: null,
      history: [],
    });
  });

  it("adds a card and rejects a duplicate id", () => {
    const s = reduce(createInitialState(), { type: "addCard", card: card("x") });
    expect(s.cards.map((c) => c.id)).toEqual(["x"]);
    expect(() => reduce(s, { type: "addCard", card: card("x") })).toThrow("duplicate card: x");
  });

  it("moves a card without mutating the previous state", () => {
    const before = seeded();
    const snapshot = structuredClone(before);
    const after = reduce(before, { type: "moveCard", id: "b", status: "doing" });
    expect(after.cards.find((c) => c.id === "b")?.status).toBe("doing");
    expect(before).toEqual(snapshot);
    expect(after).not.toBe(before);
  });

  it("returns the identical state object when a move changes nothing", () => {
    const s = seeded();
    expect(reduce(s, { type: "moveCard", id: "a", status: "ready" })).toBe(s);
  });

  it("throws for an unknown card in moveCard, updateGate and select", () => {
    const s = seeded();
    expect(() => reduce(s, { type: "moveCard", id: "zz", status: "done" })).toThrow(
      "unknown card: zz",
    );
    expect(() => reduce(s, { type: "updateGate", id: "zz", gate: "lint", state: "pass" })).toThrow(
      "unknown card: zz",
    );
    expect(() => reduce(s, { type: "select", id: "zz" })).toThrow("unknown card: zz");
  });

  it("updates a single gate and leaves the others alone", () => {
    const s = reduce(seeded(), { type: "updateGate", id: "a", gate: "test", state: "fail" });
    expect(s.cards[0]?.gates).toEqual({
      typecheck: "pending",
      lint: "pending",
      test: "fail",
      bounds: "pending",
      visual: "pending",
    });
    expect(s.cards[1]?.gates.test).toBe("pending");
  });
});

describe("basalt store: selection history", () => {
  it("pushes the previous selection and walks back through it", () => {
    let s = seeded();
    s = reduce(s, { type: "select", id: "a" });
    s = reduce(s, { type: "select", id: "b" });
    s = reduce(s, { type: "select", id: "c" });
    expect(s.selectedId).toBe("c");
    expect(s.history).toEqual(["a", "b"]);
    s = reduce(s, { type: "back" });
    expect(s.selectedId).toBe("b");
    expect(s.history).toEqual(["a"]);
  });

  it("does not record a null selection or a repeated selection", () => {
    let s = seeded();
    s = reduce(s, { type: "select", id: "a" });
    s = reduce(s, { type: "select", id: "a" });
    s = reduce(s, { type: "select", id: null });
    expect(s.selectedId).toBeNull();
    expect(s.history).toEqual(["a"]);
  });

  it("keeps at most HISTORY_LIMIT entries, dropping the oldest", () => {
    expect(HISTORY_LIMIT).toBe(10);
    const ids = Array.from({ length: 13 }, (_, i) => `n${i}`);
    let s = createInitialState(ids.map((id) => card(id)));
    for (const id of ids) s = reduce(s, { type: "select", id });
    expect(s.history).toEqual(ids.slice(2, 12));
  });

  it("returns the identical state when back has no history", () => {
    const s = seeded();
    expect(reduce(s, { type: "back" })).toBe(s);
  });
});

describe("basalt store: filters", () => {
  it("filters by case-insensitive title substring", () => {
    const s = reduce(seeded(), { type: "setFilter", filter: { text: "  PARSE " } });
    expect(visibleCards(s).map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("combines the text filter with the class filter", () => {
    let s = reduce(seeded(), { type: "setFilter", filter: { text: "parse" } });
    s = reduce(s, { type: "setFilter", filter: { cardClass: "chore" } });
    expect(s.filter).toEqual({ text: "parse", cardClass: "chore" });
    expect(visibleCards(s).map((c) => c.id)).toEqual(["c"]);
  });

  it("shows everything with an empty filter and nothing for a non-matching one", () => {
    expect(visibleCards(seeded()).map((c) => c.id)).toEqual(["a", "b", "c"]);
    const none = reduce(seeded(), { type: "setFilter", filter: { text: "kubernetes" } });
    expect(visibleCards(none)).toEqual([]);
  });
});

describe("basalt store: subscriptions", () => {
  it("notifies subscribers with the new state and stops after unsubscribe", () => {
    const store = createStore(seeded());
    const seen: (string | null)[] = [];
    const unsubscribe = store.subscribe((s) => seen.push(s.selectedId));
    store.dispatch({ type: "select", id: "a" });
    unsubscribe();
    store.dispatch({ type: "select", id: "b" });
    expect(seen).toEqual(["a"]);
    expect(store.getState().selectedId).toBe("b");
  });

  it("does not notify when an action changes nothing", () => {
    const store = createStore(seeded());
    let calls = 0;
    store.subscribe(() => {
      calls++;
    });
    store.dispatch({ type: "moveCard", id: "a", status: "ready" });
    store.dispatch({ type: "back" });
    expect(calls).toBe(0);
  });

  it("leaves the state unchanged when dispatch throws", () => {
    const store = createStore(seeded());
    const before = store.getState();
    expect(() => store.dispatch({ type: "moveCard", id: "nope", status: "done" })).toThrow(
      "unknown card: nope",
    );
    expect(store.getState()).toBe(before);
  });
});
