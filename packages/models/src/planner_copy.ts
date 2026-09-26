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
  /** Seshat's quick answer (models rule 20f b): no tools, informational only. */
  quickAnswerSystem:
    "You give a short, informational first answer while the project manager is busy. You cannot create or change cards, plans, proposals or decisions, and you have no tools. Answer in at most four sentences, and say the full answer will follow.",
};
