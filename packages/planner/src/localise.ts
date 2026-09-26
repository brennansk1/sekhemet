import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJUnit } from "@sekhemet/gates";
import { runConfined } from "@sekhemet/sandbox";
import { type PlannerLedger, appendPlannerEvent } from "./ledger.js";

/**
 * Fix localisation (planner-pm §2.16.5, PM-N6-5): for a `fix` card with a
 * reproduction test, the candidate lines of its scope are ranked by
 * spectrum-based suspiciousness — Ochiai, from which lines the failing and
 * the passing tests execute — read from V8's own coverage
 * (`NODE_V8_COVERAGE`, no dependency). The ranking is recorded with the
 * card's scope (`scope/localised`) and put in its dossier for the Worker.
 * Embedding retrieval stays rejected (DEC-22).
 *
 * **BLOCKER, fixed:** a fix card's reproduction test is a planner-staged
 * file (its interface named by the model, PM-P1-15) that has not yet been
 * approved by a person. Localisation runs it to rank candidate lines, at
 * plan time, so it must never run unconfined: every run goes through
 * `runConfined` (`@sekhemet/sandbox`), confined to the card's repository
 * root, no network, before any approval — never trusted execution.
 */

/** A test run's executed lines, per repository-relative source file (1-based). */
export type LineSpectrum = Map<string, Set<number>>;

export interface CoverageRun {
  passed: boolean;
  lines: LineSpectrum;
}

export interface SuspiciousLine {
  file: string;
  line: number;
  score: number;
  /** Failing runs that executed it. */
  ef: number;
  /** Passing runs that executed it. */
  ep: number;
}

/** Test files are not candidates for the fault. */
const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(spec|test)\.[cm]?[jt]sx?$/;
/** A run that takes longer is stopped: its coverage is still read. */
const RUN_TIMEOUT_MS = 120_000;

/** Ochiai: ef / sqrt(totalFailed × (ef + ep)); 0 when nothing failing executed it. */
export function ochiai(ef: number, ep: number, totalFailed: number): number {
  if (ef === 0 || totalFailed === 0) return 0;
  return ef / Math.sqrt(totalFailed * (ef + ep));
}

interface V8Range {
  startOffset: number;
  endOffset: number;
  count: number;
}

/**
 * Executed lines of one script from V8's block coverage: every range,
 * outer before inner, sets its count over its span; a line is executed when
 * the count at its first non-blank character is above zero (a line that
 * only closes a block is never one).
 */
function executedLines(source: string, ranges: V8Range[]): Set<number> {
  const counts = new Int32Array(source.length).fill(-1);
  const ordered = [...ranges].sort(
    (a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset,
  );
  for (const r of ordered)
    counts.fill(r.count, r.startOffset, Math.min(r.endOffset, source.length));
  const out = new Set<number>();
  let offset = 0;
  source.split("\n").forEach((text, i) => {
    const first = text.search(/\S/);
    // A line that only closes a block is not a statement a fault can be on.
    const closer = /^\s*[\]})]+[;,]?\s*$/.test(text);
    if (first !== -1 && !closer && (counts[offset + first] ?? -1) > 0) out.add(i + 1);
    offset += text.length + 1;
  });
  return out;
}

/** Every script under `root` in a `NODE_V8_COVERAGE` directory, as executed lines. */
export function v8CoverageLines(dir: string, root: string): LineSpectrum {
  const out: LineSpectrum = new Map();
  if (!existsSync(dir)) return out;
  // V8 reports real paths (macOS's /var is /private/var).
  const base = existsSync(root) ? realpathSync(root) : root;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    let report: { result?: { url?: string; functions?: { ranges: V8Range[] }[] }[] };
    try {
      report = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    for (const script of report.result ?? []) {
      if (!script.url?.startsWith("file:")) continue;
      const abs = fileURLToPath(script.url);
      const rel = relative(base, abs).split(sep).join("/");
      if (rel.startsWith("..") || rel.includes("node_modules/") || TEST_FILE.test(rel)) continue;
      if (!existsSync(abs)) continue;
      const lines = executedLines(
        readFileSync(abs, "utf8"),
        (script.functions ?? []).flatMap((f) => f.ranges),
      );
      const set = out.get(rel) ?? new Set<number>();
      for (const l of lines) set.add(l);
      out.set(rel, set);
    }
  }
  return out;
}

/**
 * Append the JUnit reporting flags a runner this staging recognises
 * supports, writing to `junitPath`; a command it does not recognise is
 * returned unchanged (its result falls back to the exit code).
 */
function withJUnitReport(command: readonly string[], junitPath: string): string[] {
  const [bin, ...rest] = command;
  if (bin === "node" && rest[0] === "--test") {
    return [...command, "--test-reporter=junit", `--test-reporter-destination=${junitPath}`];
  }
  if (bin !== undefined && /(^|[\\/])vitest(\.[cm]?js)?$/.test(bin)) {
    return [...command, "--reporter=junit", `--outputFile=${junitPath}`];
  }
  return [...command];
}

