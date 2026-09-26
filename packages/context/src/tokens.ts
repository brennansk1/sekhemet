/**
 * The one token estimator of the context package (CX-N1-2).
 *
 * The harness has no tokenizer dependency on purpose: every budget in the
 * design is a ceiling, and a deterministic characters-per-token estimate is
 * stable across machines. There is exactly one fallback ratio, here, and
 * every count — budgets, the allocator, pressure tiers, masking pointers,
 * condensing reports — goes through it, so they all agree. Code tokenizes
 * denser than prose: the reference Worker measured about 3.0 characters per
 * token, and 3.2 is the ratio the prompt budget has used since B0 (the
 * former 4 here undercounted by a quarter). Calibrating it to the model's
 * own tokenizer at card start is CX-N1-1.
 */
export const FALLBACK_CHARS_PER_TOKEN = 3.2;

/** The estimator on a length alone: it counts characters. */
export function tokensForChars(length: number): number {
  if (length <= 0) return 0;
  return Math.ceil(length / FALLBACK_CHARS_PER_TOKEN);
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return tokensForChars(text.length);
}

/** Characters that fit in a token count, by the same ratio (for cutting text). */
export function charsForTokens(tokens: number): number {
  return Math.max(0, Math.floor(tokens * FALLBACK_CHARS_PER_TOKEN));
}

/** Byte-stable thousands grouping (never locale-dependent). */
export function formatTokenCount(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
