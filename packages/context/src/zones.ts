import { createHash } from "node:crypto";
import { estimateTokens } from "./tokens.js";

/**
 * Prompt zone budgets, prefix stability and template hygiene
 * (Design §405-416, §1107; CHRONICLE §5 gotcha 1).
 */

export type PromptZone = "system" | "tool_interface" | "conventions" | "repo_map" | "volatile";

/**
 * §1107: "Target under 1,000 tokens, with the tool interface under 2,000.
 * Long system prompts cost prefill on every step, which is the binding
 * constraint."
 */
export const PROMPT_ZONE_BUDGETS: Record<"system" | "tool_interface", number> = {
  system: 1000,
  tool_interface: 2000,
};

export class PromptZoneBudgetError extends Error {
  public readonly zone: PromptZone;
  public readonly tokens: number;
  public readonly budget: number;

  constructor(zone: PromptZone, tokens: number, budget: number) {
    super(`Prompt zone "${zone}" is ${tokens} tokens, over its ${budget}-token budget`);
    this.name = "PromptZoneBudgetError";
    this.zone = zone;
    this.tokens = tokens;
    this.budget = budget;
  }
}

export interface ZoneBudgetReport {
  zone: PromptZone;
  tokens: number;
  budget: number;
  withinBudget: boolean;
}

export function measureZone(zone: PromptZone, text: string, budget: number): ZoneBudgetReport {
  const tokens = estimateTokens(text);
  return { zone, tokens, budget, withinBudget: tokens < budget };
}

/** Throws {@link PromptZoneBudgetError} when the zone is at or over its budget. */
export function assertZoneBudget(zone: PromptZone, text: string, budget: number): ZoneBudgetReport {
  const report = measureZone(zone, text, budget);
  if (!report.withinBudget) {
    throw new PromptZoneBudgetError(zone, report.tokens, budget);
  }
  return report;
}

export function assertSystemZoneBudget(text: string): ZoneBudgetReport {
  return assertZoneBudget("system", text, PROMPT_ZONE_BUDGETS.system);
}

export function assertToolInterfaceBudget(text: string): ZoneBudgetReport {
  return assertZoneBudget("tool_interface", text, PROMPT_ZONE_BUDGETS.tool_interface);
}

/** The design's four prompt zones, by what they hold. */
export type PromptZoneNumber = 1 | 2 | 3 | 4;

/**
 * Design §580: the per-zone caps are fractions of the tier's working budget
 * $W$, not absolute counts, so they scale with the window a tier actually
 * gets. Zone 4 is the remainder and has a floor rather than a ceiling: the
 * tail is where the goal, the failure and the last turns live, and starving
 * it is how a prompt ends up full of material the model never reaches.
 */
export const PROMPT_ZONE_FRACTIONS: Record<PromptZoneNumber, number> = {
  1: 0.12,
  2: 0.1,
  3: 0.5,
  4: 0.2,
};

const ZONE_NAMES: Record<PromptZoneNumber, string> = {
  1: "system and tool catalog",
  2: "playbook, skills and exemplars",
  3: "code context",
  4: "volatile tail",
};

export interface ZoneFractionReport {
  zone: PromptZoneNumber;
  name: string;
  tokens: number;
  /** The cap (zones 1-3) or the floor (zone 4), in tokens. */
  budget: number;
  withinBudget: boolean;
}

export class PromptZoneFractionError extends Error {
  public readonly zone: PromptZoneNumber;
  public readonly tokens: number;
  public readonly budget: number;

  constructor(report: ZoneFractionReport, workingBudget: number) {
    super(
      `Prompt zone ${report.zone} (${report.name}) is ${report.tokens} tokens, over its ${report.budget}-token cap (${PROMPT_ZONE_FRACTIONS[report.zone]} of a ${workingBudget}-token working budget)`,
    );
    this.name = "PromptZoneFractionError";
    this.zone = report.zone;
    this.tokens = report.tokens;
    this.budget = report.budget;
  }
}

/**
 * Measure the four zones against their fractions of the working budget.
 *
 * Zones 1 to 3 have ceilings. Zone 4 is "the remainder, never below 0.20W":
 * the floor is on the room left for the tail, not on how much of it a given
 * step happens to use — an early step with no history and no failure is short
 * because there is nothing to say yet, which is not a breach.
 */
