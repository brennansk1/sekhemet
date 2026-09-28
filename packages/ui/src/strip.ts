/**
 * Evidence that stays readable (dashboard NEW-dashboard-1, §2.5.3).
 *
 * The gates strip's model: one segment per gate up to six gates; past six,
 * one segment per check family with its count (*Security 4/4*), failing
 * groups first, each failing group naming the gates that failed and holding
 * the rest behind *+n passed* (DB-N1-1). And the issue's one state badge,
 * which never puts a failure mark on a stage's name (DB-N1-3).
 *
 * Pure and free of runtime imports beyond the other published lib modules:
 * the browser loads it as `/app/lib/strip.js`.
 */
import { GATE_FAMILIES, type GateFamily, gateFamilyOf } from "./learn.js";
import { type GateState, type GateSummary, type Tone, boardColumnLabel } from "./vocabulary.js";

/** Up to this many gates the strip shows one segment each (§2.5.3: "more than six gates"). */
export const STRIP_GROUP_AFTER = 6;

/** A family's name on the strip, short enough for a segment (the Tips name them in full). */
export const CHECK_FAMILY_LABELS: Record<GateFamily | "other", string> = {
  static: "Static",
  functional: "Tests",
  robustness: "Mutation",
  security: "Security",
  visual: "Visual",
  hygiene: "Size and integrity",
  other: "Other",
};

export interface StripSegment {
  /** The gate's id, or `family:<family>` for a group. */
  key: string;
  family?: GateFamily | "other";
  label: string;
  /** The worst state of its gates. */
  state: GateState;
  gates: GateSummary[];
  /** `2/3` for a group; empty for one gate. */
  count: string;
  /** The gates that did not pass, by their own names. */
  failing: GateSummary[];
  /** `+2 passed` for a group holding passed gates behind a failure. */
  overflow: string;
}

export interface StripModel {
  grouped: boolean;
  segments: StripSegment[];
}

/** Worst first: a group is as bad as its worst gate. */
const SEVERITY: GateState[] = ["fail", "unavailable", "running", "not_run", "skipped", "pass"];

function worst(gates: GateSummary[]): GateState {
  let best = SEVERITY.length - 1;
  for (const g of gates) best = Math.min(best, SEVERITY.indexOf(g.state));
  return SEVERITY[best] ?? "pass";
}

/**
 * The strip for a card's gates (from `gateSummary`, in execution order).
 * `layers` maps a gate id to its `gates.toml` layer (`/api/gates`); a gate
 * with none is placed by its id or label (`gateFamilyOf`).
 */
export function gateStripModel(
  gates: GateSummary[],
  layers: Record<string, string | undefined> = {},
): StripModel {
  if (gates.length <= STRIP_GROUP_AFTER) {
    return {
      grouped: false,
      segments: gates.map((g) => ({
        key: g.id,
        label: g.label,
        state: g.state,
        gates: [g],
        count: "",
        failing: g.state === "pass" ? [] : [g],
        overflow: "",
      })),
    };
  }
  const byFamily = new Map<GateFamily | "other", GateSummary[]>();
  for (const g of gates) {
    const family = gateFamilyOf(g.id, layers[g.id]) ?? gateFamilyOf(g.label) ?? "other";
    byFamily.set(family, [...(byFamily.get(family) ?? []), g]);
  }
  const order = [...GATE_FAMILIES, "other"] as const;
  const segments: StripSegment[] = order
    .filter((f) => byFamily.has(f))
    .map((family) => {
      const members = byFamily.get(family) ?? [];
      const passed = members.filter((g) => g.state === "pass").length;
      const failing = members.filter((g) => g.state !== "pass");
      return {
        key: `family:${family}`,
        family,
        label: CHECK_FAMILY_LABELS[family],
        state: worst(members),
        gates: members,
        count: `${passed}/${members.length}`,
        failing,
        overflow: failing.length > 0 && passed > 0 ? `+${passed} passed` : "",
      };
    });
  // Failing groups first, worst first; the rest keep the family order.
  const rank = (s: StripSegment) =>
    s.state === "pass" ? SEVERITY.length : SEVERITY.indexOf(s.state);
  const sorted = segments
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
    .map((x) => x.s);
  return { grouped: true, segments: sorted };
}

/**
 * The issue's state badge (the issue page's pill, DB-N1-3): the board
 * column's name with its tone, except where the tone would put a failure
 * mark on a stage — then the badge says the state itself.
 */
export function stateBadge(
  status: string,
  tone: Tone,
): { text: string; tone: Tone; mark?: "planning" } {
  if (status === "planning" && tone === "blocked")
    return { text: "Needs a new plan", tone, mark: "planning" };
  if (tone === "fail") {
    return {
      text: status === "ready" || status === "backlog" ? "Will retry" : "Checks failed",
      tone,
    };
  }
  return { text: boardColumnLabel(status), tone };
}
