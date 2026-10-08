import type { PmSnapshot } from "./agent.js";
import type {
  FailureFacts,
  SnapshotAssumption,
  SnapshotFinding,
  SnapshotGoal,
} from "./knowledge.js";
import { exchangeExamples, languageExamples, skillReference, skillRules } from "./seshat_skill.js";

/**
 * Seshat's copy (PM role; PROMPT_STANDARD rule 13, context CX-M1-13): every
 * model-facing sentence of the PM's standing prompt, its tool descriptions
 * and its proposal summaries that is not itself board data, kept in this one
 * file so a change to Seshat's voice is a change to one file, and so the
 * literal inventory (`prompt_literals.spec.ts`) never has to track it
 * piecemeal across `pm/agent.ts`, `planner_live.ts` and `project_done.ts`.
 */

/**
 * Seshat's conversation template (`pmSystemPrompt`, `pm/agent.ts`), in the
 * order of PROMPT_STANDARD rule 6: identity, the output contract, the rules
 * and tool rules of the skill's `conversation` pass (`seshat_skill.ts`, at
 * most 12, rule 11), the stable reference data, then the examples. It holds
 * nothing about the board, the runs or the Agent's model, so it is
 * byte-stable for a project whatever the board holds (PM-P6-11, rule 21).
 */
export function pmSystemPromptText(s: Pick<PmSnapshot, "project" | "pmModel">): string {
  const { rules, toolRules } = skillRules("conversation");
  const bullets = (xs: readonly string[]) => xs.map((x) => `- ${x}`).join("\n");
  return [
    `You are Seshat, the project manager of the project "${s.project}", answering the people who lead it; you run on ${s.pmModel}.`,
    "Your reply is plain text a person reads in the chat, and each change you recommend is a call to a propose tool with its reason.",
    `<rules>\n${bullets(rules)}\n</rules>`,
    `<tool_rules>\n${bullets(toolRules)}\n</tool_rules>`,
    `How this project works:\n${bullets([
      "The Agent, a local Coding model, writes the code for each issue, and an issue it finishes must pass the project's checks (types, lint, tests, size) and then be accepted by a person.",
      ...skillReference("conversation"),
    ])}`,
    `How to word a reply:\n${languageExamples()}`,
    `Sample exchanges:\n${exchangeExamples()}`,
  ].join("\n\n");
}

/**
 * The tags around each part of Seshat's task data (`seshatSections`,
 * `pm/agent.ts`; PROMPT_STANDARD rule 5), each registered in
 * `REGISTERED_PROMPT_TAGS`. The stable parts come first and the board digest
 * starts the part that changes with the board (PM-P6-11).
 */
export const SESHAT_TAGS = {
  playbook: "playbook",
  preferences: "preferences",
  board: "board",
  goals: "goals",
  brief: "brief",
  assumptions: "assumptions",
  findings: "review_findings",
  failure: "failure_evidence",
  decisions: "decisions",
  forecast: "forecast",
  team: "team",
  sprints: "sprints",
  asFound: "project_as_found",
  attempts: "recent_attempts",
  agent: "agent_record",
  dossier: "dossier",
  conversation: "conversation",
  lookups: "search_results",
  message: "message",
  /** A document the person attached to a message (PM-N10-3). */
  document: "document",
} as const;

/** One part of Seshat's task data, wrapped in its tag; empty when it has no body. */
export function seshatPart(
  tag: (typeof SESHAT_TAGS)[keyof typeof SESHAT_TAGS],
  body: string,
  attrs = "",
): string {
  return body.trim() ? `<${tag}${attrs}>\n${body}\n</${tag}>` : "";
}

/** "in 3 parts", or "on its own" for one. */
export const partsWords = (parts: number): string =>
  parts === 1 ? "on its own" : `in ${parts} parts`;

/** What the words about an attached document need of it. */
export interface AttachedRef {
  name: string;
  path?: string | undefined;
  chars: number;
}

