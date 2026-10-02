import { describe, expect, it } from "vitest";
import { type PmCardLike, formatQuery, matchCard, parseQuery } from "../src/index.js";

/**
 * dashboard DB-N5-5 (DB-T2): a team filters by who owns a card and who builds
 * it. `owner:` is the accountable person (a principal, `@me` the viewer),
 * `delegate:` who does the work (`worker`, or a person), and `assignee:`
 * means the owner.
 */
const cards: PmCardLike[] = [
  {
    id: "c_mine_worker",
    owner: "p_me",
    delegate: { kind: "worker" },
    display: { ownerName: "Jane Doe" },
  },
  {
    id: "c_sam_person",
    owner: "p_sam",
    delegate: { kind: "person", id: "p_me" },
    display: { ownerName: "Sam Ortiz", delegateName: "Jane Doe" },
  },
  { id: "c_nobody" },
  // A record from before K-N6-6 still holding the legacy assignee string.
  { id: "c_legacy", assignee: "worker" },
];
const ctx = { me: "p_me" };
const ids = (q: string) => cards.filter((c) => matchCard(c, parseQuery(q), ctx)).map((c) => c.id);

describe("owner: and delegate: queries (DB-N5-5)", () => {
  it("delegate:worker finds the cards the Worker builds", () => {
    expect(ids("delegate:worker")).toEqual(["c_mine_worker", "c_legacy"]);
  });

  it("owner:@me finds the viewer's cards; delegate:@me the cards delegated to them", () => {
    expect(ids("owner:@me")).toEqual(["c_mine_worker"]);
    expect(ids("delegate:@me")).toEqual(["c_sam_person"]);
  });

  it("assignee: means the owner", () => {
    expect(parseQuery("assignee:@me")).toEqual(parseQuery("owner:@me"));
    expect(formatQuery(parseQuery("owner:@me"))).toBe("assignee:@me");
    expect(ids("assignee:@me")).toEqual(["c_mine_worker"]);
  });

  it("matches a person by principal or name, and none by absence", () => {
    expect(ids('owner:"sam ortiz"')).toEqual(["c_sam_person"]);
    expect(ids("owner:p_sam")).toEqual(["c_sam_person"]);
    expect(ids("owner:none")).toEqual(["c_nobody", "c_legacy"]);
    expect(ids("delegate:none")).toEqual(["c_nobody"]);
    expect(ids("-delegate:worker")).toEqual(["c_sam_person", "c_nobody"]);
  });

  it("without a known viewer, @me matches nothing", () => {
    expect(cards.filter((c) => matchCard(c, parseQuery("owner:@me"), {})).map((c) => c.id)).toEqual(
      [],
    );
  });
});
