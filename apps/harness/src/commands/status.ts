import type { CardRecord } from "@sekhemet/kernel";
import { BOARD_COLUMNS, isIssueCard, plainStatus, withShownStatus } from "@sekhemet/ui";
import { setupFor } from "../planner_live.js";
import { type Audience, audienceFromAccess, soloAudience } from "../pm/audience.js";
import { namedDecisions } from "../pm/decisions.js";
import { plainTitle } from "../pm/standup.js";
import { Access } from "../team/access.js";
import { terminalBoardLines } from "../terminal_board.js";
import { orderForQueue, topGoalEpic } from "../wave2.js";
import { type StatusResult, baseResult, issueRef } from "./cli_result.js";
import type { CommandHandler } from "./registry.js";

/**
 * `sekhemet status [--json]` (surface item 20c, NEW-surface-10): the board
 * for a script — each column's issues with their state, what the queue runs
 * next, and what waits on a person. Listed under `sekhemet dev --help`
 * (rule 14). Read-only: it writes nothing to the ledger. In the Team setup
 * it holds only the issues the person at the terminal can see (PM-N9-8).
 */
/**
 * Each board column's issues, a parent where its issues are (S1B-B16:
 * `withShownStatus`): `status` stays the stored state, `state` says the
 * shown one in plain words, as the text board shows it.
 */
export function statusColumns(cards: readonly CardRecord[]): NonNullable<StatusResult["columns"]> {
  const shown = withShownStatus(cards);
  const columns: NonNullable<StatusResult["columns"]> = [];
  for (const col of BOARD_COLUMNS) {
    const issues = shown.filter((c) => col.states.includes(c.status));
    if (col.onlyWithCards && issues.length === 0) continue;
    columns.push({
      name: col.label,
      issues: issues.map((c) => {
        const stored = cards.find((s) => s.id === c.id) ?? c;
        return {
          ...issueRef(stored),
          state: plainStatus(c.status),
          steps: { used: c.stepsUsed, budget: c.stepBudget },
        };
      }),
    });
  }
  return columns;
}

export const statusCommand: CommandHandler = async (_args, env) => {
  const { db, log, cardStore, boardService } = await env.kernel("read");
  try {
    const me = log.localPrincipal();
    const audience: Audience =
      setupFor(env.repoPath) === "team"
        ? audienceFromAccess(() => new Access({ db, setup: "team", localPrincipal: () => me }), db)
        : soloAudience();
    // Surface item 8a (wave 8 B1): the project whose root holds the folder,
    // as the dashboard's board is scoped to it; the whole workspace otherwise.
    const state = await boardService.getBoardState(
      env.projectId ? { projectId: env.projectId } : {},
    );
    const cards = state.cards.filter((c) => audience.canSee(me, c.projectId));
    const board = { ...state, cards };
    const columns = statusColumns(cards);
    // The Ready issues in the order the queue takes them, as the standup's *Next up*.
    const ready = cards.filter(
      (c) => c.status === "ready" && (c.tier === "story" || c.tier === "task"),
    );
    const epic = await topGoalEpic({ store: cardStore, log }, cards).catch(() => undefined);
    const next = ready.length ? orderForQueue(env.repoPath, ready, epic).ordered.map(issueRef) : [];
    const waiting = [
      ...cards
        .filter((c) => c.status === "review")
        .map((c) => ({ ...issueRef(c), why: "review" as const })),
      ...cards
        .filter((c) => c.status === "parked")
        .map((c) => ({ ...issueRef(c), why: "on_hold" as const })),
    ];
    // The folder's project's decisions only, as its issues (surface item 8a).
    const inProject: Audience = Object.assign(Object.create(audience) as Audience, {
      canSee: (who: string, project: string | undefined) =>
        audience.canSee(who, project) && (!env.projectId || !project || project === env.projectId),
    });
    const decisions = await namedDecisions({ cardStore, log }, inProject, me, {
      plain: true,
    }).catch(() => [] as string[]);

    for (const line of terminalBoardLines(board)) console.log(line);
    console.log(
      next.length
        ? `Next: ${next.map((c) => `${c.id} ${plainTitle(c)}`).join(", then ")}`
        : "Next: nothing is Ready.",
    );
    console.log(
      waiting.length
        ? `Waiting on a person: ${waiting.map((w) => `${w.id} (${w.state})`).join(", ")}`
        : "Waiting on a person: nothing.",
    );
    for (const d of decisions) console.log(`Decision: ${d}`);

    // A column holds and counts only what it shows: a Won't do issue is a filter, not a column.
    // A parent (an epic) is listed where its issues are but is not an issue (`isIssueCard`),
    // so the count is Status's *of N issues* (wave 8 review).
    const tierOf = new Map(cards.map((c) => [c.id, c]));
    const listed = columns.reduce(
      (n, c) => n + c.issues.filter((i) => isIssueCard(tierOf.get(i.id) ?? {})).length,
      0,
    );
    const message = `${listed} ${listed === 1 ? "issue" : "issues"}; ${next.length} Ready; ${waiting.length} waiting on a person.`;
    return {
      ...baseResult("status", 0, message),
      columns,
      next,
      waiting,
      decisions,
      reviewFull: state.backpressureActive,
    };
  } finally {
    db.close();
  }
};
