import { estimatePromptTokens } from "./allocator.js";

/**
 * Query-aware line pruning in the style of SWE-Pruner (C3, design "High-
 * density context economics"). A file that does not fit is not cut blindly
 * at its middle: lines are scored against the task (the goal, the failing
 * error, the identifiers in both), and the file is reduced to the relevant
 * lines, their enclosing declarations, the imports and every protected
 * line, with elision markers that carry the dropped line ranges so the
 * model can `read_file` exactly what it needs. It is lossless where it
 * matters: a line named by the failure (`file:line`), an error line or a
 * protected pattern is never elided.
 */
export interface PruneOptions {
  /** Token budget for the pruned text. */
  maxTokens: number;
  /** Lines around each kept line. Default 1. */
  contextLines?: number;
  /** Line numbers (1-based) that must be kept, e.g. from `file:line` in the failure. */
  pinnedLines?: number[];
  /** Extra always-keep patterns. */
  protectedPatterns?: RegExp[];
}

export interface PruneResult {
  text: string;
  keptLines: number;
  totalLines: number;
  /** Elided ranges, 1-based inclusive. */
  elided: [number, number][];
  fits: boolean;
}

const STOPWORDS = new Set(
  "the and for with that this from into when then than not are was were has have had but its use using should must can will your you all any each file files line lines code test tests call return const let var function class export import new true false null undefined void type interface string number boolean async await".split(
    " ",
  ),
);

/** Identifiers in a query: words, camelCase and snake_case parts, length >= 3. */
export function queryTerms(query: string): Set<string> {
  const out = new Set<string>();
  for (const word of query.match(/[A-Za-z_$][\w$]*/g) ?? []) {
    const lower = word.toLowerCase();
    if (lower.length >= 3 && !STOPWORDS.has(lower)) out.add(lower);
    for (const part of word.split(/_|(?<=[a-z0-9])(?=[A-Z])/)) {
      const p = part.toLowerCase();
      if (p.length >= 3 && !STOPWORDS.has(p)) out.add(p);
    }
  }
  return out;
}

/** Line numbers a failure names for `path` (`path:12`, `path(12,5)`, `path:12:3`). */
export function linesNamedFor(path: string, failureText: string): number[] {
  const base = path.split("/").pop() ?? path;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:${esc(path)}|${esc(base)})(?::(\\d+)|\\((\\d+),\\d+\\))`, "g");
  const out = new Set<number>();
  for (const m of failureText.matchAll(re)) {
    const n = Number(m[1] ?? m[2]);
    if (n > 0) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

const DEFAULT_PROTECTED = [
  /\b(error|throw|assert|expect)\b/i,
  /^\s*(import|export)\b/,
  /\b(TODO|FIXME)\b/,
];

const DECLARATION =
  /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|const|let|def|fn|pub\s+fn|impl|struct)\b/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Prune `text` to the lines relevant to `query` within `maxTokens`. Returns
 * the original when it already fits.
 */
export function pruneLines(text: string, query: string, options: PruneOptions): PruneResult {
  const lines = text.split("\n");
  const total = lines.length;
  if (estimatePromptTokens(text) <= options.maxTokens) {
    return { text, keptLines: total, totalLines: total, elided: [], fits: true };
  }
  const terms = queryTerms(query);
  const protectedRes = [...DEFAULT_PROTECTED, ...(options.protectedPatterns ?? [])];
  const ctx = options.contextLines ?? 1;

  // Score each line: query identifiers it contains (whole-word, lowercased).
  const scores = lines.map((line) => {
    let s = 0;
    for (const w of line.toLowerCase().match(/[a-z_$][\w$]*/g) ?? []) if (terms.has(w)) s++;
    return s;
  });
  const mustKeep = new Set<number>();
  for (const n of options.pinnedLines ?? []) if (n >= 1 && n <= total) mustKeep.add(n - 1);
  lines.forEach((line, i) => {
    if (protectedRes.some((re) => re.test(line))) mustKeep.add(i);
  });

  const render = (threshold: number): { out: string; kept: number; elided: [number, number][] } => {
    const keep = new Set<number>(mustKeep);
    scores.forEach((s, i) => {
      if (s >= threshold) keep.add(i);
    });
    // Enclosing declarations of every kept line: walk up to a shallower declaration.
    for (const i of [...keep]) {
      let indent = indentOf(lines[i] ?? "");
      for (let j = i - 1; j >= 0 && indent > 0; j--) {
        const l = lines[j] ?? "";
        if (!l.trim()) continue;
        const ind = indentOf(l);
        if (ind < indent) {
          if (DECLARATION.test(l) || /[{:]\s*$/.test(l)) keep.add(j);
          indent = ind;
        }
      }
    }
    const withCtx = new Set<number>();
    for (const i of keep) {
      for (let k = Math.max(0, i - ctx); k <= Math.min(total - 1, i + ctx); k++) withCtx.add(k);
    }
    const out: string[] = [];
    const elided: [number, number][] = [];
    let i = 0;
    while (i < total) {
      if (withCtx.has(i)) {
        out.push(lines[i] ?? "");
        i++;
        continue;
      }
      const start = i;
      while (i < total && !withCtx.has(i)) i++;
      elided.push([start + 1, i]);
      out.push(`… (lines ${start + 1}-${i} elided; read_file that range if needed) …`);
    }
    return { out: out.join("\n"), kept: withCtx.size, elided };
  };

  // Raise the relevance threshold until the result fits; protected lines always stay.
  const maxScore = Math.max(1, ...scores);
  let best = render(1);
  for (let t = 1; t <= maxScore + 1; t++) {
    const r = t === 1 ? best : render(t);
    best = r;
    if (estimatePromptTokens(r.out) <= options.maxTokens) break;
  }
  return {
    text: best.out,
    keptLines: best.kept,
    totalLines: total,
    elided: best.elided,
    fits: estimatePromptTokens(best.out) <= options.maxTokens,
  };
}
