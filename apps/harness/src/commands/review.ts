import type { RungOutcome } from "@sekhemet/gates";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import {
  implementationFiles,
  integrationBranch,
  ledgerBundle,
  recordReviewOpened,
} from "../accept.js";
import { nextForReview } from "../triage.js";
import { numberedFindings } from "./accept.js";
import type { CommandHandler } from "./registry.js";

/**
 * `sekhemet review [issue]` (surface item 13): the oldest issue In review,
 * or the one named — its checks, its change against where its branch
 * started (FINDINGS_C1 CLI-08), each Implementation file's diff shown once
 * and recorded as shown (review-git §2.4.3, RG-S6-6), the AI review's
 * findings numbered for `accept --ack` (CLI-01), and the commands that
 * decide it.
 */

/** A check as Review reads it: skipped and could-not-run are not failures (REV-01). */
export function checkWord(
  r: Pick<RungOutcome, "gate" | "passed" | "skipped" | "unavailable">,
): string {
  if (r.skipped) return `– ${r.gate} skipped`;
  if (r.unavailable) return `? ${r.gate} could not run`;
  return `${r.passed ? "✓" : "✗"} ${r.gate}`;
}

const VERDICT: Record<string, string> = { unmet: "Unmet", unclear: "Unclear", met: "Met" };

export const reviewCommand: CommandHandler = async (args, env) => {
  const { db, log, cardStore, boardService } = await env.kernel("read");
  const ctx = { repoPath: env.repoPath, cardStore, boardService, log };
  try {
    const named = args.positionals[0];
    const card = named ? ((await cardStore.getCard(named)) ?? undefined) : await nextForReview(ctx);
    if (!card) {
      if (named) {
        console.error(`sekhemet: no issue ${named}`);
        return 1;
      }
      console.log("Nothing is waiting on you.");
      return 0;
    }
    console.log(`${card.id} — ${card.title}`);
    // The evidence the ledger names (K-S7-7), and each Implementation file's
    // diff, shown once and recorded as shown (review-git §2.4.3, RG-S6-6).
    const e = await ledgerBundle(ctx, card.id);
    if (e) {
      const gates = (e.rungResults ?? []).map(checkWord);
      console.log(`  checks: ${gates.join("  ") || "none recorded"}`);
      console.log(
        `  changed: ${(e.filesTouched ?? []).join(", ") || "nothing"} (+${e.linesAdded ?? 0} −${e.linesRemoved ?? 0})`,
      );
      const files = implementationFiles(e);
      if (files.length > 0 && card.status === "review") {
        const diff = await new NodeGitSyncAdapter(env.repoPath).structuralDiff(
          card.id,
          integrationBranch(env.repoPath),
        );
        console.log(`\n${diff.text}`);
        await recordReviewOpened(ctx, card, files);
      }
    }
    // CLI-01: the AI review's findings, numbered as `accept --ack` names them.
    const findings = await numberedFindings(cardStore, card.id);
    if (findings.length > 0) {
      console.log("\n  AI review (advice, not a check: Accept is yours)");
      for (const f of findings) {
        console.log(`  ${f.number}. ${VERDICT[f.verdict] ?? f.verdict}: ${f.text}`);
      }
    }
    const toAck = findings.filter((f) => f.needsAck).map((f) => f.number);
    const accept = toAck.length
      ? `sekhemet accept ${card.id} --ack ${toAck.join(",")}`
      : `sekhemet accept ${card.id}`;
    console.log(
      `\n  ${accept}\n  sekhemet request-changes ${card.id} "<what to change>"\n  sekhemet park ${card.id}`,
    );
    // RG-S6-7: decisions read faster than 500 changed lines an hour are
    // reported beside the rest, never refused (research RG-T5).
    const rate = await boardService.reviewRate(card.projectId);
    if (rate.fast.length > 0) {
      const named = rate.fast.map((d) => `${d.cardId} (${d.linesPerHour} lines an hour)`);
      console.log(
        `\n  ${rate.fast.length} of ${rate.decisions} review decisions read faster than 500 changed lines an hour: ${named.join(", ")}. Reported, not refused.`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
};
