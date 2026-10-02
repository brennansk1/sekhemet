import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BoardService, TransitionRefusedError } from "@sekhemet/board";
import {
  type BuiltinGateResult,
  DEFAULT_CLAIMS_REPORT,
  type GatesConfig,
  type ReportedClaim,
  loadGatesConfig,
  runBuiltinGates,
} from "@sekhemet/gates";
import type { CardRecord, CardStatus, CardStore } from "@sekhemet/kernel";
import { plural } from "@sekhemet/ui";
import { recordLedgerRun } from "../ledger_evidence.js";
import { type Claim, renderDisagreements, reviewEligible } from "./claims.js";
import type { ResearchAnswer } from "./researcher.js";

/**
 * Research cards (X7): a card labelled `research` asks a question rather
 * than asking for code. The queue gives it to the Researcher (deep research:
 * a team of sub-researchers and a verifier), not the Worker, and the result
 * is a cited note:
 *
 * - `.sekhemet/research/<card>.md`: the answer, its numbered sources, and
 *   the verdict (grounded, confidence, unverified citations);
 * - the card's dossier (the ledger), through the research service;
 * - an evidence bundle, so Review shows it like any other card;
 * - the card moves to Review when the answer is grounded, and is parked with
 *   the reason when it is not. A person accepts the note; nothing merges.
 *
 * Every move goes through the board (kernel K-S4-4): the note's run is an
 * attempt on the ledger with its stop reason and evidence, so Verify's and
 * Review's entry conditions and back-pressure apply as they do to the
 * Worker's cards. A move the board refuses holds the card with its reason.
 */

/** The board a research card moves through; `holdCard` records a refused move. */
export type ResearchBoard = Pick<BoardService, "transitionCard"> & {
  holdCard?: (
    cardId: string,
    reason: string,
    actor?: string,
    awaiting?: CardStatus,
  ) => Promise<void>;
};

export function isResearchCard(card: Pick<CardRecord, "labels">): boolean {
  return (card.labels ?? []).some((l) => l.toLowerCase() === "research");
}

export function researchQuestion(card: CardRecord): string {
  const criteria = (card.acceptanceCriteria ?? []).map((c) => `- ${c}`).join("\n");
  return [card.title, card.spec ?? "", criteria ? `The answer must cover:\n${criteria}` : ""]
    .filter(Boolean)
    .join("\n\n");
}

/** Claims the report makes, grouped by the checking each one needs. */
function claimSummary(claims: Claim[] | undefined): string[] {
  // Absent, not empty, for an answer recalled from research memory written
  // before claims were typed: an old entry has no claim list and must still
  // render rather than throwing on the note.
  const all = claims ?? [];
  const byKind = new Map<string, number>();
  for (const c of all) byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
  if (!byKind.size) return [];
  const counts = [...byKind.entries()].sort().map(([k, n]) => `${n} ${k}`);
  const executable = all.filter((c) => c.kind === "executable");
  return [
    "## Claims",
    "",
    `${plural(all.length, "claim")}: ${counts.join(", ")}.`,
    ...(executable.length
      ? [
          "",
          "Executable, pending the claim check:",
          ...executable.map((c) => `- [${c.id}] ${c.text}`),
        ]
      : []),
    "",
  ];
}

export function researchNote(card: CardRecord, r: ResearchAnswer, at = new Date()): string {
  const verdict = r.grounded
    ? `Grounded, confidence ${r.confidence.toFixed(2)}${r.badCitations.length ? `; citations [${r.badCitations.join(", ")}] point at nothing read` : ""}.`
    : "Not grounded: the evidence did not settle it.";
  return [
    `# ${card.title}`,
    "",
    `Research note for \`${card.id}\`, ${at.toISOString().slice(0, 10)}. ${verdict}`,
    "",
    r.answer.trim(),
    "",
    ...claimSummary(r.claims),
    ...(r.coverage?.outstanding.length
      ? [
          "## Not covered",
          "",
          "Open after one re-dispatch: fewer than two independent primary or secondary sources.",
          "",
          ...r.coverage.outstanding.map((o) => `- ${o}`),
          "",
        ]
      : []),
    ...(r.disagreements?.length ? [renderDisagreements(r.disagreements), ""] : []),
    ...(r.sources.length
      ? ["## Sources read", "", ...r.sources.map((s, i) => `${i + 1}. ${s}`), ""]
      : []),
  ].join("\n");
}

