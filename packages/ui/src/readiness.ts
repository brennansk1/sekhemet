/**
 * The Definition of done and *Ready to start*, readable (dashboard
 * NEW-dashboard-14, DB-N14-1, DB-N14-2; §2.16.5, §2.6; FINDINGS PRC-12,
 * DESIGN_GAPS b19): what the checks, the depth profile and the Accept rule
 * already enforce, and the kernel's entry conditions for building, in words a
 * team and a junior can read. They state what is enforced and enforce
 * nothing new (DB-N14-3). The browser loads the compiled module as
 * `/app/lib/readiness.js`; its runtime imports stay relative.
 */
import { gateLabel } from "./vocabulary.js";

export interface DoneFacts {
  /** `gates.toml`'s checks: their ids, and whether each blocks. */
  checks: { id: string; blocking: boolean }[];
  /** The project's depth profile (design-stage §2.8). */
  profile: "prototype" | "internal tool" | "production" | "regulated" | string;
  setup: "solo" | "team";
  /** The Accept rule's people by name; null in Solo, whose one person accepts. */
  accepters: string[] | null;
}

const APPROVES: Record<string, string> = {
  prototype: "A person approves each issue's acceptance criteria before it is built.",
  "internal tool": "A person approves each issue's acceptance criteria before it is built.",
  production:
    "A person approves each issue's acceptance criteria, and the example tables of every Must have requirement, before it is built.",
  regulated:
    "A person approves each issue's acceptance criteria, and every acceptance-test file, before it is built.",
};

/** The Definition of done (DB-N14-1): one sentence, then what each part means here. */
export function definitionOfDone(f: DoneFacts): {
  sentence: string;
  rows: { label: string; text: string }[];
} {
  const names = (list: { id: string }[]) =>
    [...new Set(list.map((c) => gateLabel(c.id)))].join(", ");
  const blocking = f.checks.filter((c) => c.blocking);
  const advisory = f.checks.filter((c) => !c.blocking);
  const who = f.setup === "team" ? "a person the Accept rule names accepts it" : "you accept it";
  const sentence = `An issue is done when its checks pass — ${names(blocking) || "none are set yet"} — its tests meet the strength rule, and ${who}.`;
  const advisoryText = advisory.length
    ? ` Advisory, reported but not blocking: ${names(advisory)}.`
    : "";
  const strength =
    f.profile === "prototype"
      ? "Weak tests are reported, not blocked (the project's Type: prototype). A failing test always blocks."
      : `A test that could not fail does not count: weak tests block the issue (the project's Type: ${f.profile}).`;
  const accepts =
    f.setup !== "team" || !f.accepters
      ? "You."
      : f.accepters.length
        ? `${f.accepters.join(" or ")}, as the project's Accept rule names.`
        : "No one yet: the project's Accept rule names no Member.";
  return {
    sentence,
    rows: [
      {
        label: "Checks that must pass",
        text: `${names(blocking) || "None yet: add checks to .sekhemet/gates.toml"}.${advisoryText}`,
      },
      { label: "Test strength", text: strength },
      {
        label: "Who approves what is built",
        text: APPROVES[f.profile] ?? APPROVES["internal tool"] ?? "",
      },
      { label: "Who accepts", text: accepts },
    ],
  };
}

/** One entry condition as the server reads it (`GET /api/cards/:id/readiness`). */
export interface ReadinessFact {
  id: "dependencies" | "criteria" | "approval" | "suspect" | "scope" | "small" | string;
  met: boolean;
  reason?: string;
}

const CONDITION_LABELS: Record<string, string> = {
  dependencies: "Every issue it depends on is done",
  criteria: "Acceptance criteria are written",
  approval: "Its acceptance criteria are approved",
  suspect: "No requirement it traces to changed since it was planned",
  scope: "The files it may change are declared",
  small: "Small enough to build in one pass",
};

/** *Ready to start* (DB-N14-2): each condition *Met* or *Not met* with its reason. */
export function readyToStart(facts: readonly ReadinessFact[]): {
  summary: string;
  ready: boolean;
  rows: { label: string; met: boolean; state: string; reason: string }[];
} {
  const met = facts.filter((f) => f.met).length;
  return {
    summary: `${met} of ${facts.length} met`,
    ready: met === facts.length,
    rows: facts.map((f) => ({
      label: CONDITION_LABELS[f.id] ?? f.id,
      met: f.met,
      state: f.met ? "Met" : "Not met",
      reason: f.met ? "" : (f.reason ?? ""),
    })),
  };
}
