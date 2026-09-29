/**
 * The Inbox and My issues as a person reads them (teams NEW-teams-7, items
 * 22–24; dashboard §2.17.2–3, DB-N9-14, -15). Linear's Inbox is the model:
 * what reached you, grouped by reason — *Needs you*, *Mentioned*, *Review
 * requested*, *Watching*, *Agent finished* — with *Done*, *Snooze* and
 * *Save* on each row; GitHub's notification reasons and Jira's watchers are
 * the same idea. The server sends facts (who, what changed, the AI's state);
 * every word a person reads is here, so the page and the notices agree.
 */

import {
  type AiStateFacts,
  type AiStateLine,
  type AiWho,
  aiStateLine,
  startRequestLine,
} from "./teammates.js";
import { columnLabel } from "./vocabulary.js";

export type InboxReason =
  | "needs_you"
  | "mentioned"
  | "review_requested"
  | "watching"
  | "agent_finished";

/** The groups, in teams item 24's order. */
export const INBOX_GROUPS: readonly { reason: InboxReason; label: string }[] = [
  { reason: "needs_you", label: "Needs you" },
  { reason: "mentioned", label: "Mentioned" },
  { reason: "review_requested", label: "Review requested" },
  { reason: "watching", label: "Watching" },
  { reason: "agent_finished", label: "Agent finished" },
];

/**
 * Strongest first: an issue's row sits under the strongest reason among the
 * changes that reached you. A mention is aimed at you; the Agent finishing
 * work you started is yours to look at; a review request asks for you; a
 * watched change only informs.
 */
const STRENGTH: readonly InboxReason[] = [
  "needs_you",
  "mentioned",
  "agent_finished",
  "review_requested",
  "watching",
];

export function strongestReason(reasons: Iterable<InboxReason>): InboxReason {
  let best = STRENGTH.length - 1;
  for (const r of reasons) best = Math.min(best, STRENGTH.indexOf(r));
  return STRENGTH[best] ?? "watching";
}

export type InboxFilter = "inbox" | "saved" | "done";

/** The Inbox's own tabs: what is open, what you saved, what you marked done. */
export const INBOX_FILTERS: readonly { value: InboxFilter; label: string }[] = [
  { value: "inbox", label: "Inbox" },
  { value: "saved", label: "Saved" },
  { value: "done", label: "Done" },
];

/** Every word of the Inbox page. */
export const INBOX_COPY = {
  title: "Inbox",
  empty: "Nothing needs you.",
  emptyHint:
    "Mentions, review requests, changes on issues you watch and the Agent's finished work land here.",
  emptySaved: "Nothing saved.",
  emptyDone: "Nothing marked done.",
  done: "Done",
  undone: "Move to Inbox",
  snooze: "Snooze",
  snoozedUntil: (when: string) => `Snoozed until ${when}`,
  save: "Save",
  saved: "Saved",
  open: "Open",
  start: "Start",
  decline: "Decline",
  invite: "Invite",
  dontInvite: "Don't invite",
  unread: (n: number) => (n === 1 ? "1 unread" : `${n} unread`),
  couldNot: "Couldn't update the Inbox.",
} as const;

/** One change on an issue, as the server knows it. Names are the reader's ("you"). */
export interface InboxChange {
  type:
    | "created"
    | "commented"
    | "mentioned"
    | "status"
    | "owner"
    | "delegated"
    | "updated"
    // Review verdicts and threads (teams item 25), as a pull request's notifications.
    | "reviewed"
    | "replied"
    | "resolved"
    | "reopened"
    | "accepted"
    | "accept_dismissed";
  /** Who made it, by name; absent for the harness. */
  by?: string;
  /** An AI teammate made it. */
  byAi?: AiWho;
  /** Status: the state it moved to. */
  status?: string;
  /** Owner or delegate: who it is now, by name. */
  to?: string;
  toAi?: AiWho;
  /** Updated: which fields. */
  fields?: string[];
}

const AI_NAME: Record<AiWho, string> = { agent: "Agent", seshat: "Seshat" };

