/**
 * Some mechanisms are packages, not cards (planner-pm §2.1.10, PM-P1-20):
 * a plan that shows one as a single card is wrong by an order of magnitude,
 * so the card is refused and the mechanism is re-split as an epic of its own.
 */
export const MECHANISM_PACKAGES: readonly { name: string; pattern: RegExp }[] = [
  { name: "deep-research pipeline", pattern: /\bdeep[\s-]?research\s+pipeline\b/i },
  { name: "tracker adapter", pattern: /\b(?:issue\s+)?tracker\s+adapter\b/i },
  { name: "language-server pool", pattern: /\b(?:language[\s-]server|lsp)\s+pool\b/i },
  { name: "sandbox policy assembler", pattern: /\bsandbox\s+policy\s+assembler\b/i },
  { name: "repo map", pattern: /\b(?:repo|repository)\s+map\b/i },
  { name: "failure-parser set", pattern: /\bfailure[\s-]parsers?(?:\s+set)?\b/i },
  { name: "virtualised board", pattern: /\bvirtuali[sz]ed\s+(?:kanban\s+)?board\b/i },
  { name: "visual-gate stack", pattern: /\bvisual[\s-]gate(?:\s+stack)?\b/i },
];

/** The mechanism of §2.1.10 a text names, or undefined. */
export function mechanismIn(text: string): string | undefined {
  return MECHANISM_PACKAGES.find((m) => m.pattern.test(text))?.name;
}
