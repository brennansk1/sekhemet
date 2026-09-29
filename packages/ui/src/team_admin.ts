/**
 * The Team setup's Admin pages and the level notes, their pure half (teams
 * NEW-teams-10, items 6–10, 27; dashboard §2.2.7, §2.17 items 4–5; DB-N9-16,
 * DB-N9-17; TEAM-27). Members reads like GitHub's and Linear's member
 * tables — the person, their access level, per-project overrides, profile
 * label and last active, with the Admin's actions per row — and Audit like
 * Atlassian's and GitHub's audit log: time, actor, action and target,
 * filtered by person, action and project, exported as CSV or JSON. The
 * server sends facts; every word a person reads is here, so the page and the
 * export agree. The browser imports the compiled module as
 * `/app/lib/team_admin.js`, so it must stay free of runtime imports.
 */

export type AccessLevel = "viewer" | "stakeholder" | "member" | "admin";

const LEVEL_WORD: Record<AccessLevel, string> = {
  viewer: "Viewer",
  stakeholder: "Stakeholder",
  member: "Member",
  admin: "Admin",
};
const LEVEL_ORDER: readonly AccessLevel[] = ["viewer", "stakeholder", "member", "admin"];

const isAccessLevel = (v: unknown): v is AccessLevel =>
  typeof v === "string" && (LEVEL_ORDER as readonly string[]).includes(v);

/** An access level as a word (DEC-35); "" for none. */
export function accessLevelWord(level: string | undefined | null): string {
  return isAccessLevel(level) ? LEVEL_WORD[level] : "";
}

/* ---------- The action table, as the page reads it (DB-N9-17) ---------- */

/** One row of teams item 6's table: the lowest level that may, and who else. */
export interface ControlRule {
  level: AccessLevel;
  /** The project's lead may too; `only`, the project's lead alone (health, item 28). */
  lead?: true | "only";
  /** Held by the people the project's Accept rule names (`only`), or the level or being named (`or`). */
  acceptRule?: "only" | "or";
  /** What the person tried, as the note says it: "A Member can <does>." */
  does: string;
}

/**
 * Teams item 6's action table, the same rows as the server's `ACTIONS`
 * (`apps/harness/src/team/access.ts`; a test holds the two equal). The page
 * disables a control from it and the server still refuses, so a stale page
 * can never do more than the server allows.
 */
export const CONTROL_RULES = {
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
  "project.update": { level: "admin", lead: true, does: "post this project's update" },
  "project.health": { level: "member", lead: "only", does: "set this project's health" },
  "release.target": { level: "admin", lead: true, does: "set a release's target date" },
  "brief.accept": { level: "admin", lead: true, does: "accept a brief" },
} as const satisfies Record<string, ControlRule>;

export type ControlPermission = keyof typeof CONTROL_RULES;

/** Who the page is, as `GET /api/session` tells it (teams §3). */
export interface ViewerAccess {
  mode: "solo" | "team";
  level?: string | undefined;
  /** The person's own per-project levels and the projects they lead. */
  projects?: Record<string, { level?: string; lead?: boolean }> | undefined;
}

/**
 * The note beside a control the viewer's level does not allow (DB-N9-17;
 * dashboard §2.2.7): the level they hold and one that can do it, in the
 * server's own sentence (*You're a Stakeholder on Chronicle. A Member can
 * start the Agent on this issue.*). Undefined when the control is allowed —
 * always in Solo, whose one person is Admin. A permission held by the
 * Accept rule's people is disabled here only below Member: whether the rule
 * names the viewer is the review desk's to say.
 */
