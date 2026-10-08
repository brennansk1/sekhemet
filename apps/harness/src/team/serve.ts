import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { EventLog } from "@sekhemet/kernel";
import { type SekhemetConfig, resolveConfig, userConfigError, userConfigPath } from "../config.js";
import { type TeamEnginesReport, teamEnginesMonitor } from "../team_engines.js";
import {
  CREDENTIALS_FILE,
  identityDir,
  identityRoot,
  workspaceIdentityDir,
} from "./credential_store.js";
import { Identity } from "./identity.js";
import { Sso } from "./oidc.js";
import { Passkeys } from "./passkeys.js";
import { passwordListPresent } from "./passwords.js";
import { type IdentitySettings, identitySettings } from "./settings.js";

/**
 * The identity a server runs with (teams §2.1, §2.3): settings from the
 * user config, the credential store in the install's own directory
 * (`~/.sekhemet/identity/<workspace id>/`, which the sandbox denies, security
 * items 10 and 35a), and
 * passkeys and OIDC when an Admin turned them on.
 */
export { identityDir };

export interface ServerIdentityOptions {
  settings?: IdentitySettings;
  /** The credential store's directory; `<user dir>/identity` by default. */
  dir?: string;
  now?: () => number;
  passwordList?: string;
  /**
   * The Team server's engine check (models rule 26a, MD-N15-3). A server
   * whose settings come from the user config — the one `sekhemet serve`
   * starts — checks the shipped engines at start and on Configuration ›
   * Models; one composed with its own settings checks only what it names here.
   */
  teamEngines?: () => Promise<TeamEnginesReport>;
}

export function settingsFromConfig(config: SekhemetConfig): IdentitySettings {
  return identitySettings({
    mode: config.team.mode,
    workspace: config.team.workspace,
    sources: config.identity.sources,
    userHeader: config.identity.userHeader,
    trustedProxies: config.identity.trustedProxies,
    openSignupDomains: config.identity.openSignupDomains,
    inviteTtlDays: config.identity.inviteTtlDays,
    ...(config.identity.publicUrl ? { publicUrl: config.identity.publicUrl } : {}),
    idleMinutes: config.sessions.idleMinutes,
    absoluteHours: config.sessions.absoluteHours,
    tokenDefaultDays: config.tokens.defaultDays,
    tokenMaxDays: config.tokens.maxDays,
    ...(config.identity.oidc ? { oidc: config.identity.oidc } : {}),
  });
}

/** The identity settings of the user config; an unreadable one is an error, never Solo (M6). */
export function serverSettings(repoPath: string): IdentitySettings {
  const problem = userConfigError();
  if (problem) throw new Error(problem);
  return settingsFromConfig(resolveConfig({ repoPath }).config);
}

/**
 * Why this install must not start in Solo (teams M6), or undefined when it
 * may: once the ledger has a member or the credential store exists, Solo —
 * which answers every request as the install's person at Admin — starts only
 * after a switch back recorded later than the last member joined.
 */
/**
 * The workspace's credential store (security item 35a, NEW-security-14):
 * `<user dir>/identity/<workspace id>/`. A ledger with no event yet has no
 * workspace id — no server serves one, `openLocalLedger` records the
 * install's person first — and keeps the old place until it has one, from
 * where the store moves on the next start (SEC-N14-2).
 */
function storeDirOf(db: DatabaseSync): string {
  return workspaceIdentityDir(db) ?? identityRoot();
}

export function soloStartBlocked(
  db: DatabaseSync,
  dir: string | undefined = workspaceIdentityDir(db),
): string | undefined {
  const member = db
    .prepare("SELECT MAX(seq) AS seq FROM events WHERE type = 'member/joined'")
    .get() as { seq: number | null };
  const store =
    dir !== undefined &&
    (existsSync(join(dir, CREDENTIALS_FILE)) || existsSync(join(dir, "setup-token")));
  if (member.seq === null && !store) return undefined;
  const switched = db
    .prepare(
      "SELECT seq, json_extract(payload, '$.to') AS target FROM events WHERE type = 'setup/switched' ORDER BY seq DESC LIMIT 1",
    )
    .get() as { seq: number; target: string } | undefined;
  if (switched?.target === "solo" && switched.seq > (member.seq ?? 0)) return undefined;
  return `This install has Team members or a credential store, so it will not start in Solo, which would give every request an Admin's access. Set [team] mode = "team" in ${userConfigPath()}, or record the switch back with \`sekhemet serve --switch-to-solo\`.`;
}

