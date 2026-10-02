/**
 * The story map as a pure model (dashboard §2.4.17, DB-P3-13): the board's
 * epics across as the backbone in user order (the epic cards' recorded
 * order), the release slices beneath as bands (*Release 1*, *Release 2*: DEC-31)
 * with the first — the walking skeleton, a word only Tips uses — marked, and each requirement in its slice under the epic that
 * holds its cards, with its state as an icon and words and its cards' tiles
 * beneath it. It is a view of the board's cards, not a separate hierarchy:
 * the cards no requirement traces to stay under their epic in a last band.
 * The slices and states are the requirement graph's (`GET /api/story-map`,
 * PM_CONTRACT §3, planner-pm §2.15); `web/map.js` renders this.
 *
 * The browser loads the compiled module as `/app/lib/storymap.js`.
 */
import type { IconName } from "./icons.js";
import { moscowOf } from "./status.js";
import { humanize, parseTitle } from "./vocabulary.js";

export interface RequirementLike {
  id: string;
  title?: string;
  mustHave: boolean;
  /** The internal priority class; shown only as its MoSCoW group (DEC-31). */
  kano?: string;
  state: string;
  why: string;
  cards: { id: string; status?: string; suspect: boolean }[];
}

export interface SliceLike {
  id: string;
  title?: string;
  state: "unproven" | "proven" | "done" | string;
  provenLine: string;
  requirements: RequirementLike[];
}

/** `GET /api/story-map`'s body, the fields the map reads. */
export interface StoryMapLike {
  projectId: string;
  slices: SliceLike[];
  unplanned: { id: string; title?: string }[];
  provenLine: string;
  projectDone: boolean;
}

export interface MapCardLike {
  id: string;
  status: string;
  tier?: string;
  epicId?: string;
  /** The planner files a card under its epic by parent (`persistPlan`). */
  parentId?: string | null;
  orderKey?: string;
}

export type RequirementTone = "pass" | "fail" | "park" | "";

/** NAMING's requirement states, each an icon and words (never colour alone). */
export const REQUIREMENT_STATES: Record<
  string,
  { label: string; icon: IconName; tone: RequirementTone }
> = {
  proven: { label: "Done", icon: "check-circle", tone: "pass" },
  passing_strength_unmet: { label: "Tests too weak", icon: "ring", tone: "park" },
  failing: { label: "Failing on main", icon: "alert", tone: "fail" },
  suspect: { label: "Needs re-checking", icon: "link", tone: "park" },
  planned: { label: "Planned", icon: "calendar", tone: "" },
  unplanned: { label: "Unplanned", icon: "minus", tone: "" },
  cut: { label: "Cut", icon: "x", tone: "" },
};

export function requirementState(state: string): {
  label: string;
  icon: IconName;
  tone: RequirementTone;
} {
  return REQUIREMENT_STATES[state] ?? { label: humanize(state), icon: "dot", tone: "" };
}

/** A release's state (DEC-31: a slice is a *release*, a proven must-have a requirement done). */
const SLICE_STATES: Record<string, string> = {
  unproven: "Not done yet",
  proven: "Requirements done, waiting for a person to accept it",
  done: "Done",
};

export interface MapRequirement<C> {
  id: string;
  title: string;
  mustHave: boolean;
  /** DEC-31: Must have, Should have or Could have (the project documents' rule). */
  moscow: "Must have" | "Should have" | "Could have";
  state: string;
  label: string;
  icon: IconName;
  tone: RequirementTone;
  why: string;
  /** The board's cards that trace to it, in the board's order. */
  cards: C[];
}

export interface MapCell<C> {
  /** The backbone column: an epic's id, or "" for *No epic*. */
  epicId: string;
  requirements: MapRequirement<C>[];
  /** Cards no requirement traces to (the last band only). */
  cards: C[];
}

export interface MapBand<C> {
  id: string;
  heading: string;
  /** The first slice: the thinnest journey through the whole backbone. */
  skeleton: boolean;
  /** The slice's state and its proven line; empty for the last band. */
  stateText: string;
  cells: MapCell<C>[];
}

export interface StoryMapView<C> {
  backbone: { id: string; title: string }[];
  bands: MapBand<C>[];
  /** Why there are no slices, when no brief has been accepted. */
  note?: string;
  /** Nothing to lay out yet, and how to start. */
  empty?: string;
  provenLine?: string;
}

