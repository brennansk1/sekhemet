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
