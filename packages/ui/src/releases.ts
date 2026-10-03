/**
 * Status's *Next release* and *Retrospective* sections (planner-pm §2.15
 * item 8a and §2.7 item 4, NEW-planner-pm-11, -12; review-git §2.6 item 8,
 * NEW-review-git-7): every word, from what `GET /api/projects/:id/releases/next`
 * and `GET /api/projects/:id/retrospectives` return. Pure: the browser
 * imports the compiled module as `/app/lib/releases.js`, with no runtime
 * imports. DEC-31's and DEC-52's words: issues, the Agent, Triage.
 */

export type ChangelogCategory =
  | "Added"
  | "Changed"
  | "Deprecated"
  | "Removed"
  | "Fixed"
  | "Security";

export interface PushFailureLike {
  ref: string;
  sha?: string;
  remote: string;
  result?: string;
  reason?: string;
  at?: string;
}

export interface NextReleaseLike {
  project: string;
  lastTag: { tag: string; sha: string; at: string } | null;
  issues: { id: string; title: string; category: ChangelogCategory | string }[];
  proposed: {
    version: string;
    tag: string;
    issues: string[];
    notes: string;
    changelog: string;
    sha: string;
    at: string;
  } | null;
  push: { on: boolean; remote: string; failed: PushFailureLike[] };
}

export interface RetroActionLike {
  kind: "playbook" | "review_capacity" | "issue" | string;
  text: string;
  why: string;
  href?: string;
  title?: string;
}

export interface RetroStateLike {
  due: {
    sprint?: { id: string; name: string };
    from: string;
    to: string;
    reason: string;
  } | null;
  draft: {
    wentWell: string[];
    slowed: string[];
    actions: RetroActionLike[];
    text: string;
    basedOn: string;
  } | null;
  posted: {
    id: string;
    sprint?: string;
    from: string;
    to: string;
    text: string;
    by: string;
    at: string;
  }[];
}

export const RELEASES_COPY = {
  nextHeading: "Next release",
  retroHeading: "Retrospective",
  propose: "Propose release",
  tag: (tag: string) => `Tag ${tag}`,
  since: (count: number, tag: string | undefined) =>
    `${count} ${count === 1 ? "issue" : "issues"} accepted ${tag ? `since ${tag}` : "so far, outside a planned release"}.`,
  nothingSince: (tag: string) =>
    `Nothing accepted since ${tag}. Issues accepted outside a planned release collect here.`,
  nothingYet: "Nothing accepted yet. Issues accepted outside a planned release collect here.",
  proposedHeading: (version: string) =>
    `Release ${version} is proposed. Read the notes, then tag it.`,
  notes: "Release notes",
  changelog: "Changelog",
  mayNot: "The people the project's Accept rule names propose and tag its releases.",
  pushOn: (remote: string) => `Accepted work and tags are pushed to ${remote}.`,
  pushOff: "Push to remote is off: tags and accepted work stay in this server's repository.",
  proposedToast: (version: string) =>
    `Release ${version} proposed. Nothing is tagged until you tag it.`,
  taggedToast: (tag: string) => `Tagged ${tag}.`,
  retroLede: (title: string) =>
    `Seshat drafted the retrospective for ${title} from the Activity log. Nothing changes until someone applies an action.`,
  wentWell: "What went well",
  slowed: "What slowed the team",
  actions: "Proposed actions",
  editPost: "Edit and post",
  post: "Post retrospective",
  editorLabel: "Retrospective",
  editorHint:
    "Edit it as the team agreed. Posting records it in the Activity log and lists it here.",
  posted: "Retrospective posted.",
  filed: "Filed in Triage.",
  needsText: "A retrospective needs its text.",
  empty:
    "No retrospective yet. Seshat drafts one from the Activity log when a sprint completes, or after every few accepted issues in a project without sprints.",
  openPlaybook: "Open the Playbook",
  openConfiguration: "Open review capacity",
  fileIssue: "File it in Triage",
} as const;

