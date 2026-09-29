import type { ServerResponse } from "node:http";
import { posix } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { EventLog } from "@sekhemet/kernel";
import { CONFIG_ROUTES } from "../config_routes.js";
import { allMembers, personName } from "./members.js";
import { LEVELS, type Level, isLevel, levelRank, lowerLevel } from "./settings.js";

/**
 * What a person may do (teams §2.2 items 6–9, NEW-teams-2; integrations
 * items 24–27): the four access levels, a per-project override, the project
 * lead and the per-project Accept rule, all folded from the event log. A
 * profile label is read here too, and grants nothing (TEAM-7).
 *
 * Solo: the install's person is an Admin and every check passes for them,
 * so Solo behaves as before. Team: the `member/*` events decide.
 */

export type { Level } from "./settings.js";

/** One row of the action table: the lowest level that may, and who else. */
export interface ActionRule {
  level: Level;
  /**
   * `true`: the project's lead may too (item 6's "an Admin or the project
   * lead"). `only`: the project's lead alone, at Member or above — health is
   * the lead's call (item 28, DB-N9-2); Solo's one person holds it.
   */
  lead?: true | "only";
  /**
   * A Member who leads one of the project's releases not yet accepted may
   * too (item 28: "the project lead, or any Member who leads a release").
   */
  releaseLead?: true;
  /**
   * `only`: held by the people the project's Accept rule names, at Member or
   * above (item 7) — the level alone is not enough. `or`: the level, or being named.
   */
  acceptRule?: "only" | "or";
  /** What the person tried, as the refusal says it: "A Member can <does>." */
  does: string;
}

/** Teams item 6 and integrations item 26, as data. */
export const ACTIONS = {
  read: { level: "viewer", does: "read this project" },
  comment: { level: "viewer", does: "comment" },
  "seshat.ask": { level: "viewer", does: "ask Seshat" },
  "token.own": { level: "viewer", does: "manage your own tokens" },
  "issue.file": { level: "stakeholder", does: "file an issue" },
  "project.converse": { level: "stakeholder", does: "start a project conversation" },
  "question.answer": { level: "stakeholder", does: "answer this question" },
  "issue.edit": { level: "member", does: "edit this issue" },
  "issue.create": { level: "member", does: "create issues" },
  "scope.change": { level: "member", does: "change this issue's scope" },
  "priority.change": { level: "member", does: "change priority" },
  "agent.start": { level: "member", does: "start the Agent on this issue" },
  "agent.guide": { level: "member", does: "guide the Agent" },
  "agent.pause": { level: "member", does: "pause the Agent" },
  "agent.take_over": { level: "member", does: "take this issue over from the Agent" },
  review: { level: "member", does: "send back, park or reject this issue" },
  "gates.run": { level: "member", does: "run the checks" },
  "proposal.apply": { level: "member", does: "apply Seshat's proposals" },
  "plan.approve": { level: "member", does: "approve plans" },
  "run.start": { level: "member", does: "start a queue or overnight run" },
  "project.create": { level: "member", does: "create a project" },
  accept: { level: "member", acceptRule: "only", does: "accept this issue" },
  "permission.answer": {
    level: "member",
    acceptRule: "only",
    does: "answer the Agent's permission request",
  },
  "playbook.approve": {
    level: "member",
    acceptRule: "only",
    does: "approve a Playbook rule for this project",
  },
  "review.capacity": { level: "admin", acceptRule: "or", does: "change review capacity" },
  "project.settings": {
    level: "admin",
    lead: true,
    does: "change this project's Accept rule and settings",
  },
  "project.archive": { level: "admin", lead: true, does: "archive or pause this project" },
  "level.override": { level: "admin", lead: true, does: "change a person's level on this project" },
  "project.lead": { level: "admin", does: "name this project's lead" },
  "auto_apply.enable": { level: "admin", does: "turn on auto-apply" },
  "integration.connect": { level: "admin", does: "connect an integration" },
  "members.manage": { level: "admin", does: "manage members, invites and levels" },
  "config.manage": { level: "admin", does: "change the server's configuration" },
  "queue.caps": { level: "admin", does: "set the queue's caps" },
  "audit.view": { level: "admin", does: "open the audit view" },
  "playbook.approve_all": { level: "admin", does: "approve a Playbook rule for all projects" },
  // PM_CONTRACT: "In the Team setup only the project's lead or an Admin" (teams item 6).
  "project.update": { level: "admin", lead: true, does: "post this project's update" },
  // Teams item 28, TEAM-28, DB-N9-2: health is the project lead's call, or
  // a Member's who leads a release not yet accepted.
  "project.health": {
    level: "member",
    lead: "only",
    releaseLead: true,
    does: "set this project's health",
  },
  // Teams item 28, DB-N9-2: who leads a release, named like its target date.
  "release.lead": { level: "admin", lead: true, does: "name a release's lead" },
  // DB-N9-3, DEC-37: a release's target date, like the project's settings.
  "release.target": { level: "admin", lead: true, does: "set a release's target date" },
  // Teams item 6: brief acceptance is the project's Admin or lead, like its settings.
  "brief.accept": { level: "admin", lead: true, does: "accept a brief" },
} as const satisfies Record<string, ActionRule>;

export type Permission = keyof typeof ACTIONS;

/** Properties Seshat's suggestions may auto-apply (TEAM-18: never the assignee or health). */
export const AUTO_APPLY_PROPERTIES = ["label", "priority", "duplicate", "split"] as const;

export interface MemberRecord {
  principal: string;
  level: Level;
  pending: boolean;
  removed: boolean;
  /** The profile label (item 8): a home page and notification defaults, no permission. */
  label?: string | undefined;
  /** Per-project overrides (item 6), by project id. */
  projects: Record<string, Level>;
}

