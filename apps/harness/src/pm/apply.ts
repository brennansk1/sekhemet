import type { BoardService } from "@sekhemet/board";
import type { CardRecord, CardStatus, CardStore, CardUpdate } from "@sekhemet/kernel";
import { type Audience, ownerRefusal } from "./audience.js";
import {
  type PipelineDeps,
  PipelineRefusal,
  type ProjectChoices,
  applyProjectGroup,
  createThroughPipeline,
  planThroughPipeline,
  projectGroupOf,
  splitThroughPipeline,
} from "./pipeline.js";
import type { PmStore } from "./store.js";
import type { PmProposal } from "./types.js";

export interface ApplyContext {
  cardStore: CardStore;
  boardService: BoardService;
  pmStore: PmStore;
  /** Who approved it; the ledger records this, not the PM. */
  actor?: string;
  /** The person who applied it (kernel rule 19); the request's person when omitted. */
  principal?: string;
  /**
   * The repository the planner plans in (PM-P1-1): Seshat's cards, splits
   * and projects go through the one pipeline there. Without it they cannot
   * be applied.
   */
  repoPath?: string;
  /** Who may apply a change to an owned issue (Team setup, PM-N9-9). */
  audience?: Audience;
  /**
   * A new project's Review plan choices (design-stage DS-P2-7): candidates
   * accepted or removed, the release line, the Type, the questions' answers.
   */
  choices?: ProjectChoices;
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
  // A step-budget change the cycle-time signal proposes (planner-pm PM-N5-3).
  "stepBudget",
  // An imported row's Jira or Linear key (INT-27); the PM's own tools never set it.
  "externalRef",
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
  const who = ctx.principal ? { principal: ctx.principal } : {};
  if (proposal.state !== "open") {
    throw new ProposalError(`This proposal is already ${proposal.state}.`, 409);
  }

  const touched: CardRecord[] = [];
  const card = proposal.cardId ? await ctx.cardStore.getCard(proposal.cardId) : null;
  if (proposal.cardId && !card) {
    await ctx.pmStore.setProposalState(proposal.id, "stale");
    throw new ProposalError(`Issue ${proposal.cardId} no longer exists.`, 409);
  }
  // PM-N9-9: a change Seshat made for someone else's issue is its owner's to apply.
  const refusal =
    card && proposal.forOwner
      ? ownerRefusal(card, ctx.principal, teamOf(ctx.audience), proposal.forOwner)
      : undefined;
  if (refusal) throw new ProposalError(refusal, 403);

