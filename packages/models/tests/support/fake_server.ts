import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface Seen {
  method: string;
  url: string;
  body: unknown;
}

/** A local HTTP server that records requests and answers from `reply`. */
export async function fakeServer(
  reply: (req: IncomingMessage, body: unknown) => { status?: number; json: unknown },
): Promise<{ url: string; port: number; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as unknown) : undefined;
      seen.push({ method: req.method ?? "", url: req.url ?? "", body });
      const r = reply(req, body);
      res.writeHead(r.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
