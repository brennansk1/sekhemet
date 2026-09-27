import { SOURCE_KIND_WEIGHTS, type Source, type SourceKind, tierOfSource } from "./sources.js";

/**
 * Claims, disagreement, and the gate on revision.
 *
 * A research report is not prose to be admired; it is a set of claims, each
 * of which is true or is not. This module types them so the pipeline can
 * treat them differently:
 *
 * - **executable** — a claim about software that can be *run*. This is what a
 *   harness can do that a hosted research product cannot: it owns a sandbox,
 *   so "this function has this signature" becomes a rung in the evidence
 *   bundle instead of a sentence.
 * - **citational** — the source says what the report says it says.
 * - **contested** — sources disagree. The disagreement is reported, not
 *   resolved silently: flattening conflict into confident prose is the
 *   characteristic failure of summarised search.
 * - **temporal** — true as of a date, and carrying that date.
 *
 * Extraction here is deterministic and cue-based. It is a pre-pass, not a
 * judgement: it decides what *kind* of checking a sentence needs, and the
 * checking itself is done by execution, by citation matching, and by
 * comparing sources — never by asking a model whether it was right.
 */

export type ClaimKind = "executable" | "citational" | "contested" | "temporal";

export interface Claim {
  /** 1-based index in the report, so a verdict can be attached back. */
  id: number;
  text: string;
  kind: ClaimKind;
  /** The `[n]` markers in the sentence. */
  citations: number[];
  /** For an executable claim: what to install before running it. */
  subject?: string;
  version?: string;
}

const TEMPORAL =
  /\b(as of|currently|at present|since v?\d|no longer|deprecat|latest version|nowadays|today)\b/i;
const EXECUTABLE =
  /\b(returns?|accepts?|takes?|exports?|throws?|signature|parameter|default(s to)?|option|method|property|rejects?|resolves?)\b/i;
const HEDGE = /\b(may|might|appears|seems|reportedly|some (say|report)|unclear|conflicting)\b/i;

/** A package name mentioned in backticks, which an executable claim needs. */
function subjectOf(sentence: string): { subject?: string; version?: string } {
  const code = /`([^`]{1,60})`/.exec(sentence)?.[1] ?? "";
  const pkg = /^(@[\w.-]+\/)?[a-z][\w.-]*$/i.exec(code.split(/[.(\s]/)[0] ?? "")?.[0];
  const version = /\bv?(\d+\.\d+(\.\d+)?)\b/.exec(sentence)?.[1];
  return { ...(pkg ? { subject: pkg } : {}), ...(version ? { version } : {}) };
}

/** Split a report into sentences, keeping citation markers with their sentence. */
export function sentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, " ") // code blocks are evidence, not claims
    .split(/(?<=[.!?])\s+(?=[A-Z`"'(])|\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25 && !/^#{1,6}\s/.test(s));
}

