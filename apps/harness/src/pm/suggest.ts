import { type BoardService, BoardServiceImpl } from "@sekhemet/board";
import type {
  CardRecord,
  CardStatus,
  CardStore,
  Suggestion,
  SuggestionKind,
  SuggestionValue,
} from "@sekhemet/kernel";
import { waitingReason } from "@sekhemet/planner";
import type { ProposalDraft } from "./agent.js";
import { ProposalError, applyProposal, markDuplicate } from "./apply.js";
import { type Audience, nameFor, ownerRefusal } from "./audience.js";
import { PipelineRefusal, splitThroughPipeline } from "./pipeline.js";
import type { PmStore } from "./store.js";
import { voiceGuard } from "./voice.js";

/**
 * Seshat's suggestions on an issue (planner-pm §2.18.2, PM-N9-1; teams
 * item 20, TEAM-18, TEAM-19). A change to an issue's assignee, labels,
 * priority or duplicate link, or a split, is posted on the issue as
 * *Suggested: … Why: …* with *Apply* and *Dismiss*; the kernel records the
 * suggestion, and nothing changes until a person applies it — here, where
 * Apply performs the change under that person's principal. A planner's own
 * hold or removal of someone else's issue is a suggestion of the same kind
 * (§2.18.6, PM-N9-9).
 */

export class SuggestionError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export interface SuggestionContext {
  cardStore: CardStore;
  boardService?: BoardService;
  pmStore: PmStore;
  /** The repository the planner plans a split in (PM-P1-1). */
  repoPath?: string;
  actor?: string;
  /** The person applying or dismissing it (kernel rule 19). */
  principal?: string;
  audience?: Audience;
}

const PRIORITY = ["No priority", "Urgent", "High", "Medium", "Low"];

/** The suggestion a Seshat proposal is, when it changes one of the triage properties. */
export function suggestionOf(
  draft: Pick<ProposalDraft, "kind" | "patch" | "cards">,
): { kind: SuggestionKind; value: SuggestionValue } | undefined {
  if (draft.kind === "split_card") {
    const titles = (draft.cards ?? []).map((c) => String(c.title ?? "")).filter(Boolean);
    return titles.length >= 2 ? { kind: "split", value: titles } : undefined;
  }
  if (draft.kind !== "update_card" || !draft.patch) return undefined;
  const keys = Object.keys(draft.patch);
  if (keys.length !== 1) return undefined;
  const v = draft.patch[keys[0] as string];
  switch (keys[0]) {
    case "assignee":
      return typeof v === "string" ? { kind: "assignee", value: v } : undefined;
    case "labels":
      return Array.isArray(v) ? { kind: "label", value: v as string[] } : undefined;
    case "priority":
      return typeof v === "number" ? { kind: "priority", value: v } : undefined;
    case "duplicateOf":
      return typeof v === "string" ? { kind: "duplicate", value: v } : undefined;
    default:
      return undefined;
  }
}

/** "Suggested: priority Urgent for Api." — what the suggestion changes, in words. */
export function suggestedText(
  s: { kind: SuggestionKind; value: SuggestionValue },
  title: string,
  nameOf: (p: string) => string = (p) => p,
): string {
  const v = s.value;
  switch (s.kind) {
    case "assignee":
      return `assign ${title} to ${nameOf(String(v))}`;
    case "label":
      return `label ${title} ${Array.isArray(v) ? v.join(", ") : String(v)}`;
    case "priority":
      return `priority ${PRIORITY[Number(v)] ?? String(v)} for ${title}`;
    case "duplicate":
      return `mark ${title} a duplicate of ${String(v)}`;
    case "split":
      return `split ${title} into ${Array.isArray(v) ? v.length : 2} issues${Array.isArray(v) ? ` (${v.join("; ")})` : ""}`;
    case "hold":
      return `hold ${title} in Planning: ${String(v)}`;
    case "remove":
      return `move ${title} to Won't do: ${String(v)}`;
  }
}

/**
 * Seshat's proposals as the asking person may receive them (PM-N9-1, -9;
 * TEAM-19, TEAM-40): a Viewer gets none; a triage change is posted on the
 * issue as a suggestion (one a person dismissed is not raised again); in
 * the Team setup a change to an issue someone else owns is marked for its
 * owner, and the reply says so.
 */
