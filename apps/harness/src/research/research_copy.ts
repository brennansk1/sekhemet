/**
 * The Researcher's model-facing text added by design-stage NEW-design-stage-2,
 * -4, -5 and P7 (PROMPT_STANDARD rule 13, CX-M1-13): the refusals its tools
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

  /**
   * A tool that reaches the network, called while research web access is off
   * (`[network] research`, `--offline`): nothing is sent.
   */
  webOff: (tool: string) => `Tool ${tool} needs web access, which is off for this project.`,

  /**
   * Seshat's `find_library` where no registry search was handed in: registries
   * are searched only through the research the person allowed (DS-S8-1).
   */
  registrySearchOff:
    'No registry was searched: package registries are searched only through research the person allowed ([network] research = "yes"). Plan without a package, or suggest the person ask the Researcher.',

  /**
   * A repository tool refused while answering the brief's deep question: that
   * question is built from keywords only, so its queries may carry nothing of
   * the repository (design-stage S8, DS-P7-10).
   */
  repositoryOff: (tool: string) =>
    `Tool ${tool} is off for this question: it does not read this repository. Search the web, papers, GitHub and the package registries instead.`,

  /**
   * The brief's deep question (design-stage DS-P7-10): what teams already use
   * for the product, asked from each need's keywords only — the words the
   * reuse survey may send (DS-S8-3), never the person's spec — and the
   * project's language.
   */
  priorArtQuestion: (keywords: readonly string[], language: string) =>
    [
      `A team is about to build a ${language} product whose parts are: ${keywords.map((k) => `"${k}"`).join(", ")}.`,
      "What do professional teams already use for these parts — maintained open-source libraries, hosted services or reference designs — and what should they know before choosing one? Name each option with its licence, and cite the sources that settle it.",
    ].join("\n\n"),
  /** A research host the person's yes does not cover (DS-S8-8), as a tool result or a plan line. */
  hostDeclined: (host: string) =>
    `${host} is not covered by your yes to research: you said no to it ([network] research_hosts_declined)`,
  hostAwaitsYes: (host: string) =>
    `${host} awaits a yes: the research question you answered did not name it (a new project's plan in a terminal asks; or add it to [network] research_hosts)`,

  /**
   * A page for another version than the project pins, or an unknown one
   * (design-stage DS-N9-8): it ranks after every page at the pinned version.
   */
  docsForVersion: (found: string | undefined, pinned: string) =>
    `[docs for ${found ?? "an unknown version"}; project pins ${pinned}]`,

  /** The head of documentation read at the pinned version (DS-N9-8, -10). */
  pinnedDocsHead: (name: string, version: string) =>
    `Documentation for ${name} at ${version}, the version this project pins: the parts of each page about the question, best first.`,

  /** A documentation set's size, when its pages were enumerated. */
  docsSetSize: (available: number, read: number) =>
    `(${available} pages in the set; the ${read} most relevant)`,

  /** A documentation root whose pages were all too short to read. */
  noReadableDocs: (root: string) => `No readable documentation pages under ${root}.`,

  /**
   * The pins of the packages a question names (DS-N9-11), appended to the
   * question so the answer is for the versions the project runs.
   */
  pins: (pins: readonly { eco: string; name: string; version: string }[]) =>
    `PROJECT PINS\nThis project pins ${pins.map((p) => `${p.name}@${p.version} (${p.eco})`).join(", ")}. Answer for these versions, and say when a source documents another one.`,

  /** The `probe` tool (DS-N9-13): its description and arguments. */
  probeTool: {
    description:
      "Run a program of at most 30 lines against a package installed in this project, sandboxed and offline, to check how its API behaves at the installed version. The program exits 0 when the statement holds and prints what it checked.",
    package: "The installed package (prefix python:, go: or rust: for another ecosystem).",
    language: "node for an npm package, python for a Python one.",
    code: "The program: Node code uses `require(name)` or `await load(name)`; Python code imports the package.",
    statement: "What the program shows, in one sentence, naming the API and the package.",
  },

  /** The question's probes are spent (DS-N9-13). */
  probesSpent: (max: number) =>
    `The probe budget for this question (${max} probes) is spent. Answer from the probes and sources you have.`,

  /** A probe of a package with nothing installed to run against. */
  probeNotInstalled: (pkg: string) =>
    `${pkg} has no installed copy in this project, so a probe has nothing to run against. Read its documentation or source instead.`,

  /** A probe refused before it ran (DS-N9-17's limits). */
  probeRefused: (refusal: string, limit?: number, actual?: number | string) =>
    refusal === "too_many_lines"
      ? `Probe refused before running: ${actual} lines, and the limit is ${limit}. Shorten it.`
      : refusal === "too_many_chars"
        ? `Probe refused before running: ${actual} characters, and the limit is ${limit}. Shorten it.`
        : `Probe refused before running: language "${actual}" is for another ecosystem; use node for npm packages and python for Python ones.`,

  /** A Go or Rust statement, recorded as documented (DS-N9-18). */
  probeDocumented: (target: string, reason: string) =>
    `Recorded for ${target}: ${reason}. Cite the documentation or source that states it.`,

  /** A probe that ran: its exit code and the program's own output, untrusted. */
  probeRan: (target: string, exitCode: number, timedOut: boolean, output: string) =>
    `Probe against ${target} ran: exit ${exitCode}${timedOut ? " (timed out)" : ""}. ${exitCode === 0 ? "The statement holds at this version; cite this probe for it." : "The statement is unconfirmed at this version."}\n${output}`,

  /**
   * The research packet's question to the Researcher (design-stage
   * DS-N9-16): the symbol and `pkg@ver` alone — never the card's text — so
   * it may leave the machine. Also the question a research note answers.
   */
  packetQuestion: (symbol: string, pkg: string, version: string, eco: string) =>
    `In ${pkg}@${version} (${eco}), what is the API for \`${symbol}\`? The installed package's declarations lack it. Give the API this version has for that purpose, with its signature, and cite the documentation or source at ${version}.`,

  /** The packet's question about a package the project has installed under another name, or lacks. */
  packetPackageQuestion: (name: string) =>
    `What is the \`${name}\` package, which registry publishes it, and what does it provide? Cite its registry or documentation page.`,

  /**
   * The packet's dossier entries (DS-N9-22): research data for the card,
   * each at most 400 characters, read by the Coding model as untrusted.
   */
  packet: {
    /** A member the installed package lacks, with the nearest it declares. */
    local: (written: string, target: string, near: readonly string[]) =>
      `\`${written}\` is missing from ${target}'s API. Closest at that version: ${near.join("; ")}.`,
    /** One near member: its signature, its type and where it is declared. */
    member: (signature: string, container: string | undefined, ref: string) =>
      `\`${signature}\` (${container ? `in ${container}, ` : ""}${ref})`,
    /** A member the installed package lacks, with every declared name far from it. */
    absent: (written: string, target: string) =>
      `\`${written}\` is missing from ${target}'s API, and every name it declares is far from it.`,
    /** A research note fed to the card (DS-N9-20). */
    note: (written: string, target: string, checked: string, excerpt: string) =>
      `\`${written}\` at ${target} (research note, ${checked}): ${excerpt}`,
    /** How a note was checked. */
    checkedBy: (kind: "probe" | "citation") =>
      kind === "probe" ? "shown by a sandboxed probe" : "its cited source re-checked",
    /** A Researcher's answer that is not a note: plain research. */
    research: (written: string, target: string, answer: string) =>
      `Researcher on \`${written}\` at ${target}: ${answer}`,
    /** A package the project lacks: its pin, and installed packages with near names. */
    package: (name: string, pinned: string | undefined, near: readonly string[]) =>
      `\`${name}\` is absent from this project's installed packages${pinned ? `; its lockfile pins ${pinned}, so it needs installing first` : ""}${near.length ? `; installed packages with near names: ${near.join(", ")}` : ""}.`,
  },
} as const;
