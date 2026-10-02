import { type LocalInferenceAdapter, stripReasoning } from "@sekhemet/models";
import { type EvidenceLedger, verifyReferences } from "./apodex_loop.js";
import {
  type Disagreement,
  type Position,
  type RiskVector,
  acceptRevision,
  adjudicate,
} from "./claims.js";
import { researchCopy } from "./research_copy.js";
import { type ResearchAnswer, withClaims } from "./researcher.js";
import type { Source } from "./sources.js";

/**
 * The gated critique pass (design-stage §2.7.5; DS-N2-6, DS-N2-7, DS-N2-8).
 *
 * The model proposes one revision at a time; a measured risk vector disposes.
 * Each candidate's citations are checked against the ledger by the one
 * reference checker, its executable claims are counted, and its coverage is
 * the draft's (a rewrite reads nothing new). A candidate is accepted only
 * when no component worsens and one improves (`acceptRevision`); otherwise
 * the prior draft stands and the pass stops, because no candidate lowered
 * the risk. The effort sets how many candidates may be judged. There is no
 * separate citation-repair pass: this is the only revision stage.
 *
 * Disagreements the candidates report (`DISAGREEMENT: topic | a [n] | b [m]`)
 * are kept only when each position cites a source that was read; each is
 * adjudicated in code (authority, then recency, then count) and reported
 * with both positions, their tiers and dates.
 */

export interface CritiqueRound {
  accepted: boolean;
  reason: string;
  risk: RiskVector;
}

export interface CritiqueResult {
  answer: ResearchAnswer;
  rounds: CritiqueRound[];
  disagreements: Disagreement[];
}

const DISAGREEMENT = /^\s*DISAGREEMENT:\s*(.+)$/gim;

/** The candidate without its disagreement lines: the text the risk is measured on. */
function answerText(text: string): string {
  return text
    .replace(DISAGREEMENT, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The disagreements a text reports, each position resolved to a source that
 * was read; a line citing nothing read, or with fewer than two positions, is
 * dropped.
 */
export function parseDisagreements(
  text: string,
  ledger: EvidenceLedger,
  numbered?: readonly Source[],
): Disagreement[] {
  const v = verifyReferences(text, ledger, numbered);
  const byN = new Map<number, Source>();
  for (const r of v.references) {
    if (!r.read) continue;
    const source = v.evidence.find((s) => s.ref === r.ref || r.ref.includes(s.ref)) ??
      ledger.read.get(r.ref) ?? { kind: "web", ref: r.ref };
    byN.set(r.n, source);
  }
  const out: Disagreement[] = [];
  for (const m of text.matchAll(DISAGREEMENT)) {
    const [topic, ...parts] = (m[1] ?? "").split("|").map((p) => p.trim());
    if (!topic || parts.length < 2) continue;
    const positions: Position[] = parts.flatMap((part) => {
      const stance = part.replace(/\[\d{1,3}\]/g, "").trim();
      const cited = [...part.matchAll(/\[(\d{1,3})\]/g)].flatMap((c) => {
        const s = byN.get(Number(c[1]));
        return s ? [s] : [];
      });
      return stance
        ? cited.map((source) => {
            const at = ledger.dates.get(source.ref);
            return { stance, source, ...(at ? { at } : {}) };
          })
        : [];
    });
    const d = adjudicate(topic, positions);
    if (d && !out.some((o) => o.topic.toLowerCase() === d.topic.toLowerCase())) out.push(d);
  }
  return out;
}

/** The candidate measured exactly as the draft is: citations, claims, coverage, confidence. */
function measure(
  text: string,
  draft: ResearchAnswer,
  ledger: EvidenceLedger,
  numbered: readonly Source[] | undefined,
  rebuild: (a: Omit<ResearchAnswer, "claims" | "risk">) => ResearchAnswer,
): ResearchAnswer {
  const v = verifyReferences(text, ledger, numbered);
  const { claims: _c, risk: _r, ...rest } = draft;
  return rebuild({
    ...rest,
    answer: text,
    badCitations: v.badCitations,
    references: v.references,
    // A numbered pipeline lists every source read; a References section names its own.
    ...(numbered ? {} : { evidence: v.evidence, sources: v.evidence.map((e) => e.ref) }),
    confidence: draft.grounded ? v.confidence : 0,
  });
}

export async function critiquePass(
  model: LocalInferenceAdapter,
  question: string,
  draft: ResearchAnswer,
  ledger: EvidenceLedger,
  opts: {
    candidates: number;
    /** The generic pipeline's numbered sources; absent when the draft has a References section. */
    numbered?: readonly Source[];
  },
): Promise<CritiqueResult> {
  const rebuild = withClaims;
  let current = measure(draft.answer, draft, ledger, opts.numbered, rebuild);
  const rounds: CritiqueRound[] = [];
  const disagreements: Disagreement[] = [];
  const sources = (opts.numbered ?? [...ledger.read.values()])
    .map((s, i) => `[${i + 1}] ${s.title ? `${s.title}: ` : ""}${s.ref}`)
    .join("\n");
  for (let i = 0; i < opts.candidates; i++) {
    const res = await model.generate({
      role: "researcher",
      systemPrompt: researchCopy.critiqueSystem,
      prompt: researchCopy.critique({
        question,
        draft: current.answer,
        sources,
        badCitations: current.badCitations,
        unreproduced: current.claims.filter((c) => c.kind === "executable").map((c) => c.text),
        outstanding: current.coverage?.outstanding ?? [],
      }),
      toolArm: "arm_a_flat",
      maxTokens: 1500,
      purpose: "planning",
    });
    const raw = stripReasoning(res.text);
    for (const d of parseDisagreements(raw, ledger, opts.numbered)) {
      if (!disagreements.some((o) => o.topic.toLowerCase() === d.topic.toLowerCase()))
        disagreements.push(d);
    }
    const text = answerText(raw);
    if (!text) {
      rounds.push({ accepted: false, reason: "rejected: an empty candidate", risk: current.risk });
      break;
    }
    const candidate = measure(text, current, ledger, opts.numbered, rebuild);
    const verdict = acceptRevision(current.risk, candidate.risk);
    rounds.push({ accepted: verdict.accept, reason: verdict.reason, risk: candidate.risk });
    if (!verdict.accept) break; // no candidate lowered the risk: stop (DS-N2-6)
    current = candidate;
  }
  return {
    answer: {
      ...current,
      critique: rounds.map((r) => ({ accepted: r.accepted, reason: r.reason })),
      ...(disagreements.length ? { disagreements } : {}),
    },
    rounds,
    disagreements,
  };
}
