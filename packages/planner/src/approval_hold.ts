/**
 * The hold every planned card carries until a person approves its criteria
 * (planner-pm §2.17.1, PM-N7-5): the first words of its reason, so the
 * approval lifts exactly this hold and leaves every other one in place.
 */
export const CRITERIA_APPROVAL_HOLD = "Waiting on a person's approval of its criteria";

/** The hold's reason on one card, naming the command that approves it. */
export function approvalHold(cardId: string): string {
  return `${CRITERIA_APPROVAL_HOLD}: sekhemet approve ${cardId}.`;
}
