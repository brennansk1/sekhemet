import { createHash } from "node:crypto";
import { type IncomingMessage, type Server, createServer, request as httpRequest } from "node:http";
import { type Socket, connect } from "node:net";

/**
 * The allowlisting egress proxy (S5). Confined commands have no network
 * except a route to this proxy on loopback (Seatbelt allows exactly that
 * port); the proxy forwards only to allowlisted domains and logs every
 * request, allowed or refused, with a hash of its payload.
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
}

export interface EgressProxyOptions {
  /** Domains that may be reached; a leading `*.` or bare domain covers subdomains. */
  allow: string[];
  onRequest?: (record: EgressRecord) => void;
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

  /** HTTPS: CONNECT host:port, then a raw tunnel. */
  private tunnel(req: IncomingMessage, client: Socket, head: Buffer): void {
    const [host = "", portText = "443"] = (req.url ?? "").split(":");
    const port = Number(portText) || 443;
    const allowed = domainAllowed(host, this.options.allow);
    this.record({
      method: "CONNECT",
      host,
      port,
      allowed,
      payloadHash: createHash("sha256").update(`CONNECT ${req.url}`).digest("hex"),
      bytes: head.length,
    });
    if (!allowed) {
      client.end(`HTTP/1.1 403 Forbidden\r\nX-Sekhemet-Egress: ${host} is not allowlisted\r\n\r\n`);
      return;
    }
    const upstream = connect(port, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  }

  /** Plain HTTP with an absolute URI. */
  private forward(req: IncomingMessage, res: import("node:http").ServerResponse): void {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("absolute URI required");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const allowed = domainAllowed(target.hostname, this.options.allow);
      this.record({
        method: req.method ?? "GET",
        host: target.hostname,
        port: Number(target.port) || 80,
        allowed,
        payloadHash: createHash("sha256").update(body).digest("hex"),
        bytes: body.length,
      });
      if (!allowed) {
        res.writeHead(403, { "X-Sekhemet-Egress": `${target.hostname} is not allowlisted` });
        res.end(
          `Sekhemet egress: ${target.hostname} is not on this project's network allowlist.\n`,
        );
        return;
      }
      const upstream = httpRequest(
        {
          host: target.hostname,
          port: Number(target.port) || 80,
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
  }
}
