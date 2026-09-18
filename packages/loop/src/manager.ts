import type { GateFailure } from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import { type LocalInferenceAdapter, reasoningForStep } from "@sekhemet/models";

export interface RepairPlanInput {
  card: CardRecord;
  stopReason: string;
  failures: GateFailure[];
  /** Acceptance tests and current scope-file contents, as the worker left them. */
  files: { path: string; content: string }[];
}

const MANAGER_SYSTEM = `You are the planning model in a coding harness. A smaller, faster worker model
attempted a task and did not pass verification. You do not edit files yourself.
Write a short repair plan the worker can follow exactly on its next attempt.

Rules:
1. State the root cause in one or two sentences, grounded in the failures shown.
2. Give the fix as numbered steps. Where code is needed, give the exact code.
3. Only touch the declared scope files. Never change a test.
4. If a scope file is badly broken, say "rewrite the whole file" and give its full contents.
5. No preamble, no alternatives, under 400 words unless full file contents are required.`;

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
      .join("\n") || "(no gate ran; the worker stopped without verifying)";

  const files = input.files.map((f) => `--- ${f.path} ---\n${f.content || "(empty)"}`).join("\n\n");

  const prompt = `CARD ${input.card.id}: ${input.card.spec ?? input.card.title}
Scope files: ${input.card.scopeFiles.join(", ")}
Acceptance criteria:
${(input.card.acceptanceCriteria ?? []).map((c, i) => `${i + 1}. ${c}`).join("\n")}

The worker stopped with: ${input.stopReason}
Gate failures:
${failures}

Files as the worker left them:
${files}

Write the repair plan now.`;

  // A repair plan is planning (M5, M6): the adapter's planning sampling, and
  // bounded thinking, since one good plan saves many Worker turns.
  const thinking = reasoningForStep({ purpose: "planning" });
  const response = await manager.generate({
    systemPrompt: MANAGER_SYSTEM,
    prompt,
    toolArm: "arm_b_json",
    // No temperature here: the adapter's planning sampling decides.
    maxTokens: 1800,
    purpose: "planning",
    reasoning: thinking.reasoning,
    reasoningBudgetTokens: thinking.reasoningBudgetTokens,
  });

  return response.text.trim();
}
