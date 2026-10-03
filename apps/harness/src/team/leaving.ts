import type { BoardServiceImpl } from "@sekhemet/board";
import type { CardStore, EventLog } from "@sekhemet/kernel";
import { requestPause } from "../collaborate.js";
import { park } from "../triage.js";
import { type Access, emptiedRuleSentence } from "./access.js";

export { emptiedRuleSentence };

/**
 * When a member leaves (teams §2.2 item 9a, NEW-teams-13; DESIGN_GAPS_C1
 * b12; FINDINGS_C1 PRC-09). Removing a person ends their sessions and
 * tokens (`identity.remove`); this module settles what they leave behind:
 * *Remove* first lists it (TEAM-49); on confirmation the Agent work they
 * started pauses — a running issue at its next step boundary (DEC-34), a
 * queued one on hold so nothing runs on their permissions — with each
 * assignee and every event's attribution unchanged, and no one may assign
 * them new work (TEAM-50). An Accept rule left with no current member is
 * not treated as *no rule set*: no one it does not name gains Accept, the
 * refusal names the rule, and a notice waits in the project lead's and the
 * Admins' Inbox until the rule is edited (TEAM-51; DEC-53 c15 is no). The
 * settlement is recorded as `member/removal_settled` (TEAM-52).
 */

export const REMOVAL_SETTLED = "member/removal_settled";
export const ASSIGNMENT_REFUSED = "member/assignment_refused";

/** Statuses where the Agent is at work on an issue: paused at the next step boundary. */
const RUNNING = new Set(["in_progress", "verifying", "verify"]);
/** Statuses where the Agent's work waits to start: put on hold. */
const QUEUED = new Set(["ready"]);
/** Statuses an issue they own is still open in. */
const CLOSED = new Set(["done", "rejected"]);

export interface RemovalSummary {
  principal: string;
  name?: string;
  /** The open issues they are the assignee of. */
  owns: { id: string; title: string; status: string; projectId?: string }[];
  /** The projects and the not-yet-accepted releases they lead. */
  leads: {
    projects: { id: string; name: string }[];
    releases: { project: string; id: string; name?: string }[];
  };
  /** Each Accept rule naming them, and whether it is left with no current member. */
  acceptSeats: { project: string; name: string; emptied: boolean }[];
  /** The Agent work they started: delegated by them, not finished. */
  agentWork: { id: string; title: string; status: string; running: boolean }[];
}

export interface LeavingDeps {
  repoPath: string;
  access: Access;
  cardStore: CardStore;
  boardService: BoardServiceImpl;
  log: EventLog;
  nameOf: (principal: string) => string | undefined;
}

const atLeastMember = (access: Access, principal: string, project: string): boolean => {
  const level = access.level(principal, project);
  return level === "member" || level === "admin";
};

/** TEAM-49: what the person owns and leads, their Accept-rule seats, the Agent work they started. */
export async function removalSummary(
  deps: LeavingDeps,
  principal: string,
): Promise<RemovalSummary> {
  const { access, cardStore } = deps;
  const projects = cardStore.listProjects();
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const cards = await cardStore.listCards();
  const owns = cards
    .filter((c) => c.owner === principal && !CLOSED.has(c.status))
    .map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      ...(c.projectId ? { projectId: c.projectId } : {}),
    }));
  const leadsProjects = projects
    .filter((p) => access.settings(p.id).lead === principal)
    .map((p) => ({ id: p.id, name: p.name }));
  const releases: RemovalSummary["leads"]["releases"] = [];
  const { releaseLeads, acceptedReleases } = access.projection();
  for (const [project, leads] of releaseLeads) {
    for (const [release, lead] of leads) {
      if (lead !== principal || acceptedReleases.has(release)) continue;
      const slice = await cardStore.slices.get(release);
      releases.push({ project, id: release, ...(slice?.title ? { name: slice.title } : {}) });
    }
  }
  const acceptSeats = projects
    .filter((p) => access.settings(p.id).accept_rule?.includes(principal))
    .map((p) => ({
      project: p.id,
      name: p.name,
      emptied: !(access.settings(p.id).accept_rule ?? []).some(
        (other) => other !== principal && atLeastMember(access, other, p.id),
      ),
    }));
  const agentWork = cards
    .filter(
      (c) =>
        c.delegate?.kind === "worker" &&
        cardStore.delegatorOf(c.id) === principal &&
        (RUNNING.has(c.status) || QUEUED.has(c.status)),
    )
    .map((c) => ({ id: c.id, title: c.title, status: c.status, running: RUNNING.has(c.status) }));
  const name = deps.nameOf(principal);
  return {
    principal,
    ...(name ? { name } : {}),
    owns,
    leads: { projects: leadsProjects, releases },
    acceptSeats: acceptSeats.map((s) => ({ ...s, name: projectName(s.project) })),
    agentWork,
  };
}

