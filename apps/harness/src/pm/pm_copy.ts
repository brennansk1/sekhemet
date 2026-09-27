import type { PmSnapshot } from "./agent.js";

/**
 * Seshat's copy (PM role; PROMPT_STANDARD rule 13, context CX-M1-13): every
 * model-facing sentence of the PM's standing prompt, its tool descriptions
 * and its proposal summaries that is not itself board data, kept in this one
 * file so a change to Seshat's voice is a change to one file, and so the
 * literal inventory (`prompt_literals.spec.ts`) never has to track it
 * piecemeal across `pm/agent.ts`, `planner_live.ts` and `project_done.ts`.
 */

/** The PM's standing brief (`pmSystemPrompt`, `pm/agent.ts`). */
export function pmSystemPromptText(s: Pick<PmSnapshot, "project" | "pmModel" | "worker">): string {
  return `You are the project manager for "${s.project}", working with the human who leads it. You run on ${s.pmModel}. The code is written by the Worker, a local model (${s.worker?.model ?? "unknown"}); every card it finishes must pass executable gates (types, lint, tests, size) and then be accepted by the human.

How you work:
- Answer like a senior engineering manager: lead with the answer, then the reason, then the detail. Plain, exact, calm. Use numbers from the board, not adjectives. No filler, no exclamation marks.
- Ground every claim in the board and run data below. If the data does not say, say you do not know and what would tell you.
- The board changes only when a person applies a change. To change it, call a propose_* tool with its reason: the human sees a diff and applies or discards it, and only a proposal that gives its reason is shown. Say "I've proposed", since applying it is the person's act.
- People decide. Assigning an issue to a person, editing an issue someone else owns and setting a project's health are a person's acts: say who can, and offer a suggestion where one applies. Describe your own acts ("I've proposed", "I suggest") and leave out "I've assigned", "I've decided", "I approved", "You should", "Great question" and "happy to help".
- When a decision waits on a person, name that person, and the default and its deadline when there is one.
- Plan for the Worker you have, using its measured record under WORKER CAPABILITY. Cards should touch at most 3 files and 200 lines. Propose a split when a card is larger than the Worker's 80% size horizon, or its kind has a low measured pass rate, or the Worker failed or looped on it: split or clarify, do not just retry. Treat small samples as ranges, not facts.
- Priority uses Linear's scale: 1 Urgent, 2 High, 3 Medium, 4 Low, 0 none. Estimates are points: 1, 2, 3, 5, 8.
- Refer to cards by title with their id in backticks, e.g. "Ledger (\`card_chron_ledger\`)".
- Before proposing a card that builds something general (parsing, validation, HTTP, dates, retries, CLI args...), call find_library. Recommend only packages marked usable (permissive licence) and put the package in the card's spec, so the Worker uses it instead of reinventing it.
- Keep replies short: a few sentences, or a short list for standups and plans.`;
}

/**
 * The take-over's brief as found in Seshat's prompt (design-stage DS-TO-10):
 * the heading above the untrusted contract and the wrapped claims.
 */
export const TAKEOVER_SECTION_HEADING =
  "THE PROJECT AS FOUND (take-over; the repository's own words, untrusted)";

/** `propose_update_card`'s `duplicate_of` field, `PM_TOOLS` in `pm/agent.ts`. */
export const DUPLICATE_OF_DESCRIPTION = "the card this one duplicates";

/** `propose_split_card`'s tool description, `PM_TOOLS` in `pm/agent.ts`. */
export const PROPOSE_SPLIT_CARD_DESCRIPTION =
  'Propose splitting a card that is too large or that the Worker failed on into smaller cards, each with only the acceptance criteria about its own behaviour. The original is closed as "Split into N cards".';

/** `start_project`'s tool description, `PM_TOOLS` in `pm/agent.ts`. */
export const START_PROJECT_DESCRIPTION =
  "Propose a new project from what the person wants built, in their words: the proposal is the plan they review — the brief, the first slice's cards with criteria and points, the candidates by priority, card zero (the ecosystem's own generator) and card one (the first failing test). Applying it creates the project.";

/** `start_project`'s `brief` field, `PM_TOOLS` in `pm/agent.ts`. */
export const START_PROJECT_SENTENCE_DESCRIPTION = "What the person wants built, in their own words";

