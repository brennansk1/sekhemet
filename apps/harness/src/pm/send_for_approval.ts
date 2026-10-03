import type { CardRecord } from "@sekhemet/kernel";
import { type ApplyContext, ProposalError, applyProposal } from "./apply.js";
import type { Audience } from "./audience.js";
import { type ProjectChoices, projectGroupOf } from "./pipeline.js";
import { PLAN_APPROVAL_REFUSAL } from "./pm_copy.js";
import type { PmStore } from "./store.js";
import type { PmMessage, PmPlanApproval, PmProposal } from "./types.js";

/**
 * A Stakeholder's new project, sent for approval (teams TEAM-20, TEAM-42;
 * design-stage §2.9 item 7; DEC-35, DEC-36). In the Team setup a Stakeholder
 * who finishes a project conversation presses *Send for approval* and names a
 * Member or an Admin; nothing — no project, issue, brief or setup issue — is
 * created until that person approves it, with the plan as sent or as they
 * edited it in Review plan. The issues the approved plan creates are owned by
 * the approver, and the owner can be changed afterwards like any issue's.
 */

const APPROVERS = new Set(["member", "admin"]);

const nameOf = (audience: Audience, principal: string): string =>
  audience.nameOf(principal) ?? principal;

/** The proposal's approval with the people's names, for the reader. */
export function namedApproval(approval: PmPlanApproval, audience: Audience): PmPlanApproval {
  return {
    ...approval,
    approverName: nameOf(audience, approval.approver),
    requestedByName: nameOf(audience, approval.requestedBy),
    ...(approval.thread
      ? { thread: approval.thread.map((m) => ({ ...m, byName: nameOf(audience, m.by) })) }
      : {}),
  };
}

/** The longest message a plan's thread keeps, in characters. */
const PLAN_MESSAGE_MAX = 8000;

/**
 * A message in a sent plan's thread (design-stage §2.9 item 7): the
 * approver asks a question, or the person who sent the plan answers — they
 * alone, while it waits for approval. Nothing is created; the plan's
 * choices are unchanged.
 */
export async function commentOnSentPlan(
  pmStore: PmStore,
  proposal: PmProposal,
  input: { principal: string; text: unknown; audience: Audience },
): Promise<PmProposal> {
  const approval = proposal.approval;
  if (!approval) throw new ProposalError("This plan was not sent for approval.", 409);
  if (approval.state === "approved") {
    throw new ProposalError("This plan is already approved.", 409);
  }
  if (proposal.state !== "open") {
    throw new ProposalError(`This plan is already ${proposal.state}.`, 409);
  }
  const { audience, principal } = input;
  if (principal !== approval.approver && principal !== approval.requestedBy) {
    throw new ProposalError(
      `Only ${nameOf(audience, approval.approver)} and ${nameOf(audience, approval.requestedBy)} write in this plan's thread.`,
      403,
    );
  }
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) throw new ProposalError("Write the question or the answer.", 400);
  if (text.length > PLAN_MESSAGE_MAX) {
    throw new ProposalError(`A message is at most ${PLAN_MESSAGE_MAX} characters.`, 400);
  }
  const id = await pmStore.commentOnPlan(proposal.id, text);
  const message = { id, by: principal, text, at: new Date().toISOString() };
  const next: PmPlanApproval = { ...approval, thread: [...(approval.thread ?? []), message] };
  return { ...proposal, approval: namedApproval(next, audience) };
}

/** A reply whose plan was sent to `person`: they read it once it is sent (§2.9 item 1). */
export function sentTo(message: PmMessage, person: string): boolean {
  return (message.proposals ?? []).some((p) => p.approval?.approver === person);
}

/** Each sent plan in a message, with the names of who sent it and who approves it. */
export function withApprovalNames(message: PmMessage, audience: Audience): PmMessage {
  if (!message.proposals?.some((p) => p.approval)) return message;
  return {
    ...message,
    proposals: message.proposals.map((p) =>
      p.approval ? { ...p, approval: namedApproval(p.approval, audience) } : p,
    ),
  };
}

function refuseUnlessNewProject(proposal: PmProposal): void {
  if (proposal.kind !== "start_project" || !projectGroupOf(proposal.patch)) {
    throw new ProposalError("Only a new project's plan is sent for approval.", 400);
  }
  if (proposal.state !== "open") {
    throw new ProposalError(`This plan is already ${proposal.state}.`, 409);
  }
}

/**
 * *Send for approval*: record `plan/sent_for_approval {proposalId, approver,
 * choices?}` with the sender as principal, and create nothing.
 */