/**
 * TEAM-50, -52: after the removal, pause the Agent work they started and
 * record what was settled. `actor` is the Admin who removed them.
 */
export async function settleRemoval(
  deps: LeavingDeps,
  actor: string,
  summary: RemovalSummary,
): Promise<{ paused: string[]; held: string[]; emptiedRules: string[] }> {
  const paused: string[] = [];
  const held: string[] = [];
  const who = summary.name ?? "A person who left";
  for (const work of summary.agentWork) {
    const card = await deps.cardStore.getCard(work.id);
    if (!card) continue;
    if (RUNNING.has(card.status)) {
      await requestPause(deps.cardStore, card.id, actor);
      paused.push(card.id);
    } else if (QUEUED.has(card.status)) {
      await park(
        {
          repoPath: deps.repoPath,
          cardStore: deps.cardStore,
          boardService: deps.boardService,
          log: deps.log,
          principal: actor,
        },
        card,
        `${who} left the workspace; the Agent work they started waits until a person takes it off hold`,
      );
      held.push(card.id);
    }
  }
  const emptiedRules = summary.acceptSeats.filter((s) => s.emptied).map((s) => s.project);
  await deps.log.append({
    actor: "human",
    type: REMOVAL_SETTLED,
    principal: actor,
    payload: {
      principal: summary.principal,
      owns: summary.owns.map((c) => c.id),
      leads: summary.leads.projects.map((p) => p.id),
      releases: summary.leads.releases.map((r) => r.id),
      acceptSeats: summary.acceptSeats.map((s) => s.project),
      paused,
      held,
      emptiedRules,
    },
  });
  return { paused, held, emptiedRules };
}

/**
 * TEAM-50: why new work cannot be assigned to this person, or undefined when
 * it can. A removed member is named, never by their principal id.
 */
export function assignmentRefusal(
  access: Access,
  principal: string,
  nameOf: (principal: string) => string | undefined,
): string | undefined {
  const member = access.projection().members.get(principal);
  if (!member?.removed) return undefined;
  const name = nameOf(principal) ?? "This person";
  return `${name} is no longer a member of this workspace, so no new work can be assigned to them.`;
}

/** Record a refused assignment (TEAM-52). */
export async function recordAssignmentRefused(
  log: EventLog,
  input: { by: string | undefined; principal: string; cardId: string },
): Promise<void> {
  await log.append({
    actor: "human",
    type: ASSIGNMENT_REFUSED,
    cardId: input.cardId,
    ...(input.by ? { principal: input.by } : {}),
    payload: { principal: input.principal, cardId: input.cardId },
  });
}

/**
 * TEAM-51: the projects whose recorded Accept rule names no current member,
 * for the notice in the project lead's and the Admins' Inbox. A project
 * with no rule recorded is not one: the default (DEC-42) applies to it.
 */
export function emptiedAcceptRules(
  access: Access,
  cardStore: CardStore,
): { project: string; name: string; lead?: string }[] {
  const out: { project: string; name: string; lead?: string }[] = [];
  for (const p of cardStore.listProjects()) {
    const settings = access.settings(p.id);
    if (!settings.accept_rule) continue;
    if ((access.acceptHolders(p.id) ?? []).length > 0) continue;
    out.push({ project: p.id, name: p.name, ...(settings.lead ? { lead: settings.lead } : {}) });
  }
  return out;
}
