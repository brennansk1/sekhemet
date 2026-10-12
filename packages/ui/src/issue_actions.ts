/**
 * The issue's closing and reopening actions (dashboard §2.6 *Issue actions*,
 * NEW-dashboard-21; FINDINGS ISS-04): *Won't do*, *Reopen* and *Revert*, in
 * NAMING's words as DEC-52 amends them. Pure: the page's `⋯` menu, the peek
 * and the palette render from it, and the server's routes enforce the same
 * columns (`triage.ts` `reject`, `reopen`; `accept.ts` `revertVerdict`).
 */

import { boardColumnLabel } from "./vocabulary.js";

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
  revert?:
    | { may: true }
    | {
        may: false;
        who?: Person[];
        /**
         * Sekhemet merged nothing of the issue to revert (loop wave 10 A2;
         * `accept.ts` `nothing_to_revert`): `pr` when it was accepted through
         * its pull request, `merge` the hosting service's merge commit.
         */
        nothing?: { pr?: string; merge?: string };
      };
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

/**
 * Why Revert is disabled on a Done issue Sekhemet merged nothing of (loop
 * wave 10 A2): the CLI's `nothing_to_revert` refusal and its `Do:` step, in
 * the board's words — where to revert, and how to do the work again.
 */
export function nothingToRevertText(n: { pr?: string; merge?: string }): string {
  if (n.pr) {
    const merged = n.merge ? `, merged as ${n.merge.slice(0, 7)}` : "";
    return `It was accepted through its pull request ${n.pr}${merged}, so there is no merge here to revert. Revert that merge where the pull request lives, then add a New issue to do the work again.`;
  }
  return "It is Done with no Accept on its Activity log, so nothing was merged here to revert. To do the work again, add a New issue.";
}

/**
 * The toast after taking an issue off hold (review-git §2.4, kernel rule 25;
 * loop wave 10 A3): the column the server moved it to (`to`), never "back
 * where it was". An issue put on hold from In review goes to To do, and the
 * Agent runs it again, so the toast says so when `from` is known.
 */
export function takenOffHoldText(to: string, from?: string): string {
  const column = boardColumnLabel(to);
  if (from === "review" && to === "ready")
    return `Taken off hold. It is in ${column}, not In review: the Agent runs it again.`;
  return `Taken off hold. It is in ${column}.`;
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
          why: rv.nothing ? nothingToRevertText(rv.nothing) : revertRefusalText(rv.who ?? []),
        },
      ];
    }
    return [{ id: "revert", label: c.revert, hint: c.revertHint, enabled: true }];
  }
  return [];
}