const list = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** "Dana Lee commented." — a change in one sentence, naming who made it. */
export function changeLine(c: InboxChange): string {
  const who = c.byAi ? AI_NAME[c.byAi] : (c.by ?? "Someone");
  const Who = who.charAt(0).toUpperCase() + who.slice(1);
  switch (c.type) {
    case "created":
      return `${Who} created it.`;
    case "commented":
      return `${Who} commented.`;
    case "mentioned":
      return `${Who} mentioned you.`;
    case "status":
      return `${Who} moved it to ${columnLabel(c.status ?? "")}.`;
    case "owner":
      return c.to ? `${Who} made ${c.to} the owner.` : `${Who} removed the owner.`;
    case "delegated":
      if (c.toAi === "agent") return `${Who} delegated it to the Agent.`;
      return c.to ? `${Who} delegated it to ${c.to}.` : `${Who} took it back from its delegate.`;
    case "updated":
      return `${Who} changed the ${list(c.fields?.length ? c.fields : ["details"])}.`;
    case "reviewed":
      return `${Who} left a review.`;
    case "replied":
      return `${Who} replied in a review thread.`;
    case "resolved":
      return `${Who} resolved a review thread.`;
    case "reopened":
      return `${Who} reopened a review thread.`;
    case "accepted":
      return `${Who} accepted it; its pull request is open.`;
    case "accept_dismissed":
      return c.to
        ? `Accept dismissed: new commits since ${c.to} accepted it.`
        : "Accept dismissed: new commits since it was accepted.";
  }
}

/** An Inbox row, as `GET /api/inbox` sends it. */
export interface InboxItemFacts {
  id: string;
  reason: InboxReason;
  kind:
    | "issue"
    | "start_request"
    | "decision"
    | "plan_approval"
    | "plan_question"
    | "mention_invite"
    | "invite_request";
  cardId?: string;
  title: string;
  project?: { id: string; name: string };
  /** The latest change that reached you on it. */
  change?: InboxChange;
  /** Changes since you last marked it done. */
  count: number;
  /** Who caused it, by name (a request, a plan). */
  by?: string;
  at: string;
  seq: number;
  unread: boolean;
  saved: boolean;
  done: boolean;
  snoozedUntil?: string;
  /** The AI teammates' state, on items about their work (item 19). */
  ai?: AiStateFacts[];
  /** A request to start the Agent (item 19a). */
  request?: { id: string; requestedBy: string; ask: string };
  /** A mention of people who cannot see the project (TEAM-22): their names. */
  mention?: { commentId: string; people: string[]; project?: string };
  /** The Agent's question, or the approver's question on your plan (`plan_question`). */
  question?: string;
  /** On a plan sent for your approval: its sender answered your question (design-stage §2.9 item 7). */
  answered?: boolean;
  link: string;
}

/** A row's words: what it is about, the sentence, and the AI's state lines. */
export function itemLine(item: InboxItemFacts): {
  title: string;
  line: string;
  ai?: AiStateLine[];
} {
  const ai = item.ai?.length ? { ai: item.ai.map(aiStateLine) } : {};
  const title = item.title;
  switch (item.kind) {
    case "start_request":
      return {
        title,
        line: startRequestLine({
          requestedBy: item.request?.requestedBy ?? item.by ?? "Someone",
          ask: item.request?.ask ?? "",
          title,
        }).text,
        ...ai,
      };
    case "plan_approval":
      return {
        title,
        line: item.answered
          ? `${item.by ?? "Someone"} answered your question on this plan.`
          : `${item.by ?? "Someone"} sent this plan for your approval.`,
        ...ai,
      };
    case "plan_question":
      return {
        title,
        line: `${item.by ?? "Your approver"} asked about your plan: ${item.question ?? "a question"}`,
        ...ai,
      };
    case "mention_invite":
      return {
        title,
        line: mentionInviteLine(item.mention?.people ?? [], item.mention?.project),
        ...ai,
      };
    case "invite_request":
      return {
        title,
        line: `${inviteRequestLine({
          by: item.by ?? "Someone",
          people: item.mention?.people ?? [],
          ...(item.mention?.project ? { project: item.mention.project } : {}),
        }).replace(/\.$/, "")}, from a mention on ${title}.`,
        ...ai,
      };
    case "decision":
      return { title, line: `The Agent asks: ${item.question ?? "a question"}`, ...ai };
    default: {
      const said = item.change ? changeLine(item.change) : "";
      const more = item.count > 1 ? ` ${item.count} updates.` : "";
      return { title, line: `${said}${more}`.trim(), ...ai };
    }
  }
}

/** TEAM-22: the question the author answers before a mention reaches anyone. */
export function mentionInviteLine(people: readonly string[], project?: string): string {
  return `${list(people)} can't see ${project ?? "this project"}. Invite them?`;
}

