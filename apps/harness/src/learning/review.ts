import {
  allocateContext,
  allocationBudget,
  charsForTokens,
  estimatePromptTokens,
} from "@sekhemet/context";
import {
  type InferenceRequest,
  type InferenceResponse,
  type LocalInferenceAdapter,
  REASONING_BUDGET_TOKENS,
  extractJsonObject,
} from "@sekhemet/models";
import { reviewCoverage } from "@sekhemet/ui";
import { type ReviewPromptData, reviewCopy } from "./review_copy.js";

/**
 * The Reviewer (review-git §2.3, P8): a registry role of another model family
 * than the Worker's that answers one question — does this change do what the
 * issue asked? — after the checks pass and before a person sees the issue.
 *
 * The senior reviewer is carried by structure, not by prose, because the
 * model is small and local:
 * - the diff is shown with the new side's line numbers, so a citation is a
 *   number the model copies, and the harness checks each `path:line` against
 *   the lines it showed — a finding without one is never `met`;
 * - one entry per criterion is guaranteed in code (RG-P8-1): a criterion the
 *   model skips is `unclear`;
 * - the spec-to-test fidelity check is done in code from the staged cases,
 *   fail-only (RG-P8-7): it reports a criterion no case names, never certifies;
 * - every request is counted whole — system text, issue, criteria, tests,
 *   checks, assumptions, preferences and diff — against the Review model's
 *   window through context's allocator (review-git §2.3 item 3, PROMPT_STANDARD
 *   rule 34); a diff over what is left is read in whole files per request, a
 *   file larger than one request in parts of whole lines, and each file not
 *   read is named (RG-P8-5): nothing is cut;
 * - the Worker's transcript never reaches it (RG-P8-11): its input is the
 *   issue, the criteria, the staged cases, the checks, the recorded
 *   assumptions, the preferences and the diff;
 * - each request states its answer cap and its thinking cap (worker-loop
 *   rule 22), and a reply cut off at its cap or holding no readable JSON is
 *   a failed review ({@link ReviewFailedError}), never a set of `unclear`
 *   verdicts (live-test F25);
 * - its authority is none: it returns findings, which the harness records.
 */

/** One Reviewer finding (review-git §2.3, the one declaration). */
export interface ReviewFinding {
  /**
   * The acceptance criterion verbatim, or `preference: …`, `assumption: …`,
   * `no test: …`, or `outside: <file>` for a change the issue did not ask for.
   */
  criterion: string;
  verdict: "met" | "unmet" | "unclear";
  /** `file:line` of the deciding hunk. */
  evidence: string;
  /** One sentence, only when unmet or unclear. */
  note: string;
}

/** What the Reviewer reads: never the Worker's transcript (RG-P8-11). */
export interface ReviewInput {
  card: {
    id: string;
    title: string;
    spec?: string | undefined;
    acceptanceCriteria?: string[] | undefined;
    criterionIds?: string[] | undefined;
  };
  /** The full unified diff. */
  diff: string;
  /** The staged test files with the criterion each case proves; undefined when unknown. */
  stagedTests?: { path: string; cases?: { name: string; criterionId: string }[] }[];
  checks?: { gate: string; passed: boolean; skipped?: boolean }[];
  /** The Worker's `Assumed: …` notes from the issue's dossier (RG-P8-8). */
  assumptions?: string[];
  /** The project's active code-style statements. */
  preferences: string[];
  /** The project's approved rules. */
  rules: string[];
  /** Characters of numbered diff one request may hold; from the model's window when absent. */
  budgetChars?: number;
}

export interface ReviewResult {
  modelId: string;
  findings: ReviewFinding[];
  filesChanged: string[];
  filesRead: string[];
  /** Changed files no request read (RG-P8-5). */
  notRead: string[];
  /** *AI review read 2 of 3 files; 41 of 58 changed lines are cited by no finding.* (RG-P8-6) */
  coverage: string;
  /** The changed lines no finding cites, as `file:a–b` ranges. */
  uncited: string[];
  /** Model requests made. */
  requests: number;
  /**
   * The findings whose location the model gave and the harness checked; a
   * finding with a fallback location (a skipped criterion) cites nothing.
   */
  cited: boolean[];
}