const CONTAINERS = new Set(["epic", "initiative"]);
const UNTRACED = "untraced";

function byOrderKey(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a < b ? -1 : 1;
}

/** The story map of the board's cards (DB-P3-13). */
export function storyMapModel<C extends MapCardLike>(input: {
  map: StoryMapLike | null | undefined;
  cards: C[];
  epics: readonly { id: string; title: string }[];
}): StoryMapView<C> {
  const byId = new Map(input.cards.map((c) => [c.id, c] as const));
  // Backbone: the epics in user order — their cards' recorded order — the
  // API's list order breaking ties.
  const epics = input.epics
    .map((e, i) => ({ e, i, key: byId.get(e.id)?.orderKey }))
    .sort((a, b) => byOrderKey(a.key, b.key) || a.i - b.i)
    .map(({ e }) => ({ id: e.id, title: parseTitle(e.title).title }));
  const rank = new Map(epics.map((e, i) => [e.id, i] as const));
  // A card's epic: its epic field, else the epic it was planned under.
  const epicIdOf = (c: C | undefined): string | undefined =>
    c?.epicId ?? (c?.parentId && rank.has(c.parentId) ? c.parentId : undefined);
  const work = input.cards.filter((c) => !CONTAINERS.has(c.tier ?? "") && c.status !== "rejected");
  const slices = input.map?.slices ?? [];

  if (epics.length === 0 && slices.length === 0) {
    return {
      backbone: [],
      bands: [],
      empty: "No epics yet. Start a project with Seshat and its backbone appears here.",
    };
  }

  const epicOf = (r: RequirementLike): string => {
    const count = new Map<string, number>();
    for (const l of r.cards) {
      const e = epicIdOf(byId.get(l.id));
      if (e && rank.has(e)) count.set(e, (count.get(e) ?? 0) + 1);
    }
    let best = "";
    for (const [e, n] of count) {
      const b = count.get(best) ?? 0;
      if (n > b || (n === b && (rank.get(e) ?? 0) < (rank.get(best) ?? Number.POSITIVE_INFINITY)))
        best = e;
    }
    return best;
  };

  const traced = new Set(
    slices.flatMap((s) => s.requirements.flatMap((r) => r.cards.map((c) => c.id))),
  );
  const loose = work.filter((c) => !traced.has(c.id));
  const placed = slices.map((s) => s.requirements.map((r) => ({ r, epicId: epicOf(r) })));
  const needsNone =
    placed.some((reqs) => reqs.some((p) => p.epicId === "")) ||
    loose.some((c) => !rank.has(epicIdOf(c) ?? ""));
  const backbone = needsNone ? [...epics, { id: "", title: "No epic" }] : epics;

  const bands: MapBand<C>[] = slices.map((s, i) => ({
    id: s.id,
    // DEC-31: releases, numbered; *walking skeleton* is said only inside Tips.
    heading: `Release ${i + 1}${s.title ? ` · ${s.title}` : ""}`,
    skeleton: i === 0,
    stateText: `${SLICE_STATES[s.state] ?? humanize(s.state)} · ${s.provenLine}`,
    cells: backbone.map((e) => ({
      epicId: e.id,
      requirements: (placed[i] ?? [])
        .filter((p) => p.epicId === e.id)
        .map(({ r }) => {
          const st = requirementState(r.state);
          return {
            id: r.id,
            title: r.title ?? r.id,
            mustHave: r.mustHave,
            moscow: moscowOf(r),
            state: r.state,
            label: st.label,
            icon: st.icon,
            tone: st.tone,
            why: r.why,
            cards: r.cards.map((l) => byId.get(l.id)).filter((c): c is C => c !== undefined),
          };
        }),
      cards: [],
    })),
  }));
  bands.push({
    id: UNTRACED,
    heading: slices.length ? "Not traced to a requirement" : "Issues by epic",
    skeleton: false,
    stateText: "",
    cells: backbone.map((e) => ({
      epicId: e.id,
      requirements: [],
      cards: loose.filter((c) =>
        e.id === "" ? !rank.has(epicIdOf(c) ?? "") : epicIdOf(c) === e.id,
      ),
    })),
  });
  return {
    backbone,
    bands,
    ...(input.map
      ? { provenLine: input.map.provenLine }
      : {
          note: "No brief has been accepted yet, so there are no releases. Issues are shown under their epics.",
        }),
  };
}
