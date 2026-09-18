import { type EvidenceStore, defaultEvidenceStore } from "./evidence.js";
import type { TurnHistoryItem } from "./prompts.js";
import { estimateTokens, formatTokenCount } from "./tokens.js";

/**
 * Output condensing (Design §422-432).
 *
 * RTK's four strategies, reimplemented natively so `read`/`grep`/`glob`/`run`
 * all condense the same way:
 *
 *   1. Smart Filtering — ANSI escapes, carriage-return redraws, spinner frames,
 *      progress bars, decorative rules and blank-line runs.
 *   2. Grouping        — test results collapsed by status, lint warnings by
 *      rule id, emitting counts instead of one line per occurrence.
 *   3. Deduplication   — identical lines collapsed to `<line> (xN)`.
 *   4. Truncation      — head/tail elision of what is left.
 *
 * The losslessness law (§430): condensing is *strictly lossless regarding
 * repair data*. Error lines, file paths, failing test names and exit codes are
 * classified as PROTECTED and are never elided by truncation, even when that
 * pushes the result past `maxLines`. Budget yields to repairability, not the
 * other way round. Deduplication is lossless by construction (the text stays,
 * only its multiplicity becomes a count), and Grouping only ever collapses
 * passing/skipped test lines and warning-severity lint lines — and even then it
 * carries the distinct suite paths, rule ids and counts into the group line.
 */

const ESC = String.fromCharCode(27);
const CSI = String.fromCharCode(155);
const ANSI_REGEX = new RegExp(
  `[${ESC}${CSI}][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  "g",
);

/** Progress bars, percent counters and braille/ASCII spinner frames. */
const PROGRESS_BAR_REGEX = /(?:\[[=#\-\s>]+\]|\d+%\s+(?:done|complete)|[⠀-⣿])/i;
/** Decorative rules: `────`, `====`, `****`, `----` and friends. */
const DECORATION_REGEX = /^[\s]*[-=_*~─━┄┈—]{4,}[\s]*$/;
const COMMENT_LINE_REGEX = /^\s*(?:#|\/\/)/;

const ERROR_REGEX =
  /(?:\berror\b|\berrors\b|\bfatal\b|\bpanic\b|\bexception\b|\btraceback\b|\bfail(?:ed|ure|ures|ing|s)?\b|\bassert(?:ion)?\b|\bsegmentation fault\b|\bunhandled\b|\bnot ok\b|^\s*[✗✘×]|^\s*●)/i;
const EXIT_CODE_REGEX = /(?:\bexit(?:ed)?\s+(?:code|with|status)\b|\bexit code\b|\bstatus code\b)/i;
/** `src/a.ts(12,4)`, `src/a.ts:12:4`, `./pkg/mod.rs:3` and bare `foo.spec.ts`. */
const FILE_PATH_REGEX =
  /(?:[\w@./\\-]*[/\\][\w.@-]+\.[A-Za-z0-9]{1,6}\b|\b[\w.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonc|toml|yaml|yml|md|py|rs|go|java|rb|c|h|cc|cpp|cs|sh|sql)\b)/;
const FAILING_TEST_REGEX = /^\s*(?:[×✗✘]|FAIL\b|not ok\s+\d+|●\s)/;

const PASSING_TEST_REGEX = /^\s*(?:[✓✔√]|PASS\b|ok\s+\d+(?!\s*#\s*(?:skip|todo)))/i;
const SKIPPED_TEST_REGEX = /^\s*(?:[↓○⊘]|SKIP\b|skipped\b|todo\b|ok\s+\d+\s*#\s*(?:skip|todo)\b)/i;
const WARNING_REGEX = /\bwarn(?:ing|ings)?\b|\blint\/[a-z]/i;
const BIOME_RULE_REGEX = /\b(lint\/[a-z]+\/[A-Za-z0-9]+)\b/;
const TRAILING_RULE_REGEX = /(?:\s{2,}|\()([a-z][\w-]*(?:\/[\w-]+)+|[a-z][\w-]*-[\w-]+)\)?\s*$/;
const PARSED_EXIT_CODE_REGEX =
  /(?:exit(?:ed)?(?:\s+with)?\s+(?:code|status)\s+|exit code[:=]?\s*)(\d{1,3})/i;

export type CondenseStrategy = "smart_filtering" | "grouping" | "deduplication" | "truncation";

export interface CondenseOptions {
  /** Line ceiling applied by Truncation to *non-protected* lines. */
  maxLines?: number;
  /** Exit code of the producing command, when the caller knows it. */
  exitCode?: number;
  /** Command or tool that produced the output; recorded with the evidence. */
  command?: string;
  /** Store the raw text is persisted to before condensing. */
  evidenceStore?: EvidenceStore;
  /** Strip `#`/`//` comment lines. Off by default: output comments are often repair data. */
  stripComments?: boolean;
}

