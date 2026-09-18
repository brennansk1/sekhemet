import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { BoardService } from "@sekhemet/board";
import type { EventLog } from "@sekhemet/kernel";
import { generateTokenCss, generateTokenJson } from "@sekhemet/ui";
import { runDoctor } from "./doctor.js";
import { generateDashboardHtml } from "./ui_html.js";

/** The loopback port the design fixes for the dashboard. */
export const DEFAULT_DASHBOARD_PORT = 4040;

export interface DashboardServerOptions {
  db: DatabaseSync;
  log: EventLog;
  boardService: BoardService;
  port?: number;
  repoPath?: string;
  /** How often the stream checks the log for new events. */
  streamIntervalMs?: number;
}

export { generateDashboardHtml };

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    // The dashboard is loopback-only and renders model-authored text; a strict
    // policy keeps an injected string from becoming an external request.
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

/**
 * Serve the Basalt dashboard and its read APIs over loopback.
 *
 * Updates are pushed over Server-Sent Events rather than polled. The kernel is
 * an append-only log, so tailing it is the natural shape: polling re-rendered
 * the whole board on a timer and destroyed scroll position and hover state on
 * every tick.
 */
export function startDashboardServer(
  options: DashboardServerOptions,
): Promise<{ port: number; close: () => Promise<void> }> {
  const { log, boardService, port = DEFAULT_DASHBOARD_PORT } = options;
  const html = generateDashboardHtml();
  const tokenCss = generateTokenCss();
  const tokenJson = generateTokenJson();

  const streams = new Set<ServerResponse>();
  let lastSeq = 0;
  let timer: NodeJS.Timeout | undefined;

  // Diagnostics spawn real subprocesses, including a sandbox escape probe.
  // The dashboard asks for them on every refresh, so the result is cached:
  // probing the machine once a second is a cost with no added information.
  let doctorCache: { at: number; report: Awaited<ReturnType<typeof runDoctor>> } | undefined;
  const DOCTOR_TTL_MS = 15_000;

  const cachedDoctor = async (): Promise<Awaited<ReturnType<typeof runDoctor>>> => {
    const now = Date.now();
    if (doctorCache && now - doctorCache.at < DOCTOR_TTL_MS) return doctorCache.report;
    const report = await runDoctor(options.repoPath);
    doctorCache = { at: now, report };
    return report;
  };

  /** Push any events appended since the last tick to every open stream. */
  const pump = async (): Promise<void> => {
    if (streams.size === 0) return;
    try {
      const events = await log.getEvents(lastSeq + 1, 200);
      if (events.length === 0) return;

      lastSeq = events[events.length - 1]?.seq ?? lastSeq;
      const [board, verification] = await Promise.all([
        boardService.getBoardState(),
        log.verifyHashChain(),
      ]);

      const frame = `event: append\ndata: ${JSON.stringify({ events, board, verification })}\n\n`;
      for (const res of streams) {
        // A slow or dead client must not stall the others.
        try {
          res.write(frame);
        } catch {
          streams.delete(res);
        }
      }
    } catch {
      // A transient read failure should not kill the pump.
    }
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url || "/").split("?")[0] ?? "/";

    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (url === "/tokens.css") {
      res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
      res.end(tokenCss);
      return;
    }

    // Published so plugin panels resolve the same values as the dashboard.
    if (url === "/tokens.json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(tokenJson);
      return;
    }

    if (url === "/api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      streams.add(res);

      const latest = await log.getLastEvent();
      lastSeq = Math.max(lastSeq, latest?.seq ?? 0);

      req.on("close", () => {
        streams.delete(res);
      });
      return;
    }

    if (url === "/api/board") {
      json(res, 200, await boardService.getBoardState());
      return;
    }

    if (url === "/api/wip") {
      json(res, 200, { limits: await boardService.checkWipLimits() });
      return;
    }

    if (url === "/api/events") {
      const [events, verification] = await Promise.all([
        log.getEvents(1, 200),
        log.verifyHashChain(),
      ]);
      json(res, 200, { events, verification });
      return;
    }

    if (url === "/api/doctor") {
      json(res, 200, await cachedDoctor());
      return;
    }

    json(res, 404, { error: "Not Found", path: url });
  });

  return new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => {
      timer = setInterval(() => {
        void pump();
      }, options.streamIntervalMs ?? 1000);
      // Never hold the process open for the stream ticker alone.
      timer.unref?.();

      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : port,
        close: () =>
          new Promise<void>((done) => {
            if (timer) clearInterval(timer);
            for (const stream of streams) stream.end();
            streams.clear();
            server.close(() => done());
          }),
      });
    });

    server.on("error", reject);
  });
}