// ---------------------------------------------------------------------------
// The diff, with the new side's line numbers
// ---------------------------------------------------------------------------

export interface DiffLine {
  type: "add" | "del" | "ctx";
  text: string;
  /** Line number on the new side (added and context lines). */
  newNo?: number;
}

export interface DiffFile {
  path: string;
  lines: DiffLine[];
  /** New-side numbers of the added lines. */
  added: number[];
}

/** Split a unified diff into files; the path is the new side's (`b/`), or the old one for a deletion. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | undefined;
  let newNo = 0;
  let inHunk = false;
  const strip = (p: string) => p.trim().replace(/^[ab]\//, "");
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = / b\/(.+)$/.exec(raw);
      cur = { path: m ? (m[1] as string) : strip(raw.slice(11)), lines: [], added: [] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!inHunk && raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      if (!cur) {
        cur = { path: strip(p), lines: [], added: [] };
        files.push(cur);
      } else if (p !== "/dev/null") cur.path = strip(p);
      continue;
    }
    if (!inHunk && raw.startsWith("--- ")) {
      const p = raw.slice(4).trim();
      if (!cur) {
        cur = { path: strip(p), lines: [], added: [] };
        files.push(cur);
      }
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h && cur) {
      newNo = Number(h[1]);
      inHunk = true;
      continue;
    }
    if (!cur || !inHunk) continue;
    if (raw.startsWith("+")) {
      cur.lines.push({ type: "add", text: raw.slice(1), newNo });
      cur.added.push(newNo);
      newNo++;
    } else if (raw.startsWith("-")) {
      cur.lines.push({ type: "del", text: raw.slice(1) });
    } else if (raw.startsWith(" ")) {
      cur.lines.push({ type: "ctx", text: raw.slice(1), newNo });
      newNo++;
    }
  }
  return files;
}

/** One file as the Reviewer reads it: `file <path>`, then `  12 + code`, `  13   code`, `     - code`. */
export function numberedDiff(file: DiffFile): string {
  const width = Math.max(4, String(Math.max(0, ...file.lines.map((l) => l.newNo ?? 0))).length);
  const pad = (n?: number) => (n === undefined ? " ".repeat(width) : String(n).padStart(width));
  return [
    `file ${file.path}`,
    ...file.lines.map(
      (l) => `${pad(l.newNo)} ${l.type === "add" ? "+" : l.type === "del" ? "-" : " "} ${l.text}`,
    ),
  ].join("\n");
}

/**
 * A file larger than one request, in parts of whole lines (RG-P8-5): each
 * part's numbered text fits `budget` characters. Undefined when one line
 * alone is larger than a request, so the file cannot be read without a cut.
 */
export function splitFile(file: DiffFile, budget: number): DiffFile[] | undefined {
  const width = Math.max(4, String(Math.max(0, ...file.lines.map((l) => l.newNo ?? 0))).length);
  const header = `file ${file.path}`.length + 1;
  const parts: DiffFile[] = [];
  let cur: DiffLine[] = [];
  let used = header;
  const close = () => {
    if (!cur.length) return;
    parts.push({
      path: file.path,
      lines: cur,
      added: cur.filter((l) => l.type === "add").map((l) => l.newNo as number),
    });
    cur = [];
    used = header;
  };
  for (const l of file.lines) {
    const size = width + 3 + l.text.length + 1;
    if (header + size > budget) return undefined;
    if (used + size > budget) close();
    cur.push(l);
    used += size;
  }
  close();
  return parts;
}

// ---------------------------------------------------------------------------
// The review
// ---------------------------------------------------------------------------

/** The answer's cap: one short entry per criterion. */
export const REVIEW_ANSWER_TOKENS = 1_200;
/**
 * The thinking cap every request states (worker-loop rule 22). The Reviewer
 * asks for no reasoning, but a model whose template cannot turn it off
 * thinks at its floor (models MD-N4-2a): gpt-oss thought 1,072 tokens on a
 * request for none (live-test F25), over the medium budget, so the high one
 * is stated. The window reserves only what the adapter would add for it
 * ({@link reviewThinkingReserve}), so a model that never thinks keeps the
 * room for the diff.
 */
