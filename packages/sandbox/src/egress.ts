import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { type IncomingMessage, type Server, createServer, request as httpRequest } from "node:http";
import { type Socket, connect } from "node:net";
import ipaddr from "ipaddr.js";

/**
 * The allowlisting egress proxy (S5). Confined commands have no network
 * except a route to this proxy on loopback (Seatbelt allows exactly that
 * port); the proxy forwards only to allowlisted domains and logs every
 * request, allowed or refused, with a hash of its payload.
 *
 * Hardening (security spec item 30, SEC-9–SEC-11): hostnames are
 * canonicalised and syntax-checked, only ports 80 and 443 are allowed, and
 * names are resolved here — every resolved address must be globally
 * routable unicast, and the proxy dials the checked address itself so a
 * second (rebinding) lookup cannot swap it.
 */
export interface EgressRecord {
  at: string;
  method: string;
  host: string;
  port: number;
  allowed: boolean;
  /** SHA-256 of the request body (HTTP) or of the CONNECT request line (HTTPS). */
  payloadHash: string;
  bytes: number;
  /** Why the request was refused. */
  reason?: string;
}

export type EgressLookup = (host: string) => Promise<{ address: string; family: number }[]>;

export interface EgressProxyOptions {
  /** Domains that may be reached; a leading `*.` or bare domain covers subdomains. */
  allow: string[];
  /** `fetch_deny`: refused before the allowlist is consulted, subdomains included (item 28). */
  deny?: string[];
  onRequest?: (record: EgressRecord) => void;
  /** Name resolution; defaults to `dns.promises.lookup(host, { all: true })`. */
  lookup?: EgressLookup;
}

export interface EgressDecision {
  allowed: boolean;
  /** The canonical host (or the raw one when it could not be canonicalised). */
  host: string;
  /** The checked address to dial, present only when allowed. */
  address?: string;
  reason?: string;
}

const defaultLookup: EgressLookup = (host) => dns.lookup(host, { all: true });
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const ALLOWED_PORTS = new Set([80, 443]);

/** SEC-11: lowercase, strip one trailing dot, refuse anything that is not a hostname or IP literal. */
export function canonicalHost(raw: string): { host: string } | { reason: string } {
  if (raw.includes("\0")) return { reason: "NUL byte in host" };
  if (raw.startsWith("[") || raw.endsWith("]")) {
    const inner = raw.slice(1, -1);
    if (!raw.startsWith("[") || !raw.endsWith("]") || !ipaddr.IPv6.isValid(inner)) {
      return { reason: "invalid IPv6 literal" };
    }
    return { host: inner.toLowerCase() };
  }
  let host = raw.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "") return { reason: "empty host" };
  if (host.length > 253) return { reason: "name longer than 253 characters" };
  const labels = host.split(".");
  if (labels.some((l) => l.length > 63)) return { reason: "label longer than 63 characters" };
  if (!labels.every((l) => LABEL.test(l))) return { reason: "host is outside hostname syntax" };
  return { host };
}

/** Refusal reason when an address is not globally routable unicast. */
function addressRefusal(address: string): string | undefined {
  let range: string;
  try {
    range = ipaddr.process(address).range();
  } catch {
    return `unparseable address ${address}`;
  }
  return range === "unicast" ? undefined : `${address} is ${range}, not public unicast`;
}

/**
 * The whole egress policy for one destination: canonical host (SEC-11), port
 * 80/443 (SEC-10), allowlist (empty = deny-all), then resolution with every
 * address public unicast (SEC-9). When allowed, `address` is what to dial.
 */
export async function checkDestination(
  rawHost: string,
  port: number,
  allow: readonly string[],
  lookup: EgressLookup = defaultLookup,
  deny: readonly string[] = [],
): Promise<EgressDecision> {
  const c = canonicalHost(rawHost);
  if ("reason" in c) return { allowed: false, host: rawHost, reason: c.reason };
  const host = c.host;
  if (!ALLOWED_PORTS.has(port))
    return { allowed: false, host, reason: `port ${port} is not 80 or 443` };
  if (deny.length > 0 && domainAllowed(host, deny))
    return { allowed: false, host, reason: `${host} is in fetch_deny` };
  if (!domainAllowed(host, allow))
    return { allowed: false, host, reason: `${host} is not on this project's network allowlist` };
  let addresses: string[];
  if (ipaddr.isValid(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host)).map((a) => a.address);
    } catch (err) {
      return {
        allowed: false,
        host,
        reason: `could not resolve ${host}: ${(err as Error).message}`,
      };
    }
    if (addresses.length === 0)
      return { allowed: false, host, reason: `could not resolve ${host}` };
  }
  for (const a of addresses) {
    const refusal = addressRefusal(a);
    if (refusal) return { allowed: false, host, reason: refusal };
  }
  const first = addresses[0] as string;
  return { allowed: true, host, address: ipaddr.process(first).toString() };
}

