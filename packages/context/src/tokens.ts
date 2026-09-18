/**
 * Shared token accounting for the context package.
 *
 * The harness has no tokenizer dependency on purpose: every budget in the
 * design is a ceiling, and a deterministic 4-chars-per-token estimate is both
 * stable across machines and conservative enough to keep packs under the
 * model's window. Everything that reports a token count uses this function so
 * that budgets, pressure tiers and masking pointers all agree.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Byte-stable thousands grouping (never locale-dependent). */
export function formatTokenCount(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