/** The project settings `project/settings_changed` records (teams §3). */
export interface ProjectSettings {
  accept_rule?: string[];
  require_resolved_threads?: boolean;
  lead?: string;
  auto_apply?: Record<string, boolean>;
  /**
   * Preferences → Estimation (DEC-31, dashboard DB-N7-2): `off`, the default,
   * shows no points anywhere; `points` shows story points as Jira does.
   */
  estimation?: "off" | "points";
}

export interface TeamProjection {
  members: Map<string, MemberRecord>;
  projects: Map<string, ProjectSettings>;
  /**
   * Each project's releases that have a lead (item 28, `release/lead_set`),
   * release id to lead, and the releases a person has accepted since.
   */
  releaseLeads: Map<string, Map<string, string>>;
  acceptedReleases: Set<string>;
  /**
   * Who turned each auto-apply property on, by project (TEAM-41): the
   * principal of the change that last switched it from off to on.
   */
  autoApplyBy: Map<string, Record<string, string>>;
}

const ACCESS_TYPES = [
  "member/level_changed",
  "member/label_changed",
  "project/settings_changed",
  "release/lead_set",
  "slice/accepted",
];

/** Fold the member and project-settings events into who may do what. */
export function projectTeam(db: DatabaseSync): TeamProjection {
  const members = new Map<string, MemberRecord>();
  for (const m of allMembers(db)) {
    members.set(m.principal, {
      principal: m.principal,
      level: m.level,
      pending: m.pending,
      removed: m.removed,
      projects: {},
    });
  }
  const projects = new Map<string, ProjectSettings>();
  const autoApplyBy = new Map<string, Record<string, string>>();
  const releaseLeads = new Map<string, Map<string, string>>();
  const acceptedReleases = new Set<string>();
  const rows = db
    .prepare(
      `SELECT type, actor, payload, principal FROM events WHERE type IN (${ACCESS_TYPES.map(() => "?").join(",")}) ORDER BY seq`,
    )
    .all(...ACCESS_TYPES) as {
    type: string;
    actor: string;
    payload: string;
    principal: string | null;
  }[];
  for (const row of rows) {
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    // A release's lead is named by a person (a human event with its principal),
    // never a model; and only a person's acceptance ends it (the slice ledger's rule).
    if (row.type === "release/lead_set" && (row.actor !== "human" || !row.principal)) continue;
    if (row.type === "slice/accepted" && row.actor !== "human") continue;
    if (row.type === "release/lead_set" || row.type === "slice/accepted") {
      const release = typeof p.sliceId === "string" ? p.sliceId : undefined;
      const project = typeof p.projectId === "string" ? p.projectId : undefined;
      if (!release || !project) continue;
      if (row.type === "slice/accepted") {
        acceptedReleases.add(release);
        continue;
      }
      const leads = releaseLeads.get(project) ?? new Map<string, string>();
      if (typeof p.lead === "string" && p.lead) leads.set(release, p.lead);
      else leads.delete(release);
      releaseLeads.set(project, leads);
      continue;
    }
    if (row.type === "project/settings_changed") {
      const id = typeof p.project === "string" ? p.project : undefined;
      if (!id) continue;
      const current = projects.get(id) ?? {};
      const { project: _project, ...changes } = p;
      // TEAM-41: a property switched on is that person's rule; switched off, no one's.
      const auto = (changes as ProjectSettings).auto_apply;
      if (auto) {
        const by = { ...(autoApplyBy.get(id) ?? {}) };
        for (const [k, on] of Object.entries(auto)) {
          if (!on) delete by[k];
          else if (!current.auto_apply?.[k] && row.principal) by[k] = row.principal;
        }
        autoApplyBy.set(id, by);
      }
      projects.set(id, { ...current, ...(changes as ProjectSettings) });
      continue;
    }
    const member = typeof p.principal === "string" ? members.get(p.principal) : undefined;
    if (!member) continue;
    if (row.type === "member/level_changed" && typeof p.project === "string" && isLevel(p.level)) {
      member.projects[p.project] = p.level;
    } else if (row.type === "member/label_changed") {
      if (typeof p.label === "string" && p.label) member.label = p.label;
      else member.label = undefined;
    }
  }
  return { members, projects, autoApplyBy, releaseLeads, acceptedReleases };
}

export interface AccessOptions {
  db: DatabaseSync;
  setup: "solo" | "team";
  /** The install's person: Admin on a Solo install (teams item 1). */
  localPrincipal: () => string;
}

/** The outcome of one check, with what a refusal says. */
export interface Decision {
  allowed: boolean;
  permission: Permission;
  /** The person's level on the project; `undefined` when they have none (not a member, pending, removed). */
  level?: Level;
  /** The lowest level the action table names. */
  needs: Level;
  /** "A Member", "An Admin or the project lead", "A person this project's Accept rule names". */
  grantedBy: string;
  message: string;
}

const LEVEL_NAME: Record<Level, string> = {
  viewer: "Viewer",
  stakeholder: "Stakeholder",
  member: "Member",
  admin: "Admin",
};
const article = (level: Level) => (level === "admin" ? "an" : "a");

export class Access {
  private cache: { seq: number; projection: TeamProjection } | undefined;

  constructor(private readonly options: AccessOptions) {}

  public get setup(): "solo" | "team" {
    return this.options.setup;
  }

  /** The projection, refolded only when the ledger has grown. */
  public projection(): TeamProjection {
    const seq =
      (this.options.db.prepare("SELECT MAX(seq) AS m FROM events").get() as { m: number | null })
        .m ?? 0;
    if (this.cache?.seq !== seq) this.cache = { seq, projection: projectTeam(this.options.db) };
    return this.cache.projection;
  }

  private isSoloPerson(principal: string): boolean {
    return this.options.setup === "solo" && principal === this.options.localPrincipal();
  }