export interface CondenseResult {
  condensed: string;
  /** `originalTokens - condensedTokens`, never negative. */
  tokensSaved: number;
  originalTokens: number;
  condensedTokens: number;
  /** Which of the four strategies actually changed the text. */
  strategies: CondenseStrategy[];
  /** Lines held back from truncation because they carry repair data. */
  protectedLines: number;
  /** Lines removed by truncation (grouping/dedup removals are not losses). */
  droppedLines: number;
  /** Exit code, supplied by the caller or parsed out of the output. */
  exitCode?: number;
  /** Reference to the full raw output, when an evidence store was supplied. */
  evidenceRef?: string;
}

interface Classified {
  text: string;
  isProtected: boolean;
}

/**
 * Repair-data classifier. A `true` here means truncation may never drop the
 * line: it names a file, an error, a failing test or an exit status that a
 * later repair step will need verbatim.
 */
export function isProtectedLine(line: string): boolean {
  if (!line.trim()) return false;
  return (
    ERROR_REGEX.test(line) ||
    EXIT_CODE_REGEX.test(line) ||
    FAILING_TEST_REGEX.test(line) ||
    FILE_PATH_REGEX.test(line)
  );
}

function stripAnsi(raw: string): string {
  return raw.replace(ANSI_REGEX, "");
}

/** Terminal redraws: only the final segment of a `\r`-overwritten line survives. */
function resolveCarriageReturns(line: string): string {
  if (!line.includes("\r")) return line;
  const segments = line.split("\r");
  return segments[segments.length - 1] ?? "";
}

function smartFilter(raw: string, stripComments: boolean): string[] {
  const lines = stripAnsi(raw).split("\n");
  const kept: string[] = [];
  let blankRun = 0;

  for (const rawLine of lines) {
    const line = resolveCarriageReturns(rawLine).replace(/[ \t]+$/, "");

    if (!line.trim()) {
      blankRun++;
      if (blankRun === 1 && kept.length > 0) kept.push("");
      continue;
    }
    blankRun = 0;

    const isProtected = isProtectedLine(line);
    if (!isProtected) {
      if (PROGRESS_BAR_REGEX.test(line)) continue;
      if (DECORATION_REGEX.test(line)) continue;
      if (stripComments && COMMENT_LINE_REGEX.test(line)) continue;
    }

    kept.push(line);
  }

  while (kept.length > 0 && !(kept[kept.length - 1] ?? "").trim()) kept.pop();
  return kept;
}

function extractPath(line: string): string | undefined {
  const match = line.match(FILE_PATH_REGEX);
  return match?.[0];
}

function extractLintRule(line: string): string | undefined {
  const biome = line.match(BIOME_RULE_REGEX);
  if (biome?.[1]) return biome[1];
  const trailing = line.match(TRAILING_RULE_REGEX);
  if (trailing?.[1]) return trailing[1];
  return undefined;
}

interface GroupAccumulator {
  index: number;
  count: number;
  paths: string[];
}

function touchGroup(
  groups: Map<string, GroupAccumulator>,
  key: string,
  index: number,
  path: string | undefined,
): void {
  const existing = groups.get(key);
  const target = existing ?? { index, count: 0, paths: [] };
  target.count++;
  if (path && !target.paths.includes(path)) target.paths.push(path);
  if (!existing) groups.set(key, target);
}

function renderSuites(paths: string[]): string {
  return paths.length > 0 ? ` (suites: ${paths.join(", ")})` : "";
}

function renderFiles(paths: string[]): string {
  return paths.length > 0 ? ` (${paths.join(", ")})` : "";
}

/**
 * Grouping: test-suite results by status, lint warnings by rule id.
 *
 * Failing tests and error-severity lint output are never grouped — they are the
 * repair data. Counts, suite paths and rule ids always survive into the
 * group line, so the model can still tell what ran and where.
 */
