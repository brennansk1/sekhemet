/**
 * The start page's live draft (design-stage §2.11, NEW-design-stage-7), as a
 * pure model. *New project* opens `#/projects/new`: the conversation with
 * Seshat on the left and, on the right, the draft Seshat has made so far —
 * the `start_project` proposal group (planner-pm §2.9) — as tabs: Brief (its
 * filled sections only), Requirements (by priority, with Accept, Remove and
 * the release line) and Plan (the releases with their forecast ranges and
 * issue counts). *Review plan* is offered once a plan exists, with a one-line
 * summary. Narrower than 768 px the draft is a tab beside the conversation.
 *
 * It reads the group and the person's choices so far and writes nothing:
 * the draft is a proposal, and nothing exists before approval (DS-N7-5).
 * The choices have Review plan's shape (`review_plan_view.js`), so what the
 * person accepts here is what Review plan opens with.
 * `web/start.js` renders this; the browser loads it as `/app/lib/start.js`.
 */
import { plural } from "./vocabulary.js";

/** The start page's route (dashboard §3). */
export const START_ROUTE = "#/projects/new";

/** Below this width the draft is a tab beside the conversation (DS-N7-2). */
export const START_TABS_BELOW = 768;

/** Every word of the start page (DEC-31, DEC-52). */
export const START_COPY = {
  title: "New project",
  crumb: "Projects",
  heading: "Draft · updates as you talk",
  conversation: "Conversation",
  draft: "Draft",
  nothingYet:
    "Nothing drafted yet. Say what you want built and who it is for: Seshat drafts the brief, the requirements and a plan here as you talk.",
  reviewPlan: "Review plan",
  reviewPlanWaits: "Review plan opens once Seshat has drafted a plan.",
  requirementsHint: "Accept what belongs in the project. Move the line to choose what ships first.",
  lineLabel: "Release 1 ends here",
  createdNothing: "Nothing is created until the plan is approved.",
  intro:
    "Tell me what you want to build and who it is for, in a sentence or two. I draft a brief, the requirements and a plan beside this conversation, and ask at most two questions. Nothing is created until you approve the plan.",
  composerPlaceholder: "What do you want to build, and who is it for?",
  /** DS-N7-1: a folder that already holds a project says so before any drafting. */
  blockedTitle: "This folder already holds a project",
  planNext: "Plan the next piece of work",
  planNextPrefill: "/plan ",
  backToProjects: "Back to Projects",
  /** DS-N8-1: the folder a new project's approval creates (DEC-57). */
  willCreate: (folder: string) => `Will be created in ${folder}`,
  changeFolder: "Change folder",
  folderLabel: "Folder for the new project",
  useFolder: "Use this folder",
  /** DS-N8-3: a refused folder's own project, in this workspace. */
  openIt: "Open it",
  /** DS-N8-2, TEAM-56: the take-over of a repository on this server. */
  addRepository: "Add an existing repository",
  repositoryLabel: "Path to the repository on this server",
  takeItOver: "Take it over",
  repositoryHint:
    "Seshat reads it as it is first. Nothing in it runs until it is trusted, and it becomes a project when you approve its plan.",
  takingOver: "Taking over the repository…",
  /** TEAM-57, DB-N26-1: who approves a new project when this person may not create one. */
  sendsForApproval:
    "An Admin or a project lead approves a new project: Review plan ends in Send for approval.",
} as const;

// --- Inputs: the parts of the group the draft reads (pm/pipeline.ts) --------

export interface StartCandidate {
  key: string;
  title: string;
  priority: "must" | "should" | "could";
  /** The person's request, or a step a user takes that Seshat found uncovered. */
  source: "request" | "walkthrough";
  accepted: boolean;
}

export interface StartRelease {
  name: string;
  candidates: string[];
  /** Issues it is expected to take. */
  cards: number;
  forecast?: { p50Days: number; p85Days: number; samples: number };
}

/** The part of a `start_project` proposal's group (`ProjectGroup`) the draft shows. */
export interface StartGroup {
  version: 1;
  sentence: string;
  brief: Record<BriefField, string[]>;
  candidates: StartCandidate[];
  releaseLine: number;
  releases: StartRelease[];
}

/** The person's choices so far, in Review plan's shape (`reviewState`). */
export interface StartChoices {
  accept: string[];
  remove: string[];
  line: number;
}

type BriefField =
  | "problem"
  | "outcome"
  | "users"
  | "notInScope"
  | "constraints"
  | "priorArt"
  | "riskiest"
  | "doneMeans";

/** §2.9.6's sections, in Review plan's order. */
const BRIEF_SECTION_LABELS: [BriefField, string][] = [
  ["problem", "Problem"],
  ["outcome", "Outcome"],
  ["users", "Users"],
  ["notInScope", "Not in scope"],
  ["constraints", "Constraints"],
  ["priorArt", "Prior art"],
  ["riskiest", "Riskiest assumption"],
  ["doneMeans", "Done means"],
];

