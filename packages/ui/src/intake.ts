/**
 * Intake and triage (dashboard §2.4.19, NEW-dashboard-10; DEC-51; FINDINGS
 * PRC-01). A Backlog issue filed by a person below Member, by an integration
 * or by an import, that no Member has triaged, waits in the built-in
 * *Triage* view (`is:untriaged`), oldest first. Each row offers four
 * decisions, one action and one key each: *Accept into Backlog* — never the
 * bare *Accept*, which is a person's acceptance of finished work and merges
 * code — *Decline*, *Duplicate of…* and *Snooze*. The server derives each
 * issue's `display.intake` from the ledger; this module decides the rows,
 * their words and the lead's Inbox line, for the page and the server alike.
 *
 * The browser loads the compiled module as `/app/lib/intake.js`.
 */
import { shortId } from "./vocabulary.js";

/** Where an untriaged issue came from. */
export type IntakeSource = "stakeholder" | "viewer" | "integration" | "import";

/** What the server says about an untriaged issue, on `display.intake`. */
export interface IntakeFacts {
  from: IntakeSource;
  /** The person who filed it, by name, or the integration's name. */
  by?: string;
  /** When it was filed. */
  at: string;
}

export interface TriageCardLike {
  id: string;
  status?: string;
  title?: string;
  display?: { shortId?: string; title?: string; intake?: IntakeFacts };
}

export interface TriageRow {
  id: string;
  key: string;
  title: string;
  /** Who filed it, in words. */
  from: string;
  at: string;
}

export type TriageDecision = "accept" | "decline" | "duplicate" | "snooze";

/** The four decisions, in the order and with the keys a row offers them (DB-N10-3). */
export const TRIAGE_DECISIONS: readonly { id: TriageDecision; label: string; key: string }[] = [
  { id: "accept", label: "Accept into Backlog", key: "1" },
  { id: "decline", label: "Decline", key: "2" },
  { id: "duplicate", label: "Duplicate of…", key: "3" },
  { id: "snooze", label: "Snooze", key: "H" },
];

/** The decision a key press names on a focused row, if any. */
export function triageDecisionFor(key: string): TriageDecision | undefined {
  const k = key.length === 1 ? key.toUpperCase() : key;
  return TRIAGE_DECISIONS.find((d) => d.key === k)?.id;
}

/** Every word the Triage view says (DEC-31, DEC-52). */
export const TRIAGE_COPY = {
  heading: "Triage",
  view: "Triage",
  intro:
    "Issues filed by Stakeholders, Viewers, integrations and imports wait here until a Member decides. Accepting one into Backlog keeps it in Backlog for planning; it merges nothing.",
  empty: "Nothing to triage.",
  emptyDetail: "New issues from Stakeholders, integrations and imports appear here, oldest first.",
  suggestions: "Seshat suggests. Nothing changes until you apply it.",
  declineHeading: "Decline: why won't this be done?",
  declinePlaceholder: "e.g. Out of scope for this release",
  declineNeedsReason: "Say why, so the person who filed it knows.",
  duplicateHeading: "Duplicate of which issue?",
  snoozeHeading: "Snooze until",
  accepted: (key: string) => `${key} accepted into Backlog.`,
  declined: (key: string) => `${key} declined: Won't do.`,
  duplicated: (key: string, of: string) => `${key} marked a duplicate of ${of}.`,
  snoozed: (key: string, until: string) => `${key} snoozed until ${until}.`,
  memberDecides: "A Member triages. You can read what waits here.",
  /** The New issue form, for a person who files for triage (DB-N10-1). */
  filedForTriage:
    "A Member triages what you file. Until then it waits in Backlog with the project lead as its assignee.",
  /** The New issue form's button for a person who files for triage. */
  fileSubmit: "File issue",
  filed: "Filed. It waits in Triage for a Member.",
  /** The board's level note, for a person who files but does not create (DB-N10-1). */
  filesForTriage: "New issue files one for a Member to triage.",
  /** The Inbox pane's button on the lead's Triage count. */
  open: "Open Triage",
} as const;

const LEVEL_WORDS: Record<"stakeholder" | "viewer", string> = {
  stakeholder: "a Stakeholder",
  viewer: "a Viewer",
};

/** Who filed an untriaged issue, in plain words. */
export function intakeFromLine(i: IntakeFacts): string {
  switch (i.from) {
    case "stakeholder":
    case "viewer":
      return i.by ? `Filed by ${i.by}, ${LEVEL_WORDS[i.from]}` : `Filed by ${LEVEL_WORDS[i.from]}`;
    case "integration":
      return i.by ? `From ${i.by}` : "From an integration";
    case "import":
      return "Imported";
  }
}

/**
 * The Triage view's rows and count (DB-N10-2, -4): the untriaged Backlog
 * issues, oldest first. Hidden in Solo, where one person files everything.
 */
export function triageModel(input: {
  cards: readonly TriageCardLike[];
  setup: "solo" | "team" | string | undefined;
}): { shown: boolean; count: number; rows: TriageRow[] } {
  if (input.setup !== "team") return { shown: false, count: 0, rows: [] };
  const rows = input.cards
    .filter((c) => c.status === "backlog" && c.display?.intake)
    .map((c) => {
      const intake = c.display?.intake as IntakeFacts;
      return {
        id: c.id,
        key: c.display?.shortId ?? shortId(c.id),
        title: c.display?.title ?? c.title ?? c.id,
        from: intakeFromLine(intake),
        at: intake.at,
      };
    })
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return { shown: true, count: rows.length, rows };
}

/** The lead's Inbox line under *Needs you* (DB-N10-4). */
export function triageInboxLine(count: number): string {
  return count === 1 ? "1 issue waits in Triage." : `${count} issues wait in Triage.`;
}

/** The times *Snooze* offers, each at 9:00 local time. */
export function snoozeChoices(now: Date): { label: string; until: string }[] {
  const at = (days: number) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 9, 0, 0, 0);
    return d.toISOString();
  };
  return [
    { label: "Tomorrow", until: at(1) },
    { label: "In 3 days", until: at(3) },
    { label: "Next week", until: at(7) },
  ];
}
