import { type CardClassInput, cardKind } from "@sekhemet/kernel";
import type { RuleScope } from "./learning/store.js";

/**
 * Scopes for the rules the queue proposes itself (context CX-N4-1): a rule
 * with an empty scope would reach every prompt and is refused when written,
 * so each proposal names what it is for.
 */

/** An error code a struggle names: TypeScript, ESLint/Biome-style, Python, or an exception name. */
const ERROR_CODE = /\b(TS\d{4,5}|E\d{3,5}|[A-Z][A-Za-z]*(?:Error|Exception))\b/;

/**
 * A Researcher's rule answers one struggle: scoped to the error code the
 * struggle names, and to the card's kind; with no code, to the kind alone.
 */
export function researchRuleScope(card: CardClassInput, struggle: string): RuleScope {
  const code = ERROR_CODE.exec(struggle)?.[1];
  return { ...(code ? { errorPattern: code } : {}), kind: cardKind(card) };
}

/**
 * The E5 candidate rule a fixture run adopts for that run only, with the
 * gated rule's own scope (`SEKHEMET_CANDIDATE_SCOPE`, JSON). Undefined when
 * either is missing: an unscoped candidate is not proposed.
 */
export function candidateRuleFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): { text: string; scope: RuleScope } | undefined {
  const text = env.SEKHEMET_CANDIDATE_RULE?.trim();
  const raw = env.SEKHEMET_CANDIDATE_SCOPE;
  if (!text || !raw) return undefined;
  try {
    const scope = JSON.parse(raw) as RuleScope;
    return scope && typeof scope === "object" ? { text, scope } : undefined;
  } catch {
    return undefined;
  }
}
