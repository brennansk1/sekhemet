import { type BoardService, BoardServiceImpl } from "@sekhemet/board";
import {
  AUTO_APPLICABLE_KINDS,
  type CardRecord,
  type CardStatus,
  type CardStore,
  type Suggestion,
  type SuggestionBefore,
  type SuggestionKind,
  type SuggestionValue,
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
 * (§2.18.6, PM-N9-9). Where an Admin turned auto-apply on for the property
 * on the issue's project, the suggestion is applied at once under that
 * Admin's rule, shown *Applied by <Admin>'s rule*, and undone in one action
 * (PM-N9-2, TEAM-41).
 */

/** The Admin whose rule applies a suggestion of this kind on this project, if one is on (PM-N9-2). */
export type AutoApplyRule = (
  project: string | undefined,
  kind: SuggestionKind,
) => string | undefined;

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
    /**
     * What an Admin's auto-apply rule needs to make the change (PM-N9-2): the
     * PM store and the repository a split is planned in. Without it every
     * suggestion waits for a person.
     */
    pmStore?: PmStore;
    repoPath?: string;
    boardService?: BoardService;
  },
): Promise<{ drafts: ProposalDraft[]; notes: string[] }> {
  const { audience, asker } = ctx;
  if (asker && audience.levelOf(asker) === "viewer") return { drafts: [], notes: [] };
  // TEAM-40, TEAM-6: a Viewer on an issue's own project is offered nothing on it.
  const viewerOn = (project: string | undefined) =>
    asker !== undefined && project !== undefined && audience.levelOf(asker, project) === "viewer";
  const byId = new Map(ctx.cards.map((c) => [c.id, c]));
  const out: ProposalDraft[] = [];
  const notes: string[] = [];
  const noted = new Set<string>();
  for (const draft of drafts) {
    const card = draft.cardId ? byId.get(draft.cardId) : undefined;
    if (card && viewerOn(card.projectId)) continue;
    let next: ProposalDraft = draft;
    // Said once per issue, unless an Admin's rule applied the change instead.
    let ownerNote: (() => void) | undefined;
    if (card && audience.setup === "team" && card.owner && card.owner !== asker) {
      const owner = card.owner;
      next = { ...next, forOwner: owner };
      ownerNote = () => {
        if (noted.has(card.id)) return;
        noted.add(card.id);
        const who = nameFor(audience, owner);
        notes.push(`${who} owns ${card.title}: the change is posted there for ${who} to apply.`);
      };
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
      if (!id) {
        ownerNote?.();
        continue;
      }
      // PM-N9-2: under an Admin's rule it is applied now, and the chat offers nothing to apply.
      const rule = audience.autoApplier;
      if (rule && ctx.pmStore) {
        const auto = await autoApplySuggestion(id, {
          cardStore: ctx.cardStore,
          pmStore: ctx.pmStore,
          ...(ctx.boardService ? { boardService: ctx.boardService } : {}),
          ...(ctx.repoPath ? { repoPath: ctx.repoPath } : {}),
          audience,
        });
        if (auto) {
          notes.push(`${auto.line} Undo is on the issue.`);
          continue;
        }
      }
      next = { ...next, suggestionId: id };
    }
    ownerNote?.();
    out.push(next);
  }
  return { drafts: out, notes };
}