function group(lines: string[]): { lines: string[]; changed: boolean } {
  const passed = new Map<string, GroupAccumulator>();
  const skipped = new Map<string, GroupAccumulator>();
  const lintRules = new Map<string, GroupAccumulator>();
  const consumed = new Set<number>();

  lines.forEach((line, index) => {
    if (FAILING_TEST_REGEX.test(line) || ERROR_REGEX.test(line)) return;

    if (PASSING_TEST_REGEX.test(line)) {
      touchGroup(passed, "passed", index, extractPath(line));
      consumed.add(index);
      return;
    }
    if (SKIPPED_TEST_REGEX.test(line)) {
      touchGroup(skipped, "skipped", index, extractPath(line));
      consumed.add(index);
      return;
    }
    if (WARNING_REGEX.test(line)) {
      const rule = extractLintRule(line);
      if (rule) {
        touchGroup(lintRules, rule, index, extractPath(line));
        consumed.add(index);
      }
    }
  });

  if (consumed.size === 0) return { lines, changed: false };

  const emitted = new Map<number, string>();
  const passedGroup = passed.get("passed");
  if (passedGroup) {
    emitted.set(
      passedGroup.index,
      `[grouped] ${passedGroup.count} test result(s) passed${renderSuites(passedGroup.paths)}`,
    );
  }
  const skippedGroup = skipped.get("skipped");
  if (skippedGroup) {
    emitted.set(
      skippedGroup.index,
      `[grouped] ${skippedGroup.count} test result(s) skipped${renderSuites(skippedGroup.paths)}`,
    );
  }
  for (const [rule, acc] of lintRules) {
    emitted.set(acc.index, `[grouped] warning ${rule} x${acc.count}${renderFiles(acc.paths)}`);
  }

  const out: string[] = [];
  lines.forEach((line, index) => {
    const replacement = emitted.get(index);
    if (replacement !== undefined) {
      out.push(replacement);
      return;
    }
    if (consumed.has(index)) return;
    out.push(line);
  });

  return { lines: out, changed: true };
}

/** Deduplication: identical lines collapse into `<line> (xN)`; text is retained. */
function deduplicate(lines: string[]): { lines: string[]; changed: boolean } {
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (!line.trim()) continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }

  let changed = false;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    if (seen.has(line)) {
      changed = true;
      continue;
    }
    seen.add(line);
    const count = counts.get(line) ?? 1;
    out.push(count > 1 ? `${line} (x${count})` : line);
  }

  return { lines: out, changed };
}

interface TruncationOutcome {
  lines: string[];
  dropped: number;
  protectedCount: number;
  changed: boolean;
}

/**
 * Truncation, protected-line aware.
 *
 * The previous head/tail implementation violated §430 by construction: a middle
 * error line simply vanished. Here the protected lines are selected first and
 * always kept; the remaining budget is spent on a head and a tail of the
 * unprotected lines, and each elided run is replaced by an explicit marker.
 */
function truncate(classified: Classified[], maxLines: number): TruncationOutcome {
  const protectedIdx: number[] = [];
  const plainIdx: number[] = [];
  classified.forEach((line, index) => {
    if (line.isProtected) protectedIdx.push(index);
    else plainIdx.push(index);
  });

  if (classified.length <= maxLines) {
    return {
      lines: classified.map((c) => c.text),
      dropped: 0,
      protectedCount: protectedIdx.length,
      changed: false,
    };
  }

  const spare = Math.max(0, maxLines - protectedIdx.length);
  const headCount = Math.ceil(spare / 2);
  const tailCount = spare - headCount;

  const keep = new Set<number>(protectedIdx);
  for (let i = 0; i < headCount && i < plainIdx.length; i++) {
    const index = plainIdx[i];
    if (index !== undefined) keep.add(index);
  }
  for (let i = 0; i < tailCount && i < plainIdx.length - headCount; i++) {
    const index = plainIdx[plainIdx.length - 1 - i];
    if (index !== undefined) keep.add(index);
  }

  const out: string[] = [];
  let dropped = 0;
  let gap = 0;
  for (let i = 0; i < classified.length; i++) {
    if (keep.has(i)) {
      if (gap > 0) {
        out.push(`... [${gap} lines omitted for context efficiency] ...`);
        gap = 0;
      }
      out.push(classified[i]?.text ?? "");
    } else {
      gap++;
      dropped++;
    }
  }
  if (gap > 0) out.push(`... [${gap} lines omitted for context efficiency] ...`);

  return { lines: out, dropped, protectedCount: protectedIdx.length, changed: dropped > 0 };
}