  if (card && proposal.before) {
    for (const [field, was] of Object.entries(proposal.before)) {
      const now = (card as unknown as Record<string, unknown>)[field] ?? null;
      if (JSON.stringify(now) !== JSON.stringify(was)) {
        await ctx.pmStore.setProposalState(proposal.id, "stale");
        throw new ProposalError(
          `${card.title} changed since Seshat proposed this (${field} is now ${JSON.stringify(now)}). Ask Seshat again.`,
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
      const duplicateOf = proposal.patch.duplicateOf;
      if (typeof duplicateOf === "string") {
        // A duplicate link (TEAM-18): the issue leaves the board as Won't do.
        await markDuplicate(ctx, card, duplicateOf, actor);
        touched.push((await ctx.cardStore.getCard(card.id)) ?? card);
        break;
      }
      touched.push(await ctx.cardStore.updateCard(card.id, toUpdate(proposal.patch), actor, who));
      break;
    }
    case "create_card": {
      const drafts = proposal.cards ?? [];
      // PM-P1-1: Seshat's cards go through the one planner. An import's
      // rows (INT-27) and a revision's change cards, which name the link
      // they resolve (PM-P13-11), keep their own recorded path.
      const direct = proposal.origin === "import" || drafts.some((d) => Array.isArray(d.traces));
      if (!direct) {
        for (const outcome of await viaPipeline(ctx, (deps) =>
          createThroughPipeline(deps, drafts),
        )) {
          touched.push(...outcome.cards);
        }
        break;
      }
      for (const fields of drafts) {
        // PM-P13-11, -12: a change card for a suspect done card traces to the
        // revised requirement and names the link it resolves once accepted.
        const traces = Array.isArray(fields.traces)
          ? (fields.traces as { requirementId?: unknown; changeFor?: unknown }[]).filter(
              (t) => typeof t.requirementId === "string",
            )
          : [];
        const was =
          typeof traces[0]?.changeFor === "string"
            ? await ctx.cardStore.getCard(traces[0].changeFor)
            : undefined;
        const created = await ctx.cardStore.createCard(
          toCreate(fields, was?.projectId ? { projectId: was.projectId } : {}),
          actor,
        );
        for (const t of traces) {
          await ctx.cardStore.requirements.link({
            requirementId: t.requirementId as string,
            from: "card",
            ref: created.id,
            ...(typeof t.changeFor === "string" ? { changeFor: t.changeFor } : {}),
          });
        }
        touched.push(created);
      }
      break;
    }
    case "split_card": {
      // PM-P1-1, PM-P1-7: the parts through the one planner, each with only
      // its own criteria and tests; the parent to Rejected, "Split into N cards".
      if (!card) throw new ProposalError("Nothing to split.", 400);
      if ((proposal.cards ?? []).length < 2)
        throw new ProposalError("A split needs two parts.", 400);
      const outcome = await viaPipeline(ctx, (deps) =>
        splitThroughPipeline(deps, card, proposal.cards ?? []),
      );
      touched.push(...outcome.cards);
      break;
    }
    case "start_project": {
      // PM-P2-2: the group Review plan showed, created with the person as
      // actor; a bare brief (an older proposal) is planned as before.
      const group = projectGroupOf(proposal.patch);
      if (group) {
        const r = await viaPipeline(ctx, (deps) =>
          applyProjectGroup(deps, group, ctx.choices ?? {}),
        );
        touched.push(...r.cards);
        break;
      }
      const brief = typeof proposal.patch?.brief === "string" ? proposal.patch.brief : "";
      if (!brief.trim()) throw new ProposalError("A project needs its brief.", 400);
      const r = await viaPipeline(ctx, (deps) => planThroughPipeline(deps, brief));
      for (const c of await ctx.cardStore.listCards({ parentId: r.epicId })) touched.push(c);
      break;
    }
    case "move_card":
    case "park":
    case "unpark": {
      const to = proposal.patch?.status as CardStatus | undefined;
      if (!card || !to) throw new ProposalError("Nothing to move.", 400);
      await move(card, to, `Seshat's proposal: ${proposal.summary}`);
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
        if (c) touched.push(await ctx.cardStore.updateCard(id, { cycleId: cycle.id }, actor, who));
      }
      break;
    }
    default:
      throw new ProposalError(`Unsupported proposal kind ${proposal.kind}.`, 400);
  }

  // M3: a file's text is untrusted by origin, whatever the card's link:
  // recorded on the ledger, so every later run of the card tags it.
  if (proposal.origin === "import") {
    for (const c of touched) {
      await ctx.cardStore.recordEvent({
        type: "card/imported",
        cardId: c.id,
        actor,
        payload: { id: c.id, proposal: proposal.id },
      });
    }
  }

  await ctx.pmStore.setProposalState(
    proposal.id,
    "applied",
    touched.map((c) => c.id),
  );
  // PM-N9-1: the suggestion on the issue this proposal is, applied by the same person.
  if (proposal.suggestionId) {
    const s = await ctx.cardStore.suggestions.get(proposal.suggestionId);
    if (s?.state === "open") {
      await ctx.cardStore.suggestions.apply(
        proposal.suggestionId,
        ctx.principal ?? ctx.cardStore.localPrincipal(),
      );
    }
  }
  return { proposal: { ...proposal, state: "applied" }, cards: touched };
}

/** A proposal made for an owner was made in the Team setup, whatever audience applies it. */
function teamOf(audience: Audience | undefined): Audience {
  return {
    setup: "team",
    nameOf: (p) => audience?.nameOf(p),
    levelOf: (p, project) => audience?.levelOf(p, project),
    canSee: (p, project) => audience?.canSee(p, project) ?? true,
    leadOf: (project) => audience?.leadOf(project),
  };
}

/** Run a planning step, its refusals becoming the person's 409 with the reason. */
async function viaPipeline<T>(
  ctx: ApplyContext,
  step: (deps: PipelineDeps) => Promise<T>,
): Promise<T> {
  if (!ctx.repoPath) {
    throw new ProposalError(
      "This server has no repository to plan in, so the Planning model cannot apply it.",
      501,
    );
  }
  try {
    return await step({
      repoPath: ctx.repoPath,
      cardStore: ctx.cardStore,
      log: ctx.pmStore.log,
      boardService: ctx.boardService,
      actor: ctx.actor ?? "human",
      ...(ctx.principal ? { principal: ctx.principal } : {}),
    });
  } catch (err) {
    if (err instanceof PipelineRefusal) throw new ProposalError(err.message, 409);
    throw err;
  }
}

/** Mark an issue a duplicate of another: Rejected, "Duplicate of <id>" (TEAM-18). */
export async function markDuplicate(
  ctx: Pick<ApplyContext, "cardStore" | "boardService" | "principal">,
  card: CardRecord,
  of: string,
  actor = "human",
): Promise<void> {
  if (!(await ctx.cardStore.getCard(of))) throw new ProposalError(`No issue ${of}.`, 409);
  const reason = `Duplicate of ${of}`;
  if (card.status !== "rejected") {
    await ctx.boardService.transitionCard({
      cardId: card.id,
      fromStatus: card.status,
      toStatus: "rejected",
      actor,
      reason,
    });
  }
  await ctx.cardStore.updateCard(
    card.id,
    { blockedReason: reason },
    actor,
    ctx.principal ? { principal: ctx.principal } : {},
  );
}