export const REVIEW_THINKING_TOKENS = REASONING_BUDGET_TOKENS.high;

/** What every Reviewer request asks of reasoning: none, with its thinking cap stated. */
const REVIEW_REASONING: Pick<InferenceRequest, "reasoning" | "reasoningBudgetTokens"> = {
  reasoning: "off",
  reasoningBudgetTokens: REVIEW_THINKING_TOKENS,
};

/**
 * The thinking room a request reserves in the window: what the adapter
 * would add to the answer cap for it (0 on a model it would not let think),
 * or the whole stated cap when the adapter does not say.
 */
export function reviewThinkingReserve(
  model: Pick<LocalInferenceAdapter, "thinkingAllowance">,
): number {
  return model.thinkingAllowance
    ? Math.max(0, model.thinkingAllowance(REVIEW_REASONING))
    : REVIEW_THINKING_TOKENS;
}

/**
 * A review that did not happen (live-test F25): a reply cut off at its
 * length cap, or one holding no readable JSON. Handled like any review that
 * could not run — recorded with its reason, shown on Review, refused by
 * `--auto-accept` — never read as `unclear` verdicts.
 */
export class ReviewFailedError extends Error {
  constructor(
    public readonly reason: "length" | "unreadable",
    message: string,
  ) {
    super(message);
    this.name = "ReviewFailedError";
  }
}

/** The failed review a reply is, or undefined when it can be read. */
function failedReply(res: InferenceResponse): ReviewFailedError | undefined {
  if (res.finishReason === "length") {
    const total = res.usage.completionTokens;
    const thinking = res.usage.thinkingTokens;
    return new ReviewFailedError(
      "length",
      thinking
        ? `the Review model's reply was cut off at its length cap: ${thinking} of ${total} tokens went to thinking`
        : `the Review model's reply was cut off at its length cap (${total} tokens)`,
    );
  }
  if (parseReply(res.text) === undefined) {
    return new ReviewFailedError("unreadable", "the Review model's reply held no readable JSON");
  }
  return undefined;
}
/** The Review model's window when its adapter does not say (the reviewer profile's). */
export const REVIEW_DEFAULT_WINDOW_TOKENS = 8_192;
/** Room kept for the one line saying which part of the change a request shows. */
const SHOWN_LINE_TOKENS = 48;

/** The Review model's window. */
function windowOf(model: Pick<LocalInferenceAdapter, "contextWindow">): number {
  return model.contextWindow?.contextTokens ?? REVIEW_DEFAULT_WINDOW_TOKENS;
}

/**
 * The numbered-diff budget of one request, in characters: the Review model's
 * window less the answer and thinking caps (rule 22) and the allocator's margin (context's
 * `allocationBudget`, role `reviewer`), less the system text and every fixed
 * part of the task — issue, criteria, tests, checks, assumptions and
 * preferences — counted with context's one estimator. Zero when the fixed
 * parts alone fill the window.
 */
export function reviewBudgetChars(
  model: Pick<LocalInferenceAdapter, "contextWindow" | "thinkingAllowance">,
  fixed: { system: string; task: string } = { system: "", task: "" },
): number {
  const budget = allocationBudget({
    role: "reviewer",
    windowTokens: windowOf(model),
    answerTokens: REVIEW_ANSWER_TOKENS + reviewThinkingReserve(model),
  });
  const room =
    budget -
    estimatePromptTokens(fixed.system) -
    estimatePromptTokens(fixed.task) -
    SHOWN_LINE_TOKENS;
  return charsForTokens(Math.max(0, room));
}

/**
 * One request's prompt through the allocator (PROMPT_STANDARD rule 34): the
 * task is one required section, the system text overhead. Undefined when it
 * does not fit — the request is then not sent, and its files are named.
 */
function fitRequest(
  model: Pick<LocalInferenceAdapter, "contextWindow" | "thinkingAllowance">,
  system: string,
  task: string,
): string | undefined {
  const allocation = allocateContext(
    [
      {
        id: "review_task",
        kind: "goal",
        text: task,
        priority: 100,
        placement: "volatile",
        order: 0,
        required: true,
      },
    ],
    {
      role: "reviewer",
      windowTokens: windowOf(model),
      answerTokens: REVIEW_ANSWER_TOKENS + reviewThinkingReserve(model),
      overheadTokens: estimatePromptTokens(system),
    },
  );
  return allocation.fits ? allocation.sections.map((x) => x.text).join("\n\n") : undefined;
}

