/**
 * The Worker's copy module (PROMPT_STANDARD rule 13; context CX-M1-2): the
 * sentences of the Worker's prompt, registered in `COPY_MODULES` as `worker`.
 *
 * It holds what the B2 coherence pass rewrote (context CX-M1-1): the system
 * text, the tool interface preamble, the next-action lines, the masked and
 * compacted history pointers and the fresh-context repair directive. The
 * rest of the Worker's text moves here as it is next changed.
 */

/**
 * The fixed system text, zone 1 (was `PROMPT_ZONE_1_SYSTEM` in prompts.ts).
 * Only its list header changed in the B2 coherence pass ("NON-NEGOTIABLE
 * LAWS:" became "Rules for every card:"); the five rules below it are the
 * grandfathered text (PROMPT_STANDARD rule 36), capitals and negations
 * included, until they are rewritten under the prompt change steps.
 */
const system = `=== SEKHEMET LOCAL CODING EXECUTOR ===
You are the Sekhemet autonomous coding agent running locally on open-weights models.
You operate on single-task kanban cards with deterministic executable verification gates.

Rules for every card:
1. SCOPE DISCIPLINE: Touch ONLY declared scope files. Never exceed 200 diff lines across 1-3 files.
2. CONTRACT-FIRST TDD: Acceptance tests are written first and fail before code is written. NEVER modify test assertions to make tests pass.
3. DETERMINISTIC REPAIR: When a gate fails, read the typed GateFailure excerpt and apply targeted surgical fixes. Do not hallucinate or guess.
4. ACTIONS OVER CHAT: Output concrete tool calls immediately. Do not produce conversational fluff.
5. LITERAL OUTPUT: Emit real file paths, real symbol names and real code. Never echo a template marker back.`;

