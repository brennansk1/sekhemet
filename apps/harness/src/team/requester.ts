import type { IncomingMessage } from "node:http";
import type { Level } from "./settings.js";

/**
 * Who a request is (teams §2.3): the one resolver every endpoint asks.
 *
 * - Solo: the operating-system user's principal, at every permission (TEAM-1).
 * - Team: a personal access token (`Authorization: Bearer sekp_…`, TEAM-37),
 *   the trusted proxy's user header from an address in `trusted_proxies`
 *   (TEAM-12, TEAM-38), or the `__Host-` session cookie (TEAM-10), whose
 *   mutations carry the session's CSRF token.
 *
 * Unauthenticated answers 401; a person who is known but may do nothing yet
 * (pending approval) answers 403 with `reason: "pending"`.
 */
export type Requester =
  | {
      authenticated: true;
      principal: string;
      /** The workspace level, lowered to a token's scope when a token was used. */
      level: Level;
      via: "solo" | "session" | "token" | "proxy";
      /**
       * A token's scope (TEAM-37): the ceiling of every check the request
       * meets, a per-project level included (teams item 15).
       */
      scope?: Level;
    }
  | {
      authenticated: false;
      status: 401 | 403;
      reason: string;
      /** Set when the person is known (pending, or a failed CSRF check). */
      principal?: string;
    };

export const UNAUTHENTICATED: Requester = {
  authenticated: false,
  status: 401,
  reason: "Sign in to continue.",
};

const bound = new WeakMap<IncomingMessage, Requester>();

/** The server binds each request's requester once, at the top of its handler. */
export function bindRequester(req: IncomingMessage, who: Requester): void {
  bound.set(req, who);
}

/**
 * The requester of `req`, as the server resolved it. A request the server
 * never resolved is unauthenticated: an endpoint cannot be reached around
 * the resolver.
 */
export function requester(req: IncomingMessage): Requester {
  return bound.get(req) ?? UNAUTHENTICATED;
}