/**
 * Why an executable claim was not run, when a source that was read states it
 * (DS-N2-1): "documented, not reproduced", naming the citation. Undefined
 * when no citation points at a source read — such a claim has neither a
 * reproduction nor a reason, and the claim gate fails it (DS-N2-2).
 */
export function documentedReason(claim: Claim, answer: ResearchAnswer): string | undefined {
  const bad = new Set(answer.badCitations);
  const read = claim.citations.flatMap((n) => {
    const r = answer.references?.find((x) => x.n === n && x.read);
    return r && !bad.has(n) ? [`[${n}] ${r.ref}`] : [];
  });
  return read.length > 0
    ? `documented, not reproduced: the research pipeline wrote no reproduction script; stated by ${read.join(", ")}`
    : undefined;
}

/**
 * The claims report the claim gate reads (gates rule 27a, GT-N5-3): every
 * claim of the answer, typed. The research pipeline writes no reproduction
 * script, so an executable claim a source read states is recorded as
 * documented, not reproduced, with the reason (DS-N2-1); one no read source
 * states reaches the gate with neither, and the gate holds the note back
 * naming it (DS-N2-2).
 */
export function claimsReport(card: CardRecord, answer: ResearchAnswer): string {
  const claims: ReportedClaim[] = (answer.claims ?? []).map((c) => {
    const reason = c.kind === "executable" ? documentedReason(c, answer) : undefined;
    return {
      id: String(c.id),
      kind: c.kind,
      text: c.text,
      ...(reason ? { unreproducible: reason } : {}),
    };
  });
  return `${JSON.stringify({ card: card.id, claims }, null, 2)}\n`;
}

/**
 * A research card's verification (GT-N5-3): its claims report checked by the
 * claim gate `gates.toml` declares, under the file's pinned hash, as for any
 * card. Undefined when the project declares no `[claims]`.
 */
export async function verifyResearchClaims(
  card: CardRecord,
  repoPath: string,
  gates: GatesConfig,
): Promise<BuiltinGateResult | undefined> {
  if (!gates.project.claims) return undefined;
  return runBuiltinGates({
    root: repoPath,
    base: "HEAD",
    // A note is not a code change: only the claim gate judges it.
    diff: "",
    project: { ...gates.project, mutation: false },
    gates: [],
    researchCardId: card.id,
  });
}

