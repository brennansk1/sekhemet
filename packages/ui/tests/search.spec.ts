import { describe, expect, it } from "vitest";
import { UI_LIB_MODULES } from "../src/index.js";
import { matchCard, parseQuery } from "../src/pm.js";
import { HIT_END, HIT_START, searchHits, searchWords } from "../src/search.js";

// Dashboard NEW-dashboard-12 (§2.4.21; DB-N12-1): the palette's *Issues*
// group from `GET /api/search` rows — key, title, project, its column and
// the matched words in context — and the query box's free words.

const row = (over: Record<string, unknown> = {}) => ({
  id: "card_a1b2c3d4",
  title: "Export loans as CSV",
  status: "done",
  field: "comment",
  snippet: `…the ${HIT_START}overdue${HIT_END} loans are left out…`,
  project: { id: "proj_a", name: "Alpha" },
  ...over,
});

describe("the palette's Issues from a search (DB-N12-1)", () => {
  it("names the key, title, project, column and where the words matched", () => {
    const [hit] = searchHits([row()], "overdue");
    expect(hit).toEqual({
      id: "card_a1b2c3d4",
      key: "a1b2c3d4",
      title: "Export loans as CSV",
      project: { id: "proj_a", name: "Alpha" },
      column: "Done",
      where: "in a comment",
      context: [
        { text: "…the ", hit: false },
        { text: "overdue", hit: true },
        { text: " loans are left out…", hit: false },
      ],
    });
  });

  it("includes Won't do issues, in that column's words", () => {
    expect(searchHits([row({ status: "rejected" })], "overdue")[0]?.column).toBe("Won't do");
  });

  it("says each field in the page's words", () => {
    const where = (field: string) => searchHits([row({ field })], "x")[0]?.where;
    expect(where("title")).toBe("in the title");
    expect(where("key")).toBe("in the key");
    expect(where("description")).toBe("in the description");
    expect(where("criteria")).toBe("in the acceptance criteria");
    expect(where("comment")).toBe("in a comment");
  });

  it("shows nothing for a query with no free words", () => {
    expect(searchHits([row()], "")).toEqual([]);
    expect(searchHits([row()], "label:api")).toEqual([]);
  });
});

describe("the free words of a query", () => {
  it("are the words left once the field terms are read", () => {
    expect(searchWords("label:api overdue loans")).toEqual(["overdue", "loans"]);
    expect(searchWords('"exact phrase" -priority:low')).toEqual(["exact", "phrase"]);
    expect(searchWords("is:open")).toEqual([]);
  });
});

describe("the query box matches what the search found (DB-N12-1)", () => {
  const card = { id: "card_x", status: "ready", title: "Round totals", display: { shortId: "x" } };
  it("a card the server's search found matches its words though its title lacks them", () => {
    const f = parseQuery("overdue");
    expect(matchCard(card, f)).toBe(false);
    expect(matchCard(card, f, { textHits: new Set(["card_x"]) })).toBe(true);
    expect(matchCard(card, f, { textHits: new Set(["card_y"]) })).toBe(false);
    // The title still matches by itself.
    expect(matchCard(card, parseQuery("round"), { textHits: new Set() })).toBe(true);
  });
});

it("ships to the browser as lib/search.js", () => {
  expect(UI_LIB_MODULES).toContain("search.js");
});