export function domainAllowed(host: string, allow: readonly string[]): boolean {
  const h = host.toLowerCase();
  return allow.some((d) => {
    const domain = d.toLowerCase().replace(/^\*\./, "");
    return h === domain || h.endsWith(`.${domain}`);
  });
}

export class EgressProxy {
  private server: Server | undefined;
  private sockets = new Set<Socket>();
  public readonly log: EgressRecord[] = [];

  constructor(private options: EgressProxyOptions) {}

  private record(r: Omit<EgressRecord, "at">): void {
    const full = { ...r, at: new Date().toISOString() };
    this.log.push(full);
    this.options.onRequest?.(full);
  }

  /** Start listening on 127.0.0.1; resolves to the port. */
  public start(): Promise<number> {
    const server = createServer((req, res) => this.forward(req, res));
    server.on("connect", (req, client: Socket, head) => this.tunnel(req, client, head));
    server.on("connection", (s: Socket) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
  }

  public close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private decide(host: string, port: number): Promise<EgressDecision> {
    return checkDestination(
      host,
      port,
      this.options.allow,
      this.options.lookup,
      this.options.deny ?? [],
    );
  }

  /** HTTPS: CONNECT host:port, then a raw tunnel to the checked address (TLS/SNI stay the client's). */
  private tunnel(req: IncomingMessage, client: Socket, head: Buffer): void {
    client.on("error", () => client.destroy());
    const target = req.url ?? "";
    const { host, port } = splitHostPort(target, 443);
    void this.decide(host, port).then((d) => {
      this.record({
        method: "CONNECT",
        host: d.host,
        port,
        allowed: d.allowed,
        payloadHash: createHash("sha256").update(`CONNECT ${target}`).digest("hex"),
        bytes: head.length,
        ...(d.reason ? { reason: d.reason } : {}),
      });
      if (!d.allowed || !d.address) {
        client.end(`HTTP/1.1 403 Forbidden\r\nX-Sekhemet-Egress: ${headerSafe(d.reason)}\r\n\r\n`);
        return;
      }
      const upstream = connect(port, d.address, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
  }

  /** Plain HTTP with an absolute URI, sent to the checked address with the original Host header. */
  private forward(req: IncomingMessage, res: import("node:http").ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      let target: URL | undefined;
      try {
        target = new URL(req.url ?? "");
      } catch {
        target = undefined;
      }
      const port = target ? Number(target.port) || 80 : 0;
      const decided: Promise<EgressDecision> = !target
        ? Promise.resolve({ allowed: false, host: "", reason: "absolute URI required" })
        : target.protocol !== "http:"
          ? Promise.resolve({
              allowed: false,
              host: target.hostname,
              reason: `scheme ${target.protocol} is not plain HTTP`,
            })
          : this.decide(target.hostname, port);
      void decided.then((d) => {
        this.record({
          method: req.method ?? "GET",
          host: d.host,
          port,
          allowed: d.allowed,
          payloadHash: createHash("sha256").update(body).digest("hex"),
          bytes: body.length,
          ...(d.reason ? { reason: d.reason } : {}),
        });
        if (!target || !d.allowed || !d.address) {
          res.writeHead(target ? 403 : 400, { "X-Sekhemet-Egress": headerSafe(d.reason) });
          res.end(`Sekhemet egress: ${d.reason ?? "refused"}.\n`);
          return;
        }
        const upstream = httpRequest(
          {
            host: d.address,
            port,
            method: req.method,
            path: `${target.pathname}${target.search}`,
            headers: { ...req.headers, host: target.host },
          },
          (up) => {
            res.writeHead(up.statusCode ?? 502, up.headers);
            up.pipe(res);
          },
        );
        upstream.on("error", (err) => {
          res.writeHead(502).end(`upstream error: ${err.message}`);
        });
        upstream.end(body);
      });
    });
  }
}

/** Split a CONNECT target (`host:port` or `[v6]:port`); a malformed target yields port 0 (refused). */
function splitHostPort(target: string, defaultPort: number): { host: string; port: number } {
  const m = /^(\[[^\]]*\]|[^:[\]]*)(?::(\d{1,5}))?$/.exec(target);
  if (!m) return { host: target, port: 0 };
  return { host: m[1] ?? "", port: m[2] ? Number(m[2]) : defaultPort };
}

function headerSafe(reason: string | undefined): string {
  return (reason ?? "refused").replace(/[^\x20-\x7e]/g, "?");
}