/** A failed push as a person reads it (RG-N7-3): what, where, why, and that it is tried again. */
export function pushFailureLine(f: Pick<PushFailureLike, "ref" | "remote" | "reason">): string {
  const what = f.ref.startsWith("refs/tags/")
    ? `The tag ${f.ref.slice("refs/tags/".length)}`
    : f.ref.replace(/^refs\/heads\//, "");
  const why = (f.reason ?? "the remote refused it").trim();
  return `${what} was not pushed to ${f.remote}: ${/[.!?]$/.test(why) ? why : `${why}.`} It is pushed again at the next Accept or tag.`;
}

export interface NextReleaseView {
  lede: string;
  issues: { id: string; title: string; category: string }[];
  proposed: { heading: string; notes: string; changelog: string } | null;
  action: { act: "release-propose" | "release-tag"; label: string; disabled?: string } | null;
  push: string;
  failed: string[];
}

/**
 * Next release (PM-N12-1..4): its issues, and *Propose release* only when it
 * holds one; a proposed release shows its notes and changelog with *Tag*.
 * `mayAct` is whether the viewer is one the Accept rule names.
 */
export function nextReleaseView(n: NextReleaseLike, mayAct: boolean): NextReleaseView {
  const tag = n.lastTag?.tag;
  const lede = n.issues.length
    ? RELEASES_COPY.since(n.issues.length, tag)
    : tag
      ? RELEASES_COPY.nothingSince(tag)
      : RELEASES_COPY.nothingYet;
  const base = n.proposed
    ? { act: "release-tag" as const, label: RELEASES_COPY.tag(n.proposed.tag) }
    : n.issues.length
      ? { act: "release-propose" as const, label: RELEASES_COPY.propose }
      : null;
  return {
    lede,
    issues: n.issues.map((i) => ({ id: i.id, title: i.title, category: i.category })),
    proposed: n.proposed
      ? {
          heading: RELEASES_COPY.proposedHeading(n.proposed.version),
          notes: n.proposed.notes,
          changelog: n.proposed.changelog,
        }
      : null,
    action: base ? (mayAct ? base : { ...base, disabled: RELEASES_COPY.mayNot }) : null,
    push: n.push.on ? RELEASES_COPY.pushOn(n.push.remote) : RELEASES_COPY.pushOff,
    failed: n.push.failed.map(pushFailureLine),
  };
}

/** "Oct 2": a day as a person reads it, the same in every time zone. */
function day(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export interface RetroView {
  draft: {
    lede: string;
    groups: { heading: string; items: string[] }[];
    actions: {
      text: string;
      why: string;
      label: string;
      href?: string;
      act?: "retro-issue";
      title?: string;
    }[];
    basedOn: string;
    text: string;
    sprint?: string;
    from: string;
    to: string;
  } | null;
  posted: { id: string; title: string; byline: string; text: string }[];
  empty: string | null;
}

/**
 * The retrospective (PM-N11-1..3): Seshat's draft when one is due, each
 * proposed action with where a person applies it, and the posted ones,
 * newest first. `sprints` names a posted one's sprint.
 */
export function retroView(s: RetroStateLike, sprints: Record<string, string> = {}): RetroView {
  const d = s.draft && s.due ? s.draft : null;
  const due = s.due;
  const draft =
    d && due
      ? {
          lede: RELEASES_COPY.retroLede(
            due.sprint?.name ?? (d.text.split("\n")[0] ?? "").replace(/^Retrospective: /, ""),
          ),
          groups: [
            { heading: RELEASES_COPY.wentWell, items: d.wentWell },
            { heading: RELEASES_COPY.slowed, items: d.slowed },
          ],
          actions: d.actions.map((a) =>
            a.kind === "issue" && a.title
              ? {
                  text: a.text,
                  why: a.why,
                  act: "retro-issue" as const,
                  title: a.title,
                  label: RELEASES_COPY.fileIssue,
                }
              : {
                  text: a.text,
                  why: a.why,
                  ...(a.href ? { href: a.href } : {}),
                  label:
                    a.kind === "review_capacity"
                      ? RELEASES_COPY.openConfiguration
                      : RELEASES_COPY.openPlaybook,
                },
          ),
          basedOn: d.basedOn,
          text: d.text,
          ...(due.sprint ? { sprint: due.sprint.id } : {}),
          from: due.from,
          to: due.to,
        }
      : null;
  const posted = [...s.posted]
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((p) => ({
      id: p.id,
      title:
        p.sprint && sprints[p.sprint] ? `Retrospective: ${sprints[p.sprint]}` : "Retrospective",
      byline: `Posted by ${p.by} · ${day(p.at)}`,
      text: p.text,
    }));
  return { draft, posted, empty: draft || posted.length ? null : RELEASES_COPY.empty };
}
