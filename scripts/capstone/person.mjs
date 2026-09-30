/**
 * The person-simulator for the capstone's Sekhemet arm (W2 G5): the stand-in
 * for Marisol and for the person who accepts the work.
 *
 * - **She answers Seshat only from the frozen FAQ:** a question gets, word for
 *   word, the stakeholder script's answers whose keywords match it, from the
 *   phases she has already given (`render_prompt.mjs` `answerFor`), or the
 *   default answer. She never says anything an arm in another cell would not
 *   also have read.
 * - **She decides nothing on judgement:** she approves the plan Seshat sends
 *   her for approval, moves the next issue in the board's order to Ready
 *   when none is (`pullDecision`), and accepts an issue or a release exactly when all its
 *   checks passed and, where an AI reviewer is configured, its review passed;
 *   otherwise she sends it back with the reason those records give. With no
 *   reviewer configured (the Review role ships unfilled until RG-P8-13), the
 *   checks alone decide, as they do for the Claude Code arm, and the log says
 *   no review ran.
 * - **Every simulated decision is logged** in the run's `log.jsonl`, with
 *   what it was based on, and counted as zero hands-on minutes (she is not a
 *   person; the log says so).
 *
 * `driveSekhemet` drives the whole arm against a running `sekhemet serve`
 * (Solo) through `sekhemet_arm.mjs`, with these decisions: it gives Seshat
 * `prompt.md` and stops unless Seshat holds exactly that text, then goes on
 * to the plan, the queue, Review, release 1 and the change request.
 */
import { TIMESHEET_DIR, logEvent } from "./grid.mjs";
import { answerFor, loadScript } from "./render_prompt.mjs";

const SIMULATED = { minutes: 0, simulated: true };

/** The questions in a message from Seshat: its sentences ending in a question mark. */
export function questionsIn(text) {
  return (text.replace(/\r\n/g, "\n").match(/[^.!?\n][^.!?\n]*\?/g) ?? [])
    .map((q) => q.trim())
    .filter(Boolean);
}

/**
 * Her reply to a message from Seshat: the FAQ's answers to each of its
 * questions, joined, without repeating an answer; null when it asks nothing.
 */
export function replyTo(text, { given = ["release-1"], fixture = TIMESHEET_DIR } = {}) {
  const script = loadScript(fixture);
  const qs = questionsIn(text);
  if (qs.length === 0) return null;
  const answers = [];
  for (const q of qs) {
    const a = answerFor(script, given, q);
    for (const part of a.split("\n\n")) if (!answers.includes(part)) answers.push(part);
  }
  return {
    questions: qs,
    text: answers.join("\n\n"),
    usedDefault: answers.includes(script.defaultAnswer),
  };
}

/** She approves the plan Seshat sends: she is the stakeholder, not a reviewer of plans. */
export function planDecision(plan) {
  return {
    decision: "approve",
    why: "the stakeholder approves the plan she is sent",
    plan: plan?.id ?? null,
  };
}

/**
 * She pulls the next issue when none is Ready: the first one in the board's
 * order that the phase still holds, moved with the product's own `/ready`
 * (Seshat's composer, "Move an issue to Ready."), as a person does. The
 * product decides whether it may move; she does not choose between issues.
 */
export function pullDecision(issue) {
  return {
    decision: "move to Ready",
    why: "no issue is Ready; she moves the next one in the board's order with the product's /ready",
    issue: issue?.id ?? null,
  };
}

/**
 * Accept or send back: accepted exactly when every check passed and, when an
 * AI reviewer is configured, its review passed. `checks` is `[{ id, passed }]`;
 * `review` is `{ passed }` or null when no AI review ran. With a reviewer
 * configured, nothing unreviewed is accepted; with none configured, the
 * checks decide alone and the decision says no review ran.
 */
export function acceptDecision({ checks = [], review = null, reviewerConfigured = true } = {}) {
  const failed = checks.filter((c) => !c.passed).map((c) => c.id);
  if (checks.length === 0) return { decision: "send back", why: "no checks are recorded" };
  if (failed.length) return { decision: "send back", why: `checks failed: ${failed.join(", ")}` };
  if (review && !review.passed) return { decision: "send back", why: "the AI review did not pass" };
  if (review) return { decision: "accept", why: "all checks passed and the AI review passed" };
  if (reviewerConfigured) return { decision: "send back", why: "no AI review is recorded" };
  return {
    decision: "accept",
    why: "all checks passed; no AI reviewer is configured, so no review ran",
  };
}

/** Log one simulated decision in the run's log. */
export function logDecision(paths, what, decision, basis = {}) {
  return logEvent(paths, { kind: "person", what, ...decision, basis, ...SIMULATED });
}

/**
 * The whole Sekhemet arm against a running dashboard (`sekhemet_arm.mjs`):
 * the brief, the conversation, the plan, the queue, Review, release 1, the
 * change request and the end, each of her decisions made here.
 */
export async function driveSekhemet(options) {
  const arm = await import("./sekhemet_arm.mjs");
  return arm.driveSekhemet(options);
}