/** "Applied by Ada's rule: priority Urgent for Api." (TEAM-41), as the issue shows it. */
export function ruleLine(
  s: { kind: SuggestionKind; value: SuggestionValue },
  title: string,
  admin: string,
  audience?: Audience,
): string {
  const nameOf = (p: string) => (audience ? nameFor(audience, p) : p);
  const who = audience?.nameOf(admin) ?? "an Admin";
  return `Applied by ${who === "an Admin" ? who : `${who}'s`} rule: ${suggestedText(s, title, nameOf)}.`;
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

/**
 * Apply a suggestion under an Admin's auto-apply rule (PM-N9-2, TEAM-18,
 * -41), when one is on for its property on its issue's project: the change
 * is made with that Admin as principal, and the issue as it was is recorded
 * so one action undoes it. Returns undefined — the suggestion waiting for a
 * person, as without a rule — when no rule applies, the kind is never
 * auto-applied (the assignee, a hold, a removal), or the change cannot be
 * made now (a split the planner refuses).
 */
export async function autoApplySuggestion(
  id: string,
  ctx: Omit<SuggestionContext, "principal"> & { autoApply?: AutoApplyRule },
): Promise<{ by: string; line: string; cards: CardRecord[] } | undefined> {
  const s = await ctx.cardStore.suggestions.get(id);
  if (!s || s.state !== "open" || !AUTO_APPLICABLE_KINDS.includes(s.kind)) return undefined;
  const card = await ctx.cardStore.getCard(s.cardId);
  if (!card) return undefined;
  const rule: AutoApplyRule | undefined =
    ctx.autoApply ??
    (ctx.audience?.autoApplier
      ? (project, kind) => ctx.audience?.autoApplier?.(project, kind)
      : undefined);
  const by = rule?.(card.projectId, s.kind);
  if (!by) return undefined;
  const before: SuggestionBefore = {
    status: card.status,
    labels: [...(card.labels ?? [])],
    priority: card.priority ?? 0,
    ...(card.blockedReason ? { blockedReason: card.blockedReason } : {}),
  };
  let cards: CardRecord[];
  try {
    // An automation rule's change: the machine acts, the Admin is the principal (kernel rule 19).
    cards = await perform({ ...ctx, actor: "system" }, s, card, by);
  } catch (err) {
    if (err instanceof SuggestionError) return undefined;
    throw err;
  }
  if (s.kind === "split") before.made = cards.map((c) => c.id).filter((c) => c !== card.id);
  await ctx.cardStore.suggestions.apply(id, by, { auto: true, before });
  return { by, line: ruleLine(s, card.title, by, ctx.audience), cards };
}

/** Statuses a split's part may still be withdrawn from: it has not started. */
const NOT_STARTED: CardStatus[] = ["backlog", "ready", "planning"];

/** Bring an issue back from Won't do to where it was, by the board's legal edges. */
async function restoreFrom(ctx: SuggestionContext, card: CardRecord, to: string | undefined) {
  if (card.status !== "rejected") return;
  const target = (to ?? "backlog") as CardStatus;
  const first: CardStatus = target === "backlog" ? "backlog" : "ready";
  await move(ctx, card, first, "Undo: the rule's change was undone");
  if (target !== first && ["planning", "parked"].includes(target)) {
    const now = await ctx.cardStore.getCard(card.id);
    if (now) await move(ctx, now, target, "Undo: the rule's change was undone");
  }
}

/**
 * Undo what an Admin's rule applied, in one action (TEAM-41): the issue goes
 * back as it was — its labels, its priority, back from Won't do for a
 * duplicate, and for a split the parts withdrawn and the issue restored,
 * refused once a part has started. The person may be the issue's owner (or
 * anyone who may apply it) or the Admin whose rule it was. The same change
 * is not raised again.
 */
export async function undoSuggestion(
  id: string,
  ctx: SuggestionContext,
): Promise<{ suggestion: Suggestion; cards: CardRecord[] }> {
  const s = await ctx.cardStore.suggestions.get(id);
  if (!s) throw new SuggestionError(`No suggestion ${id}.`, 404);
  if (s.state === "undone") throw new SuggestionError("This change was already undone.", 409);
  if (s.state !== "applied" || !s.rule) {
    throw new SuggestionError("Only a change an Admin's rule applied is undone here.", 409);
  }
  const [applied] = await ctx.cardStore.suggestions
    .appliedByRule(s.cardId)
    .then((all) => all.filter((a) => a.id === id));
  const card = await ctx.cardStore.getCard(s.cardId);
  if (!applied || !card) throw new SuggestionError(`Issue ${s.cardId} no longer exists.`, 409);
  const principal = ctx.principal ?? ctx.cardStore.localPrincipal();
  const refusal = principal === s.rule ? undefined : ownerRefusal(card, principal, ctx.audience);
  if (refusal) throw new SuggestionError(refusal, 403);
  const actor = ctx.actor ?? "human";
  const who = { principal };
  const before = applied.before;
  switch (s.kind) {
    case "label":
      await ctx.cardStore.updateCard(card.id, { labels: before.labels ?? [] }, actor, who);
      break;
    case "priority":
      await ctx.cardStore.updateCard(card.id, { priority: before.priority ?? 0 }, actor, who);
      break;
    case "duplicate":
    case "split": {
      const parts = await Promise.all((before.made ?? []).map((c) => ctx.cardStore.getCard(c)));
      const started = parts.find((p) => p && !NOT_STARTED.includes(p.status));
      if (started) {
        throw new SuggestionError(
          `${started.title} has started; the split is not undone. Move its parts on the board instead.`,
          409,
        );
      }
      for (const part of parts) {
        if (part && part.status !== "rejected") {
          await move(ctx, part, "rejected", "Undo: the split was undone");
        }
      }
      await restoreFrom(ctx, card, before.status);
      await ctx.cardStore.updateCard(
        card.id,
        { blockedReason: before.blockedReason ?? null },
        actor,
        who,
      );
      break;
    }
    default:
      throw new SuggestionError(`An ${s.kind} change is never applied by a rule.`, 409);
  }
  await ctx.cardStore.suggestions.undo(id, principal);
  const now = await ctx.cardStore.getCard(card.id);
  return { suggestion: s, cards: now ? [now] : [] };
}

/**
 * The issue's suggestions as it shows them: each open one as *Suggested: …*,
 * *Why: …*, and each an Admin's rule applied that no one has undone as
 * *Applied by <Admin>'s rule: …*, with Undo (PM-N9-1, -2; TEAM-41).
 */
export async function suggestionsOn(
  cardStore: CardStore,
  cardId: string,
  audience?: Audience,
): Promise<(Suggestion & { suggested: string; state: "open" | "applied"; rule?: string })[]> {
  const card = await cardStore.getCard(cardId);
  if (!card) return [];
  const nameOf = (p: string) => (audience ? nameFor(audience, p) : p);
  const open = (await cardStore.suggestions.open(cardId)).map((s) => ({
    ...s,
    state: "open" as const,
    suggested: `Suggested: ${suggestedText(s, card.title, nameOf)}.`,
  }));
  const ruled = (await cardStore.suggestions.appliedByRule(cardId)).map(
    ({ by, before: _before, appliedAt: _at, ...s }) => ({
      ...s,
      state: "applied" as const,
      rule: by,
      suggested: ruleLine(s, card.title, by, audience),
    }),
  );
  return [...ruled, ...open];
}