const PRIORITIES: ["must" | "should" | "could", string][] = [
  ["must", "Must have"],
  ["should", "Should have"],
  ["could", "Could have"],
];

// --- The draft ---------------------------------------------------------------

interface ProposalLike {
  id?: string;
  kind?: string;
  state?: string;
  patch?: { group?: { version?: number } } | null;
}

interface MessageLike {
  proposals?: ProposalLike[] | null;
}

/**
 * The draft the page shows: the latest open `start_project` proposal that
 * carries its group. Seshat drafts again as the person talks, so the newest
 * is the draft; an applied or discarded one is no longer a draft.
 */
export function startDraftOf(messages: readonly MessageLike[] | undefined): ProposalLike | null {
  for (const m of [...(messages ?? [])].reverse()) {
    for (const p of [...(m.proposals ?? [])].reverse()) {
      if (p.kind === "start_project" && p.state === "open" && p.patch?.group?.version === 1)
        return p;
    }
  }
  return null;
}

/**
 * DS-N7-1: the start page's own conversation. In a workspace that already
 * holds a project, the thread's earlier messages are that project's: none of
 * them belongs here, and none of its proposals may be applied from here (the
 * project they would change is not the one being started). Shown: the
 * messages since the page opened (`openedAt`, ms), or — opened again while a
 * draft is open — since the person's words that led to the draft; and of
 * their proposals, only the start draft's.
 */
export function startConversationOf<M extends MessageLike & { role?: string; createdAt?: string }>(
  messages: readonly M[] | undefined,
  openedAt: number,
): M[] {
  const all = [...(messages ?? [])];
  const draft = startDraftOf(all);
  let from = all.findIndex((m) => (Date.parse(m.createdAt ?? "") || 0) >= openedAt);
  if (from < 0) from = all.length;
  if (draft) {
    let at = all.findIndex((m) => (m.proposals ?? []).includes(draft as never));
    while (at > 0 && all[at - 1]?.role === "user") at -= 1;
    if (at >= 0 && at < from) from = at;
  }
  return all
    .slice(from)
    .map((m) =>
      m.proposals?.some((p) => p.kind !== "start_project")
        ? { ...m, proposals: m.proposals.filter((p) => p.kind === "start_project") }
        : m,
    );
}

export interface StartTab {
  id: "brief" | "requirements" | "plan";
  label: string;
  /** Requirements only: how many are in the plan. */
  count?: number;
}

export interface StartRequirement {
  key: string;
  title: string;
  /** Where it came from, in words. */
  from: string;
  /** Seshat's own suggestion, shown as AI (DEC-36). */
  ai: boolean;
  state: "Accepted" | "Removed" | "Proposed";
}

export interface StartPlanRow {
  name: string;
  holds: string;
  issues: string;
  when: string;
}

export interface StartDraftView {
  heading: string;
  /** Side by side, or the draft as a tab beside the conversation (DS-N7-2). */
  layout: "split" | "tabs";
  /** The page's own tabs when `layout` is "tabs". */
  pageTabs: string[];
  /** Before Seshat has drafted anything: one line, and no part. */
  empty: string | null;
  tabs: StartTab[];
  brief: { label: string; lines: string[] }[];
  requirementsHint: string;
  requirements: { label: string; items: StartRequirement[] }[];
  /** The kept requirement the release line sits under. */
  lineAfter: string | null;
  lineLabel: string;
  plan: StartPlanRow[];
  reviewPlan: { enabled: boolean; label: string; summary?: string; reason?: string };
}

/** The requirements still in the plan, in order (Review plan's `keptCandidates`). */
function kept(group: StartGroup, s: StartChoices): StartCandidate[] {
  return group.candidates.filter(
    (c) => !s.remove.includes(c.key) && (c.accepted || s.accept.includes(c.key)),
  );
}

/** A forecast as a range a person reads: days under two weeks, weeks after. */
function range(f: StartRelease["forecast"]): string {
  if (!f) return "Not enough history yet";
  const lo = Math.max(1, Math.min(f.p50Days, f.p85Days));
  const hi = Math.max(lo, f.p50Days, f.p85Days);
  if (hi < 14) return lo === hi ? `about ${plural(lo, "day")}` : `${lo} to ${hi} days`;
  const wlo = Math.max(1, Math.round(lo / 7));
  const whi = Math.max(wlo, Math.round(hi / 7));
  return wlo === whi ? `about ${plural(wlo, "week")}` : `${wlo} to ${whi} weeks`;
}

/**
 * The draft at `width`, with the person's choices so far (`state`, Review
 * plan's shape; the group's own proposal when absent). Only the parts the
 * group holds are shown: nothing is shown as empty or waiting to be filled.
 */
