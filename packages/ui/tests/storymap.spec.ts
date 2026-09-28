import { describe, expect, it } from "vitest";
import {
  REQUIREMENT_STATES,
  type StoryMapLike,
  requirementState,
  storyMapModel,
} from "../src/storymap.js";

/**
 * dashboard DB-P3-13 (§2.4.17): `#/board/map` lays the board's epics out as
 * the backbone in user order, the release slices as bands beneath with the
 * first — the walking skeleton — marked, and each requirement in its slice
 * with its state in words and its cards' tiles under it. Exact outputs; the
 * page (`web/map.js`) renders this and nothing else.
 */
const card = (id: string, status: string, epicId?: string, orderKey?: string, tier = "story") => ({
  id,
  status,
  tier,
  title: id,
  ...(epicId ? { epicId } : {}),
  ...(orderKey ? { orderKey } : {}),
});

// Three epics whose user order (orderKey) differs from the order the API lists them.
const epics = [
  { id: "ep_report", title: "Report the totals" },
  { id: "ep_import", title: "Import a statement" },
  { id: "ep_tag", title: "Tag the rows" },
];
const cards = [
  card("ep_import", "ready", undefined, "a0", "epic"),
  card("ep_tag", "ready", undefined, "a1", "epic"),
  card("ep_report", "ready", undefined, "a2", "epic"),
  card("c_parse", "done", "ep_import"),
  // The planner files a card under its epic by parent (planner persistPlan).
  { ...card("c_upload", "in_progress"), parentId: "ep_import" },
  card("c_tagrule", "ready", "ep_tag"),
  card("c_total", "backlog", "ep_report"),
  card("c_loose", "backlog", "ep_tag"),
  card("c_gone", "rejected", "ep_tag"),
];

const req = (
  id: string,
  state: string,
  cardIds: string[],
  extra: Record<string, unknown> = {},
) => ({
  id,
  version: 1,
  title: `Requirement ${id}`,
  mustHave: true,
  dependsOn: [],
  state,
  why: `why ${id}`,
  cards: cardIds.map((c) => ({ id: c, suspect: false })),
  tests: [],
  ...extra,
});

const map: StoryMapLike = {
  projectId: "proj_1",
  slices: [
    {
      id: "sl_1",
      title: "Import and total one statement",
      state: "unproven",
      provenLine: "1 of 3 requirements done",
      requirements: [
        req("REQ-1", "proven", ["c_parse", "c_upload"]),
        req("REQ-2", "planned", ["c_tagrule"]),
        req("REQ-3", "passing_strength_unmet", ["c_total"]),
      ],
    },
    {
      id: "sl_2",
      state: "unproven",
      provenLine: "0 of 1 requirement done",
      requirements: [req("REQ-4", "unplanned", []), req("REQ-5", "cut", [], { mustHave: false })],
    },
  ],
  unplanned: [{ id: "REQ-4" }],
  provenLine: "1 of 4 requirements done",
  projectDone: false,
};

