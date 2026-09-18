// Review findings from the ledger: Seshat's or the Reviewer's review of a
// passing card, either the old `{findings}` payload or a dossier entry.

/**
 * A dossier review entry (`{kind:"review", text, verdict}`, one "- [severity]
 * note" line per finding) as the findings list the Review surface renders.
 */
export function reviewFindings(p) {
  if (!p) return [];
  if (Array.isArray(p.findings)) return p.findings;
  if (typeof p.text !== "string") return [];
  return p.text
    .split("\n")
    .map((line) => /^-\s*\[([^\]]+)\]\s*(.+)$/.exec(line.trim()))
    .filter(Boolean)
    .map((m) => ({ severity: m[1], note: m[2] }));
}

/** The newest `card/review` payload with findings, or null. */
export function latestReview(events) {
  const ev = (events ?? [])
    .filter((x) => x.type === "card/review")
    .sort((a, b) => b.seq - a.seq)[0];
  const findings = reviewFindings(ev?.payload);
  return findings.length ? { ...ev.payload, findings, at: ev.timestamp ?? ev.createdAt } : null;
}
