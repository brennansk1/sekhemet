/**
 * Quick create from the board (dashboard §2.4.7, DB-P3-12): `c`, or the `+`
 * on a column, opens a form — a one-line title and an optional description —
 * that the server turns into a create proposal in Seshat's thread
 * (`POST /api/pm/create-card`, PM_CONTRACT §3). Applied, the proposal goes
 * through the planner pipeline (PM-P1-1) like any card Seshat drafts. No path
 * ends in "use the CLI".
 *
 * The browser loads the compiled module as `/app/lib/create.js`.
 */
import { type CardFilter, slug, termValues } from "./pm.js";

/** Every word of the form. */
export const QUICK_CREATE_COPY = {
  heading: "New card",
  title: "Title",
  description: "Description (optional)",
  descriptionHint: "What done looks like, in your words.",
  submit: "Propose card",
  cancel: "Cancel",
  note: "The planner checks its size, acceptance criteria and scope, and Seshat shows it as a proposal for you to apply.",
  sent: "Proposed in Seshat. Apply it to plan the card.",
  plus: "New card",
  plusTip: "New card. The planner decides where it starts.",
} as const;

export const TITLE_MAX = 300;
export const DESCRIPTION_MAX = 8000;

export interface QuickCreateInput {
  title: string;
  description?: string;
  /** The epic the board is filtered to, so the card lands under it. */
  epicId?: string;
  /** The project the board is scoped to (Team: the permission is checked there). */
  projectId?: string | null;
}

export type QuickCreateRequest =
  | {
      ok: true;
      body: { title: string; description?: string; epicId?: string; projectId?: string };
    }
  | { ok: false; error: string };

/** The request body the form sends, or why it cannot be sent, in words. */
export function quickCreateRequest(input: QuickCreateInput): QuickCreateRequest {
  const title = String(input.title ?? "").trim();
  if (!title) return { ok: false, error: "A card needs a title." };
  if (/[\r\n]/.test(title))
    return { ok: false, error: "Keep the title to one line; put the rest in the description." };
  if (title.length > TITLE_MAX)
    return { ok: false, error: `Keep the title under ${TITLE_MAX} characters.` };
  const description = String(input.description ?? "")
    .trim()
    .slice(0, DESCRIPTION_MAX);
  return {
    ok: true,
    body: {
      title,
      ...(description ? { description } : {}),
      ...(typeof input.epicId === "string" && input.epicId ? { epicId: input.epicId } : {}),
      ...(typeof input.projectId === "string" && input.projectId
        ? { projectId: input.projectId }
        : {}),
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
