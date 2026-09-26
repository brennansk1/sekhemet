/**
 * The Worker's section priorities that context rule 10a orders (CX-N3-2):
 * the tool contract, the card's contract and acceptance tests, the standing
 * failure with one remedy, the scope files, the dossier's directives (a
 * re-plan's plan and the rung's directive with them), the working memory, the
 * playbook rules (error-matched first), recent steps, the repo map, and the
 * team note last. Higher is kept longer; the pinned scope files and the
 * acceptance test are never the first thing cut. A budget policy: part of
 * the context version (rule 27).
 */
export const WORKER_PRIORITIES = {
  tests: 97,
  // failure 95 and scope files 90 are set where they are built.
  remedy: 94,
  plan: 88,
  dossier: 86,
  rung: 84,
  lessons: 82,
  errorRules: 78,
  rules: 77,
  // recent steps 70, the repo map 10.
  team: 8,
} as const;
