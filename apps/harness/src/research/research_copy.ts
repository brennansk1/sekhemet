/**
 * The Researcher's model-facing text added by design-stage NEW-design-stage-2,
 * -4 and -5 (PROMPT_STANDARD rule 13, CX-M1-13): the refusals its tools
 * return, the re-dispatch of an open sub-question, the critique pass and the
 * question the repair batch asks about a failing card. Registered as
 * `research` in `COPY_MODULES` (packages/context/src/prompt_tags.ts).
 */
export const researchCopy = {
  /** A fetch refused by `[network] fetch_deny`, naming the file and the rule (DS-N4-3). */
  denied: (host: string, rule: string, file: string) =>
    `Refusing ${host}: it is in [network] fetch_deny (rule "${rule}" in ${file}), so it is never fetched.`,

  /**
   * A fetch refused by `[network] mode = "allowlist"`. It begins "Refusing"
   * like every refusal, so the one reference checker never counts it as a
   * read (`isFetchRefusal`, DS-N2-4).
   */
  notAllowlisted: (host: string) =>
    `Refusing ${host}: it is not on the network allowlist (config.toml [network] allow).`,

  /**
   * A page that could not be read — a policy gate's or a fetcher's failure,
   * whatever its message. It begins "Refusing", so it never counts as a read
   * (`isFetchRefusal`, DS-N2-4).
   */
  unreadable: (host: string, why: string) => `Refusing ${host}: it could not be read (${why}).`,

  /** A search the same sub-question already ran: a re-dispatch uses different queries (DS-N4-2). */
  searchRepeated: (query: string) =>
    `The search "${query}" already ran for this sub-question. Use different keywords or another source.`,

  /** A sub-question's page reads are spent (DS-N4-1). */
  pagesSpent: (max: number) =>
    `The page budget for this sub-question (${max} page reads) is spent. Answer from what you have read.`,

  /**
   * An open sub-question dispatched once more (DS-N4-2): fewer than two
   * independent hosts of primary or secondary tier settled it.
   */
  redispatch: (subQuestion: string, tried: readonly string[], hosts: readonly string[]) =>
    [
      subQuestion,
      "",
      `This sub-question is still open: it needs two independent hosts of documentation, source code, papers, registries, repositories or forums, and its sources so far ${hosts.length === 0 ? "include zero hosts of that kind" : `come only from ${hosts.join(", ")}`}.`,
      tried.length > 0
        ? `Search with different queries from these, which already ran:\n${tried.map((q) => `- ${q}`).join("\n")}`
        : "Search with different queries from the ones that already ran.",
    ].join("\n"),

  /** The critique pass's system text. */
  critiqueSystem:
    "You revise research answers for a local software team. Use only the sources listed, cite them as [n], and never add a claim no listed source states.",

  /** The critique pass (DS-N2-6): one candidate revision of a draft, judged by measurement. */
  critique: (input: {
    question: string;
    draft: string;
    sources: string;
    badCitations: readonly number[];
    unreproduced: readonly string[];
    outstanding: readonly string[];
  }) =>
    [
      `QUESTION\n${input.question}`,
      `DRAFT\n${input.draft}`,
      `SOURCES READ\n${input.sources || "(none)"}`,
      "MEASURED PROBLEMS",
      input.badCitations.length > 0
        ? `- Citations that point at nothing read: ${input.badCitations.map((n) => `[${n}]`).join(", ")}. Cite a source listed above or remove the claim.`
        : "- Every citation points at a source read.",
      input.unreproduced.length > 0
        ? `- Statements about an API's behaviour that no run checked:\n${input.unreproduced.map((c) => `  - ${c}`).join("\n")}\n  Keep one only when a source above states it, and cite that source.`
        : "- No unchecked statement about an API's behaviour.",
      input.outstanding.length > 0
        ? `- Sub-questions still open: ${input.outstanding.join("; ")}. Say they are not settled rather than guessing.`
        : "- No open sub-question.",
      "",
      "Rewrite the draft to fix the measured problems, citing only the sources listed. Keep every claim the sources support. Where two sources disagree, add one line per disagreement after the answer, in this form:",
      "DISAGREEMENT: <topic> | <position> [n] | <other position> [m]",
      "Reply with the revised answer only.",
    ].join("\n\n"),

  /**
   * The question about a failing card (DS-N5-1): the card's spec, criteria
   * and scope, the failing gate's typed failure and the detected stack.
   */
  repairQuestion: (input: {
    title: string;
    spec: string;
    criteria: readonly string[];
    scopeFiles: readonly string[];
    stack: string;
    failure: {
      gate: string;
      location: string;
      expected?: string;
      actual: string;
      repro?: string;
    };
    struggle?: string;
  }) =>
    [
      `A coding model working on a ${input.stack} project failed this card and needs a correct approach before its repair plan is written.`,
      `CARD\n${input.title}\n\n${input.spec}`,
      input.criteria.length > 0
        ? `ACCEPTANCE CRITERIA\n${input.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
        : "ACCEPTANCE CRITERIA\n(none written)",
      `SCOPE FILES\n${input.scopeFiles.join("\n") || "(none declared)"}`,
      [
        "FAILING GATE",
        `gate: ${input.failure.gate}`,
        `location: ${input.failure.location}`,
        ...(input.failure.expected ? [`expected: ${input.failure.expected}`] : []),
        `actual: ${input.failure.actual}`,
        ...(input.failure.repro ? [`reproduce: ${input.failure.repro}`] : []),
      ].join("\n"),
      ...(input.struggle ? [`WHAT IT STRUGGLED WITH\n${input.struggle}`] : []),
      "What is the correct approach for this card, as it applies to this stack and these files? Cite the sources that settle it.",
    ].join("\n\n"),
} as const;