export function startDraftView(
  group: StartGroup | null | undefined,
  opts: { width: number; state?: StartChoices },
): StartDraftView {
  const layout = opts.width < START_TABS_BELOW ? "tabs" : "split";
  const base: StartDraftView = {
    heading: START_COPY.heading,
    layout,
    pageTabs: layout === "tabs" ? [START_COPY.conversation, START_COPY.draft] : [],
    empty: null,
    tabs: [],
    brief: [],
    requirementsHint: START_COPY.requirementsHint,
    requirements: [],
    lineAfter: null,
    lineLabel: START_COPY.lineLabel,
    plan: [],
    reviewPlan: {
      enabled: false,
      label: START_COPY.reviewPlan,
      reason: START_COPY.reviewPlanWaits,
    },
  };
  if (!group || group.version !== 1) return { ...base, empty: START_COPY.nothingYet };

  const s: StartChoices = opts.state ?? { accept: [], remove: [], line: group.releaseLine };
  const keep = kept(group, s);
  const line = Math.max(1, Math.min(keep.length, s.line));
  const brief = BRIEF_SECTION_LABELS.map(([field, label]) => ({
    label,
    lines: (group.brief?.[field] ?? []).filter((l) => l.trim()),
  })).filter((b) => b.lines.length > 0);
  const requirements = PRIORITIES.map(([priority, label]) => ({
    label,
    items: group.candidates
      .filter((c) => c.priority === priority)
      .map(
        (c): StartRequirement => ({
          key: c.key,
          title: c.title,
          from: c.source === "request" ? "You said" : "Seshat suggests: a step a user takes",
          ai: c.source !== "request",
          state: keep.includes(c) ? "Accepted" : s.remove.includes(c.key) ? "Removed" : "Proposed",
        }),
      ),
  })).filter((p) => p.items.length > 0);
  const holds = [keep.slice(0, line), keep.slice(line)];
  const plan = group.releases.map((r, i) => ({
    name: r.name,
    holds: plural((holds[i] ?? []).length, "requirement"),
    issues: `about ${plural(r.cards, "issue")}`,
    when: range(r.forecast),
  }));
  const tabs: StartTab[] = [];
  if (brief.length) tabs.push({ id: "brief", label: "Brief" });
  if (requirements.length)
    tabs.push({ id: "requirements", label: "Requirements", count: keep.length });
  if (plan.length) tabs.push({ id: "plan", label: "Plan" });
  const first = plan[0];
  const forecast = group.releases[0]?.forecast;
  const reviewPlan = first
    ? {
        enabled: true,
        label: START_COPY.reviewPlan,
        summary: [
          `${first.name}: ${first.holds}`,
          first.issues,
          ...(forecast ? [first.when] : []),
        ].join(" · "),
      }
    : base.reviewPlan;
  return {
    ...base,
    tabs,
    brief,
    requirements,
    lineAfter: keep[line - 1]?.key ?? null,
    plan,
    reviewPlan,
  };
}

// --- Where the project goes (DS-N8-1..3, DB-N26-1; DEC-57) -------------------

/** `GET /api/projects/new`'s answer, as the page reads it. */
export interface StartPlace {
  /** The workspace already holds a project: approval creates a new folder. */
  newFolder: boolean;
  folder?: string;
  /** The folder as a person reads it (`~` for the home folder). */
  shown?: string;
  mayCreate?: boolean;
  refusal?: {
    kind: string;
    reason: string;
    project?: { id?: string; name: string; workspace: string; here: boolean };
  };
}

export interface StartPlaceView {
  /** *Will be created in …*, or null when the server's own folder takes the project. */
  folderLine: string | null;
  changeFolder: string | null;
  addRepository: string;
  /** Why the folder cannot take the project, said before any approval (DS-N8-3). */
  refusal: {
    text: string;
    /** *Open it* for a project of this workspace. */
    openIt: { label: string; project: string } | null;
    /** A folder holding code is offered the take-over instead. */
    addInstead: boolean;
  } | null;
  /** Review plan waits while the folder is refused. */
  blocksApproval: boolean;
  /** TEAM-57: the plan goes for approval. */
  approvalNote: string | null;
}

/** The place bar above the conversation (DS-N8-1..3, DB-N26-1). */
export function startPlaceView(place: StartPlace): StartPlaceView {
  const refusal = place.refusal
    ? {
        text: place.refusal.reason,
        openIt:
          place.refusal.project?.here && place.refusal.project.id
            ? { label: START_COPY.openIt, project: place.refusal.project.id }
            : null,
        addInstead: place.refusal.kind === "has_code",
      }
    : null;
  const shown = place.shown ?? place.folder;
  return {
    folderLine: place.newFolder && shown ? START_COPY.willCreate(shown) : null,
    changeFolder: place.newFolder ? START_COPY.changeFolder : null,
    addRepository: START_COPY.addRepository,
    refusal,
    blocksApproval: refusal !== null,
    approvalNote: place.mayCreate === false ? START_COPY.sendsForApproval : null,
  };
}