  /** A person's level, for one project when given (the override wins there only, TEAM-6). */
  public level(principal: string, project?: string): Level | undefined {
    if (this.isSoloPerson(principal)) return "admin";
    const m = this.projection().members.get(principal);
    if (!m || m.pending || m.removed) return undefined;
    return (project ? m.projects[project] : undefined) ?? m.level;
  }

  public settings(project: string | undefined): ProjectSettings {
    return (project && this.projection().projects.get(project)) || {};
  }

  /**
   * The Admin whose auto-apply rule applies Seshat's suggestion of this kind
   * on this project's issues (planner-pm PM-N9-2, TEAM-18, -41): the one who
   * turned the property on, while it is on and they are still an Admin
   * there. Never for the assignee, health, a hold or a removal, nor for an
   * issue with no project.
   */
  public autoApplier(project: string | undefined, kind: string): string | undefined {
    if (!project || !(AUTO_APPLY_PROPERTIES as readonly string[]).includes(kind)) return undefined;
    if (this.settings(project).auto_apply?.[kind] !== true) return undefined;
    const by = this.projection().autoApplyBy.get(project)?.[kind];
    return by && this.level(by, project) === "admin" ? by : undefined;
  }

  /** The Admins now (approved, not removed): the workspace's default accepters (DEC-42). */
  public admins(): string[] {
    return [...this.projection().members.values()]
      .filter((m) => m.level === "admin" && !m.pending && !m.removed)
      .map((m) => m.principal);
  }

  /**
   * The people who may accept on a project (teams item 7, DEC-42): those its
   * recorded Accept rule names at Member or above; with no rule set, the
   * project lead, else the Admins — a card with no project goes by the
   * workspace default, the Admins. Solo with no rule: `undefined`, so the
   * kernel's default applies (the install's person).
   */
  public acceptHolders(project: string | undefined): string[] | undefined {
    return this.acceptRule(project).holders;
  }

  /** The effective Accept rule and where it comes from (DEC-42). */
  private acceptRule(project: string | undefined): {
    holders: string[] | undefined;
    source: "rule" | "lead" | "admins" | "solo";
  } {
    const atLeastMember = (p: string) => {
      const level = this.level(p, project);
      return level !== undefined && levelRank(level) >= levelRank("member");
    };
    const rule = this.settings(project).accept_rule;
    if (rule) return { holders: rule.filter(atLeastMember), source: "rule" };
    if (this.options.setup === "solo") return { holders: undefined, source: "solo" };
    const lead = project ? this.settings(project).lead : undefined;
    if (lead && atLeastMember(lead)) return { holders: [lead], source: "lead" };
    return { holders: this.admins(), source: "admins" };
  }

  public can(principal: string, permission: Permission, project?: string): boolean {
    return this.decide(principal, permission, project).allowed;
  }

  /**
   * One check (TEAM-4). `ceiling` is the scope of the personal token the
   * request came with (teams item 15): the person acts at the lower of it and
   * their level, for every permission, the Accept rule's included.
   */
  public decide(
    principal: string,
    permission: Permission,
    project?: string,
    projectName?: string,
    ceiling?: Level,
  ): Decision {
    const rule: ActionRule = ACTIONS[permission];
    const own = this.level(principal, project);
    const level = own !== undefined && ceiling ? lowerLevel(own, ceiling) : own;
    const member = level !== undefined && levelRank(level) >= levelRank("member");
    const atLevel = level !== undefined && levelRank(level) >= levelRank(rule.level);
    const isLead =
      rule.lead !== undefined && project !== undefined && member && this.isLead(principal, project);
    const accept = rule.acceptRule ? this.acceptRule(project) : undefined;
    // Named by the Accept rule, and acting at Member or above (item 7).
    const named = member && (accept?.holders ?? []).includes(principal);
    let allowed: boolean;
    if (rule.lead === "only") {
      // Solo's one person leads everything (item 1); in the Team setup, the
      // lead — and, where the rule says so, a Member who leads a release (item 28).
      const leadsRelease =
        rule.releaseLead === true &&
        project !== undefined &&
        member &&
        this.leadsRelease(principal, project);
      allowed = isLead || leadsRelease || this.isSoloPerson(principal);
    } else if (rule.acceptRule === "only") {
      // Solo with no rule recorded: the install's person holds Accept, as before.
      allowed = named || (accept?.source === "solo" && this.isSoloPerson(principal));
    } else {
      allowed = level !== undefined && (atLevel || isLead || named);
    }
    const where = projectName ? `on ${projectName}` : "in this workspace";
    const who =
      level === undefined
        ? this.projection().members.get(principal)?.pending
          ? "Your account is waiting for an Admin's approval."
          : "You're not a member of this workspace."
        : rule.acceptRule === "only" && member
          ? "This project's Accept rule doesn't include you."
          : `You're ${article(level)} ${LEVEL_NAME[level]} ${where}.`;
    // DEC-42: with no rule set, the refusal says who accepts meanwhile.
    const unset =
      rule.acceptRule === "only" &&
      member &&
      (accept?.source === "lead" || accept?.source === "admins")
        ? `No Accept rule set yet; ${this.defaultAccepter(accept.holders ?? [], accept.source)} can ${rule.does}.`
        : undefined;
    // Item 28: the lead's alone; with no lead named, the refusal says who names one.
    const noLead =
      rule.lead === "only" && project !== undefined && !this.settings(project).lead
        ? ", and none is named yet: an Admin names one in the project's settings"
        : "";
    const grantedBy =
      rule.lead === "only"
        ? rule.releaseLead
          ? "The project lead or a Member who leads a release"
          : "The project lead"
        : rule.acceptRule === "only"
          ? accept?.source === "lead"
            ? "The project lead"
            : accept?.source === "admins"
              ? "An Admin"
              : level !== undefined && !member
                ? "A Member this project's Accept rule names"
                : "A person this project's Accept rule names"
          : `${article(rule.level) === "an" ? "An" : "A"} ${LEVEL_NAME[rule.level]}${rule.lead ? " or the project lead" : ""}${rule.acceptRule === "or" ? " or a person this project's Accept rule names" : ""}`;
    return {
      allowed,
      permission,
      ...(level !== undefined ? { level } : {}),
      needs: rule.level,
      grantedBy,
      message: unset ?? `${who} ${grantedBy} can ${rule.does}${noLead}.`,
    };
  }

