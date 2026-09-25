import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createIngestHandler } from "./ingest.js";
import { replayEvent } from "./replay.js";
import { SseBus } from "./sse.js";
import { EventStore } from "./store.js";
import type { HmacConfig } from "./types.js";

export interface DaemonOptions {
  dbPath: string;
  port: number;
  hmac: HmacConfig;
  host?: string;
  now?: () => number;
  maxBodyBytes?: number;
}

export interface Daemon {
  port: number;
  store: EventStore;
  bus: SseBus;
  close(): Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The webhook inspector: ingest, list, stream and replay over one HTTP server. */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const store = new EventStore(options.dbPath);
  const bus = new SseBus();
  const ingest = createIngestHandler({
    store,
    hmac: options.hmac,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {}),
    onEvent: (event) => {
      bus.broadcast(
        "webhook",
        {
          id: event.id,
          source: event.source,
          verification: event.verification,
          bytes: event.body.length,
        },
        event.id,
      );
    },
  });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path.startsWith("/ingest/")) {
      ingest(req, res);
      return;
    }
    if (req.method === "GET" && path === "/health") return json(res, 200, { status: "ok" });
    if (req.method === "GET" && path === "/events/stream") {
      bus.addClient(res);
      return;
    }
    if (req.method === "GET" && path === "/events") {
      return json(
        res,
        200,
        store.list().map((e) => ({
          id: e.id,
          source: e.source,
          method: e.method,
          path: e.path,
          verification: e.verification,
          receivedAt: e.receivedAt,
          bytes: e.body.length,
        })),
      );
    }
    const replay = /^\/events\/(\d+)\/replay$/.exec(path);
    if (req.method === "POST" && replay) {
      const eventId = Number(replay[1]);
      if (store.get(eventId) === undefined) {
        return json(res, 404, { error: `event not found: ${eventId}` });
      }
      let body: { to?: unknown; headers?: unknown };
      try {
        body = JSON.parse(await readBody(req)) as { to?: unknown; headers?: unknown };
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
      if (typeof body?.to !== "string") return json(res, 400, { error: "missing to" });
      const result = await replayEvent(store, {
        eventId,
        targetUrl: body.to,
        ...(body.headers !== undefined
          ? { headerOverrides: body.headers as Record<string, string> }
          : {}),
      });
      return json(res, 200, result);
    }
    return json(res, 404, { error: "not found" });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) json(res, 400, { error: (err as Error).message });
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port, options.host ?? "127.0.0.1", resolve),
  );
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    store,
    bus,
    close: async () => {
      bus.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      store.close();
    },
  };
}