/** The request an Admin reads after the author chose *Invite*. */
export function inviteRequestLine(input: {
  by: string;
  people: readonly string[];
  project?: string;
}): string {
  return `${input.by} asked to invite ${list(input.people)} to ${input.project ?? "this project"}.`;
}

/**
 * The Inbox's groups: only those with items. *Needs you* longest wait first,
 * as decision requests always were (dashboard §2.5.2); the rest newest first.
 */
export function inboxGroups(
  items: readonly InboxItemFacts[],
): { reason: InboxReason; label: string; items: InboxItemFacts[] }[] {
  const newest = (a: InboxItemFacts, b: InboxItemFacts) =>
    b.seq - a.seq || b.at.localeCompare(a.at);
  const longest = (a: InboxItemFacts, b: InboxItemFacts) => a.at.localeCompare(b.at);
  return INBOX_GROUPS.map((g) => ({
    ...g,
    items: items
      .filter((i) => i.reason === g.reason)
      .sort(g.reason === "needs_you" ? longest : newest),
  })).filter((g) => g.items.length > 0);
}

export type SnoozeChoice = "later" | "tomorrow" | "next_week";

/** Linear's snooze choices. */
export const SNOOZE_CHOICES: readonly { value: SnoozeChoice; label: string }[] = [
  { value: "later", label: "Later today" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "next_week", label: "Next week" },
];

/** When a snoozed item comes back: in 3 hours, tomorrow at 09:00, or next Monday at 09:00 (local). */
export function snoozeUntil(choice: SnoozeChoice, now: Date): string {
  const at = new Date(now.getTime());
  if (choice === "later") return new Date(now.getTime() + 3 * 3_600_000).toISOString();
  at.setHours(9, 0, 0, 0);
  if (choice === "tomorrow") {
    at.setDate(at.getDate() + 1);
  } else {
    const days = (8 - at.getDay()) % 7 || 7;
    at.setDate(at.getDate() + days);
  }
  return at.toISOString();
}

// ---------------------------------------------------------------------------
// My issues (DB-N9-15)
// ---------------------------------------------------------------------------

export type MyIssueWhy = "owner" | "delegated" | "review";

export interface MyIssueFacts {
  id: string;
  title: string;
  status: string;
  priority?: number;
  why: MyIssueWhy[];
  project?: { id: string; name: string };
  ai?: AiStateFacts[];
}

export const MY_ISSUES_COPY = {
  title: "My issues",
  empty: "No issues are yours right now.",
  emptyHint:
    "Issues you own, are delegated or are asked to review show here, across your projects.",
  noProject: "No project",
  columns: { issue: "Issue", status: "Status", why: "Reason" },
} as const;

const WHY: Record<MyIssueWhy, string> = {
  owner: "Owner",
  delegated: "Delegated to you",
  review: "Review requested",
};

/** My issues grouped by project, projects by name, issues in the order sent. */
export function myIssueGroups(issues: readonly MyIssueFacts[]): {
  id: string;
  name: string;
  issues: (MyIssueFacts & { whyLabel: string; statusLabel: string })[];
}[] {
  const groups = new Map<
    string,
    {
      id: string;
      name: string;
      issues: (MyIssueFacts & { whyLabel: string; statusLabel: string })[];
    }
  >();
  for (const i of issues) {
    const id = i.project?.id ?? "";
    const g = groups.get(id) ?? {
      id,
      name: i.project?.name ?? MY_ISSUES_COPY.noProject,
      issues: [],
    };
    g.issues.push({
      ...i,
      whyLabel: i.why.map((w) => WHY[w]).join(" · "),
      statusLabel: columnLabel(i.status),
    });
    groups.set(id, g);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Watch (teams item 22)
// ---------------------------------------------------------------------------

export const WATCH_COPY = {
  watch: "Watch",
  watching: "Watching",
  hint: "Get every change on this issue in your Inbox.",
} as const;

/** The issue header's toggle: *Watch*, or *Watching* with who else watches. */
export function watchLine(input: { watching: boolean; watchers: readonly string[] }): {
  label: string;
  pressed: boolean;
  detail: string;
} {
  const n = input.watchers.length;
  return {
    label: input.watching ? WATCH_COPY.watching : WATCH_COPY.watch,
    pressed: input.watching,
    detail: n ? `${n} watching: ${input.watchers.join(", ")}` : WATCH_COPY.hint,
  };
}
