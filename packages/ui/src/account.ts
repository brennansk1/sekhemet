/**
 * The Team setup's pages, their pure half (dashboard §2.2.6, §2.17 item 1;
 * teams §2.3; DB-N9-11, DB-N9-12, DB-N9-13): where a request lands, which
 * sign-in methods show, what a refusal says, the account menu's items, and
 * the pages' words. The browser imports the compiled module as
 * `/app/lib/account.js`, so it must stay free of runtime imports.
 */

/** `GET /api/session`, as the page reads it (teams §3). */
export interface SessionInfo {
  mode: "solo" | "team";
  signedIn: boolean;
  /** Team, signed out: no Admin exists yet, so the page is Set up Sekhemet (TEAM-2). */
  setupNeeded?: boolean;
  /** Team: the sign-in methods an Admin turned on (`[identity] sources`). */
  sources?: readonly string[];
  /** The company's name for the SSO button, when the server gives one. */
  company?: string;
  principal?: string;
  level?: string;
  via?: string;
  csrf?: string;
  name?: string;
  email?: string;
  /** Team: the person's profile label, which sets their default page (§2.2.5). */
  label?: string;
  /** Team: the person's own per-project levels and the projects they lead (DB-N9-17). */
  projects?: Record<string, { level?: string; lead?: boolean }>;
}

/** Every word the Sign in, setup, invite and account pages show. */
export const ACCOUNT_COPY = {
  signInTitle: "Sign in",
  signIn: "Sign in",
  signingIn: "Signing in…",
  email: "Email",
  password: "Password",
  passwordHint: "At least 15 characters.",
  passkey: "Sign in with a passkey",
  passkeyUnsupported: "This browser can't use passkeys. Sign in with your email and password.",
  passkeyCancelled: "The passkey sign-in was cancelled or timed out. Try again.",
  ssoDefault: "Continue with company SSO",
  or: "or",
  askForInvite: "Ask an admin for an invite link",
  footer: "Self-hosted · your code and data stay on this server",
  setupTitle: "Set up Sekhemet",
  setupLead:
    "You are the first person here, so you become its Admin. Paste the setup token from the file whose path the server console printed.",
  setupToken: "Setup token",
  name: "Your name",
  createAdmin: "Create the Admin account",
  inviteTitle: "You're invited",
  inviteLead: "Opening this link used nothing up. Choose a password to join.",
  inviteWorkspace: "Workspace",
  inviteLevel: "Access level",
  inviteProject: "Project",
  inviteFrom: "Invited by",
  inviteExpires: "Expires",
  acceptInvite: "Accept invite",
  inviteGone: "This invite can't be used. Ask an admin for a new invite link.",
  signInToContinue: "Sign in to continue.",
  csrf: "Your session could not be confirmed. Reload the page, or sign in again.",
  pending: "Pending until an Admin approves it.",
  unreachable: "The Sekhemet server can't be reached. Check that it is running, then try again.",
  thisComputer: "This computer",
  account: "Account",
  profile: "Profile",
  notifications: "Notifications",
  shortcuts: "Keyboard shortcuts",
  theme: "Theme",
  themeSystem: "System",
  themeLight: "Light",
  themeDark: "Dark",
  members: "Members",
  audit: "Audit",
  switchWorkspace: "Switch workspace",
  signOut: "Sign out",
  signedOut: "Signed out.",
  profileTitle: "Profile",
  level: "Access level",
  signedInWith: "Signed in with",
  tokensTitle: "Personal access tokens",
  tokensLead:
    "For the CLI and MCP clients. A token acts at the lower of its level and yours, and is shown once.",
  tokenName: "Token name",
  tokenLevel: "Level",
  tokenExpires: "Expires in",
  expires: "Expires",
  createToken: "Create token",
  tokenShownOnce: "Copy this token now. It is shown once and can't be shown again.",
  copy: "Copy",
  copied: "Copied",
  revoke: "Revoke",
  revoked: "Token revoked.",
  noTokens: "No tokens yet.",
  tokensNotListed:
    "This server does not list earlier tokens yet; the ones created in this visit are below.",
  sessionsTitle: "Sessions",
  sessionsLead: "Sessions end after an hour idle and 24 hours in total.",
  thisSession: "This browser",
  sessionsNotListed: "This server lists only this browser's session.",
  signedInWithSession: "A session in this browser",
  signedInWithToken: "A personal access token",
  signedInWithProxy: "Your company's sign-in proxy",
  soloProfile:
    "Solo has one person and no sign-in: everything here is yours. Accounts, tokens and sessions come with the Team setup.",
} as const;

