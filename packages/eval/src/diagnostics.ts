import {
  type ContextDebtRecommendation,
  PlaybookRegistry,
  type SkillManifest,
  SkillsRegistry,
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

/** A finished card, as the ledger recorded it: what the skills are matched against, and whether it passed. */
export interface SkillCardOutcome {
  title: string;
  scopeFiles: string[];
  passed: boolean;
}

/** One skill's line in `doctor` (EXT-26, extensibility item 16). */
export interface SkillDiagnostic {
  name: string;
  /** The body's prompt tokens when it is selected. */
  tokens: number;
  /** Recent finished cards the skill is selected for, of `recentCards`. */
  triggered: number;
  recentCards: number;
  withSkill: { cards: number; passed: number };
  withoutSkill: { cards: number; passed: number };
  /** Pass rate with it minus without; undefined until both sides have a card. */
  netGain: number | undefined;
}

/**
 * Per skill (EXT-26): its token cost, how many recent finished cards it is
 * selected for — by the same deterministic selection the card's prompt uses
 * (rule 12) — and its net gain over those cards' recorded outcomes.
 */
export function skillDiagnostics(
  skills: readonly SkillManifest[],
  cards: readonly SkillCardOutcome[],
): SkillDiagnostic[] {
  return skills
    .map((s) => {
      const one = new SkillsRegistry();
      one.registerSkill(s);
      const on = cards.filter((c) => one.resolveActiveSkills(c.title, c.scopeFiles).length > 0);
      const off = cards.filter((c) => !on.includes(c));
      const rate = (xs: readonly SkillCardOutcome[]) => xs.filter((c) => c.passed).length;
      const withSkill = { cards: on.length, passed: rate(on) };
      const withoutSkill = { cards: off.length, passed: rate(off) };
      const netGain =
        on.length > 0 && off.length > 0
          ? Math.round((withSkill.passed / on.length - withoutSkill.passed / off.length) * 1000) /
            1000
          : undefined;
      return {
        name: s.name,
        tokens: estimatePromptTokens(s.content),
        triggered: on.length,
        recentCards: cards.length,
        withSkill,
        withoutSkill,
        netGain,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
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
  /** Per skill, when recorded card outcomes were given (EXT-26). */
  skills: SkillDiagnostic[];
  recommendations: ContextDebtRecommendation[];
  lines: string[];
}

export function playbookDiagnostics(input: {
  repoPath: string;
  outcomes?: RuleOutcome[];
  skills?: SkillManifest[];
  /** Card titles and files the skills are matched against (recent cards). */
  recentCards?: { title: string; scopeFiles: string[] }[];
  /** Recent finished cards with their recorded outcome (EXT-26); they count as recent cards too. */
  cardOutcomes?: SkillCardOutcome[];
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
  // One selection rule for the prompt and the report (rule 12): whole-word
  // triggers, or the description when a skill has none.
  const recent = [...(input.recentCards ?? []), ...(input.cardOutcomes ?? [])];
  const neverTriggered = skillDiagnostics(
    input.skills ?? [],
    recent.map((c) => ({ ...c, passed: false })),
  )
    .filter((s) => s.triggered === 0)
    .map((s) => s.name);
  const skills = input.cardOutcomes ? skillDiagnostics(input.skills ?? [], input.cardOutcomes) : [];
  const recommendations = contextDebtRecommendations(audit);
  const lines = [
    `Playbook: ${rules.length} rules (${ruleTokens} tokens), skills ${skillTokens} tokens: ${(share * 100).toFixed(0)}% of the ${systemBudget}-token system budget${share > 1 ? " (OVER)" : ""}.`,
    ...netGain
      .filter((g) => g.gain !== undefined)
      .map(
        (g) =>
          `  ${g.ruleId}: net gain ${((g.gain as number) * 100).toFixed(1)} points over ${g.samples} cards`,
      ),
    ...skills.map(
      (k) =>
        `  Skill ${k.name}: ${k.tokens} tokens, triggered on ${k.triggered} of ${k.recentCards} recent cards, net gain ${
          k.netGain === undefined
            ? "unmeasured"
            : `${k.netGain >= 0 ? "+" : ""}${(k.netGain * 100).toFixed(1)} points (${k.withSkill.passed}/${k.withSkill.cards} with, ${k.withoutSkill.passed}/${k.withoutSkill.cards} without)`
        }`,
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
    skills,
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
