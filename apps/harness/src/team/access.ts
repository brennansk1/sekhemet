import type { ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { EventLog } from "@sekhemet/kernel";
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
  /** The project's lead may too (item 6's "an Admin or the project lead"). */
  lead?: true;
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
  "gates.run": { level: "member", does: "run the gates" },
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
}

export interface TeamProjection {
  members: Map<string, MemberRecord>;
  projects: Map<string, ProjectSettings>;
}

const ACCESS_TYPES = ["member/level_changed", "member/label_changed", "project/settings_changed"];

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
  const rows = db
    .prepare(
      `SELECT type, payload FROM events WHERE type IN (${ACCESS_TYPES.map(() => "?").join(",")}) ORDER BY seq`,
    )
    .all(...ACCESS_TYPES) as { type: string; payload: string }[];
  for (const row of rows) {
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    if (row.type === "project/settings_changed") {
      const id = typeof p.project === "string" ? p.project : undefined;
      if (!id) continue;
      const current = projects.get(id) ?? {};
      const { project: _project, ...changes } = p;
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
  return { members, projects };
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
      rule.lead === true && project !== undefined && member && this.isLead(principal, project);
    const accept = rule.acceptRule ? this.acceptRule(project) : undefined;
    // Named by the Accept rule, and acting at Member or above (item 7).
    const named = member && (accept?.holders ?? []).includes(principal);
    let allowed: boolean;
    if (rule.acceptRule === "only") {
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
    const grantedBy =
      rule.acceptRule === "only"
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
      message: unset ?? `${who} ${grantedBy} can ${rule.does}.`,
    };
  }

  /** Who accepts while no rule is set (DEC-42): the lead by name, or "an Admin". */
  private defaultAccepter(holders: string[], source: string | undefined): string {
    if (source === "lead" && holders[0]) {
      return personName(this.options.db, holders[0]) ?? "the project lead";
    }
    return "an Admin";
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
  if (Object.keys(out).length === 0) {
    throw new Error("Nothing to change: accept_rule, require_resolved_threads, lead or auto_apply");
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
    new RegExp(`^/api/cards/(${CARD})/(return|park|reject|opened)$`),
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
  [["POST"], new RegExp(`^/api/cards/(${CARD})/reorder$`), fixed("priority.change", "card")],
  [
    ["POST", "PATCH"],
    new RegExp(`^/api/cards/(${CARD})/split$`),
    withGateChecks(fixed("scope.change", "card")),
  ],
  [["POST", "PATCH"], new RegExp(`^/api/cards/(${CARD})/gate$`), fixed("gates.run", "card")],
  [["POST"], new RegExp(`^/api/cards/(${CARD})/attachments$`), fixed("issue.file", "card")],
  [
    ["PATCH"],
    new RegExp(`^/api/cards/(${CARD})$`),
    withGateChecks((m, body) =>
      body === undefined
        ? { permissions: [], cardId: m[1], needsBody: true }
        : {
            permissions: [
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
  [["POST"], /^\/api\/pm\/proposals\/[A-Za-z0-9_-]+\/(apply|discard)$/, fixed("proposal.apply")],
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
    /^\/api\/members(?:\/p_[0-9a-z]+\/(unlock|password-reset))?$/,
    fixed("members.manage"),
  ],
  [["POST"], /^\/api\/projects$/, fixed("project.create")],
  // Gates rule 31 (GT-N4-1): a new visual baseline is a person's approval.
  [["POST"], /^\/api\/visual\/baselines\/[\w.-]+\/approve$/, fixed("accept")],
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
  // Any other write under /api/ still needs a Member (never an open door).
  return url.startsWith("/api/") ? { permissions: ["issue.edit"] } : undefined;
}
