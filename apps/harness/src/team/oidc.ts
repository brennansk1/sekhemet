import { timingSafeEqual } from "node:crypto";
import * as client from "openid-client";
import type { Failure, Identity, SignedIn } from "./identity.js";
import { type Level, type OidcSettings, levelRank } from "./settings.js";

/**
 * Company SSO (OIDC; teams item 12, DEC-38) with `openid-client`: the
 * authorization-code flow with PKCE, state and nonce; a claim-to-level
 * mapping; strict mode (TEAM-13); and levels managed in Sekhemet unless
 * the Admin chose the identity provider (TEAM-14). The first Admin is
 * always created by the setup token, never by a first SSO sign-in.
 *
 * Plain http is allowed only for an issuer on loopback (a local stub).
 */
const FLOW_MS = 10 * 60_000;

/**
 * The browser that started a sign-in carries its state back (M2): a
 * short-lived `__Host-` cookie, SameSite=Lax because the provider's redirect
 * back is a navigation from another site. A callback whose state this browser
 * never started — a login forced on someone — is refused.
 */
export const OIDC_STATE_COOKIE = "__Host-sekhemet_oidc";

export function oidcStateCookie(state: string): string {
  return `${OIDC_STATE_COOKIE}=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${FLOW_MS / 1000}`;
}

export function clearedOidcStateCookie(): string {
  return `${OIDC_STATE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export class Sso {
  private config: client.Configuration | undefined;
  private readonly flows = new Map<string, { verifier: string; nonce: string; expires: number }>();

  constructor(
    private readonly identity: Identity,
    private readonly settings: OidcSettings,
    private readonly redirectUri: string,
    private readonly now: () => number = Date.now,
  ) {}

  private async configuration(): Promise<client.Configuration> {
    if (this.config) return this.config;
    const issuer = new URL(this.settings.issuer);
    const secret = this.settings.clientSecretEnv
      ? process.env[this.settings.clientSecretEnv]
      : undefined;
    const insecure = issuer.protocol === "http:" && LOOPBACK.has(issuer.hostname);
    this.config = await client.discovery(
      issuer,
      this.settings.clientId,
      secret ? { client_secret: secret } : undefined,
      secret ? client.ClientSecretPost(secret) : client.None(),
      insecure ? { execute: [client.allowInsecureRequests] } : undefined,
    );
    return this.config;
  }

  /** The company's name on the Sign in page. */
  public get displayName(): string {
    return this.settings.displayName ?? new URL(this.settings.issuer).hostname;
  }

  /** The provider's sign-in page, with a fresh PKCE verifier, state and nonce. */
  public async start(): Promise<URL> {
    return (await this.begin()).url;
  }

  /** `start`, with the state the browser's cookie carries back (M2). */
  public async begin(): Promise<{ url: URL; state: string }> {
    const config = await this.configuration();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const t = this.now();
    for (const [s, f] of [...this.flows]) if (f.expires <= t) this.flows.delete(s);
    this.flows.set(state, { verifier, nonce, expires: t + FLOW_MS });
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri,
      scope: "openid email profile",
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return { url, state };
  }

  /** The level a claim maps to: the highest mapped value, or undefined (TEAM-13). */
  public levelFor(claims: Record<string, unknown>): Level | undefined {
    const raw = claims[this.settings.claim];
    const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    let best: Level | undefined;
    for (const v of values) {
      const level = typeof v === "string" ? this.settings.levels[v] : undefined;
      if (level && (!best || levelRank(level) > levelRank(best))) best = level;
    }
    return best;
  }

  /**
   * The provider's redirect back: exchange the code, map the claim, start a
   * session. `browserState` is the state cookie of the browser that came
   * back; the server passes it, and a callback without it is refused.
   */
  public async callback(
    params: URLSearchParams,
    browserState: string | undefined,
  ): Promise<SignedIn | Failure> {
    // The redirect as the provider made it: our registered URI with its query.
    const currentUrl = new URL(this.redirectUri);
    currentUrl.search = params.toString();
    const state = params.get("state") ?? "";
    if (!browserState || !sameText(browserState, state)) {
      return {
        ok: false,
        status: 400,
        reason: "state_mismatch",
        error: "This sign-in was not started in this browser; start again.",
      };
    }
    const flow = this.flows.get(state);
    this.flows.delete(state);
    if (!flow || flow.expires <= this.now()) {
      return { ok: false, status: 400, error: "That sign-in has expired; start again." };
    }
    let claims: Record<string, unknown> | undefined;
    try {
      const tokens = await client.authorizationCodeGrant(await this.configuration(), currentUrl, {
        pkceCodeVerifier: flow.verifier,
        expectedState: state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims() as Record<string, unknown> | undefined;
    } catch (err) {
      return {
        ok: false,
        status: 401,
        error: `The identity provider's answer was refused: ${(err as Error).message}`,
      };
    }
    if (!claims)
      return { ok: false, status: 401, error: "The identity provider sent no ID token." };
    const email = typeof claims.email === "string" ? claims.email : undefined;
    // Only an address the provider says it verified names a person here.
    if (!email || claims.email_verified !== true) {
      return {
        ok: false,
        status: 403,
        error: "The identity provider sent no verified email address.",
      };
    }
    const level = this.levelFor(claims);
    if (!level && this.settings.strict) {
      const raw = claims[this.settings.claim];
      const shown = raw === undefined ? "none" : JSON.stringify(raw);
      return {
        ok: false,
        status: 403,
        reason: "unmapped_claim",
        error: `The identity provider's "${this.settings.claim}" claim (${shown}) maps to no level. An Admin adds a mapping under [identity.oidc] levels.`,
      };
    }
    const name = typeof claims.name === "string" ? claims.name : undefined;
    const iss = typeof claims.iss === "string" ? claims.iss : "";
    const sub = typeof claims.sub === "string" ? claims.sub : "";
    if (!iss || !sub) {
      return { ok: false, status: 401, error: "The identity provider sent no subject." };
    }
    const joined = this.identity.joinFromProvider(
      email,
      name,
      level,
      this.settings.levelsManagedBy === "provider",
      { iss, sub },
    );
    if (!joined.ok) return joined;
    return this.identity.signInAs(joined.principal, "oidc");
  }
}
