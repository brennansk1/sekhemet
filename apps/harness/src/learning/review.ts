import type { CardRecord } from "@sekhemet/kernel";
import type { LocalInferenceAdapter } from "@sekhemet/models";

/**
 * Seshat reviews a passing card before the human does.
 *
 * AutoDev (Microsoft, arXiv 2403.08299) found an AI Reviewer "could
 * pre-emptively identify AI Developer mistakes". Sekhemet's gates already
 * prove the code works; what they cannot see is what this user wants: the
 * profile's code-style statements and the approved rules. Reviewing against
 * those is how send-back reasons get caught before a person has to write
 * them. The review never blocks a card; it is advice attached to it.
 */
export interface ReviewFinding {
  severity: "consider" | "likely_send_back";
  note: string;
}

export async function reviewCard(
  model: LocalInferenceAdapter,
  input: { card: CardRecord; diff: string; preferences: string[]; rules: string[] },
): Promise<ReviewFinding[]> {
  if (input.preferences.length === 0 && input.rules.length === 0) return [];
  const res = await model.generate({
    systemPrompt:
      "You are Seshat, reviewing a teammate's change before the human lead sees it. The tests and type checks already pass; do not re-check correctness. Judge only whether the change follows the lead's stated preferences and the team's rules. Answer with JSON only.",
    prompt: `Card: ${input.card.title}\n\nTHE LEAD'S PREFERENCES\n${input.preferences.map((p) => `- ${p}`).join("\n") || "(none)"}\n\nTEAM RULES\n${input.rules.map((r) => `- ${r}`).join("\n") || "(none)"}\n\nDIFF\n${input.diff.slice(0, 12_000)}\n\nList only concrete violations you can point to in the diff (file and what to change). Say "likely_send_back" when it breaks a stated preference, "consider" for a softer issue. If there are none, return an empty list.\nReturn: {"findings":[{"severity":"consider"|"likely_send_back","note":"..."}]}`,
    toolArm: "arm_b_json",
    temperature: 0.1,
    maxTokens: 700,
  });
  try {
    const json = /\{[\s\S]*\}/.exec(res.text.replace(/<think>[\s\S]*?<\/think>/g, ""))?.[0];
    const parsed = (json ? JSON.parse(json) : {}) as { findings?: Partial<ReviewFinding>[] };
    return (parsed.findings ?? [])
      .filter((f) => typeof f.note === "string" && f.note.trim().length > 8)
      .map(
        (f): ReviewFinding => ({
          severity: f.severity === "likely_send_back" ? "likely_send_back" : "consider",
          note: String(f.note).trim().slice(0, 400),
        }),
      )
      .slice(0, 6);
  } catch {
    return [];
  }
}