export async function postSuggestions(
  drafts: ProposalDraft[],
  ctx: {
    cardStore: CardStore;
    cards: CardRecord[];
    audience: Audience;
    asker?: string | undefined;
  },
): Promise<{ drafts: ProposalDraft[]; notes: string[] }> {
  const { audience, asker } = ctx;
  if (asker && audience.levelOf(asker) === "viewer") return { drafts: [], notes: [] };
  const byId = new Map(ctx.cards.map((c) => [c.id, c]));
  const out: ProposalDraft[] = [];
  const notes: string[] = [];
  const noted = new Set<string>();
  for (const draft of drafts) {
    const card = draft.cardId ? byId.get(draft.cardId) : undefined;
    let next: ProposalDraft = draft;
    if (card && audience.setup === "team" && card.owner && card.owner !== asker) {
      next = { ...next, forOwner: card.owner };
      if (!noted.has(card.id)) {
        noted.add(card.id);
        const who = nameFor(audience, card.owner);
        notes.push(`${who} owns ${card.title}: the change is posted there for ${who} to apply.`);
      }
    }
    const s = card ? suggestionOf(draft) : undefined;
    if (card && s) {
      // PM-N9-4: the model's "why" reaches the issue as posted text ("Suggested:
      // … Why: …"), so it is guarded here, at the one place it is stored.
      const id = await ctx.cardStore.suggestions.propose(
        { cardId: card.id, kind: s.kind, value: s.value, why: voiceGuard(draft.why ?? "") },
        "planner",
      );
      // TEAM-19: dismissed before on this issue — not raised again, and no one is asked why.
      if (!id) continue;
      next = { ...next, suggestionId: id };
    }
    out.push(next);
  }
  return { drafts: out, notes };
}

const SLICE_OF_AXIS: Record<string, string> = {
  spike: "spike",
  path: "path",
  interface: "interface",
  data: "data",
  rules: "rule",
  rule: "rule",
};

async function move(
  ctx: SuggestionContext,
  card: CardRecord,
  to: CardStatus,
  reason: string,
): Promise<void> {
  if (card.status === to) return;
  const board = ctx.boardService ?? new BoardServiceImpl(ctx.cardStore, { entryConditions: true });
  await board.transitionCard({
    cardId: card.id,
    fromStatus: card.status,
    toStatus: to,
    actor: ctx.actor ?? "human",
    reason,
  });
}

/** Perform one suggestion's change on its issue (no linked proposal). */
async function perform(
  ctx: SuggestionContext,
  s: Suggestion,
  card: CardRecord,
  principal: string,
): Promise<CardRecord[]> {
  const actor = ctx.actor ?? "human";
  const who = { principal };
  const v = s.value;
  switch (s.kind) {
    case "assignee": {
      const to = String(v);
      if (/^p_/.test(to)) await ctx.cardStore.changeOwner(card.id, to, principal, actor);
      else await ctx.cardStore.updateCard(card.id, { assignee: to }, actor, who);
      break;
    }
    case "label": {
      const labels = Array.isArray(v) ? v : [...new Set([...(card.labels ?? []), String(v)])];
      await ctx.cardStore.updateCard(card.id, { labels }, actor, who);
      break;
    }
    case "priority":
      await ctx.cardStore.updateCard(card.id, { priority: Number(v) }, actor, who);
      break;
    case "duplicate": {
      const board =
        ctx.boardService ?? new BoardServiceImpl(ctx.cardStore, { entryConditions: true });
      await markDuplicate(
        { cardStore: ctx.cardStore, boardService: board, principal },
        card,
        String(v),
        actor,
      );
      break;
    }
    case "split": {
      if (!ctx.repoPath) {
        throw new SuggestionError("This server has no repository to plan the split in.", 501);
      }
      const values = Array.isArray(v) ? v : [String(v)];
      // A signal's re-split names SPIDR axes; Seshat's names the parts.
      const parts = values.map((x) =>
        SLICE_OF_AXIS[x]
          ? {
              title: `${card.title} — ${x}`,
              spec: card.spec ?? card.title,
              slice: SLICE_OF_AXIS[x],
            }
          : { title: x, spec: x },
      );
      try {
        const out = await splitThroughPipeline(
          {
            repoPath: ctx.repoPath,
            cardStore: ctx.cardStore,
            log: ctx.pmStore.log,
            ...(ctx.boardService ? { boardService: ctx.boardService } : {}),
            actor,
            principal,
          },
          card,
          parts,
        );
        return out.cards;
      } catch (err) {
        if (err instanceof PipelineRefusal) throw new SuggestionError(err.message, 409);
        throw err;
      }
    }
    case "hold": {
      // As the planner holds it in Solo: in Planning with the reason, and a
      // decision it waits on named, so the answer releases it.
      const reason = String(v);
      const decision = /\bdec_[A-Za-z0-9_-]+/.exec(reason)?.[0];
      await move(ctx, card, "planning", reason);
      await ctx.cardStore.updateCard(
        card.id,
        { blockedReason: decision ? waitingReason(decision) : reason },
        actor,
        who,
      );
      break;
    }
    case "remove": {
      const reason = String(v);
      await move(ctx, card, "rejected", reason);
      await ctx.cardStore.updateCard(card.id, { blockedReason: reason }, actor, who);
      break;
    }
  }
  const now = await ctx.cardStore.getCard(card.id);
  return now ? [now] : [];
}

