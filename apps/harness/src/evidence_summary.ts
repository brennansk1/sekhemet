import { basename } from "node:path";
import type { CardRecord } from "@sekhemet/kernel";
import { groupByIntent } from "@sekhemet/sync";

/**
 * The evidence summary (review-git §2.5.7, RG-S5-18): the spec, *Done when*,
 * the gates with durations, the tests added, the diff stats, what was tried
 * and abandoned, and each visual-gate screenshot. The pull request's body,
 * and the squash commit's body when there is no adapter.
 */
export function evidenceSummary(
  card: CardRecord,
  ev: {
    rungResults?: { gate: string; passed: boolean; skipped?: boolean; durationMs?: number }[];
    filesTouched?: string[];
    linesAdded?: number;
    linesRemoved?: number;
    diff?: string;
    screenshots?: string[];
    /** Coverage percentages by measure, when a gate measured it (INT-12a). */
    coverage?: Record<string, number>;
  },
  abandoned: readonly { attempt: number; stopReason: string }[],
): string {
  const gates = (ev.rungResults ?? [])
    .map(
      (r) =>
        `- ${r.skipped ? "skipped" : r.passed ? "pass" : "FAIL"} ${r.gate}${r.durationMs !== undefined ? ` (${r.durationMs} ms)` : ""}`,
    )
    .join("\n");
  const added = new Set<string>();
  for (const m of (ev.diff ?? "").matchAll(/^--- \/dev\/null\n\+\+\+ b\/(.+)$/gm)) {
    if (m[1]) added.add(m[1]);
  }
  const tests = [...added].filter((f) => groupByIntent([f]).tests.length > 0);
  const files = ev.filesTouched ?? [];
  return [
    card.spec ?? "",
    card.acceptanceCriteria?.length
      ? `### Done when\n${card.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
      : "",
    `### Gates\n${gates || "_No gate results were recorded._"}`,
    `### Tests added\n${tests.length ? tests.map((t) => `- ${t}`).join("\n") : "_None._"}`,
    `### Diff\n${files.length} file(s), +${ev.linesAdded ?? 0} −${ev.linesRemoved ?? 0}`,
    `### Coverage\n${
      ev.coverage && Object.keys(ev.coverage).length
        ? Object.entries(ev.coverage)
            .map(([k, v]) => `${k} ${v}%`)
            .join(", ")
        : "_Not measured for this card._"
    }`,
    `### Tried and abandoned\n${abandoned.length ? abandoned.map((a) => `- attempt ${a.attempt}: ${a.stopReason}`).join("\n") : "_Nothing._"}`,
    ev.screenshots?.length
      ? `### Screenshots\n${ev.screenshots.map((p) => `- [${basename(p)}](${p})`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
