import { existsSync, readFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { join } from "node:path";
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

/** Map a card's latest evidence onto the five-box gate strip. */
function gateStripFor(repoPath: string, cardId: string): Record<string, string> | undefined {
  const path = join(repoPath, ".sekhemet", "evidence", `latest-${cardId}.json`);
  if (!existsSync(path)) return undefined;
  try {
    const evidence = JSON.parse(readFileSync(path, "utf8")) as {
      passed: boolean;
      rungResults?: { rung: string; passed: boolean; skipped?: boolean }[];
      filesTouched?: string[];
      linesAdded?: number;
      linesRemoved?: number;
    };
    const strip: Record<string, string> = {};
    for (const r of evidence.rungResults ?? []) {
      strip[r.rung] = r.skipped ? "skipped" : r.passed ? "pass" : "fail";
    }
    // A card that reached a gate at all parsed; bounds come from the measured diff.
    if (Object.keys(strip).length > 0) strip.parse = "pass";
    if (evidence.filesTouched) {
      const lines = (evidence.linesAdded ?? 0) + (evidence.linesRemoved ?? 0);
      strip.bounds = evidence.filesTouched.length <= 3 && lines < 200 ? "pass" : "fail";
    }
    return strip;
  } catch {
    return undefined;
  }
}

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
  const repoPath = options.repoPath ?? process.cwd();
  /** Board state with each card's gate strip filled from its latest evidence. */
  const boardWithEvidence = async () => {
    const state = await boardService.getBoardState();
    return {
      ...state,
      cards: state.cards.map((card) => {
        const gateResults = gateStripFor(repoPath, card.id);
        return gateResults ? { ...card, gateResults } : card;
      }),
    };
  };

  const pump = async (): Promise<void> => {
    if (streams.size === 0) return;
    try {
      const events = await log.getEvents(lastSeq + 1, 200);
      if (events.length === 0) return;

      lastSeq = events[events.length - 1]?.seq ?? lastSeq;
      const [board, verification] = await Promise.all([boardWithEvidence(), log.verifyHashChain()]);

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
      json(res, 200, await boardWithEvidence());
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

    // Latest evidence bundle for a card: what Review is decided on.
    const evidenceMatch = /^\/api\/evidence\/([A-Za-z0-9_.-]+)$/.exec(url);
    if (evidenceMatch) {
      const path = join(
        options.repoPath ?? process.cwd(),
        ".sekhemet",
        "evidence",
        `latest-${evidenceMatch[1]}.json`,
      );
      if (!existsSync(path)) {
        json(res, 404, { error: "No evidence recorded for this card yet" });
        return;
      }
      json(res, 200, JSON.parse(readFileSync(path, "utf8")));
      return;
    }

    if (url === "/api/queue") {
      const path = join(options.repoPath ?? process.cwd(), ".sekhemet", "queue_report.json");
      json(res, 200, existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { entries: [] });
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