async function openSuggestion(ctx: SuggestionContext, id: string) {
  const s = await ctx.cardStore.suggestions.get(id);
  if (!s) throw new SuggestionError(`No suggestion ${id}.`, 404);
  if (s.state !== "open") throw new SuggestionError(`This suggestion was already ${s.state}.`, 409);
  const card = await ctx.cardStore.getCard(s.cardId);
  if (!card) throw new SuggestionError(`Issue ${s.cardId} no longer exists.`, 409);
  const principal = ctx.principal ?? ctx.cardStore.localPrincipal();
  const refusal = ownerRefusal(card, principal, ctx.audience);
  if (refusal) throw new SuggestionError(refusal, 403);
  return { s, card, principal };
}

/**
 * Apply a suggestion (PM-N9-1): the change is made under the person's
 * principal, then recorded as applied. When Seshat's chat holds the same
 * change as a proposal, applying one applies both.
 */
export async function applySuggestion(
  id: string,
  ctx: SuggestionContext,
): Promise<{ suggestion: Suggestion; cards: CardRecord[] }> {
  const { s, card, principal } = await openSuggestion(ctx, id);
  const linked = await ctx.pmStore.proposalForSuggestion(id);
  if (linked) {
    const board =
      ctx.boardService ?? new BoardServiceImpl(ctx.cardStore, { entryConditions: true });
    try {
      const r = await applyProposal(linked, {
        cardStore: ctx.cardStore,
        boardService: board,
        pmStore: ctx.pmStore,
        actor: ctx.actor ?? "human",
        principal,
        ...(ctx.repoPath ? { repoPath: ctx.repoPath } : {}),
        ...(ctx.audience ? { audience: ctx.audience } : {}),
      });
      return { suggestion: s, cards: r.cards };
    } catch (err) {
      if (err instanceof ProposalError) throw new SuggestionError(err.message, err.status);
      throw err;
    }
  }
  const cards = await perform(ctx, s, card, principal);
  await ctx.cardStore.suggestions.apply(id, principal);
  return { suggestion: s, cards };
}

/** Dismiss it (TEAM-19): the same change is not raised again on this issue. */
export async function dismissSuggestion(id: string, ctx: SuggestionContext): Promise<void> {
  const { principal } = await openSuggestion(ctx, id);
  await ctx.cardStore.suggestions.dismiss(id, principal);
  const linked = await ctx.pmStore.proposalForSuggestion(id);
  if (linked) await ctx.pmStore.setProposalState(linked.id, "discarded");
}

/** The issue's open suggestions as it shows them: *Suggested: …*, *Why: …*. */
export async function suggestionsOn(
  cardStore: CardStore,
  cardId: string,
  audience?: Audience,
): Promise<(Suggestion & { suggested: string })[]> {
  const card = await cardStore.getCard(cardId);
  if (!card) return [];
  const nameOf = (p: string) => (audience ? nameFor(audience, p) : p);
  return (await cardStore.suggestions.open(cardId)).map((s) => ({
    ...s,
    suggested: `Suggested: ${suggestedText(s, card.title, nameOf)}.`,
  }));
}
