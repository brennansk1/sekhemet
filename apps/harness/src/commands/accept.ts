import type { DatabaseSync } from "node:sqlite";
import type { CardRecord, CardStore, EventLog } from "@sekhemet/kernel";
import {
  AcceptRefusedError,
  acceptCard,
  checkoutNotice,
  integrationBranch,
  reviewEntriesSinceEvidence,
} from "../accept.js";
import { setupFor } from "../planner_live.js";
import { Access } from "../team/access.js";
import { personName } from "../team/members.js";
import {
  type AcceptResult,
  type CliExit,
  type FindingRef,
  baseResult,
  issueRef,
} from "./cli_result.js";
import type { CommandHandler } from "./registry.js";

/**
 * `sekhemet accept <issue> [--ack <finding numbers>] [--json]` (surface
 * rule 16; FINDINGS_C1 CLI-01): the board's Accept, with the acknowledgement
 * path Review has. `sekhemet review` numbers the AI review's findings on the
 * change; `--ack 1,2` acknowledges them by those numbers (or by their entry
 * ids), and Accept's own checks decide (`acceptCard`, review-git §2.4.3,
 * RG-N5-5). A refusal names the findings by number. One still unacknowledged
 * is a missing confirmation, exit 2 (surface item 18); a file not looked at
 * yet, or any other refusal, exit 1.
 */

/** A finding as the CLI shows it: numbered in the dossier's order. */
export interface NumberedFinding {
  number: number;
  entryId: string;
  verdict: string;
  text: string;
  /** Unmet or unclear: Accept waits for its acknowledgement. */
  needsAck: boolean;
}

/** The AI review's findings on the change under review, numbered from 1 (RG-P8-9). */
export async function numberedFindings(
  store: CardStore,
  cardId: string,
): Promise<NumberedFinding[]> {
  return (await reviewEntriesSinceEvidence(store, cardId)).map((e, i) => ({
    number: i + 1,
    entryId: e.entryId,
    verdict: e.verdict ?? "met",
    text: e.text.trim().replace(/\s+/g, " "),
    needsAck: e.verdict === "unmet" || e.verdict === "unclear",
  }));
}

/** "1", "1 and 2", "1, 2 and 3". */
export function andList(items: readonly (string | number)[]): string {
  const xs = items.map(String);
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}