export async function runResearchCard(
  card: CardRecord,
  ask: (question: string, cardId: string) => Promise<ResearchAnswer>,
  cardStore: CardStore,
  repoPath: string,
  board: ResearchBoard,
): Promise<{ passed: boolean; notePath: string; answer: ResearchAnswer; held?: string }> {
  const started = Date.now();
  const noteRel = join(".sekhemet", "research", `${card.id}.md`);
  const move = async (to: CardStatus, reason: string) => {
    const now = await cardStore.getCard(card.id);
    await board.transitionCard({
      cardId: card.id,
      fromStatus: now?.status ?? card.status,
      toStatus: to,
      actor: "researcher",
      reason,
    });
  };
  if (card.status !== "in_progress") {
    // A research card writes one file, its note: that is its declared scope.
    if (card.scopeFiles.length === 0) {
      await cardStore.updateCard(card.id, { scopeFiles: [noteRel] }, "researcher");
    }
    await move("in_progress", "research: the Research model started");
  }
  const answer = await ask(researchQuestion(card), card.id);
  const dir = join(repoPath, ".sekhemet", "research");
  mkdirSync(dir, { recursive: true });
  const notePath = join(dir, `${card.id}.md`);
  writeFileSync(notePath, researchNote(card, answer));
  // A report reaches Review when it is grounded, its citations point at
  // something that was read, and every executable claim has a verdict. The
  // last is the claim gate: execution is a gate like any other, so a note
  // whose claims have never been run is not finished work. The gate reads
  // the claims report from the path `gates.toml [claims]` names (GT-N5-3);
  // a project that declares none keeps the pipeline's own check, and the
  // evidence says so.
  const gatesConfig = loadGatesConfig(repoPath);
  const reportRel = (gatesConfig.project.claims?.report ?? DEFAULT_CLAIMS_REPORT).replaceAll(
    "{card}",
    card.id,
  );
  mkdirSync(dirname(join(repoPath, reportRel)), { recursive: true });
  writeFileSync(join(repoPath, reportRel), claimsReport(card, answer));
  const claimGate = await verifyResearchClaims(card, repoPath, gatesConfig);
  const eligible = claimGate
    ? {
        eligible: claimGate.failures.length === 0,
        reason:
          claimGate.failures.length === 0
            ? "the claim check passed"
            : claimGate.failures.map((f) => f.errorExcerpt).join("; "),
      }
    : (() => {
        const documented = new Map(
          (answer.claims ?? [])
            .filter((c) => c.kind === "executable" && documentedReason(c, answer))
            .map((c) => [c.id, "documented" as const]),
        );
        const e = reviewEligible(answer.claims ?? [], documented);
        return { ...e, reason: `${e.reason} (no claim check declared in gates.toml)` };
      })();
  const passed = answer.grounded && answer.badCitations.length === 0 && eligible.eligible;
  const evDir = join(repoPath, ".sekhemet", "evidence");
  mkdirSync(evDir, { recursive: true });
  const evidence = {
    id: `ev_research_${card.id}_${started.toString(36)}`,
    cardId: card.id,
    kind: "research",
    createdAt: new Date().toISOString(),
    passed,
    note: `.sekhemet/research/${card.id}.md`,
    sources: answer.sources,
    confidence: answer.confidence,
    badCitations: answer.badCitations,
    ...(answer.effort ? { effort: answer.effort } : {}),
    ...(answer.coverage ? { uncovered: answer.coverage.outstanding } : {}),
    // DS-N2-6, DS-N2-7: each candidate revision's measured verdict; the note
    // is the last accepted draft, and no separate citation-repair pass runs.
    ...(answer.critique ? { critique: answer.critique } : {}),
    rungResults: [
      { gate: "grounded", rung: "research", passed: answer.grounded },
      { gate: "citations", rung: "research", passed: answer.badCitations.length === 0 },
      { gate: "claims", rung: "research", passed: eligible.eligible, detail: eligible.reason },
    ],
    failures: claimGate?.failures ?? [],
    claimsReport: reportRel,
    ...(claimGate ? { gatesSha256: gatesConfig.sha256 } : {}),
    durationMs: Date.now() - started,
    diff: "",
    filesTouched: [],
    linesAdded: 0,
    linesRemoved: 0,
  };
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  writeFileSync(join(evDir, `${evidence.id}.json`), body);
  writeFileSync(join(evDir, `latest-${card.id}.json`), body);
  // The run on the ledger. A note is not repaired in place, so an unsettled
  // answer exhausts its ladder at once and parks for a person (rule 31).
  await recordLedgerRun(cardStore, {
    cardId: card.id,
    modelId: "researcher",
    passed,
    stopReason: passed ? "gate_passed" : "repair_exhausted",
    evidenceId: evidence.id,
    path: join(".sekhemet", "evidence", `${evidence.id}.json`),
    body,
    filesTouched: [noteRel],
    secondsUsed: Math.round((Date.now() - started) / 1000),
  });
  if (passed) {
    try {
      await move("verify", "research: note written");
      await move("review", "research: cited note ready for review");
    } catch (err) {
      if (!(err instanceof TransitionRefusedError)) throw err;
      const reason = `${err.toStatus} refused (${err.message})`;
      await board.holdCard?.(card.id, reason, "researcher", err.toStatus);
      return { passed, notePath, answer, held: reason };
    }
  } else {
    await move(
      "parked",
      `on hold: research not settled (${
        !answer.grounded
          ? "not grounded"
          : answer.badCitations.length
            ? `unverified citations ${answer.badCitations.join(", ")}`
            : eligible.reason
      })`,
    );
  }
  return { passed, notePath, answer };
}