/** `serve --switch-to-solo` (M6): the install's person records the switch back. */
export function recordSwitchToSolo(log: EventLog): void {
  log.appendNow({
    actor: "human",
    type: "setup/switched",
    payload: { to: "solo" },
    principal: log.localPrincipal(),
  });
}

export interface ServerIdentity {
  identity: Identity;
  passkeys?: Passkeys;
  sso?: Sso;
  /** The engines' report for Configuration › Models, in the Team setup (rule 26a). */
  teamEngines?: () => Promise<TeamEnginesReport>;
  /** Start the refusal-summary and session-sweep timers; returns their stop. */
  startTimers(): () => void;
}

export function createServerIdentity(
  db: DatabaseSync,
  log: EventLog,
  repoPath: string,
  options: ServerIdentityOptions = {},
): ServerIdentity {
  const settings = options.settings ?? serverSettings(repoPath);
  const now = options.now ?? Date.now;
  const identity = new Identity({
    db,
    log,
    settings,
    dir: options.dir ?? storeDirOf(db),
    now,
    ...(options.passwordList ? { passwordList: options.passwordList } : {}),
  });
  const team = settings.mode === "team";
  if (team && !passwordListPresent(options.passwordList)) {
    // TEAM-9: said plainly, never hidden — the list awaits the owner's approval (DEC-38).
    console.warn(
      "The common-password list is not installed: passwords are checked for length, name, email and the workspace's name only.",
    );
  }
  const passkeys =
    team && settings.sources.includes("passkeys") && settings.publicUrl
      ? new Passkeys(identity, db, log, settings.publicUrl, now)
      : undefined;
  const redirect =
    settings.oidc?.redirectUri ??
    (settings.publicUrl ? new URL("/api/oidc/callback", settings.publicUrl).href : undefined);
  const sso =
    team && settings.sources.includes("oidc") && settings.oidc && redirect
      ? new Sso(identity, settings.oidc, redirect, now)
      : undefined;
  // MD-N15-3 (FINDINGS INS-01): the engines checked as the Team server starts.
  const engines = !team
    ? undefined
    : options.teamEngines
      ? { current: options.teamEngines, start: async () => undefined }
      : options.settings
        ? undefined
        : teamEnginesMonitor();
  return {
    identity,
    ...(passkeys ? { passkeys } : {}),
    ...(sso ? { sso } : {}),
    ...(engines ? { teamEngines: engines.current } : {}),
    startTimers() {
      if (!team) return () => undefined;
      void engines?.start();
      const flush = setInterval(() => identity.flushRefusals(), 30_000);
      const sweep = setInterval(() => identity.sweep(), 60_000);
      flush.unref?.();
      sweep.unref?.();
      return () => {
        clearInterval(flush);
        clearInterval(sweep);
        void identity.close();
      };
    },
  };
}

/**
 * `sekhemet serve --new-setup-token` (TEAM-31): a new setup token voiding
 * the old one while no Admin exists; with an Admin, nothing is written.
 * Returns the exit code.
 */
export function newSetupTokenCommand(
  db: DatabaseSync,
  log: EventLog,
  repoPath: string,
  options: ServerIdentityOptions = {},
): number {
  const settings = options.settings ?? serverSettings(repoPath);
  if (settings.mode !== "team") {
    console.error(
      '--new-setup-token is for the Team setup ([team] mode = "team" in the user config).',
    );
    return 2;
  }
  const identity = new Identity({
    db,
    log,
    settings,
    dir: options.dir ?? storeDirOf(db),
    ...(options.now ? { now: options.now } : {}),
  });
  const result = identity.newSetupToken();
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }
  console.log(
    `A new setup token is in ${result.path} (mode 0600, valid 24 hours); the old one is void.`,
  );
  return 0;
}