export async function sendPlanForApproval(
  pmStore: PmStore,
  proposal: PmProposal,
  input: {
    principal: string;
    approver: unknown;
    choices?: ProjectChoices | undefined;
    audience: Audience;
  },
): Promise<PmProposal> {
  const { audience, principal } = input;
  if (audience.setup !== "team") {
    throw new ProposalError("Solo has no one to send a plan to: Create project creates it.", 409);
  }
  refuseUnlessNewProject(proposal);
  if (proposal.approval) {
    throw new ProposalError(
      `This plan was already sent to ${nameOf(audience, proposal.approval.approver)} for approval.`,
      409,
    );
  }
  // Only the person whose conversation it is sends it; a plan that is no
  // one's conversation (a reply recorded without `to`) is no one's to send.
  const asker = await pmStore.askerOf(proposal.id);
  if (!asker) {
    throw new ProposalError(
      "This plan is not from your conversation with Seshat, so you cannot send it.",
      403,
    );
  }
  if (asker !== principal) {
    throw new ProposalError(`This plan is ${nameOf(audience, asker)}'s to send.`, 403);
  }
  const approver = typeof input.approver === "string" ? input.approver.trim() : "";
  if (!approver) throw new ProposalError("Name the Member or Admin who approves it.", 400);
  if (approver === principal) {
    throw new ProposalError("Send it to a Member or an Admin other than yourself.", 400);
  }
  const level = audience.levelOf(approver);
  if (!level || !APPROVERS.has(level)) {
    throw new ProposalError(
      `${nameOf(audience, approver)} is not a Member or an Admin here, so cannot approve a plan.`,
      400,
    );
  }
  // TEAM-57 (amends TEAM-20): a new project's plan is approved by one who may
  // create a project, an Admin or a person who leads a project.
  if (audience.mayCreateProject && !audience.mayCreateProject(approver)) {
    throw new ProposalError(
      `${nameOf(audience, approver)} cannot create a project here, so cannot approve this plan: an Admin or a person who leads a project can.`,
      400,
    );
  }
  const choices = input.choices as Record<string, unknown> | undefined;
  await pmStore.sendForApproval(proposal.id, approver, choices);
  const approval: PmPlanApproval = {
    state: "sent",
    approver,
    requestedBy: principal,
    ...(choices ? { choices } : {}),
  };
  return { ...proposal, approval: namedApproval(approval, audience) };
}

/**
 * A plan sent for approval is decided by its named approver alone (teams
 * §2.4 item 21): *Apply* would create it without `plan/approved` and without
 * the approver owning its issues (TEAM-42), so it is refused to everyone —
 * the approver presses *Approve*; *Discard* is the approver's (declining) or
 * the sender's (withdrawing). Undefined when the action may go ahead.
 */
export function approvalRefusal(
  proposal: PmProposal,
  verb: "apply" | "discard",
  principal: string | undefined,
  audience: Audience,
): ProposalError | undefined {
  const approval = proposal.approval;
  if (!approval || approval.state !== "sent") return undefined;
  const approver = nameOf(audience, approval.approver);
  if (verb === "apply") {
    return new ProposalError(PLAN_APPROVAL_REFUSAL.applied(approver), 409);
  }
  if (principal === approval.approver || principal === approval.requestedBy) return undefined;
  return new ProposalError(
    PLAN_APPROVAL_REFUSAL.discarded(approver, nameOf(audience, approval.requestedBy)),
    403,
  );
}

/**
 * *Approve*: only the person the plan was sent to. The plan is created with
 * their edits, else the choices sent (the one path Create project takes,
 * PM-P2-2); each issue of the new project is then owned by the approver
 * (TEAM-42), and `plan/approved {proposalId, projectId}` names them.
 */
export async function approveSentPlan(
  proposal: PmProposal,
  ctx: ApplyContext & { principal: string; audience: Audience },
): Promise<{ proposal: PmProposal; cards: CardRecord[] }> {
  const approval = proposal.approval;
  if (!approval) throw new ProposalError("This plan was not sent for approval.", 409);
  if (approval.state === "approved") {
    throw new ProposalError("This plan is already approved.", 409);
  }
  refuseUnlessNewProject(proposal);
  if (ctx.principal !== approval.approver) {
    throw new ProposalError(
      `${nameOf(ctx.audience, approval.requestedBy)} sent this plan to ${nameOf(ctx.audience, approval.approver)} for approval; only they approve it.`,
      403,
    );
  }
  const choices = ctx.choices ?? (approval.choices as ProjectChoices | undefined);
  const applied = await applyProposal(proposal, { ...ctx, ...(choices ? { choices } : {}) });
  const projectId = applied.cards.find((c) => c.projectId)?.projectId;
  const cards: CardRecord[] = [];
  if (projectId) {
    for (const card of await ctx.cardStore.listCards()) {
      if (card.projectId !== projectId) continue;
      cards.push(
        card.owner === ctx.principal
          ? card
          : await ctx.cardStore.changeOwner(card.id, ctx.principal, ctx.principal, ctx.actor),
      );
    }
  }
  await ctx.pmStore.recordPlanApproved(proposal.id, projectId);
  const done: PmPlanApproval = { ...approval, state: "approved", approvedBy: ctx.principal };
  return {
    proposal: { ...applied.proposal, approval: namedApproval(done, ctx.audience) },
    cards: cards.length ? cards : applied.cards,
  };
}