const LEVEL_LABELS: Record<string, string> = {
  viewer: "Viewer",
  stakeholder: "Stakeholder",
  member: "Member",
  admin: "Admin",
};

/** A level as a word (teams item 6); nothing for an unknown one. */
export function levelLabel(level: string | undefined): string {
  return (level && LEVEL_LABELS[level]) || "";
}

/** The levels a token may carry, lowest first, up to `top`. */
export function levelsUpTo(top: string | undefined): string[] {
  const order = Object.keys(LEVEL_LABELS);
  const i = top ? order.indexOf(top) : -1;
  return i < 0 ? [] : order.slice(0, i + 1);
}

/** The initials avatar: first and last word of the name. */
export function initials(name: string | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** The pages reached before signing in (and the invite, reached either way). */
export type AuthPage = { name: "signin" } | { name: "setup" } | { name: "invite"; id: string };

export type AuthDecision =
  | { kind: "app" }
  | { kind: "redirect"; to: string }
  | { kind: "page"; page: AuthPage; next?: string };

const AUTH_ROUTES = new Set(["signin", "setup", "invite"]);

function routeParts(hash: string): string[] {
  return hash
    .replace(/^#\/?/, "")
    .split("/")
    .filter(Boolean)
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
}

/** A route to go on to after signing in: an app route, never an auth page or another origin. */
export function safeNext(hash: string | undefined): string {
  if (!hash || !/^#\/[^/]/.test(hash)) return "#/";
  const first = routeParts(hash)[0] ?? "";
  return AUTH_ROUTES.has(first) ? "#/" : hash;
}

/**
 * Where a page lands (DB-N9-12; teams items 1, 2, 10). Solo shows no sign-in
 * page. In the Team setup, signed out, every app route shows Sign in (or Set
 * up Sekhemet while no Admin exists) and remembers where it was going; an
 * invite link shows the invite either way.
 */
export function authDecision(session: SessionInfo, hash: string): AuthDecision {
  const [first = "", id = ""] = routeParts(hash);
  if (first === "invite" && id && session.mode === "team") {
    return { kind: "page", page: { name: "invite", id } };
  }
  if (session.mode !== "team") {
    return AUTH_ROUTES.has(first) ? { kind: "redirect", to: "#/" } : { kind: "app" };
  }
  if (session.signedIn) {
    return AUTH_ROUTES.has(first) ? { kind: "redirect", to: "#/" } : { kind: "app" };
  }
  const page: AuthPage = session.setupNeeded ? { name: "setup" } : { name: "signin" };
  const next = first && !AUTH_ROUTES.has(first) ? hash : undefined;
  return next ? { kind: "page", page, next } : { kind: "page", page };
}

export interface SignInMethods {
  password: boolean;
  passkey: boolean;
  sso: boolean;
  ssoLabel: string;
}

/** The methods Sign in shows: each only when an Admin turned it on (DB-N9-13, DEC-38). */
export function signInMethods(session: SessionInfo): SignInMethods {
  const sources = session.sources ?? ["accounts"];
  return {
    password: sources.includes("accounts"),
    passkey: sources.includes("passkeys"),
    sso: sources.includes("oidc"),
    ssoLabel: session.company ? `Sign in with ${session.company}` : ACCOUNT_COPY.ssoDefault,
  };
}

/**
 * What a refusal says (teams TEAM-4): the server's own sentence, which names
 * the missing permission and who can grant it; written from its parts when
 * the server sent none.
 */
export function refusalMessage(status: number, body: unknown): string {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const error = typeof b.error === "string" ? b.error : "";
  if (status === 0) return ACCOUNT_COPY.unreachable;
  if (status === 403 && error === "csrf") return ACCOUNT_COPY.csrf;
  if (status === 403 && b.pending === true) return ACCOUNT_COPY.pending;
  if (error) return error;
  if (status === 403 && typeof b.needs === "string") {
    const who = typeof b.grantedBy === "string" && b.grantedBy ? b.grantedBy : "An Admin";
    return `This needs the ${levelLabel(b.needs) || b.needs} level. ${who} can grant it.`;
  }
  if (status === 401) return ACCOUNT_COPY.signInToContinue;
  return `The server answered ${status}.`;
}

/** The account menu's header (§2.2.6): the name, then the email (Solo: *This computer*). */
export function accountHeader(session: SessionInfo): {
  name: string;
  detail: string;
  level?: string;
} {
  const name = session.name || session.principal || "You";
  if (session.mode !== "team") return { name, detail: ACCOUNT_COPY.thisComputer };
  const level = levelLabel(session.level);
  return { name, detail: session.email || level, level };
}

export interface AccountMenuItem {
  id:
    | "profile"
    | "notifications"
    | "shortcuts"
    | "theme"
    | "members"
    | "audit"
    | "switch"
    | "signout";
  label: string;
  /** The page it opens, for the items that are pages. */
  route?: string;
}

/**
 * The account menu's items, in order (§2.2.6, DB-N9-11). `pages` are the
 * account pages this build has: a page not built is never linked. Solo shows
 * no Members, Audit, Switch workspace or Sign out (DB-N9-12); Audit is for
 * an Admin.
 */
export function accountMenu(session: SessionInfo, pages: ReadonlySet<string>): AccountMenuItem[] {
  const team = session.mode === "team";
  const out: AccountMenuItem[] = [
    { id: "profile", label: ACCOUNT_COPY.profile, route: "#/account/profile" },
  ];
  if (pages.has("notifications"))
    out.push({
      id: "notifications",
      label: ACCOUNT_COPY.notifications,
      route: "#/account/notifications",
    });
  out.push({ id: "shortcuts", label: ACCOUNT_COPY.shortcuts });
  out.push({ id: "theme", label: ACCOUNT_COPY.theme });
  if (team) {
    if (pages.has("members"))
      out.push({ id: "members", label: ACCOUNT_COPY.members, route: "#/members" });
    if (pages.has("audit") && session.level === "admin")
      out.push({ id: "audit", label: ACCOUNT_COPY.audit, route: "#/audit" });
    if (pages.has("switch")) out.push({ id: "switch", label: ACCOUNT_COPY.switchWorkspace });
    out.push({ id: "signout", label: ACCOUNT_COPY.signOut });
  }
  return out;
}

export type ThemeChoice = "system" | "light" | "dark";

/** The saved theme as the menu's choice: Sand is Light, Basalt Dark, nothing System. */
export function themeChoice(saved: string | null | undefined): ThemeChoice {
  return saved === "sand" ? "light" : saved === "basalt" ? "dark" : "system";
}

/** The theme to paint: System follows `prefers-color-scheme`. */
export function themeFor(choice: ThemeChoice, prefersLight: boolean): "sand" | "basalt" {
  if (choice === "light") return "sand";
  if (choice === "dark") return "basalt";
  return prefersLight ? "sand" : "basalt";
}

/** A token's expiry choices, up to the server's maximum, the default selected (teams item 15). */
export function tokenExpiryOptions(
  maxDays = 365,
  defaultDays = 90,
): { days: number; label: string; selected: boolean }[] {
  return [7, 30, 90, 365]
    .filter((d) => d <= maxDays)
    .map((days) => ({
      days,
      label: days === 365 ? "1 year" : `${days} days`,
      selected: days === defaultDays,
    }));
}
