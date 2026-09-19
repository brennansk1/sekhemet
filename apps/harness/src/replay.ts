import type { CardStore, EventRecord } from "@sekhemet/kernel";

/**
 * `sekhemet replay` (H8): an attempt's trajectory, rebuilt from the ledger,
 * and the difference between two attempts.
 *
 * A trajectory is the attempt's steps in order: the tool calls with their
 * targets and outcomes, the gate result, tokens, and the stop reason. Two
 * attempts (a retry, a fork, the same card on another model with `--as`)
 * are aligned step by step; the report names the first step where they chose
 * differently, and what changed in their reproducibility records (model,
 * prompt, tool schema, rules, gates, harness).
 */

export interface TrajectoryStep {
  turn: number;
  calls: { name: string; target?: string; ok?: boolean }[];
  gate?: { passed: boolean; failed: string[] };
  tokens: number;
  stopReason?: string;
}

export interface Trajectory {
  cardId: string;
  attemptId: string;
  attemptNumber: number;
  modelId: string;
  forkedFrom?: { attemptId: string; step: number };
  steps: TrajectoryStep[];
  outcome: string;
  repro?: Record<string, unknown>;
}

export async function trajectories(cardStore: CardStore, cardId: string): Promise<Trajectory[]> {
  const events = await cardStore.cardEvents(cardId, [
    "attempt/started",
    "attempt/finished",
    "card/step",
    "card/repro",
  ]);
  const out: Trajectory[] = [];
  const byAttempt = new Map<string, Trajectory>();
  let current: Trajectory | undefined;
  for (const e of events as EventRecord<Record<string, unknown>>[]) {
    const p = e.payload ?? {};
    if (e.type === "attempt/started") {
      const started: Trajectory = {
        cardId,
        attemptId: String(p.id),
        attemptNumber: Number(p.attemptNumber ?? out.length + 1),
        modelId: String(p.modelId ?? "?"),
        steps: [],
        outcome: "running",
      };
      if (p.forkedFrom) started.forkedFrom = p.forkedFrom as { attemptId: string; step: number };
      current = started;
      out.push(started);
      byAttempt.set(started.attemptId, started);
      continue;
    }
    const t = (e.attemptId && byAttempt.get(e.attemptId)) || current;
    if (!t) continue;
    if (e.type === "card/step") {
      const calls =
        (p.calls as { name: string; target?: string; ok?: boolean }[] | undefined) ?? [];
      const usage = p.usage as { promptTokens?: number; completionTokens?: number } | undefined;
      const gate = p.gate as { passed: boolean; failed: string[] } | undefined;
      t.steps.push({
        turn: Number(p.turn ?? t.steps.length + 1),
        calls: calls.map((c) => ({
          name: c.name,
          ...(c.target ? { target: c.target } : {}),
          ...(c.ok !== undefined ? { ok: c.ok } : {}),
        })),
        ...(gate ? { gate: { passed: gate.passed, failed: gate.failed ?? [] } } : {}),
        tokens: (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0),
        ...(p.stopReason ? { stopReason: String(p.stopReason) } : {}),
      });
    } else if (e.type === "attempt/finished") {
      t.outcome = String(p.status ?? p.stopReason ?? "finished");
    } else if (e.type === "card/repro") {
      t.repro = p;
    }
  }
  return out;
}

const signature = (s: TrajectoryStep) =>
  s.calls.map((c) => `${c.name}(${c.target ?? ""})`).join(" ");

export function formatTrajectory(t: Trajectory): string {
  const head = `Attempt ${t.attemptNumber} (${t.attemptId}) on ${t.modelId}${t.forkedFrom ? `, forked from ${t.forkedFrom.attemptId} at step ${t.forkedFrom.step}` : ""}: ${t.outcome}, ${t.steps.length} step(s), ${t.steps.reduce((n, s) => n + s.tokens, 0)} tokens`;
  const rows = t.steps.map((s) => {
    const gate = s.gate
      ? ` | gates ${s.gate.passed ? "pass" : `FAIL ${s.gate.failed.join(",")}`}`
      : "";
    const calls = s.calls
      .map((c) => `${c.name}${c.target ? ` ${c.target}` : ""}${c.ok === false ? " ✗" : ""}`)
      .join("; ");
    return `  ${String(s.turn).padStart(2)}. ${calls || "(no tool)"}${gate}${s.stopReason ? ` | stop: ${s.stopReason}` : ""}`;
  });
  return [head, ...rows].join("\n");
}

export interface TrajectoryDiff {
  firstDivergence?: number;
  a: { steps: number; tokens: number; outcome: string };
  b: { steps: number; tokens: number; outcome: string };
  sameChoicesUntil: number;
  reproChanged: string[];
}

export function diffTrajectories(a: Trajectory, b: Trajectory): TrajectoryDiff {
  let same = 0;
  let divergence: number | undefined;
  const n = Math.max(a.steps.length, b.steps.length);
  for (let i = 0; i < n; i++) {
    const sa = a.steps[i];
    const sb = b.steps[i];
    if (sa && sb && signature(sa) === signature(sb)) {
      same++;
      continue;
    }
    divergence = i + 1;
    break;
  }
  const reproChanged: string[] = [];
  if (a.repro && b.repro) {
    for (const key of [
      "model",
      "promptSha",
      "toolSchemaSha",
      "playbookSha",
      "activeRules",
      "gatesSha",
      "harness",
    ]) {
      if (JSON.stringify(a.repro[key]) !== JSON.stringify(b.repro[key])) reproChanged.push(key);
    }
  }
  const sum = (t: Trajectory) => ({
    steps: t.steps.length,
    tokens: t.steps.reduce((x, s) => x + s.tokens, 0),
    outcome: t.outcome,
  });
  return {
    ...(divergence !== undefined ? { firstDivergence: divergence } : {}),
    a: sum(a),
    b: sum(b),
    sameChoicesUntil: same,
    reproChanged,
  };
}

export function formatDiff(a: Trajectory, b: Trajectory, d: TrajectoryDiff): string {
  const lines = [
    `Attempt ${a.attemptNumber} (${a.modelId}) vs attempt ${b.attemptNumber} (${b.modelId}):`,
    `  outcome: ${d.a.outcome} vs ${d.b.outcome}; steps ${d.a.steps} vs ${d.b.steps}; tokens ${d.a.tokens} vs ${d.b.tokens}`,
    d.firstDivergence === undefined
      ? "  The same tool choices at every step."
      : `  Same choices for ${d.sameChoicesUntil} step(s); they diverge at step ${d.firstDivergence}:\n    ${a.steps[d.firstDivergence - 1] ? signature(a.steps[d.firstDivergence - 1] as TrajectoryStep) : "(ended)"}\n    ${b.steps[d.firstDivergence - 1] ? signature(b.steps[d.firstDivergence - 1] as TrajectoryStep) : "(ended)"}`,
    d.reproChanged.length
      ? `  What changed between them: ${d.reproChanged.join(", ")}.`
      : "  Their reproducibility records match.",
  ];
  return lines.join("\n");
}
