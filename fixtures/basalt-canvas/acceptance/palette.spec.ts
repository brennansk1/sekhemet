import { describe, expect, it } from "vitest";
import {
  type PaletteItem,
  type PaletteKey,
  type PaletteState,
  createPalette,
  fuzzyScore,
  paletteKey,
  renderPalette,
  search,
  setQuery,
} from "../src/palette.js";

const ITEMS: PaletteItem[] = [
  { id: "c4", label: "Toggle theme", kind: "setting" },
  { id: "c2", label: "Git settings", kind: "setting" },
  { id: "c1", label: "Gate strip", kind: "card" },
  { id: "c3", label: "Graph layout", kind: "dependency" },
];

function press(state: PaletteState, ...keys: PaletteKey[]): PaletteState {
  let s = state;
  for (const key of keys) s = paletteKey(s, key).state;
  return s;
}

describe("basalt palette: fuzzy scoring", () => {
  it("scores 1 per matched char, +2 when consecutive, +3 at a word start", () => {
    expect(fuzzyScore("abc", "abc")).toBe(10);
    expect(fuzzyScore("gt", "gate strip")).toBe(5);
    expect(fuzzyScore("gs", "gate strip")).toBe(8);
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("GS", "Gate Strip")).toBe(8);
  });

  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyScore("xyz", "gate strip")).toBeNull();
    expect(fuzzyScore("pg", "gate strip")).toBeNull();
    expect(fuzzyScore("gates", "gate")).toBeNull();
  });

  it("returns 0 for an empty query", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("treats -, _ and space as word separators", () => {
    expect(fuzzyScore("b", "a-b")).toBe(4);
    expect(fuzzyScore("b", "a_b")).toBe(4);
    expect(fuzzyScore("b", "a.b")).toBe(1);
  });
});

describe("basalt palette: search", () => {
  it("returns every item sorted by label for an empty query", () => {
    expect(search(ITEMS, "").map((i) => i.id)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  it("sorts by score descending, then label ascending", () => {
    expect(search(ITEMS, "gs").map((i) => i.id)).toEqual(["c1", "c2"]);
    expect(search(ITEMS, "gl").map((i) => i.id)).toEqual(["c3", "c4"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(search(ITEMS, "zzz")).toEqual([]);
  });
});

describe("basalt palette: keyboard", () => {
  it("starts closed and opens with Mod+K showing every item", () => {
    const closed = createPalette(ITEMS);
    expect(closed.open).toBe(false);
    const open = press(closed, "Mod+K");
    expect(open.open).toBe(true);
    expect(open.query).toBe("");
    expect(open.activeIndex).toBe(0);
    expect(open.results.map((i) => i.id)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  it("toggles closed with Mod+K and closes with Escape", () => {
    const open = press(createPalette(ITEMS), "Mod+K");
    expect(press(open, "Mod+K").open).toBe(false);
    expect(press(open, "Escape").open).toBe(false);
  });

  it("resets the query when reopened", () => {
    const typed = setQuery(press(createPalette(ITEMS), "Mod+K"), "gs");
    const reopened = press(typed, "Escape", "Mod+K");
    expect(reopened.query).toBe("");
    expect(reopened.results.length).toBe(4);
  });

  it("moves the active item with the arrows, wrapping at both ends", () => {
    const open = press(createPalette(ITEMS), "Mod+K");
    expect(press(open, "ArrowDown", "ArrowDown").activeIndex).toBe(2);
    expect(press(open, "ArrowUp").activeIndex).toBe(3);
    expect(press(open, "ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown").activeIndex).toBe(0);
  });

  it("resets the active item when the query changes", () => {
    const moved = press(press(createPalette(ITEMS), "Mod+K"), "ArrowDown", "ArrowDown");
    const typed = setQuery(moved, "gs");
    expect(typed.activeIndex).toBe(0);
    expect(typed.results.map((i) => i.id)).toEqual(["c1", "c2"]);
  });

  it("chooses the active result with Enter and closes", () => {
    const s = press(setQuery(press(createPalette(ITEMS), "Mod+K"), "gs"), "ArrowDown");
    const { state, chosen } = paletteKey(s, "Enter");
    expect(chosen).toEqual({ id: "c2", label: "Git settings", kind: "setting" });
    expect(state.open).toBe(false);
  });

  it("chooses nothing and stays open when Enter is pressed with no results", () => {
    const s = setQuery(press(createPalette(ITEMS), "Mod+K"), "zzz");
    const down = press(s, "ArrowDown");
    expect(down.activeIndex).toBe(0);
    const { state, chosen } = paletteKey(down, "Enter");
    expect(chosen).toBeNull();
    expect(state.open).toBe(true);
  });

  it("ignores every key except Mod+K while closed", () => {
    const closed = createPalette(ITEMS);
    for (const key of ["Escape", "ArrowDown", "ArrowUp", "Enter"] as PaletteKey[]) {
      const { state, chosen } = paletteKey(closed, key);
      expect(state).toEqual(closed);
      expect(chosen).toBeNull();
    }
  });
});

describe("basalt palette: accessible markup", () => {
  it("renders nothing while closed", () => {
    expect(renderPalette(createPalette(ITEMS))).toBe("");
  });

  it("renders a modal dialog with a combobox and listbox", () => {
    const s = press(setQuery(press(createPalette(ITEMS), "Mod+K"), "gs"), "ArrowDown");
    expect(renderPalette(s)).toBe(
      '<div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">' +
        '<input class="palette-input" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant="opt-c2" value="gs">' +
        '<ul id="palette-list" role="listbox">' +
        '<li id="opt-c1" role="option" aria-selected="false" data-kind="card">Gate strip</li>' +
        '<li id="opt-c2" role="option" aria-selected="true" data-kind="setting">Git settings</li>' +
        "</ul></div>",
    );
  });

  it("omits aria-activedescendant when there are no results and escapes the query", () => {
    const s = setQuery(press(createPalette(ITEMS), "Mod+K"), '"><img>');
    const html = renderPalette(s);
    expect(html.includes("aria-activedescendant")).toBe(false);
    expect(html.includes('value="&quot;&gt;&lt;img&gt;"')).toBe(true);
    expect(html.includes('<ul id="palette-list" role="listbox"></ul>')).toBe(true);
  });
});