/** The `--ack` values as tokens: `--ack 1,2 --ack 3` → 1, 2, 3. */
function ackTokens(value: unknown): string[] {
  const all = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return all
    .flatMap((v) => String(v).split(","))
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * The card's project's Accept rule, as the dashboard's Accept reads it
 * (`card_routes.ts`; teams item 7, INT-22, TEAM-25; FINDINGS_C1 SEC-03): who
 * may accept, whether every review thread must be resolved first, and
 * people's names for the refusal. A card with no project goes by the one
 * project there is, as the dashboard's does.
 */
export function acceptRuleFor(
  db: DatabaseSync,
  log: EventLog,
  cardStore: CardStore,
  card: CardRecord,
  repoPath: string,
): {
  acceptHolders?: readonly string[];
  requireResolvedThreads: boolean;
  nameOf: (p: string | undefined) => string | undefined;
} {
  const access = new Access({
    db,
    setup: setupFor(repoPath),
    localPrincipal: () => log.localPrincipal(),
  });
  const projects = cardStore.listProjects();
  const project = card.projectId ?? (projects.length === 1 ? projects[0]?.id : undefined);
  const holders = access.acceptHolders(project);
  return {
    ...(holders ? { acceptHolders: holders } : {}),
    requireResolvedThreads: access.settings(project).require_resolved_threads === true,
    nameOf: (p) => (p ? personName(db, p) : undefined),
  };
}

export const acceptCommand: CommandHandler = async (args, env) => {
  const cardId = args.positionals[0] as string;
  const { db, log, cardStore, boardService } = await env.kernel("write");
  const card = await cardStore.getCard(cardId);
  const refused = (exitCode: CliExit, message: string, extra: Partial<AcceptResult> = {}) => {
    console.error(`sekhemet: ${message}`);
    return { ...baseResult("accept", exitCode, message), accepted: false, ...extra };
  };
  if (!card) return refused(1, `no issue ${cardId}`);

  const findings = await numberedFindings(cardStore, cardId);
  const acknowledged: string[] = [];
  const unknown: string[] = [];
  for (const token of ackTokens(args.values.ack)) {
    const byNumber = /^\d+$/.test(token) ? findings[Number(token) - 1] : undefined;
    const found = byNumber ?? findings.find((f) => f.entryId === token);
    if (found) {
      if (!acknowledged.includes(found.entryId)) acknowledged.push(found.entryId);
    } else unknown.push(token);
  }
  const refs = (): FindingRef[] =>
    findings.map((f) => ({
      number: f.number,
      verdict: f.verdict,
      text: f.text,
      acknowledged: acknowledged.includes(f.entryId),
    }));
  if (unknown.length > 0) {
    return refused(
      2,
      `${cardId} has no finding ${andList(unknown)}; \`sekhemet review ${cardId}\` numbers its findings`,
      { refusal: "usage", issue: issueRef(card), findings: refs() },
    );
  }

  try {
    const sha = await acceptCard(
      {
        repoPath: env.repoPath,
        restrictedMode: env.restrictedMode,
        cardStore,
        boardService,
        // DS-N3-1: the project documents follow the accept.
        eventLog: log,
      },
      card,
      "human",
      {
        acknowledgedFindings: acknowledged,
        // SEC-03: the project's Accept rule, as on the dashboard.
        ...acceptRuleFor(db, log, cardStore, card, env.repoPath),
      },
    );
    const target = integrationBranch(env.repoPath);
    const pullRequest = sha.startsWith("http") ? sha : undefined;
    const notice = pullRequest ? undefined : checkoutNotice(env.repoPath, target, sha);
    const message = pullRequest
      ? `Accepted ${cardId} — pull request ${sha} opened; the issue reaches Done when it merges.`
      : `Accepted ${cardId} — squashed onto ${target} as ${sha.slice(0, 10)}, issue moved to Done. Your files were not touched.`;
    console.log(`\n${message}`);
    if (notice) console.log(notice);
    const after = (await cardStore.getCard(cardId)) ?? card;
    return {
      ...baseResult("accept", 0, message),
      issue: issueRef(after),
      accepted: true,
      ...(pullRequest ? { pullRequest } : { commit: sha }),
      ...(notice ? { notice } : {}),
      findings: refs(),
    };
  } catch (err) {
    if (err instanceof AcceptRefusedError && err.code === "unacknowledged" && err.remaining) {
      const open = findings.filter((f) => err.remaining?.findings.includes(f.entryId));
      const files = err.remaining.files;
      const numbers = open.map((f) => f.number);
      const ackLine = `sekhemet accept ${cardId} --ack ${[
        ...findings.filter((f) => acknowledged.includes(f.entryId)).map((f) => f.number),
        ...numbers,
      ]
        .sort((a, b) => a - b)
        .join(",")}`;
      const parts = [
        files.length ? `look at ${files.join(", ")}` : "",
        numbers.length
          ? `acknowledge the AI review ${numbers.length === 1 ? "finding" : "findings"} ${andList(numbers)}`
          : "",
      ].filter(Boolean);
      const message = files.length
        ? `before accepting ${cardId}, ${parts.join(" and ")}: \`sekhemet review ${cardId}\` shows them`
        : `before accepting ${cardId}, ${parts.join(" and ")} (\`sekhemet review ${cardId}\` shows them): ${ackLine}`;
      return refused(files.length ? 1 : 2, message, {
        issue: issueRef(card),
        refusal: err.code,
        findings: refs(),
        ...(files.length ? { files } : {}),
      });
    }
    return refused(1, err instanceof Error ? err.message : String(err), {
      issue: issueRef(card),
      ...(err instanceof AcceptRefusedError ? { refusal: err.code } : {}),
    });
  }
};
