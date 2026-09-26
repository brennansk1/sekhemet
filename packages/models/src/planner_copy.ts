/**
 * The Planner's copy module (PROMPT_STANDARD rule 13; context CX-M1-13): the
 * sentences the Planner and Seshat (the Planner's weights) read about their
 * indexed tools (worker-loop rule 11a, WL-N8-1), and Seshat's quick answer
 * while the Worker runs (models rule 20f b). Registered in `COPY_MODULES`
 * as `planner`.
 */
export const plannerCopy = {
  toolSearch: {
    description:
      "Load the full schema of tools listed in the TOOLS index, by exact name or by keywords, before calling them. The schemas arrive as a message; then call the tool by its name.",
    query: "Tool names from the index, or keywords, separated by spaces",
  },
  indexHeader: (count: number): string =>
    `TOOLS (${count}): load a tool's schema with tool_search before calling it.`,
  loaded: (count: number): string => `Loaded ${count} tool schema(s); call them by name:`,
  noMatch: (query: string): string =>
    `No tool matches "${query}". Use a name from the TOOLS index.`,
  notLoaded: (name: string): string =>
    `[ERROR]: ${name} is not loaded; load it with tool_search first.`,
  /** The combination benchmark's end-to-end check (measurement MS-N5-7): the plan the Worker is given. */
  benchmarkPlanSystem:
    "You are the Planner. Write a short numbered plan the Worker will follow to finish this card. Plain text only.",
  /** Seshat's quick answer (models rule 20f b): no tools, informational only. */
  quickAnswerSystem:
    "You give a short, informational first answer while the project manager is busy. You cannot create or change cards, plans, proposals or decisions, and you have no tools. Answer in at most four sentences, and say the full answer will follow.",
  /** The SPIDR slicer's system prompt (spidr.ts, optional model assistance). */
  sliceLines: [
    "Decompose the specification into SPIDR vertical slices.",
    "Kinds: spike (technical uncertainty), interface (types and contracts), data (persistence),",
    "path (happy path, then one slice per named failure mode), rule (validation, authz, limits).",
    "Every slice must be independently shippable and touch at most three files.",
    "Use only the nouns the specification uses.",
    "For each slice give its acceptance criteria: each one sentence a test can check, with concrete values — Given ..., when ..., then ... — and, when it has values, its examples as rows of the arguments passed and the value expected.",
    "A rule about repeated requests states the correct behaviour: a retried request returns the original result.",
    "Name the function each slice's test calls: its symbol, the file that exports it and its signature.",
    'Reply with JSON only: {"slices":[{"kind":"path","title":"Refund a paid invoice","keywords":["refund","invoice"],"rationale":"...","criteria":[{"text":"Given a paid invoice of 1000 cents, refunding 400 leaves 600","examples":[{"args":[1000,400],"expected":600}]}],"interface":[{"symbol":"refundInvoice","file":"src/refund.ts","signature":"refundInvoice(paidCents: number, refundCents: number): number"}]}]}',
  ] as readonly string[],
  /** The oracle's independent second sample (oracle.ts, PM-N7-2). */
  oracleSystem:
    'You compute what a function must return according to a specification. Reply with JSON only: {"expected": <value>}.',
  oracleQuestion: (call: string): string => `What does ${call} return?`,
};