export function measureZoneFractions(
  tokens: Record<PromptZoneNumber, number>,
  workingBudget: number,
): ZoneFractionReport[] {
  const remainder = workingBudget - tokens[1] - tokens[2] - tokens[3];
  return ([1, 2, 3, 4] as PromptZoneNumber[]).map((zone) => {
    const budget = Math.floor(workingBudget * (PROMPT_ZONE_FRACTIONS[zone] as number));
    return {
      zone,
      name: ZONE_NAMES[zone] as string,
      tokens: tokens[zone],
      budget,
      withinBudget: zone === 4 ? remainder >= budget : tokens[zone] <= budget,
    };
  });
}

/**
 * The working budget below which the fractional caps cannot bind.
 *
 * The lowest tier runs a 12,288-token window (`calibration.ts`), which leaves
 * a working budget smaller still once the output reserve is taken; at that
 * size 0.12W is under 1,200 tokens, less than the immutable system prompt plus
 * any usable tool catalog, so every build would breach a cap it has no way to
 * meet. A window that small failing to hold a prompt is already reported as
 * `budget_exhausted`. Test fixtures that exercise the cutting logic with toy
 * budgets sit far below this; production sits above it from the second tier up.
 */
export const MIN_ASSERTED_WORKING_BUDGET = 12_288;

/**
 * Assert the prefix zones, which the allocator never cuts.
 *
 * Zones 1 and 2 are required or pinned sections: nothing downstream can shrink
 * them, so an overflow is silent overflow — the one outcome §580 rules out.
 * Zones 3 and 4 are reported instead of thrown, because the allocator already
 * shrinks the repo map and drops the lowest-ranked sections to fit, and a card
 * whose code context still will not fit fails the Ready entry condition
 * upstream rather than dying mid-turn.
 */
export function assertPrefixZoneFractions(
  reports: ZoneFractionReport[],
  workingBudget: number,
): void {
  if (workingBudget < MIN_ASSERTED_WORKING_BUDGET) return;
  for (const report of reports) {
    if ((report.zone === 1 || report.zone === 2) && !report.withinBudget) {
      throw new PromptZoneFractionError(report, workingBudget);
    }
  }
}

export class PromptPlaceholderError extends Error {
  public readonly offender: string;
  public readonly where: string;

  constructor(offender: string, where: string) {
    super(
      `Banned placeholder ${offender} found in ${where}: Qwen-class models copy bracketed placeholders verbatim. Use numbered requirements and empty skeletons instead.`,
    );
    this.name = "PromptPlaceholderError";
    this.offender = offender;
    this.where = where;
  }
}

/**
 * CHRONICLE §5 gotcha 1: "If prompt has `code: <insert code here>`, it outputs
 * verbatim `<insert code here>`." Bracketed placeholders are therefore banned
 * from every template the model sees; prompts use numbered requirements and
 * empty skeletons.
 */
const BANNED_PLACEHOLDER_PATTERNS: RegExp[] = [
  /\[[A-Z][A-Z0-9_]*(?:\s+[A-Z0-9_]+)*\]/,
  /<[A-Z][A-Z0-9_]*>/,
  /<[^<>]{0,60}(?:insert|your|here|placeholder|todo|fill in)[^<>]{0,60}>/i,
  /\{\{[^}]{0,60}\}\}/,
];

export function findBannedPlaceholder(text: string): string | undefined {
  for (const pattern of BANNED_PLACEHOLDER_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[0]) return match[0];
  }
  return undefined;
}

/** Throws when a prompt template contains a bracketed placeholder. */
export function assertNoBannedPlaceholders(text: string, where: string): void {
  const offender = findBannedPlaceholder(text);
  if (offender) {
    throw new PromptPlaceholderError(offender, where);
  }
}

/**
 * Byte-stable prefix hash (C15 / design M2).
 *
 * Zones 1 and 2 must be byte-identical across steps within a card for the
 * inference server's prefix cache to hit. Hashing them gives the harness a
 * cheap assertion: if this value changes mid-card, the cache was invalidated
 * and the step paid a full prefill.
 */
export function computePrefixHash(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt, "utf8").digest("hex");
}

/** True when two prompt prefixes are byte-identical. */
export function prefixIsStable(hashA: string, hashB: string): boolean {
  return hashA === hashB;
}
