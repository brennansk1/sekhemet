/**
 * The issue's closing and reopening actions (dashboard §2.6 *Issue actions*,
 * NEW-dashboard-21; FINDINGS ISS-04): *Won't do*, *Reopen* and *Revert*, in
 * NAMING's words as DEC-52 amends them. Pure: the page's `⋯` menu, the peek
 * and the palette render from it, and the server's routes enforce the same
 * columns (`triage.ts` `reject`, `reopen`; `accept.ts` `revertVerdict`).
 */

/** Where Won't do is offered (review-git RG-S5-11): the server refuses it elsewhere. */
export const WONT_DO_FROM = ["backlog", "ready", "review", "parked"] as const;

export type IssueActionId = "wontdo" | "reopen" | "revert";

export interface IssueAction {
  id: IssueActionId;
  label: string;
  hint: string;
  enabled: boolean;
  /** Why it is disabled, as adjacent text (DB-P12-3); absent when enabled. */
  why?: string;
}

interface Person {
  principal: string;
  name?: string;
}

/** The review desk's answer on a Done issue (`GET /api/cards/:id/review`). */
export interface RevertDesk {
  revert?: { may: true } | { may: false; who?: Person[] };
}

export const ISSUE_ACTION_COPY = {
  menu: "More actions",
  wontDo: "Won't do",
  wontDoHint: "Closes the issue without building it. You can reopen it.",
  reopen: "Reopen",
  reopenHint: "Moves it back to To do.",
  revert: "Revert",
  revertHint: "Adds a commit that undoes the accepted change.",
  /** The reason form (a reason is required, RG-S5-11). */
  reasonLabel: "Why won't it be done?",
  reasonPlaceholder: "Required. The reason is kept on the issue.",
  reasonMissing: "Add a reason. It is kept on the issue for whoever reads it next.",
  reasonPresets: ["Out of scope", "Duplicate", "No longer needed"],
  confirmWontDo: "Mark Won't do",
  confirmRevert: "Revert",
  cancel: "Cancel",
  revertTitle: "Revert this issue?",
  wontDoDone: "Marked Won't do. You can reopen it.",
  reopened: "Reopened. It is back in To do.",
  wontDoAgain: "Marked Won't do again.",
  /** The reason sent when Undo puts a reopened issue back in Won't do. */
  undoReopenReason: "Reopen undone",
  reverted: (sha: string) => `Reverted as ${sha.slice(0, 7)}. The issue is back in To do.`,
  revertFailed: "Couldn't revert. The issue stays in Done.",
  /** The line the Accept toast gains once the issue page offers Revert (§2.5.10). */
  canRevert: "You can revert it from the issue page.",
} as const;

const list = (names: readonly string[]): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** Why Revert is disabled: who the Accept rule names, never a principal id. */
export function revertRefusalText(who: readonly Person[]): string {
  const names = who.map((p) => p.name).filter((n): n is string => Boolean(n));
  if (who.length === 0) {
    return "The Accept rule names no current member, so no one can revert it. The project lead or an Admin can edit the rule.";
  }
  if (names.length === 0) return "Only a person the Accept rule names can revert it.";
  return `Only ${list(names)} can revert it: the Accept rule names them.`;
}

/** The confirmation Revert shows first, naming the commit it undoes. */
export function revertConfirmText(sha: string, branch = "main"): string {
  const short = sha ? sha.slice(0, 7) : "the accepted change";
  return `Revert adds a commit to ${branch} that undoes ${short}, and moves this issue back to To do.`;
}

/** The actions an issue in this column offers; [] when none. */
export function issueActions(card: { status: string }, desk?: RevertDesk | null): IssueAction[] {
  const c = ISSUE_ACTION_COPY;
  if ((WONT_DO_FROM as readonly string[]).includes(card.status)) {
    return [{ id: "wontdo", label: c.wontDo, hint: c.wontDoHint, enabled: true }];
  }
  if (card.status === "rejected") {
    return [{ id: "reopen", label: c.reopen, hint: c.reopenHint, enabled: true }];
  }
  if (card.status === "done") {
    const rv = desk?.revert;
    if (rv && rv.may === false) {
      return [
        {
          id: "revert",
          label: c.revert,
          hint: c.revertHint,
          enabled: false,
          why: revertRefusalText(rv.who ?? []),
        },
      ];
    }
    return [{ id: "revert", label: c.revert, hint: c.revertHint, enabled: true }];
  }
  return [];
}