function parseExitCode(text: string): number | undefined {
  const match = text.match(PARSED_EXIT_CODE_REGEX);
  if (!match?.[1]) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Full four-strategy condensing pipeline. Returns the structured result the
 * `run` tool needs (`{condensed, tokensSaved, exitCode}` plus accounting),
 * never a bare string.
 */
export function condenseCommandOutput(raw: string, options: CondenseOptions = {}): CondenseResult {
  const maxLines = options.maxLines ?? 40;
  const originalTokens = estimateTokens(raw);
  const exitCode = options.exitCode ?? parseExitCode(raw);

  const evidenceRef = options.evidenceStore
    ? options.evidenceStore.put(raw, {
        ...(options.command ? { producer: options.command } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
      })
    : undefined;

  if (!raw) {
    return {
      condensed: "",
      tokensSaved: 0,
      originalTokens: 0,
      condensedTokens: 0,
      strategies: [],
      protectedLines: 0,
      droppedLines: 0,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(evidenceRef ? { evidenceRef } : {}),
    };
  }

  const strategies: CondenseStrategy[] = [];

  const rawLines = raw.split("\n");
  const filtered = smartFilter(raw, options.stripComments ?? false);
  if (filtered.length !== rawLines.length || filtered.join("\n") !== raw) {
    strategies.push("smart_filtering");
  }

  const grouped = group(filtered);
  if (grouped.changed) strategies.push("grouping");

  const deduped = deduplicate(grouped.lines);
  if (deduped.changed) strategies.push("deduplication");

  const classified: Classified[] = deduped.lines.map((text) => ({
    text,
    isProtected: isProtectedLine(text),
  }));
  const truncated = truncate(classified, maxLines);
  if (truncated.changed) strategies.push("truncation");

  const condensed = truncated.lines.join("\n").trim();
  const condensedTokens = estimateTokens(condensed);

  return {
    condensed,
    tokensSaved: Math.max(0, originalTokens - condensedTokens),
    originalTokens,
    condensedTokens,
    strategies,
    protectedLines: truncated.protectedCount,
    droppedLines: truncated.dropped,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(evidenceRef ? { evidenceRef } : {}),
  };
}

/**
 * String-returning convenience wrapper over {@link condenseCommandOutput} for
 * call sites that only want the text.
 */
export function condenseOutput(raw: string, maxLines = 40): string {
  return condenseCommandOutput(raw, { maxLines }).condensed;
}

export interface MaskOptions {
  /** Store the full observation text is written to before masking. */
  evidenceStore?: EvidenceStore;
  /** Mask every turn, ignoring the recent window (pressure tier 4). */
  maskAll?: boolean;
  cardId?: string;
}

/** First non-empty line, trimmed and length-capped — the pointer's semantic half. */
function summarize(action: string, result: string): string {
  const firstLine = result
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return `${action} produced no output`;
  const clipped = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  return `${action}: ${clipped}`;
}

/**
 * In-place observation masking (Design §418-420).
 *
 * Observations older than the two most recent are replaced with a ~15-token
 * pointer carrying (a) what the tool did, (b) how many tokens were masked and
 * (c) a retrievable `EvidenceRef`. Nothing is summarized by a model, and
 * nothing is lost: the full text is in the evidence store keyed by that ref.
 *
 *   [Observation #4: tsc completed with 0 errors. 1,420 tokens masked. EvidenceRef: ev_8f9a2]
 */
export function maskOlderObservations(
  turns: TurnHistoryItem[],
  keepRecentTurns = 2,
  options: MaskOptions = {},
): TurnHistoryItem[] {
  const store = options.evidenceStore ?? defaultEvidenceStore;
  const total = turns.length;
  const keep = options.maskAll ? 0 : keepRecentTurns;

  return turns.map((t, idx) => {
    if (idx >= total - keep) return t;

    const lineCount = t.result.split("\n").length;
    if (!options.maskAll && lineCount <= 3 && t.result.length <= 120) return t;

    const ref = store.put(t.result, {
      producer: t.action,
      turn: t.turn,
      ...(options.cardId ? { cardId: options.cardId } : {}),
    });
    const maskedTokens = estimateTokens(t.result);

    return {
      turn: t.turn,
      action: t.action,
      result:
        `[Observation #${t.turn}: ${summarize(t.action, t.result)} ` +
        `(preserved in WAL: ${lineCount} lines omitted). ` +
        `${formatTokenCount(maskedTokens)} tokens masked. EvidenceRef: ${ref}]`,
    };
  });
}

/** Retrieves the full text behind a pointer emitted by {@link maskOlderObservations}. */
export function retrieveMaskedObservation(
  ref: string,
  store: EvidenceStore = defaultEvidenceStore,
): string | undefined {
  return store.get(ref);
}

export const ContextCondenser = {
  condenseOutput,
  condenseCommandOutput,
  maskOlderObservations,
  retrieveMaskedObservation,
  isProtectedLine,
};