interface RawEntry {
  n?: unknown;
  verdict?: unknown;
  at?: unknown;
  note?: unknown;
  contradicted?: unknown;
  broken?: unknown;
}

interface RawReply {
  criteria?: RawEntry[];
  assumptions?: RawEntry[];
  preferences?: RawEntry[];
  outside?: RawEntry[];
}

/**
 * The reply's JSON object through the harness's one reader (MD-N4-8): the
 * first balanced object, so trailing braces in prose after it are not a
 * failed review; undefined when it holds none that parses (F25).
 */
function parseReply(text: string): RawReply | undefined {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const o = extractJsonObject(clean);
  return typeof o === "object" && o !== null && !Array.isArray(o) ? (o as RawReply) : undefined;
}

const arr = (x: unknown): RawEntry[] =>
  Array.isArray(x) ? (x.filter((e) => e && typeof e === "object") as RawEntry[]) : [];

/** A note without any confidence the model states (RG-P8-12), one sentence, bounded. */
function cleanNote(x: unknown): string {
  return String(typeof x === "string" ? x : "")
    .replace(/\s*[([]\s*(?:\w+\s+)?confiden(?:ce|t)\b[^)\]]*[)\]]/gi, "")
    .replace(/\s*\b(?:with\s+)?(?:high|low|medium|\d+%?)\s+confidence\b/gi, "")
    .replace(/\s*\bconfiden(?:ce|t)\b\s*[:=]?\s*\d+(?:\.\d+)?%?/gi, "")
    .replace(/\s*\b(?:i am|i'm)\s+\d+%\s+(?:sure|certain|confident)\b/gi, "")
    .replace(/\s+([.,;])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

/**
 * `path:line` checked against the lines a request showed; undefined when it
 * names no shown line. Any shown path counts, with or without an extension
 * (`Makefile:3`, `Dockerfile:1`), the longest first so `a/b.ts` is not read
 * as `b.ts`.
 */
function checkedAt(
  at: unknown,
  shown: ReadonlyMap<string, ReadonlySet<number>>,
): string | undefined {
  const text = String(at ?? "").replace(/(^|[\s(`'"])[ab]\//g, "$1");
  const paths = [...shown.keys()].sort((a, b) => b.length - a.length);
  for (const path of paths) {
    const esc = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`(?:^|[^\\w@./-])${esc}:(\\d+)`).exec(text);
    if (!m) continue;
    const line = Number(m[1]);
    return shown.get(path)?.has(line) ? `${path}:${line}` : undefined;
  }
  return undefined;
}

const VERDICTS = ["met", "unmet", "unclear"] as const;
type Verdict = (typeof VERDICTS)[number];
const rank: Record<Verdict, number> = { unclear: 0, met: 1, unmet: 2 };

/**
 * Review one change. Every criterion gets one finding; the fidelity check,
 * the assumptions and the preferences follow; the coverage line closes it.
 */
export async function reviewCard(
  model: LocalInferenceAdapter,
  input: ReviewInput,
): Promise<ReviewResult> {
  const files = parseDiff(input.diff);
  const criteria = input.card.acceptanceCriteria ?? [];
  const ids = input.card.criterionIds ?? [];
  const assumptions = input.assumptions ?? [];
  const preferences = [...input.preferences, ...input.rules];

  const tests = input.stagedTests
    ? criteria.map(
        (_, i) =>
          input.stagedTests?.flatMap((t) =>
            (t.cases ?? [])
              .filter((c) => ids[i] !== undefined && c.criterionId === ids[i])
              .map((c) => `${t.path}: ${c.name}`),
          ) ?? [],
      )
    : undefined;
  const taskOf = (diff: string, shown: ReviewPromptData["shown"]) =>
    reviewCopy.task({
      title: input.card.title,
      spec: input.card.spec,
      criteria,
      tests,
      checks: input.checks ?? [],
      assumptions,
      preferences,
      diff,
      shown,
    });

  // Every request is counted whole against the window (rule 34): the fixed
  // parts first, what is left holds the diff. Whole files per request, in
  // the diff's order; a file larger than one request is read in parts of
  // whole lines, each its own request; a file with a line larger than a
  // request is not read, and is named (RG-P8-5).
  const budget =
    input.budgetChars ??
    reviewBudgetChars(model, {
      system: reviewCopy.system,
      task: taskOf("", { read: files.length, total: files.length }),
    });
  const plan: { files: DiffFile[]; part?: { n: number; of: number } }[] = [];
  const notRead: string[] = [];
  let batch: DiffFile[] = [];
  let used = 0;
  const flush = () => {
    if (batch.length) plan.push({ files: batch });
    batch = [];
    used = 0;
  };
  for (const f of files) {
    const size = numberedDiff(f).length + 1;
    if (size <= budget) {
      if (used + size > budget) flush();
      batch.push(f);
      used += size;
      continue;
    }
    const parts = splitFile(f, budget);
    if (!parts) {
      notRead.push(f.path);
      continue;
    }
    flush();
    parts.forEach((p, i) => plan.push({ files: [p], part: { n: i + 1, of: parts.length } }));
  }
  flush();
  // A change with no diff to read still has its criteria judged.
  if (plan.length === 0 && files.length === 0) plan.push({ files: [] });

  const perCriterion: { verdict: Verdict; at?: string; note: string }[] = criteria.map(() => ({
    verdict: "unclear",
    note: "",
  }));
  const byAssumption = new Map<number, { at: string; note: string }>();
  const byPreference = new Map<number, { at: string; note: string }>();
  const outside: { at: string; note: string }[] = [];
  const read = new Set<string>();
  let requests = 0;

  for (const r of plan) {
    const b = r.files;
    const prompt = fitRequest(
      model,
      reviewCopy.system,
      taskOf(b.map(numberedDiff).join("\n\n"), {
        read: b.length,
        total: files.length,
        ...(r.part && b[0] ? { part: { ...r.part, path: b[0].path } } : {}),
      }),
    );
    // Over the window after all (an estimate the budget missed): not sent, and named.
    if (prompt === undefined) {
      for (const f of b) if (!notRead.includes(f.path)) notRead.push(f.path);
      continue;
    }
    const shown = new Map<string, Set<number>>(
      b.map((f) => [
        f.path,
        new Set(f.lines.filter((l) => l.newNo !== undefined).map((l) => l.newNo as number)),
      ]),
    );
    const res = await model.generate({
      systemPrompt: reviewCopy.system,
      prompt,
      toolArm: "arm_b_json",
      temperature: 0,
      maxTokens: REVIEW_ANSWER_TOKENS,
      ...REVIEW_REASONING,
      role: "reviewer",
    });
    requests++;
    // F25: a cut-off or unreadable reply fails the whole review.
    const failed = failedReply(res);
    if (failed) throw failed;
    for (const f of b) read.add(f.path);
    const reply = parseReply(res.text) ?? {};
    for (const e of arr(reply.criteria)) {
      const i = Number(e.n) - 1;
      const cur = perCriterion[i];
      if (!cur) continue;
      const v = (VERDICTS as readonly string[]).includes(String(e.verdict))
        ? (e.verdict as Verdict)
        : "unclear";
      // A verdict without a checked location decides nothing (RG-P8-1).
      const at = checkedAt(e.at, shown);
      if (!at) continue;
      if (rank[v] > rank[cur.verdict] || !cur.at) {
        perCriterion[i] = { verdict: v, at, note: v === "met" ? "" : cleanNote(e.note) };
      }
    }
    for (const e of arr(reply.assumptions)) {
      const n = Number(e.n);
      const at = checkedAt(e.at, shown);
      if (
        e.contradicted === true &&
        at &&
        n >= 1 &&
        n <= assumptions.length &&
        !byAssumption.has(n)
      )
        byAssumption.set(n, { at, note: cleanNote(e.note) });
    }
    for (const e of arr(reply.preferences)) {
      const n = Number(e.n);
      const at = checkedAt(e.at, shown);
      if (e.broken === true && at && n >= 1 && n <= preferences.length && !byPreference.has(n))
        byPreference.set(n, { at, note: cleanNote(e.note) });
    }
    for (const e of arr(reply.outside)) {
      const at = checkedAt(e.at, shown);
      if (at && !outside.some((o) => o.at.split(":")[0] === at.split(":")[0]))
        outside.push({ at, note: cleanNote(e.note) });
    }
  }

  // A file is read when every request that showed it was sent.
  const filesRead = files.map((f) => f.path).filter((p) => read.has(p) && !notRead.includes(p));
  const firstRead = files.find((f) => filesRead.includes(f.path) && f.lines.length) ?? files[0];
  const firstLine =
    firstRead?.added[0] ?? firstRead?.lines.find((l) => l.newNo !== undefined)?.newNo ?? 1;
  const fallback = firstRead ? `${firstRead.path}:${firstLine}` : `${input.card.id}:1`;

  const findings: ReviewFinding[] = [];
  const cited: boolean[] = [];
  const push = (f: ReviewFinding, isCited: boolean) => {
    findings.push(f);
    cited.push(isCited);
  };
  criteria.forEach((text, i) => {
    const c = perCriterion[i] as { verdict: Verdict; at?: string; note: string };
    push(
      {
        criterion: text,
        verdict: c.verdict,
        evidence: c.at ?? fallback,
        note: c.at ? c.note : reviewCopy.noCitation,
      },
      c.at !== undefined,
    );
  });
  // RG-P8-7: fail-only. A criterion no staged case names is reported; one a
  // case names keeps the model's verdict — the case never certifies it.
  if (input.stagedTests) {
    const linked = input.stagedTests.some((t) => (t.cases ?? []).length > 0);
    if (!linked && input.stagedTests.length > 0 && criteria.length > 0) {
      push(
        {
          criterion: "no test: the staged tests name no criterion",
          verdict: "unclear",
          evidence: fallback,
          note: reviewCopy.noTestUnlinked,
        },
        false,
      );
    } else {
      criteria.forEach((text, i) => {
        if (tests?.[i]?.length) return;
        const c = perCriterion[i];
        push(
          {
            criterion: `no test: ${text}`,
            verdict: "unmet",
            evidence: c?.at ?? fallback,
            note: reviewCopy.noTest,
          },
          c?.at !== undefined,
        );
      });
    }
  }
  for (const [n, a] of [...byAssumption].sort((x, y) => x[0] - y[0]))
    push(
      {
        criterion: `assumption: ${assumptions[n - 1]}`,
        verdict: "unmet",
        evidence: a.at,
        note: a.note,
      },
      true,
    );
  for (const [n, p] of [...byPreference].sort((x, y) => x[0] - y[0]))
    push(
      {
        criterion: `preference: ${preferences[n - 1]}`,
        verdict: "unmet",
        evidence: p.at,
        note: p.note,
      },
      true,
    );
  for (const o of outside)
    push(
      {
        criterion: `outside: ${o.at.split(":")[0]}`,
        verdict: "unclear",
        evidence: o.at,
        note: o.note,
      },
      true,
    );

  // RG-P8-6: the coverage line, computed as the Review page computes it.
  const cov = reviewCoverage(
    files.map((f) => ({ path: f.path, addedLines: f.added })),
    findings.map((f, i) => ({
      id: String(i),
      verdict: f.verdict,
      text: cited[i] ? f.evidence : "",
    })),
    filesRead,
  );
  return {
    modelId: model.modelId,
    findings,
    filesChanged: files.map((f) => f.path),
    filesRead,
    notRead,
    coverage: cov.line,
    uncited: cov.uncited,
    requests,
    cited,
  };
}

/**
 * The dossier text of one finding: the criterion, the note, and the cited
 * location — which the Review page reads as the citation (DB-N5-2). A
 * finding with a fallback location cites nothing.
 */
export function findingText(f: ReviewFinding, cited: boolean): string {
  return [f.criterion, f.note ? `— ${f.note}` : "", cited ? `(${f.evidence})` : ""]
    .filter(Boolean)
    .join(" ");
}