describe("the story map (DB-P3-13)", () => {
  it("lays the epics out in backbone (user) order, never the API's list order", () => {
    const m = storyMapModel({ map, cards, epics });
    expect(m.backbone).toEqual([
      { id: "ep_import", title: "Import a statement" },
      { id: "ep_tag", title: "Tag the rows" },
      { id: "ep_report", title: "Report the totals" },
      { id: "", title: "No epic" },
    ]);
  });

  it("numbers the releases (DEC-31), and marks only the first as the walking skeleton", () => {
    const m = storyMapModel({ map, cards, epics });
    expect(m.bands.map((b) => [b.id, b.skeleton, b.heading])).toEqual([
      ["sl_1", true, "Release 1 · Import and total one statement"],
      ["sl_2", false, "Release 2"],
      ["untraced", false, "Not traced to a requirement"],
    ]);
    expect(m.bands[0]?.stateText).toBe("Not done yet · 1 of 3 requirements done");
  });

  it("puts each requirement under its cards' epic, with its state in words and its cards", () => {
    const m = storyMapModel({ map, cards, epics });
    const cell = (band: number, epic: string) =>
      m.bands[band]?.cells.find((c) => c.epicId === epic);
    expect(
      cell(0, "ep_import")?.requirements.map((r) => [r.id, r.label, r.cards.map((c) => c.id)]),
    ).toEqual([["REQ-1", "Done", ["c_parse", "c_upload"]]]);
    expect(cell(0, "ep_tag")?.requirements.map((r) => r.id)).toEqual(["REQ-2"]);
    expect(cell(0, "ep_report")?.requirements.map((r) => [r.id, r.label, r.tone])).toEqual([
      ["REQ-3", "Passing, strength unmet", "park"],
    ]);
    // A requirement with no cards has no epic yet: the last column.
    expect(cell(1, "")?.requirements.map((r) => [r.id, r.label])).toEqual([
      ["REQ-4", "Unplanned"],
      ["REQ-5", "Cut"],
    ]);
    // Every band has one cell per backbone column, in backbone order.
    for (const b of m.bands)
      expect(b.cells.map((c) => c.epicId)).toEqual(["ep_import", "ep_tag", "ep_report", ""]);
  });

  it("DEC-31: tags each requirement Must have, Should have or Could have, never Nice-to-have", () => {
    const m = storyMapModel({
      map: {
        ...map,
        slices: [
          {
            id: "sl_m",
            state: "unproven",
            provenLine: "",
            requirements: [
              req("REQ-1", "planned", []),
              req("REQ-2", "planned", [], { mustHave: false, kano: "performance" }),
              req("REQ-3", "planned", [], { mustHave: false, kano: "attractive" }),
              req("REQ-4", "planned", [], { mustHave: false }),
            ],
          },
        ],
      },
      cards,
      epics,
    });
    expect(m.bands[0]?.cells.flatMap((c) => c.requirements.map((r) => [r.id, r.moscow]))).toEqual([
      ["REQ-1", "Must have"],
      ["REQ-2", "Should have"],
      ["REQ-3", "Could have"],
      ["REQ-4", "Could have"],
    ]);
  });

  it("keeps the board's other cards under their epic in the last band, never a rejected one", () => {
    const m = storyMapModel({ map, cards, epics });
    const loose = m.bands[2]?.cells.map((c) => [c.epicId, c.cards.map((x) => x.id)]);
    expect(loose).toEqual([
      ["ep_import", []],
      ["ep_tag", ["c_loose"]],
      ["ep_report", []],
      ["", []],
    ]);
  });

  it("leaves out the No epic column when nothing belongs there", () => {
    const m = storyMapModel({
      map: { ...map, slices: [map.slices[0] as StoryMapLike["slices"][number]] },
      cards,
      epics,
    });
    expect(m.backbone.map((e) => e.id)).toEqual(["ep_import", "ep_tag", "ep_report"]);
  });

  it("names every requirement state with an icon and words, never colour alone", () => {
    expect(
      Object.fromEntries(
        Object.entries(REQUIREMENT_STATES).map(([k, v]) => [k, `${v.icon} ${v.label}`]),
      ),
    ).toEqual({
      proven: "check-circle Done",
      passing_strength_unmet: "ring Passing, strength unmet",
      failing: "alert Failing on main",
      suspect: "link Suspect",
      planned: "calendar Planned",
      unplanned: "minus Unplanned",
      cut: "x Cut",
    });
    expect(requirementState("something_new")).toEqual({
      label: "Something new",
      icon: "dot",
      tone: "",
    });
  });

  it("without an accepted brief, shows the epics and their cards and says why there are no releases", () => {
    const m = storyMapModel({ map: null, cards, epics });
    expect(m.note).toBe(
      "No brief has been accepted yet, so there are no releases. Issues are shown under their epics.",
    );
    expect(m.bands.map((b) => b.id)).toEqual(["untraced"]);
    expect(m.bands[0]?.heading).toBe("Issues by epic");
    expect(m.bands[0]?.cells.map((c) => c.cards.map((x) => x.id))).toEqual([
      ["c_parse", "c_upload"],
      ["c_tagrule", "c_loose"],
      ["c_total"],
    ]);
  });

  it("with no epics and no brief, says how to start", () => {
    const m = storyMapModel({ map: null, cards: [], epics: [] });
    expect(m.bands).toEqual([]);
    expect(m.empty).toBe(
      "No epics yet. Start a project with Seshat and its backbone appears here.",
    );
  });

  it("ties go to the earlier epic in the backbone", () => {
    const m = storyMapModel({
      map: {
        ...map,
        slices: [
          {
            id: "sl_1",
            state: "proven",
            provenLine: "1 of 1 requirement done",
            requirements: [req("REQ-9", "proven", ["c_total", "c_tagrule"])],
          },
        ],
      },
      cards,
      epics,
    });
    expect(m.bands[0]?.cells.find((c) => c.requirements.length)?.epicId).toBe("ep_tag");
    expect(m.bands[0]?.stateText).toBe(
      "Requirements done, waiting for a person to accept it · 1 of 1 requirement done",
    );
  });
});