  /** Who accepts while no rule is set (DEC-42): the lead by name, or "an Admin". */
  private defaultAccepter(holders: string[], source: string | undefined): string {
    if (source === "lead" && holders[0]) {
      return personName(this.options.db, holders[0]) ?? "the project lead";
    }
    return "an Admin";
  }

  /** The release's lead, while it has one (item 28). */
  public releaseLead(project: string, release: string): string | undefined {
    return this.projection().releaseLeads.get(project)?.get(release);
  }

  /**
   * Whether the person leads one of the project's releases that no person
   * has accepted yet, at Member or above there (teams item 28, DB-N9-2).
   */
  public leadsRelease(principal: string, project: string): boolean {
    const level = this.level(principal, project);
    if (level === undefined || levelRank(level) < levelRank("member")) return false;
    const { releaseLeads, acceptedReleases } = this.projection();
    for (const [release, lead] of releaseLeads.get(project) ?? []) {
      if (lead === principal && !acceptedReleases.has(release)) return true;
    }
    return false;
  }

  public isLead(principal: string, project: string): boolean {
    return (
      this.settings(project).lead === principal && this.level(principal, project) !== undefined
    );
  }
}

/** The Stakeholder refusals that offer to ask a Member instead (TEAM-5, item 19a). */
const ASK_A_MEMBER = new Set<Permission>([
  "agent.start",
  "scope.change",
  "priority.change",
  "issue.edit",
  "proposal.apply",
  "accept",
]);

export interface RefusalContext {
  principal: string;
  project?: string;
  cardId?: string;
  /** Whom a Stakeholder's ask goes to: the issue's owner if a Member, else the project lead. */
  askTo?: string;
}

/**
 * The one 403 (TEAM-4, INT-22): names the missing permission and a level
 * that has it, records `access/refused` with the person's principal, and for
 * a Stakeholder offers to ask a Member (TEAM-5).
 */
export function refuse(
  res: ServerResponse,
  json: (res: ServerResponse, status: number, body: unknown) => void,
  log: EventLog,
  decision: Decision,
  ctx: RefusalContext,
): void {
  log.appendNow({
    actor: "human",
    type: "access/refused",
    principal: ctx.principal,
    ...(ctx.cardId ? { cardId: ctx.cardId } : {}),
    payload: {
      permission: decision.permission,
      level: decision.level ?? "none",
      needs: decision.needs,
      ...(ctx.project ? { project: ctx.project } : {}),
    },
  });
  const offer =
    decision.level === "stakeholder" && ASK_A_MEMBER.has(decision.permission)
      ? {
          offer: {
            kind: "ask_member",
            say: `Ask a Member to ${ACTIONS[decision.permission].does}`,
            ...(ctx.askTo ? { to: ctx.askTo } : {}),
          },
        }
      : {};
  json(res, 403, {
    error: decision.message,
    refused: "permission",
    permission: decision.permission,
    level: decision.level ?? null,
    needs: decision.needs,
    grantedBy: decision.grantedBy,
    ...offer,
  });
}

/** Thrown when a recorded change is refused outside HTTP (the refusal's message). */
export class AccessRefusedError extends Error {
  constructor(public readonly decision: Decision) {
    super(decision.message);
  }
}

/** Refused because the workspace would be left without an Admin (409). */
export class LastAdminError extends Error {}

/**
 * Change a person's level (TEAM-6): the workspace level is an Admin's; a
 * one-project override an Admin's or the project lead's, and a lead who is
 * not an Admin sets none above their own level there. The last Admin is
 * never lowered. `ceiling` is the scope of the token the request came with.
 * Records `member/level_changed {principal, level, project?}`.
 */
export async function recordLevelChange(
  log: EventLog,
  access: Access,
  input: { by: string; principal: string; level: Level; project?: string; ceiling?: Level },
): Promise<void> {
  if (!isLevel(input.level)) throw new Error(`level must be one of ${LEVELS.join(", ")}`);
  const decision = input.project
    ? access.decide(input.by, "level.override", input.project, undefined, input.ceiling)
    : access.decide(input.by, "members.manage", undefined, undefined, input.ceiling);
  if (!decision.allowed) throw new AccessRefusedError(decision);
  const target = access.projection().members.get(input.principal);
  if (!target || target.removed) {
    throw new Error(`${input.principal} is not a member of this workspace`);
  }
  if (input.project && decision.level !== "admin" && decision.level !== undefined) {
    if (levelRank(input.level) > levelRank(decision.level)) {
      throw new AccessRefusedError({
        ...decision,
        allowed: false,
        needs: "admin",
        grantedBy: "An Admin",
        message: `You're the project lead at ${LEVEL_NAME[decision.level]}: you can set levels up to ${LEVEL_NAME[decision.level]} on this project. An Admin can set a higher one.`,
      });
    }
  }
  if (
    !input.project &&
    target.level === "admin" &&
    input.level !== "admin" &&
    access.admins().every((p) => p === input.principal)
  ) {
    throw new LastAdminError(
      "This is the last Admin: name another Admin before lowering this one.",
    );
  }
  await log.append({
    actor: "human",
    type: "member/level_changed",
    principal: input.by,
    payload: {
      principal: input.principal,
      level: input.level,
      ...(input.project ? { project: input.project } : {}),
    },
  });
}

