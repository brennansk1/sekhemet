import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { BoardService } from "@sekhemet/board";
import { type EvidenceBundle, type GatesConfig, loadGatesConfig } from "@sekhemet/gates";
import type { CardRecord, CardStore, EventLog } from "@sekhemet/kernel";
import {
  BASALT,
  EMPTY_SHA256,
  ICONS,
  UI_LIB_DIR,
  UI_LIB_MODULES,
  UI_WEB_DIR,
  describeCard,
  gateLabel,
  generateTokenCss,
  generateTokenJson,
  parseTitle,
  vocabularyTables,
} from "@sekhemet/ui";
import { resolveConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { acceptCard } from "./execute.js";
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
  /** Enables the triage actions (accept, return, park). Read-only without it. */
  cardStore?: CardStore;
}

export { generateDashboardHtml };

/** Read a small JSON request body. Triage payloads are tiny; anything large is refused. */
async function readJsonBody(
  req: IncomingMessage,
  limit = 16_384,
): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new Error("request body too large");
  }
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

/**
 * Mutations require a custom header. Browsers cannot attach one cross-origin
 * without a CORS preflight, which this server never grants, so a web page the
 * user happens to visit cannot trigger an accept (a git merge) on loopback.
 */
function isTrustedMutation(req: IncomingMessage): boolean {
  if (req.headers["x-sekhemet-action"] !== "1") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/**
 * Resolve `/app/<rel>` inside `root`, or undefined when the path escapes it.
 *
 * Refuses encoded traversal (`%2e%2e`), backslashes and NUL outright, then
 * checks the real path still sits under the real root, so a symlink inside the
 * web directory cannot point the server at the rest of the disk.
 */
export function resolveStaticPath(root: string, rel: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return undefined;
  }
  if (!decoded || decoded.includes("\0") || decoded.includes("\\")) return undefined;
  if (decoded.split("/").some((part) => part === ".." || part === ".")) return undefined;
  if (!MIME[extname(decoded)]) return undefined;
  const base = resolve(root);
  const target = resolve(base, decoded);
  if (!target.startsWith(base + sep)) return undefined;
  if (!existsSync(target)) return undefined;
  try {
    const real = realpathSync(target);
    if (!real.startsWith(realpathSync(base) + sep) || !statSync(real).isFile()) return undefined;
    return real;
  } catch {
    return undefined;
  }
}