/**
 * Whether every case a JUnit report names passed or was skipped
 * (PM-N6-5: per-test results, not the exit code, which a runner can return
 * non-zero for reasons unrelated to any test, or zero despite one failing
 * under some configurations); undefined when no report was written or it
 * could not be read, so the caller falls back to the exit code.
 */
function junitPassed(path: string): boolean | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const cases = parseJUnit(readFileSync(path, "utf8"));
    if (cases.length === 0) return undefined;
    return cases.every((c) => c.status === "passed" || c.status === "skipped");
  } catch {
    return undefined;
  }
}

/**
 * Run one test command in `root` with V8 coverage on, confined
 * (`runConfined`; BLOCKER, fixed: a fix card's staged reproduction is
 * model-named content, run at plan time before any person has approved
 * it — it must never run unconfined). Whether it passed is read from its
 * own JUnit result when the runner writes one, the exit code only when it
 * does not.
 */
export async function runWithCoverage(
  root: string,
  command: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<CoverageRun> {
  const dir = mkdtempSync(join(tmpdir(), "sek-v8cov-"));
  const junitPath = join(dir, "junit.xml");
  try {
    const [bin, ...args] = withJUnitReport(command, junitPath) as [string, ...string[]];
    const stringEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (v !== undefined) stringEnv[k] = v;
    stringEnv.NODE_V8_COVERAGE = dir;
    const res = await runConfined(bin, args, {
      root,
      cwd: root,
      writable: [dir],
      env: stringEnv,
      timeoutMs: RUN_TIMEOUT_MS,
    });
    const passed = junitPassed(junitPath) ?? res.exitCode === 0;
    return { passed, lines: v8CoverageLines(dir, root) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Rank every line a failing run executed by Ochiai, most suspicious first
 * (ties by file and line). Without a failing run there is nothing to rank.
 */
export function rankSuspiciousLines(
  runs: readonly CoverageRun[],
  options: { files?: readonly string[]; limit?: number } = {},
): SuspiciousLine[] {
  const failing = runs.filter((r) => !r.passed);
  if (failing.length === 0) return [];
  const only = options.files ? new Set(options.files) : undefined;
  const key = (file: string, line: number) => `${file}\u0000${line}`;
  const tally = new Map<string, { file: string; line: number; ef: number; ep: number }>();
  for (const run of runs) {
    for (const [file, lines] of run.lines) {
      if (only && !only.has(file)) continue;
      for (const line of lines) {
        const k = key(file, line);
        const t = tally.get(k) ?? { file, line, ef: 0, ep: 0 };
        if (run.passed) t.ep += 1;
        else t.ef += 1;
        tally.set(k, t);
      }
    }
  }
  return [...tally.values()]
    .filter((t) => t.ef > 0)
    .map((t) => ({ ...t, score: Math.round(ochiai(t.ef, t.ep, failing.length) * 1000) / 1000 }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line)
    .slice(0, options.limit ?? 50);
}

/**
 * PM-N6-5: run the failing reproduction and the passing tests with
 * coverage, rank the card's scope lines (or every line when it declares no
 * scope), and record the ranking with the scope.
 */
export async function localiseFix(
  ledger: PlannerLedger,
  input: {
    cardId: string;
    root: string;
    failing: readonly (readonly string[])[];
    passing: readonly (readonly string[])[];
    limit?: number;
  },
): Promise<SuspiciousLine[]> {
  const card = await ledger.store.getCard(input.cardId);
  const scopeFiles = (card?.scopeFiles ?? []).filter((f) => !TEST_FILE.test(f));
  const runs = await Promise.all([
    ...input.failing.map((c) => runWithCoverage(input.root, c)),
    ...input.passing.map((c) => runWithCoverage(input.root, c)),
  ]);
  const ranking = rankSuspiciousLines(runs, {
    ...(scopeFiles.length > 0 ? { files: scopeFiles } : {}),
    limit: input.limit ?? 20,
  });
  await appendPlannerEvent(
    ledger,
    "scope/localised",
    {
      cardId: input.cardId,
      method: "ochiai",
      failing: runs.filter((r) => !r.passed).length,
      passing: runs.filter((r) => r.passed).length,
      scopeFiles,
      lines: ranking.map((r) => ({ file: r.file, line: r.line, score: r.score })),
    },
    { cardId: input.cardId },
  );
  if (card && ranking.length > 0) {
    await ledger.store.recordDossierEntry({
      cardId: input.cardId,
      kind: "note",
      actor: "planner",
      text: `Where the fault most likely is (spectrum-based, Ochiai, from ${runs.filter((r) => !r.passed).length} failing and ${runs.filter((r) => r.passed).length} passing test runs): ${ranking
        .slice(0, 5)
        .map((r) => `${r.file}:${r.line} (${r.score})`)
        .join(", ")}.`,
    });
  }
  return ranking;
}