/** Change a person's profile label (item 8, TEAM-7): an Admin's; it grants nothing. */
export async function recordLabelChange(
  log: EventLog,
  access: Access,
  input: { by: string; principal: string; label: string | null },
): Promise<void> {
  const decision = access.decide(input.by, "members.manage");
  if (!decision.allowed) throw new AccessRefusedError(decision);
  await log.append({
    actor: "human",
    type: "member/label_changed",
    principal: input.by,
    payload: { principal: input.principal, label: input.label ?? "" },
  });
}

/** The permission each changed setting needs (item 6's project table). */
const SETTING_PERMISSION: Record<keyof ProjectSettings, Permission> = {
  accept_rule: "project.settings",
  require_resolved_threads: "project.settings",
  lead: "project.lead",
  auto_apply: "auto_apply.enable",
  estimation: "project.settings",
};

/** Parse a settings patch; throws naming the bad field. */
export function parseSettingsPatch(body: Record<string, unknown>): ProjectSettings {
  const out: ProjectSettings = {};
  const PRINCIPAL = /^p_[0-9a-z]+$/;
  if ("accept_rule" in body) {
    const v = body.accept_rule;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !PRINCIPAL.test(x))) {
      throw new Error("accept_rule is a list of principals (p_…)");
    }
    out.accept_rule = [...new Set(v as string[])];
  }
  if ("require_resolved_threads" in body) {
    if (typeof body.require_resolved_threads !== "boolean") {
      throw new Error("require_resolved_threads is true or false");
    }
    out.require_resolved_threads = body.require_resolved_threads;
  }
  if ("lead" in body) {
    if (typeof body.lead !== "string" || !PRINCIPAL.test(body.lead)) {
      throw new Error("lead is a principal (p_…)");
    }
    out.lead = body.lead;
  }
  if ("auto_apply" in body) {
    const v = body.auto_apply;
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      throw new Error("auto_apply maps a property to true or false");
    }
    for (const [k, on] of Object.entries(v)) {
      if (!(AUTO_APPLY_PROPERTIES as readonly string[]).includes(k)) {
        throw new Error(
          `auto_apply is not available for ${k}; only ${AUTO_APPLY_PROPERTIES.join(", ")} (TEAM-18)`,
        );
      }
      if (typeof on !== "boolean") throw new Error(`auto_apply.${k} is true or false`);
    }
    out.auto_apply = v as Record<string, boolean>;
  }
  if ("estimation" in body) {
    if (body.estimation !== "off" && body.estimation !== "points") {
      throw new Error("estimation is off or points");
    }
    out.estimation = body.estimation;
  }
  if (Object.keys(out).length === 0) {
    throw new Error(
      "Nothing to change: accept_rule, require_resolved_threads, lead, auto_apply or estimation",
    );
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The fields of `patch` that differ from `current`; auto-apply compared per property. */
export function changedSettings(current: ProjectSettings, patch: ProjectSettings): ProjectSettings {
  const out: ProjectSettings = {};
  if (patch.accept_rule && !same(current.accept_rule, patch.accept_rule)) {
    out.accept_rule = patch.accept_rule;
  }
  if (
    patch.require_resolved_threads !== undefined &&
    (current.require_resolved_threads ?? false) !== patch.require_resolved_threads
  ) {
    out.require_resolved_threads = patch.require_resolved_threads;
  }
  if (patch.lead && current.lead !== patch.lead) out.lead = patch.lead;
  if (patch.estimation && (current.estimation ?? "off") !== patch.estimation) {
    out.estimation = patch.estimation;
  }
  if (patch.auto_apply) {
    const diff = Object.fromEntries(
      Object.entries(patch.auto_apply).filter(
        ([k, on]) => (current.auto_apply?.[k] ?? false) !== on,
      ),
    );
    if (Object.keys(diff).length > 0) out.auto_apply = { ...current.auto_apply, ...diff };
  }
  return out;
}

/** The permissions a settings patch needs, one per kind of field (TEAM-32). */
export function settingsPermissions(patch: ProjectSettings): Permission[] {
  return [
    ...new Set((Object.keys(patch) as (keyof ProjectSettings)[]).map((k) => SETTING_PERMISSION[k])),
  ];
}

/** Record `project/settings_changed` with only the changed fields (TEAM-32); returns their names. */
export async function recordSettingsChange(
  log: EventLog,
  access: Access,
  input: { by: string; project: string; patch: ProjectSettings },
): Promise<(keyof ProjectSettings)[]> {
  const changes = changedSettings(access.settings(input.project), input.patch);
  const names = Object.keys(changes) as (keyof ProjectSettings)[];
  if (names.length === 0) return [];
  await log.append({
    actor: "human",
    type: "project/settings_changed",
    principal: input.by,
    payload: { project: input.project, ...changes },
  });
  return names;
}

/** What a write route needs: its permissions, and where the card or project is in the URL. */
export interface RouteRule {
  permissions: Permission[];
  cardId?: string | undefined;
  projectId?: string | undefined;
  decisionId?: string | undefined;
  /** B4.3: the caller resolves these to a project (slice's, requirement's or suggestion's card's). */
  sliceId?: string | undefined;
  requirementId?: string | undefined;
  suggestionId?: string | undefined;
  /** A proposal applied: the caller adds what its kind needs besides `proposal.apply`. */
  proposalId?: string | undefined;
  /** The permissions depend on the JSON body: read it, then ask again with it. */
  needsBody?: true;
}

const CARD = "[A-Za-z0-9_.:-]+";
const PROJ = "proj_[A-Za-z0-9_-]+";

type Resolver = (m: RegExpExecArray, body: Record<string, unknown> | undefined) => RouteRule;
const fixed =
  (permission: Permission, where: "card" | "project" | "none" = "none"): Resolver =>
  (m) => ({
    permissions: [permission],
    ...(where === "card" ? { cardId: m[1] } : where === "project" ? { projectId: m[1] } : {}),
  });

/**
 * What a card declares to its gates (`gateChecks`: DOM assertions, allowed
 * overlaps, a refactor's declared surface change, an upgrade's kept tests)
 * changes what the gates judge, so it needs Accept as well as the route's own
 * permission — never instead of it (gates rule 31a, GT-N4-6).
 */
function declaresGateChecks(body: Record<string, unknown>): boolean {
  if (body.gateChecks !== undefined) return true;
  return (
    Array.isArray(body.parts) &&
    body.parts.some(
      (p) => typeof p === "object" && p !== null && (p as { gateChecks?: unknown }).gateChecks,
    )
  );
}

/** The route's permissions, with Accept added (never substituted) when the body declares gate checks. */
const withGateChecks =
  (inner: Resolver): Resolver =>
  (m, body) => {
    if (body === undefined) {
      const rule = inner(m, undefined);
      return { ...rule, needsBody: true };
    }
    const rule = inner(m, body);
    if (rule.needsBody || !declaresGateChecks(body)) return rule;
    return {
      ...rule,
      permissions: rule.permissions.includes("accept")
        ? rule.permissions
        : [...rule.permissions, "accept"],
    };
  };

/** Every write route the dashboard server serves, and the permission it needs (TEAM-4). */
const ROUTES: [methods: string[], pattern: RegExp, resolve: Resolver][] = [
  [
    ["POST"],
    new RegExp(`^/api/cards/(${CARD})/(accept|revert|override)$`),
    (m) => ({ permissions: ["accept"], cardId: m[1] }),
  ],
  [
    ["POST"],
    new RegExp(`^/api/cards/(${CARD})/(return|park|unpark|reject|opened)$`),
    fixed("review", "card"),
  ],
  [["POST"], new RegExp(`^/api/cards/(${CARD})/(abort|pause)$`), fixed("agent.pause", "card")],
  [
    ["POST"],
    new RegExp(`^/api/cards/(${CARD})/(hand-back|take-over|submit-take-over)$`),
    fixed("agent.take_over", "card"),
  ],
  [["POST"], new RegExp(`^/api/cards/(${CARD})/message$`), fixed("agent.guide", "card")],
  [["POST"], new RegExp(`^/api/cards/(${CARD})/(rewind|fork|run)$`), fixed("agent.start", "card")],
  [["POST"], new RegExp(`^/api/cards/(${CARD})/reroute$`), fixed("issue.edit", "card")],
  // PM-N7-5: a person's approval of a plan's criteria is a Member's edit.
  [["POST"], new RegExp(`^/api/cards/(${CARD})/approve$`), fixed("issue.edit", "card")],
  [["POST"], new RegExp(`^/api/cards/(${CARD})/reorder$`), fixed("priority.change", "card")],
  [
    ["POST", "PATCH"],
    new RegExp(`^/api/cards/(${CARD})/split$`),
    withGateChecks(fixed("scope.change", "card")),
  ],
  [["POST", "PATCH"], new RegExp(`^/api/cards/(${CARD})/gate$`), fixed("gates.run", "card")],
  [["POST"], new RegExp(`^/api/cards/(${CARD})/attachments$`), fixed("issue.file", "card")],
  // Teams items 19, 19a (TEAM-15, -39, -40): every level comments; what an
  // `@Agent` in it may do is decided by the commenter's own level there.
  [["POST"], new RegExp(`^/api/cards/(${CARD})/comments$`), fixed("comment", "card")],
  // TEAM-39: a Member starts the Agent on a Stakeholder's or Viewer's request, or declines it.
  [
    ["POST"],
    new RegExp(`^/api/cards/(${CARD})/agent-requests/asr_[A-Za-z0-9_-]+/(?:start|decline)$`),
    fixed("agent.start", "card"),
  ],
  // Teams items 22–24 (TEAM-21, -22, -23): a person's own Inbox marks and
  // Watch toggle need only to read (every level); a comment's author answers
  // whether to invite the people it mentioned as they comment.
  [
    ["POST"],
    /^\/api\/inbox\/items\/[A-Za-z0-9_.:%-]+\/(?:read|done|undone|snooze|save|unsave)$/,
    fixed("read"),
  ],
  [["POST"], new RegExp(`^/api/issues/(${CARD})/watch$`), fixed("read", "card")],
  // Teams item 26 (TEAM-26): a page says which issue it shows or which card
  // it drags — presence, held in memory, never recorded — at every level.
  [["POST"], /^\/api\/presence$/, fixed("read")],
  // Teams item 25 (NEW-teams-8): the *Comment* verdict and a reply in a
  // review thread are comments (every level, as anyone who can read a pull
  // request may review it); resolving or reopening a thread is a reviewer's.
  [["POST"], new RegExp(`^/api/cards/(${CARD})/reviews$`), fixed("comment", "card")],
  [
    ["POST"],
    new RegExp(`^/api/cards/(${CARD})/threads/thr_[A-Za-z0-9_-]+/replies$`),
    fixed("comment", "card"),
  ],
  [
    ["POST"],
    new RegExp(`^/api/cards/(${CARD})/threads/thr_[A-Za-z0-9_-]+/(?:resolve|reopen)$`),
    fixed("review", "card"),
  ],
  [
    ["POST"],
    new RegExp(`^/api/cards/(${CARD})/comments/cmt_[A-Za-z0-9_-]+/mention$`),
    fixed("comment", "card"),
  ],
  [
    ["PATCH"],
    new RegExp(`^/api/cards/(${CARD})$`),
    withGateChecks((m, body) =>
      body === undefined
        ? { permissions: [], cardId: m[1], needsBody: true }
        : {
            permissions: [
              // Delegating the issue to the Agent starts it (teams item 6, TEAM-15),
              // and a refusal says so first, offering to ask a Member (item 19a).
              ...(typeof body.assignee === "string" &&
              body.assignee.trim().toLowerCase() === "worker"
                ? (["agent.start"] as const)
                : []),
              "priority" in body ? "priority.change" : "issue.edit",
              ...("title" in body ? (["scope.change"] as const) : []),
            ],
            cardId: m[1],
          },
    ),
  ],
  [
    ["POST", "PATCH"],
    new RegExp(`^/api/projects/(${PROJ})/cards$`),
    withGateChecks(fixed("issue.file", "project")),
  ],
  [
    ["PATCH"],
    new RegExp(`^/api/projects/(${PROJ})/settings$`),
    (m, body) => {
      if (body === undefined) return { permissions: [], projectId: m[1], needsBody: true };
      let patch: ProjectSettings;
      try {
        patch = parseSettingsPatch(body);
      } catch {
        return { permissions: ["project.settings"], projectId: m[1] };
      }
      return { permissions: settingsPermissions(patch), projectId: m[1] };
    },
  ],
  [
    ["POST"],
    new RegExp(`^/api/projects/(${PROJ})$`),
    (m, body) =>
      body === undefined
        ? { permissions: [], projectId: m[1], needsBody: true }
        : {
            permissions: [
              typeof body.reviewMinutesPerDay === "number" ? "review.capacity" : "project.archive",
            ],
            projectId: m[1],
          },
  ],
  [
    ["POST"],
    /^\/api\/members\/(p_[0-9a-z]+)\/level$/,
    (_m, body) =>
      body === undefined
        ? { permissions: [], needsBody: true }
        : typeof body.project === "string"
          ? { permissions: ["level.override"], projectId: body.project }
          : { permissions: ["members.manage"] },
  ],
  // A decision: a permission request is the Accept rule's, any other question a Stakeholder's.
  [
    ["POST"],
    /^\/api\/decisions\/(dec_[A-Za-z0-9_-]+)$/,
    (m) => ({ permissions: ["question.answer"], decisionId: m[1] }),
  ],
  [["POST"], /^\/api\/planner\/decisions\/(dec_[A-Za-z0-9_-]+)$/, fixed("plan.approve")],
  [["POST"], /^\/api\/recurring\/trigger\/[\w.-]+$/, fixed("run.start")],
  [["POST"], /^\/api\/pm\/messages$/, fixed("seshat.ask")],
  // Quick create from the board (dashboard DB-P3-12): a create proposal in
  // Seshat's thread; applying it is proposal.apply's, below. It is checked on
  // the project the card would land in: the epic's when it names one, else
  // the project the board is scoped to, else the workspace.
  [
    ["POST"],
    /^\/api\/pm\/create-card$/,
    (_m, body) =>
      body === undefined
        ? { permissions: [], needsBody: true }
        : {
            permissions: ["issue.create"],
            ...(typeof body.epicId === "string" && body.epicId
              ? { cardId: body.epicId }
              : typeof body.projectId === "string" && body.projectId
                ? { projectId: body.projectId }
                : {}),
          },
  ],
  // TEAM-20 (design-stage §2.9 item 7): a Stakeholder sends their project
  // conversation's plan to a named Member or Admin; approving it is a
  // Member's (item 6: "approve plans"), and creates the project. The named
  // approver accepts its brief by approving, so it needs no `brief.accept`.
  [
    ["POST"],
    /^\/api\/pm\/proposals\/[A-Za-z0-9_-]+\/send-for-approval$/,
    fixed("project.converse"),
  ],
  // Design-stage §2.9 item 7: a question or answer in a sent plan's thread is a
  // comment (every level); the route lets only its approver and sender write.
  [["POST"], /^\/api\/pm\/proposals\/[A-Za-z0-9_-]+\/comments$/, fixed("comment")],
  [
    ["POST"],
    /^\/api\/pm\/proposals\/[A-Za-z0-9_-]+\/approve$/,
    () => ({ permissions: ["plan.approve", "project.create"] }),
  ],
  // Applying a proposal names it, so the server can add what its kind needs
  // (a new project's group accepts a brief: teams item 6, design-stage §2.9 item 7).
  [
    ["POST"],
    /^\/api\/pm\/proposals\/([A-Za-z0-9_-]+)\/(apply|discard)$/,
    (m) => ({
      permissions: ["proposal.apply"],
      ...(m[2] === "apply" ? { proposalId: m[1] } : {}),
    }),
  ],
  [["POST"], /^\/api\/cycles$/, fixed("issue.edit")],
  [["PATCH"], /^\/api\/cycles\/[A-Za-z0-9_-]+$/, fixed("issue.edit")],
  [
    ["POST", "PATCH"],
    /^\/api\/learning\/rules\/[A-Za-z0-9_-]+(?:\/(approve|retire))?$/,
    fixed("playbook.approve_all"),
  ],
  [
    ["POST", "PATCH"],
    /^\/api\/learning\/profile\/[A-Za-z0-9_-]+(?:\/dismiss)?$/,
    fixed("issue.edit"),
  ],
  [["POST", "PATCH"], /^\/api\/assumptions\/asm_[A-Za-z0-9_-]+$/, fixed("plan.approve")],
  [["POST"], /^\/api\/machine\/calibrate$/, fixed("config.manage")],
  [["PUT", "DELETE", "POST"], /^\/api\/integrations\/.+$/, fixed("integration.connect")],
  [["POST"], /^\/api\/import$/, fixed("issue.create")],
  [
    ["POST"],
    /^\/api\/members(?:\/p_[0-9a-z]+\/(unlock|password-reset|label))?$/,
    fixed("members.manage"),
  ],
  [["POST"], /^\/api\/projects$/, fixed("project.create")],
  // PM_CONTRACT "Take over a project" (B4.4): starting one creates a project;
  // approving its plan is a plan's approval, recorded with the person's
  // principal; a reconciliation applied or dismissed is a proposal.
  [["POST"], /^\/api\/takeover$/, fixed("project.create")],
  [
    ["POST"],
    /^\/api\/takeover\/approve$/,
    (_m, body) =>
      body === undefined
        ? { permissions: [], needsBody: true }
        : {
            permissions: ["plan.approve"],
            ...(typeof body.projectId === "string" ? { projectId: body.projectId } : {}),
          },
  ],
  [["POST"], /^\/api\/takeover\/reconciliation\/(apply|dismiss)$/, fixed("proposal.apply")],
  // Gates rule 31 (GT-N4-1): a new visual baseline is a person's approval.
  [["POST"], /^\/api\/visual\/baselines\/[\w.-]+\/approve$/, fixed("accept")],
  // B4.3 (TEAM-4): a slice's acceptance is the project's Accept rule, like accepting a card.
  [
    ["POST"],
    /^\/api\/slices\/([\w.-]+)\/accept$/,
    (m) => ({ permissions: ["accept"], sliceId: m[1] }),
  ],
  [
    ["POST"],
    /^\/api\/slices\/([\w.-]+)\/extend$/,
    (m) => ({ permissions: ["scope.change"], sliceId: m[1] }),
  ],
  [
    ["POST"],
    /^\/api\/requirements\/([\w.-]+)\/(?:cut|revise)$/,
    (m) => ({ permissions: ["scope.change"], requirementId: m[1] }),
  ],
  [
    ["POST"],
    /^\/api\/requirements\/([\w.-]+)\/confirm$/,
    (m) => ({ permissions: ["accept"], requirementId: m[1] }),
  ],
  [
    ["POST"],
    /^\/api\/suggestions\/([\w.-]+)\/(?:apply|dismiss|undo)$/,
    (m) => ({ permissions: ["proposal.apply"], suggestionId: m[1] }),
  ],
  // PM_CONTRACT: the weekly update is posted by the project's lead or an Admin.
  [
    ["POST"],
    new RegExp(`^/api/projects/(${PROJ})/update$`),
    (m) => ({ permissions: ["project.update"], projectId: m[1] }),
  ],
  // Teams item 28, TEAM-28: the project lead sets its health.
  [
    ["POST"],
    new RegExp(`^/api/projects/(${PROJ})/health$`),
    (m) => ({ permissions: ["project.health"], projectId: m[1] }),
  ],
  // DB-N9-3: a release's target date, checked on the release's own project.
  [
    ["POST"],
    /^\/api\/slices\/([\w.-]+)\/target$/,
    (m) => ({ permissions: ["release.target"], sliceId: m[1] }),
  ],
  // Teams item 28, DB-N9-2: a release's lead, named on the release's own project.
  [
    ["POST"],
    /^\/api\/slices\/([\w.-]+)\/lead$/,
    (m) => ({ permissions: ["release.lead"], sliceId: m[1] }),
  ],
  // Teams item 6: brief acceptance is the project's Admin or lead; the body
  // names the project (checked to exist before it grounds a decision, below).
  [
    ["POST"],
    /^\/api\/brief\/accept$/,
    (_m, body) =>
      body === undefined
        ? { permissions: [], needsBody: true }
        : {
            permissions: ["brief.accept"],
            ...(typeof body.projectId === "string" ? { projectId: body.projectId } : {}),
          },
  ],
  // The Configuration page (B4.1, dashboard DB-N6-15): each change needs its
  // route's permission — `config.manage` (an Admin), review capacity `review.capacity`.
  ...CONFIG_ROUTES.filter((r) => r.method !== "GET").map((r): [string[], RegExp, Resolver] => [
    [r.method],
    new RegExp(`^${r.path.replace(/:[A-Za-z]+/g, "[^/]+")}$`),
    fixed(r.permission),
  ]),
];

const IDENTITY_ROUTES = /^\/api\/(session|setup|tokens|account|oidc|passkeys|invites)(\/|$)/;

/**
 * The permissions a request to the dashboard server needs, or `undefined`
 * for a read (or a route with no person behind it, such as the tracker's
 * signed webhook). `body` is the parsed JSON body once read.
 */
export function routePermissions(
  method: string,
  url: string,
  body: Record<string, unknown> | undefined,
): RouteRule | undefined {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return undefined;
  // Signing in, setup, invites and one's own tokens are the identity
  // module's to check (teams item 15: every level manages its own tokens).
  if (IDENTITY_ROUTES.test(url)) return undefined;
  for (const [methods, pattern, resolve] of ROUTES) {
    if (!methods.includes(method)) continue;
    const m = pattern.exec(url);
    if (m) return resolve(m, body);
  }
  // A write that reads as a Configuration path only once decoded and its
  // slashes collapsed (`/api//config/…`, `/api/config/%62enchmark`, a
  // trailing slash) is never served as one, and still needs the Admin's
  // permission, never a Member's fallback (B4.1 review: defence in depth).
  if (readsAsConfigPath(url)) return { permissions: ["config.manage"] };
  // Any other write under /api/ still needs a Member (never an open door).
  return url.startsWith("/api/") ? { permissions: ["issue.edit"] } : undefined;
}

/** Whether a path is under `/api/config` once decoded, lower-cased, its slashes collapsed and its dot segments resolved. */
function readsAsConfigPath(url: string): boolean {
  let path = url;
  try {
    path = decodeURIComponent(url);
  } catch {
    // A malformed escape: read the raw path.
  }
  // Dot segments resolve as a URL's do (`/api/./config`, `/api/x/../config`).
  const resolved = posix.normalize(path.toLowerCase().replace(/\/+/g, "/"));
  return /^\/api\/config(?:\/|$)/.test(resolved);
}
