import { join } from "node:path";
import { type VisualCandidate, approveVisualBaseline, listVisualCandidates } from "@sekhemet/gates";
import type { CardStore } from "@sekhemet/kernel";

/**
 * A person approves a visual candidate as the baseline (gates rule 31,
 * GT-N4-1): the `sekhemet gates approve-baseline` verb and
 * `POST /api/visual/baselines/<key>/approve` both call this. Approval is a
 * person's act, bound to what they saw: the candidate the named card's run
 * wrote (the card must exist, and the candidate's record must name it) and
 * the SHA-256 of the screenshot shown to them; any other bytes are refused.
 * The ledger records who approved which screenshot, by that SHA-256, and the
 * card whose run produced it.
 */

export const BASELINE_APPROVED = "visual/baseline_approved";

const KEY = /^[\w.-]+$/;

/** The project's visual state directory, where the gate writes candidates and baselines. */
export function visualStateDir(repoPath: string): string {
  return join(repoPath, ".sekhemet");
}

/** Candidates waiting for a person: key, the card that wrote each, and its SHA-256. */
export function visualCandidates(repoPath: string): VisualCandidate[] {
  return listVisualCandidates(visualStateDir(repoPath));
}

/** One candidate as a line a person can act on. */
export function describeCandidate(c: VisualCandidate): string {
  return `${c.key}${c.cardId ? ` --card ${c.cardId}` : ""} --sha256 ${c.sha256}`;
}

export type BaselineApproval =
  | { approved: true; key: string; sha256: string; principal: string; cardId?: string }
  | { approved: false; reason: string; status: 400 | 404 | 409 };

export async function approveBaseline(
  store: Pick<CardStore, "recordLedgerEvent" | "getCard">,
  opts: {
    repoPath: string;
    key: string;
    principal: string;
    cardId?: string | undefined;
    sha256?: string | undefined;
  },
): Promise<BaselineApproval> {
  const { key, principal, cardId } = opts;
  if (!KEY.test(key)) return { approved: false, reason: `not a snapshot key: ${key}`, status: 400 };
  if (!principal) {
    return { approved: false, reason: "an approval names the person who made it", status: 400 };
  }
  const waiting = visualCandidates(opts.repoPath).filter((c) => c.key === key);
  const listed = waiting.length ? `; waiting: ${waiting.map(describeCandidate).join("; ")}` : "";
  if (!opts.sha256) {
    return {
      approved: false,
      reason: `an approval names the SHA-256 of the screenshot the person saw${listed}`,
      status: 400,
    };
  }
  // The card is the ledger's, never the caller's word alone.
  if (cardId !== undefined && !(await store.getCard(cardId))) {
    return { approved: false, reason: `no issue ${cardId}`, status: 404 };
  }
  const r = approveVisualBaseline(visualStateDir(opts.repoPath), {
    key,
    cardId,
    sha256: opts.sha256,
  });
  if (!r.approved) {
    return { approved: false, reason: `${r.reason}${listed}`, status: r.missing ? 404 : 409 };
  }
  await store.recordLedgerEvent({
    type: BASELINE_APPROVED,
    actor: "human",
    principal,
    payload: { principal, key, sha256: r.sha256, ...(cardId ? { cardId } : {}) },
  });
  return { approved: true, key, sha256: r.sha256, principal, ...(cardId ? { cardId } : {}) };
}