export function levelNote(
  viewer: ViewerAccess,
  permission: string,
  where: { project?: string | undefined; projectName?: string | undefined } = {},
): string | undefined {
  if (viewer.mode !== "team") return undefined;
  const rule = (CONTROL_RULES as Record<string, ControlRule>)[permission];
  if (!rule) return undefined;
  const own = where.project ? viewer.projects?.[where.project] : undefined;
  const level = isAccessLevel(own?.level)
    ? own.level
    : isAccessLevel(viewer.level)
      ? viewer.level
      : undefined;
  const place = where.projectName
    ? `on ${where.projectName}`
    : where.project
      ? "on this project"
      : "in this workspace";
  if (!level) return `You're not a member of this workspace. An Admin can invite you.`;
  const rank = LEVEL_ORDER.indexOf(level);
  const article = (l: AccessLevel) => (l === "admin" ? "an" : "a");
  if (rule.lead === "only") {
    if (own?.lead && rank >= LEVEL_ORDER.indexOf("member")) return undefined;
    return `You're ${article(level)} ${LEVEL_WORD[level]} ${place}. The project lead can ${rule.does}.`;
  }
  const needs = rule.acceptRule === "only" ? "member" : rule.level;
  if (rank >= LEVEL_ORDER.indexOf(needs)) return undefined;
  if (rule.lead && own?.lead && rank >= LEVEL_ORDER.indexOf("member")) return undefined;
  const who =
    rule.acceptRule === "only"
      ? "A Member this project's Accept rule names"
      : `${article(rule.level) === "an" ? "An" : "A"} ${LEVEL_WORD[rule.level]}${rule.lead ? " or the project lead" : ""}`;
  return `You're ${article(level)} ${LEVEL_WORD[level]} ${place}. ${who} can ${rule.does}.`;
}

/* ---------- Members (DB-N9-16) ---------- */

export const MEMBERS_COPY = {
  title: "Members",
  lead: "Everyone in this workspace, their access level and what they last did.",
  readOnly: "Only an Admin can invite people or change levels.",
  person: "Person",
  level: "Access level",
  overrides: "Project overrides",
  label: "Profile label",
  lastActive: "Last active",
  actions: "Actions",
  invite: "Invite",
  inviteTitle: "Invite people",
  inviteLevel: "Access level",
  inviteProject: "Project",
  inviteNoProject: "Whole workspace",
  inviteEmail: "Email (optional)",
  inviteDays: "Expires in",
  createInvite: "Create invite link",
  inviteOnce: "Copy this invite link now. It works once, until it expires, and is shown only here.",
  copy: "Copy",
  copied: "Copied",
  changeLevel: "Change level",
  override: "Override for a project",
  overrideProject: "Project",
  overrideLevel: "Level on that project",
  save: "Save",
  cancel: "Cancel",
  changeLabel: "Change label",
  noLabel: "No label",
  resetPassword: "Reset password",
  resetOnce: "Send this password reset link to them. It works once and is shown only here.",
  unlock: "Unlock",
  remove: "Remove",
  removeConfirm: (name: string) =>
    `Remove ${name} from this workspace? Their sessions and tokens end now.`,
  approve: "Approve",
  decline: "Decline",
  pending: "Pending until an Admin approves it.",
  locked: "Locked",
  you: "You",
  activeNow: "Active now",
  never: "Not yet",
  none: "None",
  empty: "No one has joined yet. Invite people to start working together.",
} as const;

/** The profile labels teams item 8 names; an Admin may add another. */
export const PROFILE_LABELS: readonly string[] = [
  "Product owner",
  "Project manager",
  "Developer",
  "Reviewer",
  "Researcher",
  "Designer",
];

/** One member as `GET /api/members` sends it. */
export interface MemberFacts {
  principal: string;
  level: string;
  pending?: boolean;
  name?: string;
  email?: string;
  label?: string;
  /** Per-project levels, by project id. */
  projects?: Record<string, string>;
  /** The last thing this person did, from the event log. */
  lastActive?: string;
  /** Active in the last five minutes (in memory, never recorded). */
  active?: boolean;
  locked?: boolean;
}

