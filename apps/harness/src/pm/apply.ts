import type { BoardService } from "@sekhemet/board";
import type { CardRecord, CardStatus, CardStore, CardUpdate } from "@sekhemet/kernel";
import type { PmStore } from "./store.js";
import type { PmProposal } from "./types.js";

export interface ApplyContext {
  cardStore: CardStore;
  boardService: BoardService;
  pmStore: PmStore;
  /** Who approved it; the ledger records this, not the PM. */
  actor?: string;
}

export class ProposalError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** Card fields a proposal may set; anything else in a patch is ignored. */
const EDITABLE = new Set([
  "title",
  "spec",
  "priority",
  "estimate",
  "labels",
  "cycleId",
  "epicId",
  "assignee",
  "dueDate",
  "scopeFiles",
  "acceptanceCriteria",
  "dependsOn",
]);

function toUpdate(patch: Record<string, unknown>): CardUpdate {
  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (EDITABLE.has(k)) update[k] = v;
  return update as CardUpdate;
}

function toCreate(fields: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const input: Record<string, unknown> = { tier: "task", status: "backlog", ...extra };
  for (const [k, v] of Object.entries(fields)) if (EDITABLE.has(k)) input[k] = v;
  input.title = String(fields.title ?? "Untitled");
  return input as unknown as Parameters<CardStore["createCard"]>[0];
}

/**
 * Apply one approved proposal to the board.
 *
 * A proposal is checked against the board as it stands now, not as it stood
 * when the PM wrote it: if a field it would overwrite has since changed, the
 * proposal is stale and applying it would silently undo someone's edit.
 */
export async function applyProposal(
  proposal: PmProposal,
  ctx: ApplyContext,
): Promise<{ proposal: PmProposal; cards: CardRecord[] }> {
  const actor = ctx.actor ?? "human";
  if (proposal.state !== "open") {
    throw new ProposalError(`This proposal is already ${proposal.state}.`, 409);
  }

  const touched: CardRecord[] = [];
  const card = proposal.cardId ? await ctx.cardStore.getCard(proposal.cardId) : null;
  if (proposal.cardId && !card) {
    await ctx.pmStore.setProposalState(proposal.id, "stale");
    throw new ProposalError(`Card ${proposal.cardId} no longer exists.`, 409);
  }

  if (card && proposal.before) {
    for (const [field, was] of Object.entries(proposal.before)) {
      const now = (card as unknown as Record<string, unknown>)[field] ?? null;
      if (JSON.stringify(now) !== JSON.stringify(was)) {
        await ctx.pmStore.setProposalState(proposal.id, "stale");
        throw new ProposalError(
          `${card.title} changed since the PM proposed this (${field} is now ${JSON.stringify(now)}). Ask the PM again.`,
          409,
        );
      }
    }
  }

  const move = async (target: CardRecord, to: CardStatus, reason: string) => {
    await ctx.boardService.transitionCard({
      cardId: target.id,
      fromStatus: target.status,
      toStatus: to,
      actor,
      reason,
    });
  };

  switch (proposal.kind) {
    case "update_card":
    case "assign_cycle": {
      if (!card || !proposal.patch) throw new ProposalError("Nothing to update.", 400);
      touched.push(await ctx.cardStore.updateCard(card.id, toUpdate(proposal.patch), actor));
      break;
    }
    case "create_card": {
      for (const fields of proposal.cards ?? []) {
        touched.push(await ctx.cardStore.createCard(toCreate(fields), actor));
      }
      break;
    }
    case "split_card": {
      if (!card) throw new ProposalError("Nothing to split.", 400);
      let previous: string | undefined;
      for (const fields of proposal.cards ?? []) {
        // Parts inherit the original's placement and run in order.
        const created = await ctx.cardStore.createCard(
          toCreate(fields, {
            status: card.status === "backlog" ? "backlog" : "ready",
            ...(card.cycleId ? { cycleId: card.cycleId } : {}),
            ...(card.epicId ? { epicId: card.epicId } : {}),
            ...(card.priority ? { priority: card.priority } : {}),
            ...(card.acceptanceTests?.length ? { acceptanceTests: card.acceptanceTests } : {}),
            dependsOn: [...(card.dependsOn ?? []), ...(previous ? [previous] : [])],
          }),
          actor,
        );
        previous = created.id;
        touched.push(created);
      }
      if (card.status !== "parked" && card.status !== "done") {
        await move(card, "parked", `split into ${touched.map((c) => c.id).join(", ")}`);
      }
      break;
    }
    case "move_card":
    case "park":
    case "unpark": {
      const to = proposal.patch?.status as CardStatus | undefined;
      if (!card || !to) throw new ProposalError("Nothing to move.", 400);
      await move(card, to, `PM proposal: ${proposal.summary}`);
      const moved = await ctx.cardStore.getCard(card.id);
      if (moved) touched.push(moved);
      break;
    }
    case "create_cycle": {
      const p = proposal.patch ?? {};
      const cycle = await ctx.pmStore.createCycle(
        {
          name: String(p.name),
          startsOn: String(p.startsOn),
          endsOn: String(p.endsOn),
          ...(typeof p.goal === "string" ? { goal: p.goal } : {}),
        },
        actor,
      );
      for (const id of (p.cardIds as string[] | undefined) ?? []) {
        const c = await ctx.cardStore.getCard(id);
        if (c) touched.push(await ctx.cardStore.updateCard(id, { cycleId: cycle.id }, actor));
      }
      break;
    }
    default:
      throw new ProposalError(`Unsupported proposal kind ${proposal.kind}.`, 400);
  }

  await ctx.pmStore.setProposalState(
    proposal.id,
    "applied",
    touched.map((c) => c.id),
  );
  return { proposal: { ...proposal, state: "applied" }, cards: touched };
}
