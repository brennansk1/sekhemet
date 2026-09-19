import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BakeOffRecord } from "@sekhemet/models";
import type { EvalBenchmarkResult, TaskBenchmarkResult } from "./types.js";

const MATRIX_COLUMNS = [
  "Model",
  "Quant",
  "Engine",
  "Arm",
  "Ctx",
  "Temp",
  "Steps",
  "k",
  "Tasks",
  "Pass@1",
  "Pass@k",
  "Avg turns",
  "Tokens",
  "Wall",
  "Suite",
  "Harness",
  "Recorded",
];

const TASK_COLUMNS = [
  "Task",
  "Pass@1",
  "Pass@k",
  "Attempts",
  "Turns",
  "Tokens",
  "Stop reason",
  "Flipped to passing",
  "Still failing",
  "Regressed",
];

const UNTIERED = "Unspecified tier";

export interface ModelMatrixOptions {
  title?: string | undefined;
  /** Prose placed between the heading and the first table. */
  preamble?: string | undefined;
  /** Emit a per-task breakdown under each run. On by default. */
  includeTaskDetail?: boolean | undefined;
}

function escapeCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function table(header: string[], rows: string[][]): string {
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
  ];
  return lines.join("\n");
}

function averageTurns(result: EvalBenchmarkResult): number {
  const attempts = result.tasks.flatMap((task) => task.attempts);
  if (attempts.length === 0) return 0;
  return attempts.reduce((sum, a) => sum + a.turnsUsed, 0) / attempts.length;
}

function matrixRow(result: EvalBenchmarkResult): string[] {
  const s = result.settings;
  const harness =
    s.harnessCommitSha.length >= 7
      ? `${s.harnessCommitSha.slice(0, 7)}${s.harnessDirty ? " (dirty)" : ""}`
      : `${s.harnessCommitSha}${s.harnessDirty ? " (dirty)" : ""}`;

  return [
    s.modelId,
    s.quant,
    s.engine,
    s.toolArm,
    String(s.contextTokens),
    s.sampling.temperature.toFixed(2),
    String(s.stepBudget),
    String(s.passAtK),
    String(result.taskCount),
    percent(result.passAt1),
    result.settings.passAtK > 1 ? percent(result.passAtK) : "—",
    averageTurns(result).toFixed(1),
    String(result.totalTokens),
    formatDuration(result.totalTimeMs),
    s.suiteVersion,
    harness,
    s.timestamp,
  ];
}

function taskRow(task: TaskBenchmarkResult): string[] {
  const first = task.attempts[0];
  const last = task.attempts.at(-1);
  const turns = task.attempts.reduce((sum, a) => sum + a.turnsUsed, 0);
  const winning = task.attempts.find((a) => a.passed) ?? last;

  return [
    task.taskId,
    first?.passed ? "pass" : "fail",
    task.passed ? "pass" : "fail",
    String(task.attempts.length),
    String(turns),
    String(task.totalTokens),
    winning
      ? `${winning.stopReason}${winning.failureReason ? ` / ${winning.failureReason}` : ""}`
      : "—",
    winning?.flippedToPassing.join(", ") || "—",
    winning?.stillFailing.join(", ") || "—",
    winning?.regressed.join(", ") || "—",
  ];
}

/**
 * Render a `MODEL_MATRIX.md`-style document.
 *
 * Runs are grouped by hardware tier because a pass rate is only comparable
 * against another run on comparable silicon, and every row carries its own
 * settings rather than inheriting them from a section heading.
 */
