import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import ts from "typescript";
import { RERUN_GATES, gateCopy } from "./copy.js";
import { redactSecrets } from "./secrets.js";
import type { CompleteGateFailure, GateFailure } from "./types.js";

/**
 * Ranking, the cap and the completeness check (gates rules 19-20; GT-M6-6,
 * GT-M6-7; F14).
 *
 * Failures go to the model in dependency order, at most three per repair
 * attempt, and the cap is applied once, after every gate has reported:
 * `finalizeFailures` is that one place.
 */

/** Failures shown to the model per repair attempt (rule 20, fixed by design). */
export const FAILURES_SHOWN = 3;

/** Lower sorts first: causes before symptoms, behaviour before style. */
const RUNG_ORDER: Record<string, number> = {
  parse: 0,
  typecheck: 1,
  test: 2,
  bounds: 3,
  lint: 4,
};
const DEFAULT_RUNG_ORDER = 2;

/** The six fields every failure that reaches the model carries (rule 19). */
export const REQUIRED_FAILURE_FIELDS = [
  "gate",
  "location",
  "expected",
  "actual",
  "minimalRepro",
  "suggestedAction",
] as const;

/** The required fields a failure lacks or leaves empty. */
export function missingFailureFields(failure: Partial<GateFailure>): string[] {
  return REQUIRED_FAILURE_FIELDS.filter((key) => {
    if (key === "location") return !failure.location?.file?.trim();
    const value = failure[key];
    return typeof value !== "string" || value.trim() === "";
  });
}

/** Throws on the first failure that lacks a required field, naming where it was caught. */
export function assertCompleteFailures(
  failures: readonly GateFailure[],
  where: string,
): asserts failures is readonly CompleteGateFailure[] {
  for (const f of failures) {
    const missing = missingFailureFields(f);
    if (missing.length > 0) {
      throw new Error(
        `${where}: a ${f.rung} failure from gate ${f.gate || "unknown"} lacks ${missing.join(", ")} (${f.errorExcerpt.slice(0, 120)})`,
      );
    }
  }
}

/**
 * Fill what an incomplete failure lacks, so a harness defect never stops a
 * card mid-turn: each gap is reported through `onIncomplete` for the record.
 */
export function completeFailures(
  failures: readonly GateFailure[],
  onIncomplete?: (defect: string) => void,
): CompleteGateFailure[] {
  return failures.map((f) => {
    const missing = missingFailureFields(f);
    if (missing.length === 0) return f;
    onIncomplete?.(
      `a ${f.rung} failure from gate ${f.gate || "unknown"} lacks ${missing.join(", ")}`,
    );
    const repro = f.minimalRepro?.trim() ? f.minimalRepro : RERUN_GATES;
    return {
      ...f,
      gate: f.gate?.trim() ? f.gate : String(f.rung),
      location: f.location?.file?.trim() ? f.location : { file: f.suggestedFixFiles[0] ?? "." },
      expected: f.expected?.trim() ? f.expected : `${f.gate || f.rung} to pass`,
      actual: f.actual?.trim() ? f.actual : f.errorExcerpt.split("\n")[0] || "it failed",
      minimalRepro: repro,
      suggestedAction: f.suggestedAction?.trim() ? f.suggestedAction : gateCopy.rerun(repro),
    };
  });
}

/**
 * True when a result failed only because gates could not run (gates rule 9):
 * nothing in it is the Worker's, so no path may charge it to the model.
 */
export function onlyNotRun(result: { passed: boolean; failures: readonly GateFailure[] }): boolean {
  return (
    !result.passed && result.failures.length > 0 && result.failures.every((f) => f.notRun === true)
  );
}

/** Gates whose findings never hide behind three test failures: one slot is theirs. */
const RESERVED_GATES = new Set(["integrity", "secrets"]);

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A relative import specifier resolved to a project file, repository-relative. */
function resolveRelative(importer: string, specifier: string, cwd: string): string | undefined {
  const base = normalize(join(dirname(importer), specifier));
  const stem = base.replace(/\.(m|c)?jsx?$/, "");
  const candidates = [
    base,
    ...EXTENSIONS.map((e) => `${stem}${e}`),
    ...EXTENSIONS.map((e) => join(stem, `index${e}`)),
  ];
  return candidates.find((c) => isFile(join(cwd, c)));
}

/**
 * Direct project imports of each file reachable from `files` (relative
 * specifiers only; packages are not part of the project's graph). Files are
 * repository-relative. Reading stops after `maxFiles` files.
 */
