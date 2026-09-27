import {
  type ContextSection,
  allocateContext,
  allocationBudget,
  estimatePromptTokens,
} from "@sekhemet/context";
import type { GateFailure } from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import { type LocalInferenceAdapter, reasoningForStep } from "@sekhemet/models";
import { replanCopy } from "./replan_copy.js";

export interface RepairPlanInput {
  card: CardRecord;
  stopReason: string;
  failures: GateFailure[];
  /** Acceptance tests and current scope-file contents, as the worker left them. */
  files: { path: string; content: string }[];
  /**
   * What the Researcher found before this repair (design-stage DS-N5-2): the
   * grounded answer and its sources, shown whole as a required section.
   */
  research?: { answer: string; sources: string[] };
}

const MANAGER_SYSTEM = replanCopy.system;

/**
 * Ask the manager model for a repair plan for a failed card.
 *
 * This is the escalation rung the worker cannot climb alone: a small model
 * that has failed the same gate repeatedly rarely diagnoses its own mistake,
 * while a stronger model reading the same evidence usually can. The plan is
 * returned as text and injected into the worker's next attempt as a directive.
 */
export async function planRepair(
  manager: LocalInferenceAdapter,
  input: RepairPlanInput,
): Promise<string> {
  const failures =
    input.failures
      .slice(0, 3)
      .map(
        (f, i) =>
          `${i + 1}. [${f.gate ?? f.rung}] ${f.errorExcerpt}${f.minimalRepro ? `\n   reproduce: ${f.minimalRepro}` : ""}`,
      )
      .join("\n") || replanCopy.noGateRan;

  // A repair plan is planning (M5, M6): the adapter's planning sampling, and
  // bounded thinking, since one good plan saves many Worker turns.
  const thinking = reasoningForStep({ purpose: "planning" });
  const prompt = replanPrompt(input, failures, {
    windowTokens: manager.contextWindow?.contextTokens ?? PLANNER_DEFAULT_WINDOW,
    answerTokens: REPLAN_ANSWER_TOKENS + thinking.reasoningBudgetTokens,
  });

  const response = await manager.generate({
    systemPrompt: MANAGER_SYSTEM,
    prompt,
    toolArm: "arm_b_json",
    // No temperature here: the adapter's planning sampling decides.
    maxTokens: REPLAN_ANSWER_TOKENS,
    purpose: "planning",
    reasoning: thinking.reasoning,
    reasoningBudgetTokens: thinking.reasoningBudgetTokens,
  });

  return response.text.trim();
}

/** The re-plan's answer cap. */
const REPLAN_ANSWER_TOKENS = 1800;
/** The smallest useful part of a file in the re-plan prompt. */
const REPLAN_FILE_MIN_TOKENS = 200;
/** The Planner's window when its adapter does not say (the roster's manager profile). */
const PLANNER_DEFAULT_WINDOW = 8192;

/**
 * The re-plan prompt, fitted to the Planner's window by the allocator
 * (context rule 10c, CX-N3-8): the card and its spec at the start, the stop
 * reason with the failures and the closing instruction are never cut; the
 * acceptance tests, then the scope files, are each shrunk or dropped by
 * priority instead of a fixed 8,000 characters.
 */
function replanPrompt(
  input: RepairPlanInput,
  failures: string,
  window: { windowTokens: number; answerTokens: number },
): string {
  const required: ContextSection[] = [
    {
      id: "card",
      kind: "contract",
      placement: "static",
      order: 0,
      priority: 100,
      required: true,
      text: replanCopy.card(
        input.card.id,
        input.card.spec ?? input.card.title,
        input.card.scopeFiles.join(", "),
        (input.card.acceptanceCriteria ?? []).map((c, i) => `${i + 1}. ${c}`).join("\n"),
      ),
    },
    {
      id: "failure",
      kind: "failure",
      placement: "static",
      order: 10,
      priority: 100,
      required: true,
      text: replanCopy.stopped(input.stopReason, failures),
    },
    ...(input.research
      ? [
          {
            id: "research",
            kind: "dossier" as const,
            placement: "static" as const,
            order: 15,
            priority: 100,
            required: true,
            text: replanCopy.research(input.research.answer, input.research.sources),
          },
        ]
      : []),
    {
      id: "files_header",
      kind: "notice",
      placement: "static",
      order: 20,
      priority: 100,
      required: true,
      text: replanCopy.filesHeader,
    },
    {
      id: "goal",
      kind: "goal",
      placement: "volatile",
      order: 1000,
      priority: 100,
      required: true,
      text: replanCopy.close,
    },
  ];
  const options = {
    role: "planner" as const,
    windowTokens: window.windowTokens,
    answerTokens: window.answerTokens,
    overheadTokens: estimatePromptTokens(MANAGER_SYSTEM),
  };
  // Each file's cap is its share of what the required sections leave, so
  // every file is shown in part rather than one in full and the rest dropped.
  const left =
    allocationBudget(options) -
    options.overheadTokens -
    required.reduce((n, s) => n + estimatePromptTokens(s.text) + 1, 0);
  const share = Math.max(
    REPLAN_FILE_MIN_TOKENS,
    Math.floor(left / Math.max(1, input.files.length)) - 1,
  );
  const files = input.files.map(
    (f, i): ContextSection => ({
      id: `file:${f.path}`,
      kind: f.path.startsWith("tests/") ? "tests" : "scope_file",
      placement: "static",
      order: 30 + i,
      // Acceptance tests are kept longer than scope files (rule 10a).
      priority: f.path.startsWith("tests/") ? 90 : 85,
      capTokens: share,
      minTokens: REPLAN_FILE_MIN_TOKENS,
      text: replanCopy.file(f.path, f.content),
    }),
  );
  const allocation = allocateContext([...required, ...files], options);
  return allocation.sections.map((s) => s.text).join("\n\n");
}