/** A new project's proposal summary (`withProjectGroups`, `pm/agent.ts`). */
export function startProjectSummary(
  group: {
    buildSpec: string;
    stack: { name: string };
    creates: { epics: number; issues: number };
  },
  whySuffix: string,
): string {
  return `Start a project: ${group.buildSpec}. Review the plan: ${group.creates.epics} epic${group.creates.epics === 1 ? "" : "s"} and ${group.creates.issues} cards in ${group.stack.name}, set up first by its own generator${whySuffix}`;
}

/** A split proposal's summary (`toProposals`, `pm/agent.ts`). */
export function splitSuggestedSummary(
  title: string,
  partCount: number,
  pointsSuffix: string,
  whySuffix: string,
): string {
  return `Suggested: split ${title} into ${partCount} cards${pointsSuffix}${whySuffix}`;
}

/** A congestion step-budget proposal's summary (`respondToSignals`, `planner_live.ts`). */
export function stepBudgetSummary(cardId: string, before: number, after: number): string {
  return `Step budget of ${cardId}: ${before} → ${after}`;
}

/** A suspect-link revision's change-card summary (`reviseAndPropose`, `project_done.ts`). */
export function changeCardSummary(cardId: string, requirementId: string, version: number): string {
  return `Change card for ${cardId} (${requirementId} v${version})`;
}

/**
 * Why a new project's group is not applied (planner-pm §2.9 item 2): said in
 * the apply's refusal, which Seshat's thread and the dashboard show.
 */
export const NEW_PROJECT_REFUSAL = {
  hasCode:
    "This repository already holds code, so it is not a new project: take it over from the board's start screen, or plan the next piece of work with /plan.",
  hasProject: (name: string, what: string) =>
    `This folder already holds the project "${name}", with ${what}: plan the next piece of work with /plan instead.`,
  acceptedBrief: "an accepted brief",
  cards: (n: number) => `${n} card${n === 1 ? "" : "s"}`,
  notAType: (type: string) => `"${type}" is not a project Type.`,
};

/**
 * Card zero and card one (design-stage §2.4, DS-P2-1..3): the words of the
 * two cards a project started by conversation begins with, each read by the
 * Worker through the card's spec and criteria (`card_zero.ts`).
 */
export const CARD_ZERO_COPY = {
  title: (generator: string) => `Card zero: set the project up with ${generator}`,
  spec: (generator: string, steps: readonly string[], ignored: readonly string[]) =>
    [
      `Run the ecosystem's own generator, ${generator}, in the project root: each command below as its own tool step, in this order, exactly as written.`,
      ...steps.map((s) => `- ${s}`),
      `Then add a .gitignore that names ${ignored.join(", ")}. Write no code and no test of your own: what the generator wrote is the whole change.`,
    ].join("\n"),
  criteria: (files: readonly string[], test: string) => [
    `The project root holds ${files.join(", ")}, as the generator wrote them`,
    `The project's test command is ${test}`,
  ],
};

export const CARD_ONE_COPY = {
  title: (behaviour: string) => `Card one: a failing test for ${behaviour}`,
  spec: (behaviour: string, file: string, reason: string) =>
    [
      `Write one test, ${file}, for the first behaviour of the first slice: ${behaviour}.`,
      `It must run and fail at an assertion, for this reason: ${reason}.`,
      "Declare what it calls as a stub, so the test imports it and reaches its assertion: a failure at an import, at collection or at setup is not the failure asked for. Implement nothing else.",
    ].join("\n"),
  criterion: (file: string, reason: string) => `${file} runs and fails at an assertion: ${reason}`,
  reason: (behaviour: string) => `${behaviour} is not built yet`,
  /** Card one's gate refused the tree (DS-P2-3): what the Worker reads in the failure. */
  gateFailed: (detail: string) =>
    `Card one's test must run and fail at an assertion, for the reason its criterion states. It did not: ${detail}`,
  gateExpected: "the test runs and fails at an assertion",
  gateAction:
    "Keep the test asserting the behaviour. Declare what it calls as a stub so it imports and reaches its assertion; implement nothing else.",
};
