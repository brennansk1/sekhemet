import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";

/**
 * The dashboard's one guard (security item 37, runtime item 24; gap B-1):
 * the Host allowlist that defeats DNS rebinding, the Solo per-start mutation
 * token, the same-origin rule for the live streams, and the headers every
 * response carries (a strict Content-Security-Policy, no framing, no
 * referrer, a Permissions-Policy).
 *
 * Why each part: a page on another site cannot read loopback answers, but a
 * name the attacker controls can be re-pointed at 127.0.0.1 after the page
 * loads, and then the browser treats the dashboard as that site's own. Such
 * a request still names the attacker's host, so the Host header is checked
 * on every request, GET included. A write also needs a secret the page gets
 * from this server at load, which no other site can read; the constant
 * `X-Sekhemet-Action` header alone was a guess any local page could make.
 */

/** The names a loopback server answers to, as `URL.hostname` spells them. */
const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"];

/** Every address a wildcard bind (`0.0.0.0`, `::`) listens on: this machine's own. */
const WILDCARD = new Set(["0.0.0.0", "::", "[::]"]);

/** A Host header: a name or IPv4 address, or a bracketed IPv6 address, then an optional port. */
const HOST_SHAPE = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)(?::\d{1,5})?$/;

/** An address as URL.hostname spells it: lower case, IPv6 in brackets. */
function hostnameOf(address: string): string | undefined {
  const bare = address.trim().toLowerCase();
  if (!bare) return undefined;
  const bracketed = bare.includes(":") && !bare.startsWith("[") ? `[${bare}]` : bare;
  try {
    return new URL(`http://${bracketed}`).hostname;
  } catch {
    return undefined;
  }
}

export interface HostAllowlistOptions {
  /** The address the server is bound to (`bindHost`). */
  bindHost: string;
  /** The Team setup's `[identity] public_url`: the name people reach the server at. */
  publicUrl?: string;
}

/**
 * The host names this server answers to: loopback, the bound address, and
 * in the Team setup the public URL's host. A wildcard bind adds this
 * machine's own interface addresses, which no other site can own.
 */
export function allowedHosts(options: HostAllowlistOptions): ReadonlySet<string> {
  const names = new Set(LOOPBACK_NAMES);
  const bind = options.bindHost.trim().toLowerCase();
  if (WILDCARD.has(bind)) {
    for (const list of Object.values(networkInterfaces())) {
      for (const nic of list ?? []) {
        const name = hostnameOf(nic.address.split("%")[0] ?? "");
        if (name) names.add(name);
      }
    }
  } else {
    const name = hostnameOf(bind);
    if (name) names.add(name);
  }
  if (options.publicUrl) {
    try {
      names.add(new URL(options.publicUrl).hostname);
    } catch {
      // A malformed public URL names nothing; the Team setup's own checks report it.
    }
  }
  return names;
}

/**
 * The sentence `serve` prints when a Team server bound off loopback has no
 * `[identity] public_url`: the allowlist is fixed at start, so the name
 * people use through the proxy, a hostname or mDNS name, or an address the
 * machine gets later is refused (421). Undefined when there is nothing to say.
 */
export function hostAllowlistWarning(options: HostAllowlistOptions): string | undefined {
  const bind = options.bindHost.trim().toLowerCase();
  if (options.publicUrl || LOOPBACK_NAMES.includes(hostnameOf(bind) ?? bind)) return undefined;
  return `This server answers only to loopback and ${WILDCARD.has(bind) ? "this machine's addresses at start" : bind}; any other name, such as the one your proxy or tunnel serves, is refused (421). Set [identity] public_url to the address people open.`;
}

/** True when the request's Host header names this server (SEC-24). Ports are not compared. */
export function hostAllowed(host: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (!host || !HOST_SHAPE.test(host)) return false;
  try {
    return allowed.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/**
 * True when a request comes from the page this server served: no Origin (a
 * local program, or a same-origin GET that browsers send without one), or
 * an Origin whose host is exactly the Host the request was sent to. Another
 * loopback port is another site: any local program can serve a page there.
 */
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  if (!host) return false;
  try {
    const from = new URL(origin);
    if (from.protocol !== "http:" && from.protocol !== "https:") return false;
    return from.host === new URL(`http://${host}`).host;
  } catch {
    return false;
  }
}

/**
 * The health route (runtime item 23b, RUN-72): public in either setup, read
 * before the identity gate, answering with no session and no data — a
 * container's `HEALTHCHECK` or an uptime monitor reads only its status.
 */
export const HEALTH_ROUTE = "/healthz";

/** A fresh per-start mutation token: 256 random bits, base64url (43 characters). */
export function mintMutationToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Compare a presented token with the server's in constant time. */
export function tokenMatches(presented: string | string[] | undefined, token: string): boolean {
  const value = Array.isArray(presented) ? presented[0] : presented;
  if (!value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Methods that change nothing; every other method is a write and needs the token. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The Content-Security-Policy for the dashboard (SEC-26, DB-S3c-2). Scripts
 * only from this server, no eval, no inline script; the page's one inline
 * `<style>` (the theme tokens, for a themed first paint) is allowed by its
 * hash. Style attributes stay allowed (`style-src-attr`): the views set
 * widths and colours through them, and a style attribute runs no code.
 */
export function contentSecurityPolicy(html: string): string {
  const hashes = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(
    (m) =>
      `'sha256-${createHash("sha256")
        .update(m[1] ?? "", "utf8")
        .digest("base64")}'`,
  );
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Browsers without the -elem/-attr split fall back to this one.
    "style-src 'self' 'unsafe-inline'",
    `style-src-elem 'self' ${hashes.join(" ")}`.trim(),
    "style-src-attr 'unsafe-inline'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-src 'none'",
    "worker-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Powerful features the dashboard never uses, refused to it and anything it could embed. */
const PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "serial=()",
  "hid=()",
  "bluetooth=()",
  "midi=()",
  "display-capture=()",
].join(", ");

/** The headers every response carries, page or API or file. */
export function securityHeaders(csp: string): Record<string, string> {
  return {
    "Content-Security-Policy": csp,
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": PERMISSIONS_POLICY,
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

/**
 * The 421 answer's sentence. It names no address: a rebound page can read
 * it, and this machine's addresses are not that page's business.
 */
export const MISDIRECTED =
  "This server does not answer to that name. Open the dashboard at the address Sekhemet printed when it started.";
