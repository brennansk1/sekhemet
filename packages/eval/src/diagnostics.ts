import {
  type ContextDebtRecommendation,
  PlaybookRegistry,
  type SkillManifest,
  contextDebtRecommendations,
  estimatePromptTokens,
} from "@sekhemet/context";
import { QUALIFICATION_BAR, type QualificationResult, qualifyModel } from "@sekhemet/models";
import type { LocalInferenceAdapter, ModelRegistry } from "@sekhemet/models";

/**
 * Doctor diagnostics for skills and the playbook (E19, design "Skill &
 * playbook diagnostics"): the net gain of each rule (pass rate with it
 * minus without), how much of the system-prompt budget rules and skills
 * take (context bloat), skills that never trigger, and pruning
 * recommendations. Qualification scoring for models (E6) lives here too,
 * over the models package's deterministic suite.
 */
export interface RuleOutcome {
  ruleId: string;
  /** Cards that ran with the rule in the prompt, and how many passed. */
  withRule: { cards: number; passed: number };
  withoutRule: { cards: number; passed: number };
}

export interface PlaybookDiagnostics {
  netGain: { ruleId: string; gain: number | undefined; samples: number }[];
  bloat: {
    ruleTokens: number;
    skillTokens: number;
    systemBudget: number;
    share: number;
    over: boolean;
  };
  neverTriggered: string[];
  recommendations: ContextDebtRecommendation[];
  lines: string[];
}

export function playbookDiagnostics(input: {
  repoPath: string;
  outcomes?: RuleOutcome[];
  skills?: SkillManifest[];
  /** Card titles and files the skills are matched against (recent cards). */
  recentCards?: { title: string; scopeFiles: string[] }[];
  systemBudget?: number;
}): PlaybookDiagnostics {
  const registry = new PlaybookRegistry(input.repoPath);
  const rules = registry.getAllRules();
  const netGain = rules.map((r) => {
    const o = input.outcomes?.find((x) => x.ruleId === r.id);
    const samples = o ? Math.min(o.withRule.cards, o.withoutRule.cards) : 0;
    const gain =
      o && samples > 0
        ? Math.round(
            (o.withRule.passed / o.withRule.cards - o.withoutRule.passed / o.withoutRule.cards) *
              1000,
          ) / 1000
        : undefined;
    return { ruleId: r.id, gain, samples };
  });
  const audit = registry.auditContextDebt({
    performance: (input.outcomes ?? [])
      .filter((o) => o.withRule.cards > 0 && o.withoutRule.cards > 0)
      .map((o) => ({
        ruleId: o.ruleId,
        passRateWithRule: o.withRule.passed / o.withRule.cards,
        passRateWithoutRule: o.withoutRule.passed / o.withoutRule.cards,
        samplesWithRule: o.withRule.cards,
        samplesWithoutRule: o.withoutRule.cards,
      })),
  });
  const ruleTokens = rules.reduce((a, r) => a + estimatePromptTokens(r.instruction), 0);
  const skillTokens = (input.skills ?? []).reduce((a, s) => a + estimatePromptTokens(s.content), 0);
  const systemBudget = input.systemBudget ?? 1000;
  const share = Math.round(((ruleTokens + skillTokens) / systemBudget) * 1000) / 1000;
  const neverTriggered = (input.skills ?? [])
    .filter(
      (s) =>
        !(input.recentCards ?? []).some((c) => {
          const text = `${c.title} ${c.scopeFiles.join(" ")}`.toLowerCase();
          return s.triggers.some((t) => text.includes(t.toLowerCase()));
        }),
    )
    .map((s) => s.name)
    .sort();
  const recommendations = contextDebtRecommendations(audit);
  const lines = [
    `Playbook: ${rules.length} rules (${ruleTokens} tokens), skills ${skillTokens} tokens: ${(share * 100).toFixed(0)}% of the ${systemBudget}-token system budget${share > 1 ? " (OVER)" : ""}.`,
    ...netGain
      .filter((g) => g.gain !== undefined)
      .map(
        (g) =>
          `  ${g.ruleId}: net gain ${((g.gain as number) * 100).toFixed(1)} points over ${g.samples} cards`,
      ),
    ...(neverTriggered.length
      ? [`  Skills that never triggered on recent cards: ${neverTriggered.join(", ")}`]
      : []),
    ...recommendations
      .filter((r) => r.action !== "keep")
      .map((r) => `  ${r.action.toUpperCase()} ${r.ruleId}: ${r.reason}`),
  ];
  return {
    netGain,
    bloat: { ruleTokens, skillTokens, systemBudget, share, over: share > 1 },
    neverTriggered,
    recommendations,
    lines,
  };
}

/** E6: qualify candidate models and rank them by the deterministic score. */
export async function qualifyCandidates(
  adapters: readonly LocalInferenceAdapter[],
  options: {
    registry?: ModelRegistry;
    bar?: number;
    release?: (a: LocalInferenceAdapter) => Promise<void>;
  } = {},
): Promise<{ modelId: string; best: QualificationResult; qualified: boolean }[]> {
  const out: { modelId: string; best: QualificationResult; qualified: boolean }[] = [];
  for (const a of adapters) {
    const { best } = await qualifyModel(a, {
      ...(options.registry ? { registry: options.registry } : {}),
      bar: options.bar ?? QUALIFICATION_BAR,
    });
    out.push({ modelId: a.modelId, best, qualified: best.qualified });
    await options.release?.(a);
  }
  return out.sort(
    (x, y) => y.best.passRate - x.best.passRate || x.modelId.localeCompare(y.modelId),
  );
}