/** A document's tag attributes: quotes and angle brackets dropped from its name. */
export function documentAttrs(d: {
  id: string;
  name: string;
  path?: string | undefined;
  extra?: string;
}): string {
  const clean = (v: string) => v.replace(/["<>]/g, "");
  return ` name="${clean(d.name)}"${d.path ? ` path="${clean(d.path)}"` : ""} id="${d.id}"${d.extra ?? ""}`;
}

/**
 * Reading one part of an attached document too long for Seshat's window
 * (PM-N10-3): the reader's system text and its request. The notes it writes
 * are what Seshat's answer carries for that part.
 */
export const SESHAT_READER_SYSTEM =
  "You read one part of a document a person attached for Seshat, their project manager. Write notes on this part that keep every requirement, rule, number, name, date, constraint and open question in it, in the document's own words where they are exact. Plain lines; no commentary, and nothing that is not in this part.";

export function seshatReaderPrompt(
  d: { id: string; name: string; path?: string | undefined },
  part: string,
  index: number,
  parts: number,
): string {
  return `${seshatPart(SESHAT_TAGS.document, part, documentAttrs({ ...d, extra: ` part="${index} of ${parts}"` }))}\n\nWrite your notes on part ${index} of ${parts} now.`;
}

/**
 * Said in a reply made without an attached document, because not even the
 * notes of its reading fit beside the rest of Seshat's prompt (PM-N10-3):
 * the reply does not cite it, and says so (planner-pm §2.8 item 18).
 */
export function documentsNotHeldWords(
  docs: readonly { name: string; path?: string | undefined }[],
): string {
  const names = docs.map((d) => `"${d.name}"`).join(", ");
  const one = docs.length === 1;
  const where = docs
    .filter((d) => d.path)
    .map((d) => d.path)
    .join(", ");
  return `I could not fit ${names} into what I can read at once, even as notes, so this answer is not based on ${one ? "it" : "them"}.${where ? ` The whole text is at ${where}.` : ""} A Planning model with a larger context window can read ${one ? "it" : "them"}.`;
}

/** The words Seshat's task data uses around the ledger's facts. */
export const SESHAT_DATA = {
  today: (date: string) => `Today: ${date}`,
  emptyBoard: "(empty)",
  newConversation: "(new conversation)",
  earlierSummary: "(Summary of the earlier conversation)",
  person: "Person",
  you: "You",
  lookingAt: (cardId: string) => ` [looking at \`${cardId}\`]`,
  agentRecord: (model: string, record: string) => `${model}: ${record}`,
  /** A long message kept whole as its own attached document: the message line names it (PM-N10-3). */
  sentAsDocument: (d: AttachedRef) =>
    `(a long message, kept whole as the attached document "${d.name}"${d.path ? ` at ${d.path}` : ""}; it is in the document part below)`,
  /** The same, to a quick answerer that is not given the document (rule 20f b). */
  sentAsDocumentUnread: (d: AttachedRef) =>
    `(a long message, kept whole as the document "${d.name}"${d.path ? ` at ${d.path}` : ""}; the full answer reads it)`,
  /** A document attached to the message, named after the person's words. */
  attached: (d: AttachedRef) =>
    ` (attached the document "${d.name}"${d.path ? ` at ${d.path}` : ""}, ${d.chars} characters; it is in the document part below)`,
  /** An earlier message's document, in the conversation. */
  attachedEarlier: (d: AttachedRef) => ` (attached "${d.name}"${d.path ? ` at ${d.path}` : ""})`,
  /** A document read in parts: what the notes are, and how often they were condensed to fit. */
  readInParts: (parts: number, path: string | undefined, condensed = 0) =>
    `This document did not fit your context window beside the rest of this prompt, so you read it ${partsWords(parts)} before this reply; below are your notes on ${parts === 1 ? "all of it" : "every part"}${condensed ? `, condensed ${condensed === 1 ? "once" : `${condensed} times`} (notes on your notes) to fit` : ""}.${path ? ` The whole text is at ${path}.` : ""}`,
  documentErased: "A person erased this document; its text is gone.",
  /** The last line of the prompt: the next action (rule 6, step 7). */
  replyNow: "Reply to the person now.",
  replyAfterLookups: "Reply to the person now, using the search results above.",
};

/**
 * One line per fact of Seshat's knowledge beyond the board (`pm/knowledge.ts`,
 * P6), each carrying the id Seshat cites it by: rendered into its prompt and,
 * for a ledger answer, into the reply (PM-P6-1, -2, -6).
 */
export const SESHAT_FACTS = {
  goal: (g: SnapshotGoal) =>
    `- Goal \`${g.id}\` (${g.state}): ${g.statement} · ${g.met} of ${g.total} criteria met${g.assumptions.length ? ` · assumes: ${g.assumptions.join("; ")}` : ""}`,
  assumption: (a: SnapshotAssumption) =>
    `- Assumption \`${a.id}\` on \`${a.cardId}\`: ${a.statement} (basis: ${a.basis})${a.outcome ? ` · ${a.outcome} by a person` : a.riskHours !== undefined ? ` · unverified for ${a.riskHours}h, on the risk register` : " · unverified"}`,
  finding: (f: SnapshotFinding) =>
    `- \`${f.cardId}\` finding \`${f.entryId}\`, ${f.verdict}: ${f.text}${f.modelId ? ` (Review model ${f.modelId})` : ""}`,
  /** A failed attempt's facts, in the order PM-P6-6 names them. */
  failure: (f: FailureFacts, words: { stop: string; gate?: string | undefined }) =>
    `\`${f.cardId}\` stopped on ${words.stop}${f.step !== undefined ? ` at step ${f.step}` : ""}${words.gate ? `; the first failing check was ${words.gate}${f.at ? `, at ${f.at}` : ""}` : f.at ? `, at ${f.at}` : ""}${f.excerpt ? ` (${f.excerpt})` : ""}. Evidence \`${f.evidenceId}\`${f.attempt !== undefined ? `, attempt ${f.attempt}` : ""}.`,
};

/**
 * Ledger answers about the goal and the assumptions (PM-P6-1): person-facing,
 * answered without a model (models rule 20f a), each fact with its id.
 */
export const SESHAT_LEDGER_ANSWERS = {
  goalHead: (n: number) => (n === 1 ? "Our goal:" : `Our ${n} goals:`),
  noGoal:
    "There is no goal recorded yet. A goal is set with sekhemet goal, and I answer from it once it exists.",
  assumedHead: (n: number) =>
    n === 1 ? "What I assumed instead of asking:" : `What I assumed instead of asking (${n}):`,
  noAssumption: "I have logged no assumption: every open question so far was asked.",
  basedOn: (what: string) => `Based on: ${what}.`,
};

/**
 * Seshat's tool descriptions (`PM_TOOLS`, `ASK_RESEARCHER_TOOL` in
 * `pm/agent.ts`; PROMPT_STANDARD rules 13 and 18: at most two sentences
 * each). In DEC-31's words — issue, sprint, release, the Agent, the Research
 * model — and in DEC-36's frame: a change to an issue is a suggestion a
 * person applies or dismisses (planner-pm NEW-planner-pm-9, B4.8). The same
 * length as before, word for word where the meaning did not change; the tool
 * and argument names stay internal.
 */
export const PM_TOOL_COPY = {
  askResearcher:
    "Delegate a question that needs evidence (a library's API or licence, how a module really works, a security advisory, what research says, what the project did before) to the Research model; its answer cites sources and states its confidence. depth 'deep' runs sub-researchers and a verifier, for decisions such as choosing a technology; 'quick' suits a single fact.",
  findLibrary:
    "Search the npm or PyPI registry for an existing, permissively licensed package before proposing an issue that would build it from scratch. Results include the licence and whether it is safe to use.",
  libraryQuery: "What the package should do, or its name",
  updateIssue:
    "Suggest changing an issue's fields; a person applies or dismisses it. Include only fields that change.",
  priority: "1 urgent, 2 high, 3 medium, 4 low, 0 none",
  estimate: "points: 1, 2, 3, 5 or 8",
  day: "YYYY-MM-DD",
  createIssue: "Propose a new issue of at most 3 files and 200 changed lines.",
  moveIssue: "Propose moving an issue to ready, backlog or parked.",
  createSprint: "Propose a sprint with a goal, and optionally the issues planned into it.",
} as const;

/** `propose_update_card`'s `duplicate_of` field, `PM_TOOLS` in `pm/agent.ts`. */
export const DUPLICATE_OF_DESCRIPTION = "the issue this one duplicates";

/** `propose_split_card`'s tool description, `PM_TOOLS` in `pm/agent.ts`. */
export const PROPOSE_SPLIT_CARD_DESCRIPTION =
  'Propose splitting an issue that is too large or that the Agent failed on into smaller issues, each with only the acceptance criteria about its own behaviour. The original is closed as "Split into N issues".';

/** `start_project`'s tool description, `PM_TOOLS` in `pm/agent.ts`. */
export const START_PROJECT_DESCRIPTION =
  "Propose a new project from what the person wants built, in their words: the proposal is the plan they review — the brief, the first release's issues with criteria and points, the candidates by priority, issue zero (the ecosystem's own generator) and issue one (the first failing test). Applying it creates the project.";

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
  return `Start a project: ${group.buildSpec}. Review the plan: ${group.creates.epics} epic${group.creates.epics === 1 ? "" : "s"} and ${group.creates.issues} issue${group.creates.issues === 1 ? "" : "s"} in ${group.stack.name}, set up first by its own generator${whySuffix}`;
}

/** A split proposal's summary (`toProposals`, `pm/agent.ts`). */
export function splitSuggestedSummary(
  title: string,
  partCount: number,
  pointsSuffix: string,
  whySuffix: string,
): string {
  return `Suggested: split ${title} into ${partCount} issue${partCount === 1 ? "" : "s"}${pointsSuffix}${whySuffix}`;
}

/** A sprint bet's proposal summary, with its basis (PM-P6-8; `pm/judgement.ts`). */
export function sprintBetSummary(
  name: string,
  startsOn: string,
  endsOn: string,
  size: number,
  unit: string,
  basis: string,
): string {
  return `Plan ${name} (${startsOn} to ${endsOn}) with ${size} ${unit}. Why: ${basis}.`;
}

/** A split proposed instead of a retry (PM-P6-9; `pm/judgement.ts`). */
export function splitNotRetrySummary(title: string, partCount: number, why: string): string {
  return `Suggested: split ${title} into ${partCount} issues instead of retrying it. Why: ${why}.`;
}

/**
 * The parts of a split by an issue's own criteria (PM-P6-9, `splitByCriteria`):
 * each part's title and the spec the Coding model reads when it runs.
 */
export const SPLIT_BY_CRITERIA_COPY = {
  title: (title: string, part: number, parts: number) => `${title} (${part} of ${parts})`,
  spec: (spec: string, own: readonly string[]) =>
    `${spec}\n\nThis part delivers only: ${own.join("; ")}.`,
};

/** A proposed sprint's summary (`propose_create_cycle`, `pm/agent.ts`), in DEC-31's words. */
export function sprintProposalSummary(
  name: string,
  startsOn: string,
  endsOn: string,
  issues: number,
): string {
  return `Plan sprint ${name} (${startsOn} to ${endsOn})${issues ? ` with ${issues} ${issues === 1 ? "issue" : "issues"}` : ""}`;
}

/** A congestion step-budget proposal's summary (`respondToSignals`, `planner_live.ts`). */
export function stepBudgetSummary(cardId: string, before: number, after: number): string {
  return `Step budget of ${cardId}: ${before} → ${after}`;
}

/** A suspect-link revision's change-card summary (`reviseAndPropose`, `project_done.ts`). */
export function changeCardSummary(cardId: string, requirementId: string, version: number): string {
  return `Change issue for ${cardId} (${requirementId} v${version})`;
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
  cards: (n: number) => `${n} ${n === 1 ? "issue" : "issues"}`,
  notAType: (type: string) => `"${type}" is not a project Type.`,
};

/**
 * New project's folder in a workspace of many (TEAM-55, TEAM-60; DS-N8-3):
 * why a folder cannot take a new project, said before any approval is asked.
 */
export const NEW_FOLDER_REFUSAL = {
  hasProject: (name: string, workspace: string) =>
    `This folder already holds the project ${name}, in the workspace ${workspace}.`,
  nested: (folder: string, project: string, inside: boolean) =>
    inside
      ? `${folder} lies inside the folder of the project ${project}; a project's folder never lies inside another's. Choose a folder outside it.`
      : `${folder} contains the folder of the project ${project}; a project's folder never contains another's. Choose another folder.`,
  hasCode: (folder: string) =>
    `${folder} already holds code, so it is not a new project: add it as an existing repository instead.`,
  notAFolder: (folder: string) => `${folder} is a file, not a folder.`,
  notARepository: (folder: string) =>
    `${folder} is not a git repository: start a new project there instead, or run git init first.`,
  missing: (folder: string) => `There is no folder at ${folder} on this server.`,
  notAbsolute: "Name the folder by its full path, starting with / or ~.",
};

/** A plan sent for approval (TEAM-20, TEAM-42): why it cannot be applied or discarded around its approver. */
export const PLAN_APPROVAL_REFUSAL = {
  applied: (approver: string) =>
    `This plan was sent to ${approver} for approval: ${approver} approves it with Approve.`,
  discarded: (approver: string, sender: string) =>
    `This plan was sent to ${approver} for approval; only ${approver} or ${sender} can discard it.`,
};

/**
 * Card zero and card one (design-stage §2.4, DS-P2-1..3): the words of the
 * two cards a project started by conversation begins with, each read by the
 * Worker through the card's spec and criteria (`card_zero.ts`).
 */
export const CARD_ZERO_COPY = {
  // DEC-31: the title is read on the board and the issue page, so no *card* in it.
  title: (generator: string) => `Set the project up with ${generator}`,
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
  title: (behaviour: string) => `A failing test for ${behaviour}`,
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

/**
 * Seshat answering a question the Worker asks mid-issue, when Seshat's
 * weights are already resident (the queue's `askTeam`, `commands/queue.ts`).
 */
export const WORKER_QUESTION_COPY = {
  system:
    "You are Seshat, the project manager. A teammate (the coding Worker) is mid-card and asks a question its card's spec does not answer. Answer in at most three sentences, concretely, consistent with the spec and acceptance tests. If it is genuinely the lead's call, say so and give the most conservative choice.",
  prompt: (title: string, spec: string, doneWhen: string, question: string) =>
    `Card: ${title}\nSpec: ${spec}\nDone when: ${doneWhen}\n\nQuestion: ${question}`,
};