/** The claims a report makes, typed by the checking each one needs. */
export function extractClaims(report: string): Claim[] {
  const out: Claim[] = [];
  for (const text of sentences(report)) {
    const citations = [...text.matchAll(/\[(\d{1,2})\]/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n > 0);
    const hasCode = /`[^`]+`/.test(text);
    const kind: ClaimKind = HEDGE.test(text)
      ? "contested"
      : hasCode && EXECUTABLE.test(text)
        ? "executable"
        : TEMPORAL.test(text)
          ? "temporal"
          : "citational";
    out.push({
      id: out.length + 1,
      text,
      kind,
      citations,
      ...(kind === "executable" ? subjectOf(text) : {}),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Disagreement                                                        */
/* ------------------------------------------------------------------ */

export interface Position {
  stance: string;
  source: Source;
  /** ISO date of the source, when known; recency breaks a tier tie. */
  at?: string;
}

export interface Disagreement {
  topic: string;
  positions: Position[];
  /** The better-supported stance, and the reason it wins. */
  betterSupported: string;
  why: string;
}

const weightOf = (s: Source): number =>
  SOURCE_KIND_WEIGHTS[s.kind as SourceKind]?.[0] ?? SOURCE_KIND_WEIGHTS.web[0];

/**
 * Which position is better supported, and why — stated, never silently
 * applied. Authority first (the design's source weights), then recency,
 * then the number of independent sources holding it.
 */
export function adjudicate(topic: string, positions: Position[]): Disagreement | undefined {
  const stances = new Map<string, Position[]>();
  for (const p of positions) {
    const key = p.stance.trim().toLowerCase();
    stances.set(key, [...(stances.get(key) ?? []), p]);
  }
  if (stances.size < 2) return undefined;
  const scored = [...stances.entries()].map(([key, ps]) => ({
    key,
    stance: ps[0]?.stance ?? key,
    authority: Math.max(...ps.map((p) => weightOf(p.source))),
    newest:
      ps
        .map((p) => p.at ?? "")
        .sort()
        .at(-1) ?? "",
    count: new Set(ps.map((p) => p.source.ref)).size,
    ps,
  }));
  scored.sort(
    (a, b) => b.authority - a.authority || b.newest.localeCompare(a.newest) || b.count - a.count,
  );
  const [win, runner] = scored;
  if (!win || !runner) return undefined;
  const why =
    win.authority > runner.authority
      ? `a ${win.ps[0]?.source.kind ?? "stronger"} source outranks a ${runner.ps[0]?.source.kind ?? "weaker"} one`
      : win.newest > runner.newest
        ? `the supporting source is newer (${win.newest || "undated"} against ${runner.newest || "undated"})`
        : `more independent sources hold it (${win.count} against ${runner.count})`;
  return { topic, positions, betterSupported: win.stance, why };
}

const TIER_NAMES = { 1: "primary", 2: "secondary", 3: "other" } as const;

/** The ledger as it appears in the report: both positions with tier and date, and the verdict (DS-N2-8). */
export function renderDisagreements(ds: Disagreement[]): string {
  if (!ds.length) return "";
  return [
    "## Where sources disagree",
    "",
    ...ds.flatMap((d) => [
      `**${d.topic}**`,
      ...d.positions.map((p) => {
        const tier = tierOfSource(p.source);
        return `- ${p.stance} — ${p.source.kind}${tier ? ` (${TIER_NAMES[tier]})` : ""}, ${p.source.ref}${p.at ? ` (${p.at})` : ""}`;
      }),
      `Better supported: ${d.betterSupported}, because ${d.why}.`,
      "",
    ]),
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* The gate on revision                                                */
/* ------------------------------------------------------------------ */

/**
 * The grounded risk of a draft. Every component is measured outside the
 * generated text: citations are matched against what was read, coverage and
 * confidence come from the source ledger, and failed claims come from the
 * sandbox. None of it is the model's opinion of its own work.
 */
export interface RiskVector {
  /** Citation markers that point at nothing read. Lower is better. */
  badCitations: number;
  /** Sub-questions of the brief still open. Lower is better. */
  uncovered: number;
  /** Executable claims that did not reproduce. Lower is better. */
  failedClaims: number;
  /** Executable claims no run has checked: documented at best (DS-N2-6). Lower is better. */
  unreproduced: number;
  /** Grounding confidence in [0, 1]. Higher is better. */
  confidence: number;
}

export interface RevisionVerdict {
  accept: boolean;
  reason: string;
}

const EPS = 1e-9;

/**
 * Accept a revision only when no component of the grounded risk worsens and
 * at least one improves; otherwise the previous draft stands.
 *
 * This is the harness's standing rule — the model does not judge its own
 * output — applied to the critique stage. A gate that reads only the
 * generated text cannot reliably improve on it, so the critique stage does
 * not rewrite freely: it proposes, and a measured vector disposes. It also
 * gives the stage a stopping condition it otherwise lacks: stop when no
 * candidate revision lowers risk.
 */
export function acceptRevision(prev: RiskVector, next: RiskVector): RevisionVerdict {
  const worse: string[] = [];
  if (next.badCitations > prev.badCitations) worse.push("more unverified citations");
  if (next.uncovered > prev.uncovered) worse.push("fewer sub-questions answered");
  if (next.failedClaims > prev.failedClaims) worse.push("more claims that do not reproduce");
  if (next.unreproduced > prev.unreproduced) worse.push("more unreproduced executable claims");
  if (next.confidence < prev.confidence - EPS) worse.push("lower grounding confidence");
  if (worse.length) return { accept: false, reason: `rejected: ${worse.join(", ")}` };

  const better: string[] = [];
  if (next.badCitations < prev.badCitations) better.push("fewer unverified citations");
  if (next.uncovered < prev.uncovered) better.push("more sub-questions answered");
  if (next.failedClaims < prev.failedClaims) better.push("fewer failing claims");
  if (next.unreproduced < prev.unreproduced) better.push("fewer unreproduced executable claims");
  if (next.confidence > prev.confidence + EPS) better.push("higher grounding confidence");
  return better.length
    ? { accept: true, reason: `accepted: ${better.join(", ")}` }
    : { accept: false, reason: "rejected: no measured improvement" };
}

/** A report is eligible for Review only when its claims have been settled. */
export function reviewEligible(
  claims: Claim[],
  verdicts: Map<number, "reproduced" | "unreproducible" | "documented">,
): { eligible: boolean; reason: string } {
  const unsettled = claims.filter((c) => c.kind === "executable" && !verdicts.has(c.id));
  return unsettled.length
    ? {
        eligible: false,
        reason: `${unsettled.length} executable claim(s) neither executed nor marked unreproducible: ${unsettled
          .map((c) => c.id)
          .join(", ")}`,
      }
    : { eligible: true, reason: "every executable claim has a verdict" };
}