export interface MemberRow {
  principal: string;
  name: string;
  initials: string;
  email: string;
  level: string;
  levelWord: string;
  overrides: { project: string; projectName: string; level: string; levelWord: string }[];
  label: string;
  lastActive: string;
  active: boolean;
  pending: boolean;
  locked: boolean;
  you: boolean;
  /** The row's actions: an Admin's, none for anyone else (DB-N9-16). */
  actions: (
    | "level"
    | "override"
    | "label"
    | "reset"
    | "unlock"
    | "remove"
    | "approve"
    | "decline"
  )[];
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** "Active now", "5 minutes ago", "3 hours ago", "2 days ago", or the date. */
export function lastActiveText(iso: string | undefined, now: number, active = false): string {
  if (active) return MEMBERS_COPY.activeNow;
  if (!iso) return MEMBERS_COPY.never;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return MEMBERS_COPY.never;
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * The Members table (DB-N9-16): pending people first, then by level (Admins
 * first) and name. An Admin sees each row's actions — never on their own
 * row's level or removal, so the last Admin is not lowered from here — and
 * anyone else the same table read-only.
 */
export function memberRows(
  members: readonly MemberFacts[],
  ctx: { admin: boolean; me?: string; projectNames?: Record<string, string>; now: number },
): MemberRow[] {
  const rank = (m: MemberFacts) => (isAccessLevel(m.level) ? LEVEL_ORDER.indexOf(m.level) : -1);
  const sorted = [...members].sort(
    (a, b) =>
      Number(b.pending === true) - Number(a.pending === true) ||
      rank(b) - rank(a) ||
      (a.name ?? a.principal).localeCompare(b.name ?? b.principal),
  );
  return sorted.map((m) => {
    const name = m.name || m.principal;
    const you = m.principal === ctx.me;
    const actions: MemberRow["actions"] = [];
    if (ctx.admin) {
      if (m.pending) actions.push("approve", "decline");
      else {
        if (!you) actions.push("level");
        actions.push("override", "label");
        if (!you) actions.push("reset");
        if (m.locked) actions.push("unlock");
        if (!you) actions.push("remove");
      }
    }
    return {
      principal: m.principal,
      name,
      initials: initialsOf(name),
      email: m.email ?? "",
      level: m.level,
      levelWord: accessLevelWord(m.level),
      overrides: Object.entries(m.projects ?? {})
        .map(([project, level]) => ({
          project,
          projectName: ctx.projectNames?.[project] ?? project,
          level,
          levelWord: accessLevelWord(level),
        }))
        .sort((a, b) => a.projectName.localeCompare(b.projectName)),
      label: m.label ?? "",
      lastActive: lastActiveText(m.lastActive, ctx.now, m.active === true),
      active: m.active === true,
      pending: m.pending === true,
      locked: m.locked === true,
      you,
      actions,
    };
  });
}

/* ---------- Audit (TEAM-27) ---------- */

export type AuditCategory =
  | "sign_in"
  | "refusal"
  | "lock"
  | "level"
  | "invite"
  | "token"
  | "password"
  | "model"
  | "configuration";

/** The audit log's actions, by kind, in teams item 27's order; each lists the events it reads. */
export const AUDIT_CATEGORIES: readonly {
  id: AuditCategory;
  label: string;
  types: readonly string[];
}[] = [
  { id: "sign_in", label: "Sign-ins", types: ["session/started", "session/ended"] },
  { id: "refusal", label: "Refusals", types: ["session/refused", "access/refused"] },
  { id: "lock", label: "Locks", types: ["account/locked", "account/unlocked"] },
  {
    id: "level",
    label: "Members and levels",
    types: [
      "member/joined",
      "member/approved",
      "member/level_changed",
      "member/label_changed",
      "member/removed",
    ],
  },
  { id: "invite", label: "Invites", types: ["member/invited"] },
  { id: "token", label: "Tokens", types: ["token/created", "token/used", "token/revoked"] },
  {
    id: "password",
    label: "Passwords and passkeys",
    types: ["password/reset_issued", "password/changed", "passkey/registered"],
  },
  {
    id: "model",
    label: "Models",
    types: [
      "models/assigned",
      "models/restored",
      "models/folder_added",
      "models/folder_removed",
      "model/downloaded",
      "model/copied",
    ],
  },
  {
    id: "configuration",
    label: "Configuration",
    types: [
      "config/changed_outside",
      "config/changed",
      "project/settings_changed",
      "setup/switched",
    ],
  },
];

/** Every event type the audit log reads. */
export const AUDIT_TYPES: readonly string[] = AUDIT_CATEGORIES.flatMap((c) => c.types);

export function auditCategoryOf(type: string): AuditCategory | undefined {
  return AUDIT_CATEGORIES.find((c) => c.types.includes(type))?.id;
}

export const AUDIT_COPY = {
  title: "Audit",
  lead: "Every sign-in, refusal, lock, level change, invite, token, password reset, model change and configuration change, read from the event log.",
  refused: "Only an Admin can open the audit log.",
  time: "Time",
  actor: "Actor",
  action: "Action",
  target: "Target",
  person: "Person",
  anyPerson: "Anyone",
  kind: "Action",
  anyKind: "All actions",
  project: "Project",
  anyProject: "All projects",
  exportCsv: "Export CSV",
  exportJson: "Export JSON",
  more: "Show older entries",
  empty: "Nothing in the audit log matches these filters.",
  onBehalfOf: (name: string) => `on behalf of ${name}`,
  sekhemet: "Sekhemet",
  ai: "AI",
} as const;

const SESSION_ENDED: Record<string, string> = {
  signed_out: "Signed out",
  idle: "Session ended: idle",
  expired: "Session ended: expired",
  removed: "Session ended: removed",
  level_lowered: "Session ended: level lowered",
  password_reset: "Session ended: password reset",
  password_changed: "Session ended: password changed",
  revoked: "Session ended by its owner",
};

const REFUSED_REASON: Record<string, string> = {
  bad_credentials: "wrong password",
  unknown_account: "unknown account",
  bad_setup_token: "wrong setup token",
  bad_invite: "invite not valid",
  bad_reset_link: "reset link not valid",
};

const METHOD: Record<string, string> = {
  password: "password",
  passkey: "passkey",
  oidc: "company SSO",
  setup: "setup token",
  invite: "invite",
};

type Payload = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A model role as DEC-31 names it; the internal role ids stay in code. */
const ROLE_WORD: Record<string, string> = {
  worker: "Coding model",
  executor: "Coding model",
  planner: "Planning model",
  manager: "Planning model",
  reviewer: "Review model",
  researcher: "Research model",
};
const roleWord = (role: unknown) => ROLE_WORD[str(role)] ?? str(role);

/** What happened, in words (the Action column and the export's). */
export function auditAction(type: string, p: Payload): string {
  switch (type) {
    case "session/started":
      return METHOD[str(p.method)] ? `Signed in with ${METHOD[str(p.method)]}` : "Signed in";
    case "session/ended":
      return SESSION_ENDED[str(p.reason)] ?? "Session ended";
    case "session/refused": {
      const n = typeof p.count === "number" ? p.count : 1;
      const why = REFUSED_REASON[str(p.reason)];
      return `Sign-in refused ${n} time${n === 1 ? "" : "s"}${why ? `: ${why}` : ""}`;
    }
    case "access/refused":
      return `Refused: needs ${accessLevelWord(str(p.needs)) || "a higher level"}`;
    case "account/locked":
      return "Account locked";
    case "account/unlocked":
      return "Account unlocked";
    case "member/joined":
      return p.pending === true
        ? "Joined, pending approval"
        : `Joined as ${accessLevelWord(str(p.level))}`;
    case "member/approved":
      return "Approved";
    case "member/level_changed":
      return `Level changed to ${accessLevelWord(str(p.level))}`;
    case "member/label_changed":
      return str(p.label) ? `Profile label set to ${str(p.label)}` : "Profile label cleared";
    case "member/removed":
      return "Removed from the workspace";
    case "member/invited":
      return `Invited as ${accessLevelWord(str(p.level))}`;
    case "token/created":
      return `Personal access token created at ${accessLevelWord(str(p.level))}`;
    case "token/used":
      return "Personal access token used";
    case "token/revoked":
      return p.reason === "member_removed"
        ? "Personal access token revoked: member removed"
        : "Personal access token revoked";
    case "password/reset_issued":
      return "Password reset issued";
    case "password/changed":
      return "Password changed";
    case "passkey/registered":
      return "Passkey added";
    case "models/assigned":
      return `${roleWord(p.role)} set to ${str(p.model)}`;
    case "models/restored":
      return `${roleWord(p.role)} restored to ${str(p.model)}`;
    case "models/folder_added":
      return "Model folder added";
    case "models/folder_removed":
      return "Model folder removed";
    case "model/downloaded":
      return "Model downloaded";
    case "model/copied":
      return "Model copied";
    case "config/changed_outside":
      return "Configuration changed outside Sekhemet";
    case "config/changed":
      return "Configuration changed";
    case "project/settings_changed":
      return "Project settings changed";
    case "setup/switched":
      return `Switched to ${str(p.to) === "solo" ? "Solo" : "Team"}`;
    default:
      return type;
  }
}

/** One audit entry as the server sends it and the page and the export read it. */
export interface AuditEntry {
  seq: number;
  at: string;
  type: string;
  category: AuditCategory;
  action: string;
  actor: {
    principal?: string;
    name: string;
    /** An AI teammate, shown with its AI badge (DEC-36). */
    ai?: boolean;
    onBehalfOf?: { principal: string; name: string };
  };
  target: string;
  targetPrincipal?: string;
  project?: string;
}

/** The names the entries use: people and projects, by id. */
export interface AuditNames {
  person(principal: string): string | undefined;
  project(id: string): string | undefined;
}

const AI_ACTORS: Record<string, string> = {
  planner: "Seshat",
  manager: "Seshat",
  executor: "Agent",
  worker: "Agent",
};

/**
 * One ledger row as an audit entry. It reads the row's public payload only —
 * never a private part — so no email, token name, address or free text
 * reaches the audit log or its export; a configuration change names its
 * keys, never their values (TEAM-44).
 */
export function auditEntry(
  row: {
    seq: number;
    at: string;
    type: string;
    actor: string;
    principal?: string | null;
    onBehalfOf?: string | null;
    cardProject?: string | null;
    payload: Payload;
  },
  names: AuditNames,
): AuditEntry | undefined {
  const category = auditCategoryOf(row.type);
  if (!category) return undefined;
  const p = row.payload;
  const person = (id: string) => names.person(id) ?? id;
  const ai = AI_ACTORS[row.actor];
  const actor: AuditEntry["actor"] = ai
    ? {
        name: ai,
        ai: true,
        ...(row.onBehalfOf
          ? { onBehalfOf: { principal: row.onBehalfOf, name: person(row.onBehalfOf) } }
          : {}),
      }
    : row.principal
      ? { principal: row.principal, name: person(row.principal) }
      : { name: AUDIT_COPY.sekhemet };
  const project = str(p.project) || row.cardProject || undefined;
  const projectName = project ? (names.project(project) ?? project) : "";
  const targetPrincipal = str(p.principal) || undefined;
  let target = "";
  if (row.type === "config/changed_outside" || row.type === "config/changed") {
    target = Array.isArray(p.keys) ? p.keys.filter((k) => typeof k === "string").join(", ") : "";
  } else if (row.type === "project/settings_changed") {
    const fields = Object.keys(p).filter((k) => k !== "project");
    target = `${projectName}${fields.length ? ` (${fields.join(", ")})` : ""}`;
  } else if (row.type === "access/refused") {
    target = `${str(p.permission)}${projectName ? ` on ${projectName}` : ""}`;
  } else if (targetPrincipal) {
    target = `${person(targetPrincipal)}${projectName ? ` on ${projectName}` : ""}`;
  } else if (row.type.startsWith("token/")) {
    target = `Token ${str(p.token)}`;
  } else if (row.type === "member/invited") {
    target = `Invite ${str(p.invite)}${projectName ? ` to ${projectName}` : ""}`;
  } else if (row.type.startsWith("session/")) {
    target = row.principal ? person(row.principal) : "";
  } else if (row.type.startsWith("model")) {
    target = str(p.model) || roleWord(p.role);
  } else if (projectName) {
    target = projectName;
  }
  return {
    seq: row.seq,
    at: row.at,
    type: row.type,
    category,
    action: auditAction(row.type, p),
    actor,
    target,
    ...(targetPrincipal ? { targetPrincipal } : {}),
    ...(project ? { project } : {}),
  };
}

/** The actor as one phrase: "Agent (AI) on behalf of Mo Member", "Ada Admin", "Sekhemet". */
export function auditActorText(a: AuditEntry["actor"]): string {
  const base = a.ai ? `${a.name} (${AUDIT_COPY.ai})` : a.name;
  return a.onBehalfOf ? `${base} ${AUDIT_COPY.onBehalfOf(a.onBehalfOf.name)}` : base;
}

const csvCell = (v: string) => {
  // A cell a spreadsheet would read as a formula starts with a quote (OWASP CSV injection).
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The export as CSV: time, actor, on behalf of, action, target, project, event. */
export function auditCsv(entries: readonly AuditEntry[]): string {
  const head = ["time", "actor", "on_behalf_of", "action", "target", "project", "event", "seq"];
  const lines = entries.map((e) =>
    [
      e.at,
      e.actor.ai ? `${e.actor.name} (${AUDIT_COPY.ai})` : e.actor.name,
      e.actor.onBehalfOf?.name ?? "",
      e.action,
      e.target,
      e.project ?? "",
      e.type,
      String(e.seq),
    ]
      .map(csvCell)
      .join(","),
  );
  return `${[head.join(","), ...lines].join("\r\n")}\r\n`;
}