function serveFile(res: ServerResponse, path: string): void {
  const body = readFileSync(path);
  res.writeHead(200, {
    "Content-Type": MIME[extname(path)] ?? "application/octet-stream",
    "Content-Length": body.length,
    // Local and build-free: always revalidate so an edit shows on reload.
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

/** The brand glyph on a base-coloured rounded square, from the tokens. */
function faviconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="${BASALT.bgBase}"/><g transform="translate(4 4)" fill="none" stroke="${BASALT.accent}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${ICONS.glyph}</g></svg>`;
}

/** Card ids travel in URLs; anything else is refused before touching the disk. */
const CARD_ID = "[A-Za-z0-9_.-]+";

interface AttemptSummary {
  attempt: number;
  evidenceId: string;
  createdAt: string;
  passed: boolean;
  stopReason: string;
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

  const repoPath = options.repoPath ?? process.cwd();
  const evidenceDir = join(repoPath, ".sekhemet", "evidence");

  // Evidence files are rewritten only when an attempt ends, so reads are cached
  // by mtime: the stream re-derives the board every tick an event lands.
  const fileCache = new Map<string, { mtimeMs: number; value: unknown }>();
  const readJsonCached = <T>(path: string): T | undefined => {
    try {
      const { mtimeMs } = statSync(path);
      const hit = fileCache.get(path);
      if (hit && hit.mtimeMs === mtimeMs) return hit.value as T;
      const value = JSON.parse(readFileSync(path, "utf8")) as T;
      fileCache.set(path, { mtimeMs, value });
      return value;
    } catch {
      return undefined;
    }
  };
  const latestEvidence = (cardId: string) =>
    readJsonCached<EvidenceBundle>(join(evidenceDir, `latest-${cardId}.json`));

  let gatesCache: { at: number; config: GatesConfig } | undefined;
  const gatesConfig = (): GatesConfig => {
    const now = Date.now();
    if (!gatesCache || now - gatesCache.at > 5_000) {
      gatesCache = { at: now, config: loadGatesConfig(repoPath) };
    }
    return gatesCache.config;
  };

  /** Every attempt recorded for a card, oldest first. */
  const attemptsFor = (cardId: string): { summary: AttemptSummary; path: string }[] => {
    if (!existsSync(evidenceDir)) return [];
    const found: { summary: AttemptSummary; path: string }[] = [];
    for (const name of readdirSync(evidenceDir)) {
      if (!/^ev_[A-Za-z0-9]+\.json$/.test(name)) continue;
      const path = join(evidenceDir, name);
      const ev = readJsonCached<EvidenceBundle>(path);
      if (!ev || ev.cardId !== cardId) continue;
      found.push({
        path,
        summary: {
          attempt: 0,
          evidenceId: ev.id,
          createdAt: ev.createdAt,
          passed: ev.passed,
          stopReason: ev.stopReason,
        },
      });
    }
    found.sort((a, b) => a.summary.createdAt.localeCompare(b.summary.createdAt));
    found.forEach((f, i) => {
      f.summary.attempt = i + 1;
    });
    return found;
  };

  /**
   * The staged acceptance tests' source, so Review can show the lines a failure
   * points at in a protected file the Worker never touched. Names come from the
   * card record and are reduced to a basename inside `acceptance/`.
   */
  const acceptanceSources = (card: CardRecord) =>
    (card.acceptanceTests ?? []).flatMap((name) => {
      const file = join(repoPath, "acceptance", basename(name));
      try {
        if (!existsSync(file) || statSync(file).size > 256_000) return [];
        return [{ name, path: `tests/${basename(name)}`, content: readFileSync(file, "utf8") }];
      } catch {
        return [];
      }
    });

  /** The transition that put each card in its current column: when, by whom, why. */
  const statusEntries = () => {
    const rows = options.db
      .prepare(
        `SELECT e.card_id AS cardId, e.actor AS actor, e.payload AS payload, e.created_at AS at
         FROM events e
         JOIN (SELECT card_id, MAX(seq) AS seq FROM events
               WHERE type = 'card/status_changed' GROUP BY card_id) last
           ON e.seq = last.seq`,
      )
      .all() as { cardId: string; actor: string; payload: string; at: string }[];
    const map = new Map<
      string,
      { actor: string; toStatus?: string; reason?: string; at: string }
    >();
    for (const row of rows) {
      try {
        const p = JSON.parse(row.payload) as {
          toStatus?: string;
          reason?: string;
          updatedAt?: string;
        };
        map.set(row.cardId, {
          actor: row.actor,
          at: p.updatedAt ?? row.at,
          ...(p.toStatus ? { toStatus: p.toStatus } : {}),
          ...(p.reason ? { reason: p.reason } : {}),
        });
      } catch {
        // A malformed payload leaves the card without a wait time, nothing worse.
      }
    }
    return map;
  };

  /** A card with its presentation (`display`) derived by the shared vocabulary. */
  const withDisplay = (
    card: CardRecord,
    all: CardRecord[],
    entries: ReturnType<typeof statusEntries>,
    now: number,
  ) => {
    const config = gatesConfig();
    const entry = entries.get(card.id);
    const current = entry && entry.toStatus === card.status ? entry : undefined;
    const waitsOn = (card.dependsOn ?? [])
      .map((id) => all.find((c) => c.id === id))
      .filter((c): c is CardRecord => c !== undefined && c.status !== "done")
      .map((c) => ({ id: c.id, title: parseTitle(c.title).title }));
    const evidence = latestEvidence(card.id);
    const display = describeCard(card, {
      now,
      ...(evidence ? { evidence } : {}),
      enteredColumnAt: current?.at ?? card.createdAt,
      ...(current?.reason ? { statusReason: current.reason } : {}),
      ...(current?.actor ? { statusActor: current.actor } : {}),
      waitsOn,
      configuredGates: config.gates.map((g) => ({ id: g.id, rung: g.rung })),
      limits: { maxFiles: config.project.maxFiles, maxDiffLines: config.project.maxDiffLines },
    });
    return { ...card, display };
  };

  /** Board state with every card's `display` filled in. */
  const boardWithEvidence = async () => {
    const state = await boardService.getBoardState();
    const entries = statusEntries();
    const now = Date.now();
    return {
      ...state,
      cards: state.cards.map((card) => withDisplay(card, state.cards, entries, now)),
    };
  };

  let reviewMinutesPerDay = 60;
  try {
    reviewMinutesPerDay = resolveConfig({ repoPath }).config.review.reviewMinutesPerDay;
  } catch {
    // An unreadable config keeps the documented default.
  }
  let gitUser: string | undefined;
  try {
    gitUser =
      execFileSync("git", ["config", "user.name"], { cwd: repoPath, encoding: "utf8" }).trim() ||
      undefined;
  } catch {
    gitUser = undefined;
  }
  let version = "0.0.0";
  try {
    version = (
      JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
        version: string;
      }
    ).version;
  } catch {
    // Version is informational.
  }

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
    const [url = "/", search = ""] = (req.url || "/").split("?");
    const query = new URLSearchParams(search);

    if (url === "/" || url === "/index.html") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(html);
      return;
    }

    // The page's ES modules and stylesheets, straight from packages/ui/web.
    // The two pure presentation modules come from the compiled package, so the
    // browser runs the same vocabulary the server used to build `display`.
    if (url.startsWith("/app/")) {
      const rel = url.slice("/app/".length);
      const lib = /^lib\/([a-z]+\.js)$/.exec(rel)?.[1];
      const path =
        lib && (UI_LIB_MODULES as readonly string[]).includes(lib)
          ? resolveStaticPath(UI_LIB_DIR, lib)
          : lib
            ? undefined
            : resolveStaticPath(UI_WEB_DIR, rel);
      if (!path) {
        json(res, 404, { error: "Not Found", path: url });
        return;
      }
      serveFile(res, path);
      return;
    }

    if (url === "/vocab.json") {
      json(res, 200, vocabularyTables());
      return;
    }

    if (url === "/favicon.svg" || url === "/favicon.ico") {
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=86400" });
      res.end(faviconSvg());
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

    // Evidence for a card: the latest attempt by default, or `?attempt=n`.
    const evidenceMatch = new RegExp(`^/api/evidence/(${CARD_ID})$`).exec(url);
    if (evidenceMatch) {
      const cardId = evidenceMatch[1] as string;
      const wanted = query.get("attempt");
      if (wanted !== null) {
        const n = Number(wanted);
        const hit = attemptsFor(cardId).find((a) => a.summary.attempt === n);
        if (!Number.isInteger(n) || !hit) {
          json(res, 404, { error: `No attempt ${wanted} recorded for this card` });
          return;
        }
        json(res, 200, readJsonCached(hit.path));
        return;
      }
      const path = join(evidenceDir, `latest-${cardId}.json`);
      if (!existsSync(path)) {
        json(res, 404, { error: "No evidence recorded for this card yet" });
        return;
      }
      json(res, 200, JSON.parse(readFileSync(path, "utf8")));
      return;
    }

    // One card with its presentation and its attempt history.
    const cardMatch = new RegExp(`^/api/cards/(${CARD_ID})$`).exec(url);
    if (cardMatch && req.method !== "POST") {
      const state = await boardService.getBoardState();
      const card = state.cards.find((c) => c.id === cardMatch[1]);
      if (!card) {
        json(res, 404, { error: `No card ${cardMatch[1]}` });
        return;
      }
      json(res, 200, {
        card: withDisplay(card, state.cards, statusEntries(), Date.now()),
        attempts: attemptsFor(card.id).map((a) => a.summary),
        acceptance: acceptanceSources(card),
      });
      return;
    }

    // The gate contract, in execution order, so the UI can show declared gates
    // that never ran and flag a contract that hashed to nothing.
    if (url === "/api/gates") {
      const config = gatesConfig();
      json(res, 200, {
        gates: config.gates.map((g) => ({
          id: g.id,
          rung: g.rung,
          layer: g.layer,
          label: gateLabel(g.rung),
          blocking: g.blocking,
          command: [g.command, ...g.args].join(" "),
        })),
        protected: config.project.protected,
        maxFiles: config.project.maxFiles,
        maxDiffLines: config.project.maxDiffLines,
        sha256: config.sha256,
        empty: config.sha256 === EMPTY_SHA256,
      });
      return;
    }

    if (url === "/api/meta") {
      json(res, 200, {
        project: basename(repoPath),
        repoPath,
        triage: options.cardStore !== undefined,
        reviewMinutesPerDay,
        version,
        ...(gitUser ? { gitUser } : {}),
      });
      return;
    }

    const action = new RegExp(`^/api/cards/(${CARD_ID})/(accept|return|park)$`).exec(url);
    if (action && req.method === "POST") {
      if (!isTrustedMutation(req)) {
        json(res, 403, { error: "Triage actions must come from the dashboard itself" });
        return;
      }
      const store = options.cardStore;
      if (!store) {
        json(res, 501, { error: "This server was started read-only" });
        return;
      }
      const [, cardId, verb] = action as unknown as [string, string, string];
      const card = await store.getCard(cardId);
      if (!card) {
        json(res, 404, { error: `No card ${cardId}` });
        return;
      }
      try {
        if (verb === "accept") {
          const sha = await acceptCard(
            {
              repoPath,
              restrictedMode: false,
              cardStore: store,
              boardService: boardService as never,
            },
            card,
          );
          json(res, 200, { ok: true, status: "done", sha });
          return;
        }

        const body = await readJsonBody(req);
        const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 2000) : "";
        if (verb === "return" && !reason) {
          json(res, 400, { error: "A return needs a reason: it is what the agent is told next" });
          return;
        }

        const to = verb === "return" ? "ready" : "parked";
        await boardService.transitionCard({
          cardId,
          fromStatus: card.status,
          toStatus: to,
          actor: "human",
          reason:
            verb === "return" ? `returned: ${reason}` : `parked${reason ? `: ${reason}` : ""}`,
        });

        if (verb === "return") {
          // Every return reason is a candidate playbook rule (design §820):
          // the correction a human had to make once should not be needed twice.
          const dir = join(repoPath, ".sekhemet");
          mkdirSync(dir, { recursive: true });
          appendFileSync(
            join(dir, "playbook_candidates.jsonl"),
            `${JSON.stringify({ cardId, reason, at: new Date().toISOString() })}\n`,
          );
        }
        json(res, 200, { ok: true, status: to });
      } catch (err) {
        json(res, 409, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (url === "/api/queue") {
      const path = join(repoPath, ".sekhemet", "queue_report.json");
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