export function renderModelMatrix(
  results: EvalBenchmarkResult[],
  options: ModelMatrixOptions = {},
): string {
  const sections: string[] = [];
  sections.push(`# ${options.title ?? "MODEL_MATRIX"}`);
  sections.push(
    options.preamble ??
      "Per-repo bake-off results. Candidates run under the real harness against fail-to-pass task oracles, so these numbers include harness effects. Every row records the full settings that produced it: a number without settings is not admissible.",
  );

  if (results.length === 0) {
    sections.push("_No benchmark runs recorded._");
    return `${sections.join("\n\n")}\n`;
  }

  const tiers = new Map<string, EvalBenchmarkResult[]>();
  for (const result of results) {
    const tier = result.settings.hardwareTier ?? UNTIERED;
    const bucket = tiers.get(tier);
    if (bucket) bucket.push(result);
    else tiers.set(tier, [result]);
  }

  for (const [tier, tierResults] of tiers) {
    sections.push(`## ${tier}`);
    sections.push(table(MATRIX_COLUMNS, tierResults.map(matrixRow)));
  }

  if (options.includeTaskDetail !== false) {
    sections.push("## Task detail");
    for (const result of results) {
      const s = result.settings;
      sections.push(
        `### ${s.modelId} · ${s.toolArm} · T=${s.sampling.temperature} · ${s.timestamp}`,
      );
      if (result.tasks.length === 0) {
        sections.push("_No tasks executed._");
        continue;
      }
      sections.push(table(TASK_COLUMNS, result.tasks.map(taskRow)));
    }
  }

  return `${sections.join("\n\n")}\n`;
}

/** Render the matrix and write it, creating parent directories as needed. */
export async function writeModelMatrix(
  filePath: string,
  results: EvalBenchmarkResult[],
  options: ModelMatrixOptions = {},
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, renderModelMatrix(results, options), "utf8");
}

/**
 * `MODEL_MATRIX.md` from recorded bake-off records (E4, X19): one row per
 * candidate and fixture with every setting that produced the number, the
 * best Pass@1 per fixture marked. Incomplete records are listed separately,
 * never mixed into the ranking.
 */
export function renderBakeOffMatrix(
  records: readonly (BakeOffRecord & { incomplete?: string[] })[],
  options: { title?: string } = {},
): string {
  const out = [
    `# ${options.title ?? "MODEL_MATRIX"}`,
    "Measured on this machine and this repository by `sekhemet bake-off`. Every row carries the settings that produced it; a number without settings is not admissible.",
  ];
  const admissible = records.filter((r) => !r.incomplete?.length);
  const fixtures = [...new Set(admissible.map((r) => r.fixture))].sort();
  if (fixtures.length === 0) out.push("_No admissible bake-off records._");
  for (const fixture of fixtures) {
    const rows = admissible
      .filter((r) => r.fixture === fixture)
      .sort((a, b) => b.passAt1 - a.passAt1 || a.minutes - b.minutes);
    const best = rows[0];
    out.push(`## ${fixture}`);
    out.push(
      table(
        [
          "Model",
          "Quant",
          "Engine",
          "Arm",
          "Ctx",
          "KV",
          "MTP",
          "Steps",
          "Pass@1",
          "Passed",
          "Minutes",
          "Tokens",
          "Harness",
          "Date",
        ],
        rows.map((r) => [
          `${r === best ? "**" : ""}${r.candidate.modelId}${r === best ? "**" : ""}`,
          r.candidate.quant,
          r.candidate.engine,
          r.candidate.toolArm,
          String(r.candidate.contextTokens ?? ""),
          r.candidate.kvType ?? "",
          r.candidate.mtp === undefined ? "" : r.candidate.mtp ? "on" : "off",
          String(r.stepBudget),
          percent(r.passAt1),
          `${r.passed}/${r.total}`,
          String(r.minutes),
          String(r.tokens),
          r.harnessCommit.slice(0, 7),
          r.date.slice(0, 10),
        ]),
      ),
    );
  }
  const bad = records.filter((r) => r.incomplete?.length);
  if (bad.length) {
    out.push("## Inadmissible records (missing settings)");
    out.push(
      bad
        .map((r) => `- ${r.candidate.modelId} on ${r.fixture}: missing ${r.incomplete?.join(", ")}`)
        .join("\n"),
    );
  }
  return `${out.join("\n\n")}\n`;
}

export async function writeBakeOffMatrix(
  filePath: string,
  records: readonly BakeOffRecord[],
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, renderBakeOffMatrix(records), "utf8");
}
