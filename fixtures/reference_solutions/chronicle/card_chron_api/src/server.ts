import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Ledger } from "./ledger.js";

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The ledger over HTTP: POST /events, GET /events/:id, GET /audit, GET /health. */
export async function startServer(options: {
  dbPath: string;
  port: number;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const ledger = new Ledger(options.dbPath);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && path === "/health") return send(res, 200, { status: "ok" });
    if (req.method === "GET" && path === "/audit") return send(res, 200, ledger.audit());
    if (req.method === "POST" && path === "/events") {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        return send(res, 400, { error: `invalid JSON: ${(err as Error).message}` });
      }
      const input = body as { type?: unknown; payload?: unknown; idempotencyKey?: unknown };
      if (typeof input !== "object" || input === null || typeof input.type !== "string") {
        return send(res, 400, { error: "the body must be an object with a string type" });
      }
      const event = ledger.append({
        type: input.type,
        payload: input.payload ?? null,
        ...(typeof input.idempotencyKey === "string"
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
      });
      return send(res, 201, event);
    }
    const match = /^\/events\/([^/]+)$/.exec(path);
    if (req.method === "GET" && match?.[1]) {
      const event = ledger.get(decodeURIComponent(match[1]));
      return event ? send(res, 200, event) : send(res, 404, { error: "event not found" });
    }
    return send(res, 404, { error: "not found" });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => send(res, 500, { error: String(err) }));
  });
  await new Promise<void>((resolve) => server.listen(options.port, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          ledger.close();
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
