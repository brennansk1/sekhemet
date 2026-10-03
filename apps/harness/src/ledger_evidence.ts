import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type EvidenceSummary, evidenceSummaryOf, withExternalResults } from "@sekhemet/board";
import type { CardStopReason, CardStore, EvidenceBundleRecord } from "@sekhemet/kernel";
import { workspaceFolderOf } from "./workspace_locator.js";

/**
 * Events after which a card's earlier evidence no longer counts for Review
 * (kernel rule 32, K-S7-8): a rewind or a fork abandons the state that
 * evidence was about, so only evidence recorded after it satisfies the
 * `review` entry condition.
 */
export const EVIDENCE_INVALIDATING_EVENTS = ["card/rewound", "card/fork_requested"] as const;

/**
 * The card's latest evidence bundle as the ledger records it (K-S7-7), or
 * undefined when none was recorded since the last rewind (K-S7-8). The
 * record, not a `latest-<card>.json` pointer, names the bundle.
 */
export async function latestLedgerEvidence(
  store: CardStore,
  cardId: string,
): Promise<EvidenceBundleRecord | undefined> {
  const events = await store.cardEvents(cardId, [
    "evidence/recorded",
    ...EVIDENCE_INVALIDATING_EVENTS,
  ]);
  const last = events.at(-1);
  if (!last || last.type !== "evidence/recorded") return undefined;
  const id = (last.payload as { id?: string }).id;
  return id ? store.runs.getEvidence(id) : undefined;
}

/**
 * The Review entry condition's view of a card's evidence, resolved from the
 * ledger (K-S7-7): the bundle the latest `evidence/recorded` names, read from
 * its recorded path and checked against its recorded SHA-256. A bundle whose
 * file is missing or changed is no evidence at all.
 */
export async function ledgerEvidenceSummary(
  store: CardStore,
  repoPath: string,
  cardId: string,
  external: {
    /** External checks the project declares blocking (`[review] blocking_checks`). */
    blockingChecks?: readonly string[];
    /** The card branch's head sha; an external result at another head never counts (K-N8-4). */
    branchHead?: (cardId: string) => string | undefined | Promise<string | undefined>;
  } = {},
): Promise<EvidenceSummary | undefined> {
  const record = await latestLedgerEvidence(store, cardId);
  if (!record) return undefined;
  let body: string;
  try {
    body = readFileSync(
      // Kernel rule 38a: evidence is beside the workspace's ledger.
      isAbsolute(record.path) ? record.path : join(workspaceFolderOf(repoPath), record.path),
      "utf8",
    );
  } catch {
    return undefined;
  }
  if (createHash("sha256").update(body).digest("hex") !== record.sha256) return undefined;
  let summary: EvidenceSummary;
  try {
    summary = evidenceSummaryOf(JSON.parse(body));
  } catch {
    return undefined;
  }
  // K-N8-4: external results — advisory unless declared, never at another head.
  return withExternalResults(summary, store.runs.listGateResults(record.attemptId), {
    blockingChecks: external.blockingChecks ?? [],
    branchHead: await external.branchHead?.(cardId),
  });
}

/**
 * The head sha of a card's branch (`sekhemet/<project>/<card-id>[-<slug>]`),
 * or undefined when it has none — so an external result can be matched to
 * the head it ran on (K-N8-4).
 */
export function cardBranchHead(repoPath: string, cardId: string): string | undefined {
  return cardBranch(repoPath, cardId)?.sha;
}

/**
 * A card's branch, `sekhemet/<project>/<card-id>[-<slug>]`, with its head:
 * the issue page's *Branch* (dashboard §2.6 properties rail, ISS-01).
 */
export function cardBranch(
  repoPath: string,
  cardId: string,
): { name: string; sha: string } | undefined {
  try {
    const out = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/sekhemet/"],
      { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    for (const line of out.split("\n")) {
      const [ref, sha] = line.trim().split(" ");
      const leaf = ref?.split("/").at(-1) ?? "";
      if (ref && sha && (leaf === cardId || leaf.startsWith(`${cardId}-`)))
        return { name: ref, sha };
    }
  } catch {
    // Not a git repository, or git is missing: no head, so no external result counts.
  }
  return undefined;
}

/**
 * Record a run that is not the Worker's — a research note, an external
 * review, a parent's integration gate — as an attempt with its evidence on
 * the ledger, so the card enters Verify with a recorded stop reason (K-S4-6)
 * and Review reads the bundle from the ledger (K-S7-7).
 */
export async function recordLedgerRun(
  store: CardStore,
  run: {
    cardId: string;
    modelId: string;
    passed: boolean;
    stopReason: CardStopReason;
    evidenceId: string;
    /** Repository-relative path of the bundle file, as written. */
    path: string;
    /** The bundle file's exact contents. */
    body: string;
    filesTouched?: string[];
    secondsUsed?: number;
    /** Who built it (K-N6-4): a person's take-over (WL-N10-3); the Worker otherwise. */
    builtBy?: { kind: "worker" | "person"; id: string };
  },
): Promise<void> {
  const attempt = await store.runs.startAttempt({
    cardId: run.cardId,
    attemptNumber: store.runs.nextAttemptNumber(run.cardId),
    modelId: run.modelId,
    ...(run.builtBy ? { builtBy: run.builtBy } : {}),
  });
  await store.runs.recordEvidence({
    id: run.evidenceId,
    cardId: run.cardId,
    attemptId: attempt.id,
    passed: run.passed,
    stopReason: run.stopReason,
    path: run.path,
    sha256: createHash("sha256").update(run.body).digest("hex"),
    filesTouched: run.filesTouched ?? [],
    linesAdded: 0,
    linesRemoved: 0,
  });
  await store.runs.finishAttempt({
    attemptId: attempt.id,
    status: run.passed ? "passed" : "failed",
    stopReason: run.stopReason,
    tokensUsed: 0,
    secondsUsed: run.secondsUsed ?? 0,
    evidenceId: run.evidenceId,
  });
}