export function importGraph(
  files: readonly string[],
  cwd: string,
  maxFiles = 500,
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  const queue = [...new Set(files)];
  while (queue.length > 0 && graph.size < maxFiles) {
    const file = queue.shift() as string;
    if (graph.has(file)) continue;
    const edges = new Set<string>();
    graph.set(file, edges);
    const abs = join(cwd, file);
    if (!existsSync(abs)) continue;
    let source: string;
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    for (const ref of ts.preProcessFile(source, true, true).importedFiles) {
      if (!ref.fileName.startsWith(".")) continue;
      const target = resolveRelative(file, ref.fileName, cwd);
      if (!target) continue;
      edges.add(target);
      if (!graph.has(target)) queue.push(target);
    }
  }
  return graph;
}

function fileOf(failure: GateFailure): string | undefined {
  return failure.location?.file ?? failure.suggestedFixFiles[0];
}

/** Every file `file` imports, directly or through other files. */
function reachable(graph: Map<string, Set<string>>, file: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...(graph.get(file) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (seen.has(next) || next === file) continue;
    seen.add(next);
    stack.push(...(graph.get(next) ?? []));
  }
  return seen;
}

/**
 * Rank failures in dependency order and keep the first `limit` (rule 20):
 * by rung (parse, typecheck, test, bounds, lint); within a rung, a failure in
 * a file others import before one in a file that imports it (when `cwd` is
 * given to read the imports); then the most-referenced file first. Fixing the
 * first often clears the rest.
 */
export function rankFailures(
  failures: GateFailure[],
  limit: number = FAILURES_SHOWN,
  cwd?: string,
): GateFailure[] {
  // `.` is the whole change, not a file: it carries no reference weight.
  const files = (failure: GateFailure) =>
    [...new Set([...failure.suggestedFixFiles, fileOf(failure) ?? ""])].filter(
      (f) => f && f !== ".",
    );
  const references = new Map<string, number>();
  for (const failure of failures) {
    for (const file of files(failure)) references.set(file, (references.get(file) ?? 0) + 1);
  }
  const weight = (failure: GateFailure): number =>
    files(failure).reduce((max, f) => Math.max(max, references.get(f) ?? 0), 0);
  const rung = (failure: GateFailure): number =>
    RUNG_ORDER[String(failure.rung)] ?? DEFAULT_RUNG_ORDER;

  // Within a rung: how many of the rung's other failing files this file
  // depends on. A file that depends on none of them goes first.
  const depth = new Map<GateFailure, number>();
  if (cwd) {
    const files = [...new Set(failures.map(fileOf).filter((f): f is string => !!f))];
    const graph = importGraph(files, cwd);
    for (const failure of failures) {
      const file = fileOf(failure);
      if (!file) continue;
      const deps = reachable(graph, file);
      const sameRung = new Set(
        failures
          .filter((other) => rung(other) === rung(failure))
          .map(fileOf)
          .filter((f): f is string => !!f && f !== file),
      );
      depth.set(failure, [...sameRung].filter((f) => deps.has(f)).length);
    }
  }

  // A gate that could not run goes after every real failure: it is not the
  // card's work, and the model's three slots are for what it can fix.
  const sorted = [...failures].sort(
    (a, b) =>
      Number(a.notRun === true) - Number(b.notRun === true) ||
      rung(a) - rung(b) ||
      (depth.get(a) ?? 0) - (depth.get(b) ?? 0) ||
      weight(b) - weight(a),
  );
  const shown = sorted.slice(0, limit);
  // Integrity and secrets keep a slot: three test failures must not hide a
  // switched-off check or a credential.
  const reserved = sorted.find((f) => RESERVED_GATES.has(f.gate) && !f.notRun);
  if (reserved && !shown.includes(reserved) && shown.length === limit && limit > 0) {
    shown[limit - 1] = reserved;
  }
  return shown;
}

/**
 * The one place failures are finalized for the model: every failure is made
 * complete (a gap is filled and reported through `onIncomplete`, never thrown
 * mid-turn), then all of them — declared, built-in, integrity, bounds and
 * project gates together — are ranked and capped once.
 */
export function finalizeFailures(
  failures: GateFailure[],
  options: { limit?: number; cwd?: string; onIncomplete?: (defect: string) => void } = {},
): CompleteGateFailure[] {
  // SEC-22: a secret in a gate's output is redacted before anyone stores,
  // shows or posts the failure (evidence, check-run annotations, the model).
  return rankFailures(
    completeFailures(failures, options.onIncomplete),
    options.limit ?? FAILURES_SHOWN,
    options.cwd,
  ).map((f) => ({
    ...f,
    errorExcerpt: redactSecrets(f.errorExcerpt),
    expected: redactSecrets(f.expected),
    actual: redactSecrets(f.actual),
    minimalRepro: redactSecrets(f.minimalRepro),
  }));
}
