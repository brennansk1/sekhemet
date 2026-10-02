/**
 * The identity settings of the Team setup (teams §3 Config), read only from
 * the user config — a repository cannot set them (integrations INT-26).
 */

/** The four access levels (teams item 6), lowest first. */
export const LEVELS = ["viewer", "stakeholder", "member", "admin"] as const;
export type Level = (typeof LEVELS)[number];

export function isLevel(value: unknown): value is Level {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

/** The lower of two levels (a token acts at the lower of its scope and the person's level). */
export function lowerLevel(a: Level, b: Level): Level {
  return LEVELS.indexOf(a) <= LEVELS.indexOf(b) ? a : b;
}

export function levelRank(level: Level): number {
  return LEVELS.indexOf(level);
}

export type IdentitySource = "accounts" | "proxy" | "oidc" | "passkeys";

export interface OidcSettings {
  issuer: string;
  clientId: string;
  /** The company's name on the Sign in page ("Sign in with Northwind"); the issuer's host by default. */
  displayName?: string;
  /** Environment variable holding the client secret; none means a public client (PKCE only). */
  clientSecretEnv?: string;
  /** Defaults to `<public_url>/api/oidc/callback`. */
  redirectUri?: string;
  /** The ID-token claim mapped to a level (a string or an array of strings). */
  claim: string;
  /** Claim value to level. */
  levels: Record<string, Level>;
  /** A claim that maps to no level refuses the sign-in (TEAM-13); off, the person joins pending. */
  strict: boolean;
  /** "sekhemet": a level set here is never changed from a claim (TEAM-14). */
  levelsManagedBy: "sekhemet" | "provider";
}

export interface IdentitySettings {
  mode: "solo" | "team";
  /** The workspace's name; a password may not contain it (TEAM-9). */
  workspace: string;
  sources: IdentitySource[];
  /** The trusted proxy's user header, holding the person's email. */
  userHeader: string;
  trustedProxies: string[];
  openSignupDomains: string[];
  inviteTtlDays: number;
  /** The origin people reach the server at; passkeys and OIDC need it. */
  publicUrl?: string;
  idleMinutes: number;
  absoluteHours: number;
  tokenDefaultDays: number;
  tokenMaxDays: number;
  oidc?: OidcSettings;
}

export const DEFAULT_IDENTITY: IdentitySettings = {
  mode: "solo",
  workspace: "Sekhemet",
  sources: ["accounts"],
  userHeader: "x-forwarded-email",
  trustedProxies: [],
  openSignupDomains: [],
  inviteTtlDays: 7,
  idleMinutes: 60,
  absoluteHours: 24,
  tokenDefaultDays: 90,
  tokenMaxDays: 365,
};

export function identitySettings(partial: Partial<IdentitySettings> = {}): IdentitySettings {
  return { ...DEFAULT_IDENTITY, ...partial };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * The address `serve` binds (runtime item 26, teams TEAM-1). Solo binds
 * loopback only. Team may bind another address only when traffic is
 * encrypted: the server has no TLS of its own, so a proxy in
 * `trusted_proxies` must terminate it.
 */
export function bindHost(
  mode: "solo" | "team",
  requested: string | undefined,
  settings: IdentitySettings,
): string {
  const host = requested?.trim() || "127.0.0.1";
  if (LOOPBACK.has(host)) return host === "localhost" ? "127.0.0.1" : host;
  if (mode === "solo") {
    throw new Error(
      `Solo binds loopback only (asked for ${host}); switch to the Team setup to serve other addresses`,
    );
  }
  if (settings.trustedProxies.length === 0) {
    throw new Error(
      `A Team server binds ${host} only behind TLS: name the proxy that terminates it in [identity] trusted_proxies (runtime item 26)`,
    );
  }
  return host;
}

/** An address as the socket reports it, without the IPv4-mapped prefix. */
export function normalAddress(address: string | undefined): string {
  if (!address) return "";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const v = Number(p);
    if (v > 255) return undefined;
    n = n * 256 + v;
  }
  return n;
}

/** Whether `address` is one of `trusted` (exact addresses, or IPv4 CIDR ranges). */
export function isTrustedProxy(address: string | undefined, trusted: readonly string[]): boolean {
  const ip = normalAddress(address);
  if (!ip) return false;
  for (const entry of trusted) {
    const t = entry.trim();
    if (!t) continue;
    if (!t.includes("/")) {
      if (normalAddress(t) === ip) return true;
      continue;
    }
    const [base = "", bitsRaw = ""] = t.split("/");
    const bits = Number(bitsRaw);
    const a = ipv4ToInt(ip);
    const b = ipv4ToInt(base);
    if (a === undefined || b === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32)
      continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((a & mask) >>> 0 === (b & mask) >>> 0) return true;
  }
  return false;
}
