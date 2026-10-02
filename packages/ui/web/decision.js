// The decision request component (FRONTEND_DESIGN §2.5.7) and the pure helpers
// the Inbox sorts and words them with. Pure functions are exported for tests.

/** Planner decisions (rich) and the kernel's plain asks, as one list. */
export function mergeDecisions(planner, plain) {
  const out = [];
  const seen = new Set();
  for (const d of planner ?? []) {
    if (d.state !== "pending") continue;
    seen.add(d.id);
    const r = d.request;
    out.push({
      id: d.id,
      cardId: r.cardId,
      question: r.question,
      category: r.category,
      options: r.options.map((o, i) => ({
        label: o.label,
        consequence: o.consequence,
        effort: o.effortDelta,
        risk: o.riskNote,
        preview: o.previewSketch ?? r.previewSketches?.[i] ?? "",
        destructive: Boolean(o.destructive),
      })),
      recommended: r.recommendation?.optionIndex,
      rationale: r.recommendation?.rationale ?? "",
      policy: r.policy,
      defaultIndex: r.defaultIfNoAnswer?.optionIndex,
      deadline: r.defaultIfNoAnswer?.deadline,
      createdAt: r.createdAt ?? d.record?.createdAt,
      source: "planner",
    });
  }
  for (const d of plain ?? []) {
    if (d.status !== "pending" || seen.has(d.id)) continue;
    out.push({
      id: d.id,
      cardId: d.cardId,
      question: d.question,
      category: d.kind,
      context: d.context,
      options: d.options.map((label) => ({ label })),
      recommended: d.recommendationIndex,
      rationale: "",
      policy: d.kind === "permission" ? "default_deny" : undefined,
      createdAt: d.createdAt,
      source: "kernel",
    });
  }
  return out;
}

/** Longest wait first: the Inbox's order (§2.4.8). */
export function byWait(list, now = Date.now()) {
  return [...list].sort(
    (a, b) => waited(b, now) - waited(a, now) || String(a.id).localeCompare(String(b.id)),
  );
}

export function waited(d, now = Date.now()) {
  const t = Date.parse(d.createdAt ?? "");
  return Number.isFinite(t) ? Math.max(0, now - t) : 0;
}

export function duration(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/**
 * The footer policy sentence. The countdown is worded to the minute and turns
 * amber under 15 minutes.
 */
export function policyLine(d, now = Date.now()) {
  if (d.policy === "safe_default" && d.deadline && d.defaultIndex !== undefined) {
    const at = Date.parse(d.deadline);
    const left = at - now;
    const letter = String.fromCharCode(65 + d.defaultIndex);
    const clock = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (left <= 0) return { text: `Option ${letter} is being applied.`, urgent: true };
    return {
      text: `If you don't answer by ${clock} (in ${duration(left)}), option ${letter} is applied.`,
      urgent: left < 15 * 60_000,
    };
  }
  return { text: "If you don't answer, the issue stays on hold.", urgent: false, lock: true };
}