export const workerCopy = {
  system,

  /**
   * The text tool interface's preamble. The loop runs every call of a reply
   * in order (session.ts), so several calls per step is the behaviour, and
   * the text says so once.
   */
  toolPreamble: [
    "Emit tool calls, not prose. You may emit several calls in one step; batch independent work (for example two read_file calls) rather than spending a step on each.",
    "1. Arguments marked with a trailing asterisk are required.",
    "2. Pass arguments as JSON values of the declared type.",
    "3. Call only tools named in this prompt.",
  ].join("\n"),

  /** The goal tail's last line while scope files are still to be written. */
  nextAction:
    "Next action: make the tool calls this step needs. Call finish_card when every criterion above holds.",

  /**
   * The line under a gate failure. finish_card is named once per tail, in the
   * next-action line (the B2.1 review, B6).
   */
  repairInstruction: "INSTRUCTION: Address the error above in declared scope files.",

  /** The goal tail's last line once every scope file has content, shown in full above. */
  nextActionReady:
    "Next action: every declared scope file has been written, and its current content is shown above. If it satisfies the criteria above, call finish_card now; otherwise correct it with edit.",

  /** The same line when a scope file is not shown in full (too large, or cut to fit). */
  nextActionReadyRead: (paths: readonly string[]): string =>
    `Next action: every declared scope file has been written. ${paths.join(", ")} ${paths.length > 1 ? "are" : "is"} not shown in full above: ${paths.map((p) => `read_file(path="${p}", start, end)`).join(", ")} the lines you need, then call finish_card if the criteria above hold, or correct it with edit.`,

  /** The read for a failing line in a file the prompt does not show in full. */
  readAround: (path: string, line: number): string =>
    `${path} is not shown in full above: read_file(path="${path}", start=${Math.max(1, line - 10)}, end=${line + 10}) before editing line ${line}.`,

  /** A scope file's header: "do not read_file it" only when its content is shown in full. */
  scopeFileHeader: (path: string, full: boolean): string =>
    full
      ? `=== SCOPE FILE: ${path} (current content; edit it, do not read_file it) ===`
      : `=== SCOPE FILE: ${path} (part of the current content; read_file with a line range for the rest) ===`,

  /** An acceptance test's header, on the same rule. */
  testFileHeader: (path: string, full: boolean): string =>
    full
      ? `=== ACCEPTANCE TEST: ${path} (shown in full; do not read_file it) ===`
      : `=== ACCEPTANCE TEST: ${path} (part of it; read_file with a line range for the rest) ===`,

  /**
   * A masked observation. The ref and the way back appear only when `recall`
   * is offered: a pointer the Worker cannot follow is a contradiction.
   */
  maskedPointer: (
    turn: number,
    summary: string,
    lines: number,
    tokens: string,
    ref?: string,
  ): string => {
    const head = `[Observation #${turn}: ${summary.replace(/[.\s]+$/, "")}. ${lines} lines, ${tokens} tokens, omitted`;
    return ref === undefined
      ? `${head}.]`
      : `${head}; recall(ref) returns them. EvidenceRef: ${ref}]`;
  },

  /** The head of a compacted history entry; the way back only with `recall`. */
  compactedHeader: (first: number, last: number, count: number, recall: boolean): string =>
    `Turns ${first}-${last} compacted (${count} turns).${recall ? " Use recall(ref) for any full text." : ""}`,

  /**
   * The footer of condensed tool output: what was cut and, with `recall`
   * offered, the way back to the full text.
   */
  outputFooter: (notes: readonly string[], ref?: string): string =>
    ref === undefined
      ? `(${notes.join("; ")})`
      : `[${notes.join("; ")}. Full output: recall(ref="${ref}")]`,

  /**
   * `edit`'s reply when the search text is not in the file: copy from the
   * content above when the last prompt showed the file in full, otherwise the
   * read_file call that shows the lines.
   */
  editNotFound: (path: string, shownInFull: boolean): string =>
    shownInFull
      ? `edit failed: the search string does not appear in ${path}. Copy the search text exactly, including indentation, from the file's current content shown above.`
      : `edit failed: the search string does not appear in ${path}. Call read_file(path="${path}", start, end) for the lines around it, then copy the search text exactly, including indentation.`,

  /** The `recall` tool's description (tool_catalog.ts). */
  recallSummary:
    "Fetch the full text of an earlier observation that was compacted. Use the EvidenceRef shown in its pointer.",

  /** One line of the compaction index, with its ref only when `recall` is offered. */
  compactedLine: (turn: number, summary: string, ref?: string): string =>
    `- turn ${turn}: ${summary}${ref === undefined ? "" : ` (EvidenceRef: ${ref})`}`,

  /** How the allocator names cut history in its cut notice. */
  historyOldCut: (recall: boolean): string =>
    recall ? "earlier turns (recall(ref) brings any back)" : "earlier turns",

  /**
   * The repair ladder's fresh-context rung. The scope files' current content
   * is in every prompt, so the Worker is pointed at it rather than told to
   * read the files again.
   */
  freshContextDirective:
    "Previous repair attempts did not resolve this, so your turn history has been cleared. Base your next edit on the file as it is now — shown in this prompt where it fits in full, otherwise read with read_file and a line range — not on what you remember of it.",

  /**
   * `note`'s optional `gate` parameter (gates rule 18, GT-M6-5). At most 60
   * characters: the text tool interface cuts a parameter's description there.
   */
  noteGate: "A gate you believe is wrong; naming one parks the card.",

  /** The history line when finishing met only gates that could not run (gates rule 9). */
  gatesNotRun: (excerpts: string): string => `Gates could not run: ${excerpts}`,

  /** `note` naming a gate this attempt does not run: one line. */
  unknownGate: (gate: string, gates: string): string =>
    `There is no gate named ${gate} on this card. The gates are: ${gates}.`,

  // --- the evidence-gated commit (worker-loop rule 29a) ------------------------
  // A postponed write or finish names the missing evidence and the call that
  // supplies it; the evidence is what the harness observed, never a claim.
  evidencePostponed: "postponed until the evidence it depends on is observed",
  evidenceUnread: (files: string, calls: string): string =>
    `Not written yet: the acceptance test imports ${files}, and this attempt has not read all of ${files.includes(", ") ? "them" : "it"}. Call ${calls}${calls.includes("), ") ? " (they can go in one reply)" : ""}, then make this write again.`,
  evidenceImporters: (symbol: string, importers: string, call: string): string =>
    `Not written yet: this changes the signature of ${symbol}, which ${importers} import, and neither they nor its references have been looked at since the file last changed. Call ${call} to see every use, then make this write again.`,
  evidenceFinish:
    "Not finished yet: the tests had not run on the current files, so the check ran now instead, and it fails. Fix what it reports:",
  readFileCall: (path: string): string => `read_file(path="${path}")`,
  readFileRangeCall: (path: string, start: string, end: string): string =>
    `read_file(path="${path}", start=${start}, end=${end})`,
  findReferencesCall: (symbol: string, file: string): string =>
    `find_references(symbol="${symbol}", file="${file}")`,

  // --- read_file's own replies, naming only offered tools (review item 3) -----
  /** read_file on a directory: the offered tool that lists it, when there is one. */
  readFileDirectory: (path: string, lister?: string): string =>
    lister === "list_dir"
      ? `${path} is a directory; use list_dir`
      : lister === "grep_search"
        ? `${path} is a directory; grep_search(query=".", path="${path}", output_mode="files_with_matches") lists its files`
        : `${path} is a directory; read_file takes a file`,
  /** read_file's outline of a long file: read_symbol is named only when it is offered. */
  readFileOutline: (
    path: string,
    lines: string,
    outline: string,
    head: string,
    symbolTool?: string,
  ): string =>
    `${path} has ${lines} lines, so here is its outline instead of the whole file. Read a range with read_file(path, start, end)${symbolTool === "read_symbol" ? " or a declaration with read_symbol(path, symbol)" : ""}.\n\nOUTLINE\n${outline || "(no top-level declarations found)"}\n\nFIRST 40 LINES\n${head}`,

  // --- tool_search asked for code (worker-loop WL-M2-7) -----------------------
  /** tool_search's reply when the query names code symbols; read_symbol is loaded. */
  toolSearchSymbols: (calls: string): string =>
    `tool_search finds tools, not code. read_symbol is now loaded; to see these definitions, call:\n${calls}`,
  /** A read_symbol call as the tool takes it: the declaring file and the name. */
  readSymbolCall: (path: string, symbol: string): string =>
    `read_symbol(path="${path}", symbol="${symbol}")`,
  /** A symbol whose declaring file the symbol index did not find. */
  symbolNotDeclared: (symbol: string): string =>
    `${symbol}: grep_search(query="${symbol}") finds where it is declared or used.`,
} as const;
