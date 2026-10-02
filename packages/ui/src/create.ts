/**
 * Quick create from the board (dashboard §2.4.7, DB-P3-12): `c`, or the `+`
 * on a column, opens a form — a one-line title and an optional description —
 * that the server turns into a create proposal in Seshat's thread
 * (`POST /api/pm/create-card`, PM_CONTRACT §3). Applied, the proposal goes
 * through the planner pipeline (PM-P1-1) like any card Seshat drafts. No path
 * ends in "use the CLI".
 *
 * NEW-dashboard-15 (§2.4.22): the form also offers the issue's type (DEC-31's
 * words), priority, labels, sprint and assignee, and for a Bug *What
 * happened*, *What you expected*, *Steps* and *Release*, each optional. They
 * travel in the proposal; the reproduction joins the issue's text, which is
 * the planner's input for the fix card (planner-pm §2.16).
 *
 * The browser loads the compiled module as `/app/lib/create.js`.
 */
import { type CardFilter, slug, termValues } from "./pm.js";

/** Every word of the form. */
export const QUICK_CREATE_COPY = {
  heading: "New issue",
  title: "Title",
  description: "Description (optional)",
  descriptionHint: "What done looks like, in your words.",
  submit: "Propose issue",
  cancel: "Cancel",
  note: "The planning model checks its size, acceptance criteria and scope, and Seshat shows it as a proposal for you to apply.",
  sent: "Proposed in Seshat. Apply it to plan the issue.",
  plus: "New issue",
  plusTip: "New issue. The planning model decides where it starts.",
  type: "Type",
  priority: "Priority",
  labels: "Labels",
  labelsHint: "Separate labels with commas.",
  sprint: "Sprint",
  noSprint: "No sprint",
  assignee: "Assignee",
  unassigned: "Unassigned",
  reproduction: "How to see the bug",
  reproductionHint:
    "Each is optional. The planning model turns them into the test that shows the bug.",
  happened: "What happened",
  expected: "What you expected",
  steps: "Steps",
  release: "Release",
  noRelease: "Not in a release",
} as const;

/** The types a person files (DEC-31); an epic is planned, not filed here. */
export const NEW_ISSUE_TYPES = ["story", "bug", "task", "spike"] as const;
export type NewIssueType = (typeof NEW_ISSUE_TYPES)[number];

/** A Bug's reproduction, each part optional (DB-N15-2). */
export interface Reproduction {
  happened?: string;
  expected?: string;
  steps?: string;
  release?: string;
}

const REPRO_PARTS = ["happened", "expected", "steps", "release"] as const;
const REPRO_MAX = 4000;

/** A Bug's reproduction as the issue's text, in the form's own words. */
export function reproductionText(r: Reproduction | undefined): string {
  if (!r) return "";
  const lines: string[] = [];
  if (r.happened) lines.push(`${QUICK_CREATE_COPY.happened}: ${r.happened}`);
  if (r.expected) lines.push(`${QUICK_CREATE_COPY.expected}: ${r.expected}`);
  if (r.steps) lines.push(`${QUICK_CREATE_COPY.steps}:\n${r.steps}`);
  if (r.release) lines.push(`${QUICK_CREATE_COPY.release}: ${r.release}`);
  return lines.join("\n");
}

/** The issue's text: the description, then a Bug's reproduction. */
export function issueSpec(description: string | undefined, r: Reproduction | undefined): string {
  return [description ?? "", reproductionText(r)].filter(Boolean).join("\n\n");
}

export const TITLE_MAX = 300;
export const DESCRIPTION_MAX = 8000;

export interface QuickCreateInput {
  title: string;
  description?: string;
  /** The epic the board is filtered to, so the card lands under it. */
  epicId?: string;
  /** The project the board is scoped to (Team: the permission is checked there). */
  projectId?: string | null;
  /** NEW-dashboard-15: the type and properties a person chose. */
  type?: string;
  priority?: number;
  labels?: string[];
  cycleId?: string;
  assignee?: string;
  reproduction?: Reproduction;
}

export interface QuickCreateBody {
  title: string;
  description?: string;
  epicId?: string;
  projectId?: string;
  type?: NewIssueType;
  priority?: number;
  labels?: string[];
  cycleId?: string;
  assignee?: string;
  reproduction?: Reproduction;
}

export type QuickCreateRequest = { ok: true; body: QuickCreateBody } | { ok: false; error: string };

/** The request body the form sends, or why it cannot be sent, in words. */
export function quickCreateRequest(input: QuickCreateInput): QuickCreateRequest {
  const title = String(input.title ?? "").trim();
  if (!title) return { ok: false, error: "An issue needs a title." };
  if (/[\r\n]/.test(title))
    return { ok: false, error: "Keep the title to one line; put the rest in the description." };
  if (title.length > TITLE_MAX)
    return { ok: false, error: `Keep the title under ${TITLE_MAX} characters.` };
  const description = String(input.description ?? "")
    .trim()
    .slice(0, DESCRIPTION_MAX);
  const type = input.type === undefined || input.type === "" ? undefined : input.type;
  if (type !== undefined && !(NEW_ISSUE_TYPES as readonly string[]).includes(type))
    return { ok: false, error: "Choose Story, Bug, Task or Spike." };
  const priority = input.priority;
  if (
    priority !== undefined &&
    (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 4)
  )
    return { ok: false, error: "Choose a priority from No priority to Urgent." };
  const labels = Array.isArray(input.labels)
    ? [...new Set(input.labels.map((l) => String(l).trim()).filter(Boolean))]
    : [];
  const text = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, REPRO_MAX) : undefined;
  const reproduction: Reproduction = {};
  if (type === "bug" && input.reproduction) {
    for (const k of REPRO_PARTS) {
      const v = text(input.reproduction[k]);
      if (v) reproduction[k] = v;
    }
  }
  const has = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  return {
    ok: true,
    body: {
      title,
      ...(description ? { description } : {}),
      ...(has(input.epicId) ? { epicId: input.epicId } : {}),
      ...(has(input.projectId) ? { projectId: input.projectId } : {}),
      ...(type ? { type: type as NewIssueType } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(labels.length ? { labels } : {}),
      ...(has(input.cycleId) ? { cycleId: input.cycleId } : {}),
      ...(has(input.assignee) ? { assignee: input.assignee } : {}),
      ...(Object.keys(reproduction).length ? { reproduction } : {}),
    },
  };
}

/**
 * The epic a filter names, when it names exactly one (`epic:<id or title>`):
 * a card created from a board filtered to an epic lands under it.
 */
export function epicFromFilter(
  filter: CardFilter,
  epics: readonly { id: string; title: string }[],
): string | undefined {
  const vals = termValues(filter, "epic");
  if (vals.length !== 1) return undefined;
  const v = vals[0] as string;
  return epics.find((e) => e.id.toLowerCase() === v || slug(e.title) === slug(v))?.id;
}
