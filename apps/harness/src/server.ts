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
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { DecisionStore } from "@sekhemet/planner";
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
import {
  type MemorySample,
  latestByCard,
  listRuns,
  liveSteps,
  machineMemory,
  playbookSnapshot,
  queryEvents,
  readTranscript,
  sampleMemory,
  transcriptFiles,
  worktrees,
} from "./dashboard_api.js";
import { runDoctor } from "./doctor.js";
import {
  acceptCard,
  explainCard,
  forkCard,
  releaseHeldCards,
  requestAbort,
  rewindCard,
} from "./execute.js";
import { learnFromSendBack } from "./learning/reflect.js";
import { startNotifier } from "./notify.js";
import { createPmApi } from "./pm_api.js";
import { handleRestExtras } from "./rest_extra.js";
import { generateDashboardHtml } from "./ui_html.js";
import { handleWave2Route } from "./wave2_server.js";
import { type StreamClient, acceptWebSocket } from "./ws.js";

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
  /** Memory reader for /api/machine; injectable so tests can cross thresholds. */
  memoryProbe?: () => MemorySample;
  /** How often the stream pushes a `machine` event, in stream ticks. */
  machineEveryTicks?: number;
  /** The PM's model (default dirk-27b). */
  pmModel?: string;
  /** Injectable PM model, for tests; production builds one from `pmModel`. */
  pmAdapter?: () => LocalInferenceAdapter;
  /** Injectable memory-pressure reader, for tests. */
  pressureLevel?: () => number | undefined;
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

/** Ledger facts the board derives display from, besides status changes. */
const FACT_TYPES = ["card/step", "card/accepted"];

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

  // SSE responses and WebSocket clients (ws.ts) share one broadcaster.
  const streams = new Set<StreamClient>();
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
  // The PM conversation, proposals, cycles, inline edits, flow metrics and
  // integrations (docs/design/PM_CONTRACT.md) live in their own module.
  const pmApi = createPmApi({
    repoPath,
    log,
    boardService,
    ...(options.cardStore ? { cardStore: options.cardStore } : {}),
    ...(options.pmModel ? { pmModel: options.pmModel } : {}),
    ...(options.pmAdapter ? { pmAdapter: options.pmAdapter } : {}),
    ...(options.pressureLevel ? { pressureLevel: options.pressureLevel } : {}),
    json,
    readJsonBody,
    isTrustedMutation,
  });
  const memoryProbe = options.memoryProbe ?? sampleMemory;
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
        `SELECT e.card_id AS cardId, e.actor AS actor, e.payload AS payload, e.created_at AS at,
                e.seq AS seq
         FROM events e
         JOIN (SELECT card_id, MAX(seq) AS seq FROM events
               WHERE type = 'card/status_changed' GROUP BY card_id) last
           ON e.seq = last.seq`,
      )
      .all() as { cardId: string; actor: string; payload: string; at: string; seq: number }[];
    const map = new Map<
      string,
      { actor: string; toStatus?: string; reason?: string; at: string; seq: number }
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
          seq: row.seq,
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
    facts: ReturnType<typeof latestByCard> = latestByCard(options.db, FACT_TYPES),
  ) => {
    const config = gatesConfig();
    const entry = entries.get(card.id);
    const mine = facts.get(card.id);
    const step = mine?.get("card/step");
    // Only a step from the attempt in progress describes what the card is doing.
    const lastStep =
      card.status === "in_progress" && step && step.seq > (entry?.seq ?? 0)
        ? (step.payload as { turn: number; calls?: { name: string; target?: string }[] })
        : undefined;
    const accepted = mine?.get("card/accepted")?.payload as { sha?: string } | undefined;
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
      ...(lastStep ? { lastStep } : {}),
      ...(card.status === "done" && accepted?.sha ? { acceptedSha: accepted.sha } : {}),
      configuredGates: config.gates.map((g) => ({ id: g.id, rung: g.rung })),
      limits: { maxFiles: config.project.maxFiles, maxDiffLines: config.project.maxDiffLines },
    });
    return { ...card, display };
  };

  /** Board state with every card's `display` filled in. */
  const boardWithEvidence = async (projectId?: string) => {
    const state = await boardService.getBoardState(projectId ? { projectId } : {});
    const entries = statusEntries();
    const facts = latestByCard(options.db, FACT_TYPES);
    const now = Date.now();
    const cycles = await pmApi.pmStore.cycles();
    // Epics with roll-up progress (PM_CONTRACT §3): done/total cards and points.
    const epics = state.cards
      .filter((c) => c.tier === "epic")
      .map((epic) => {
        const children = state.cards.filter((c) => c.epicId === epic.id);
        const done = children.filter((c) => c.status === "done");
        return {
          id: epic.id,
          title: epic.title,
          progress: {
            done: done.length,
            total: children.length,
            points: children.reduce((n, c) => n + (c.estimate ?? 0), 0),
            pointsDone: done.reduce((n, c) => n + (c.estimate ?? 0), 0),
          },
        };
      });
    return {
      ...state,
      cards: state.cards.map((card) => withDisplay(card, state.cards, entries, now, facts)),
      epics,
      cycles,
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
      const pmFrames = (await pmApi.streamFrames(events)).join("");
      for (const res of streams) {
        // A slow or dead client must not stall the others.
        try {
          res.write(frame + pmFrames);
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

    // H12: workspace, project board and cards, split, run, gate, evidence, calibrate.
    if (
      url.startsWith("/api/") &&
      (await handleRestExtras(req, res, url, {
        repoPath,
        cardStore: options.cardStore,
        boardService,
        log,
        json,
        readJsonBody,
        trusted: isTrustedMutation,
      }))
    ) {
      return;
    }

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
      // The first memory reading goes out at once, not five seconds later.
      res.write(
        `event: machine\ndata: ${JSON.stringify({ memory: machineMemory(memoryProbe()) })}\n\n`,
      );
      streams.add(res);

      const latest = await log.getLastEvent();
      lastSeq = Math.max(lastSeq, latest?.seq ?? 0);

      req.on("close", () => {
        streams.delete(res);
      });
      return;
    }

    if (url === "/api/board") {
      // B8: ?project=<id> scopes the board to one project.
      json(res, 200, await boardWithEvidence(query.get("project") ?? undefined));
      return;
    }

    if (url === "/api/projects" && req.method !== "POST") {
      json(res, 200, {
        projects: options.cardStore?.listProjects() ?? [],
        activeCap: options.cardStore?.activeProjectCap,
      });
      return;
    }

    if (url === "/api/wip") {
      json(res, 200, { limits: await boardService.checkWipLimits() });
      return;
    }

    if (url === "/api/events") {
      const paged = ["card", "since", "before", "limit", "order", "type", "actor"].some((k) =>
        query.has(k),
      );
      if (!paged) {
        // The original contract: the first 200 events, oldest first.
        const [events, verification] = await Promise.all([
          log.getEvents(1, 200),
          log.verifyHashChain(),
        ]);
        json(res, 200, { events, verification });
        return;
      }
      const num = (k: string) => {
        const v = query.get(k);
        return v !== null && /^\d+$/.test(v) ? Number(v) : undefined;
      };
      const q = {
        ...(query.get("card") ? { card: query.get("card") as string } : {}),
        ...(query.get("type") ? { type: query.get("type") as string } : {}),
        ...(query.get("actor") ? { actor: query.get("actor") as string } : {}),
        ...(num("since") !== undefined ? { since: num("since") } : {}),
        ...(num("before") !== undefined ? { before: num("before") } : {}),
        ...(num("limit") !== undefined ? { limit: num("limit") } : {}),
        order: query.get("order") === "asc" ? ("asc" as const) : ("desc" as const),
      };
      const [page, verification] = [queryEvents(options.db, q), await log.verifyHashChain()];
      json(res, 200, { ...page, verification });
      return;
    }

    // One attempt's steps: the transcript file, or live `card/step` events
    // while the card is still running and the transcript is not yet written.
    const transcriptMatch = new RegExp(`^/api/cards/(${CARD_ID})/transcript$`).exec(url);
    if (transcriptMatch) {
      const cardId = transcriptMatch[1] as string;
      const files = transcriptFiles(repoPath, cardId);
      const card = (await boardService.getBoardState()).cards.find((c) => c.id === cardId);
      if (!card) {
        json(res, 404, { error: `No card ${cardId}` });
        return;
      }
      const wanted = query.get("attempt");
      const running = card.status === "in_progress";
      const total = files.length + (running ? 1 : 0);
      const n = wanted !== null ? Number(wanted) : total;
      if (total === 0) {
        json(res, 200, { attempt: 0, attempts: 0, file: null, live: false, steps: [] });
        return;
      }
      if (!Number.isInteger(n) || n < 1 || n > total) {
        json(res, 404, { error: `No attempt ${wanted} recorded for this card` });
        return;
      }
      if (running && n === total) {
        json(res, 200, {
          attempt: n,
          attempts: total,
          file: null,
          live: true,
          steps: liveSteps(options.db, cardId),
        });
        return;
      }
      const file = files[n - 1] as string;
      json(res, 200, {
        attempt: n,
        attempts: total,
        file: basename(file),
        live: false,
        steps: readTranscript(file),
      });
      return;
    }

    // Run history: every queue scorecard, newest first.
    if (url === "/api/runs") {
      json(res, 200, { runs: listRuns(repoPath).runs });
      return;
    }
    const runMatch = /^\/api\/runs\/([\w.-]+)$/.exec(url);
    if (runMatch) {
      const path = listRuns(repoPath).reports.get(runMatch[1] as string);
      if (!path) {
        json(res, 404, { error: `No run ${runMatch[1]}` });
        return;
      }
      json(res, 200, { id: runMatch[1], ...JSON.parse(readFileSync(path, "utf8")) });
      return;
    }

    // The machine: memory against its thresholds, the model, health checks.
    if (url === "/api/machine") {
      if (query.get("fresh") === "1") doctorCache = undefined;
      const doctor = await cachedDoctor();
      const inference = doctor.checks.find((c) => c.name === "Local inference socket");
      const served = (/model\(s\): (.+)$/.exec(inference?.detail ?? "")?.[1] ?? "")
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
      json(res, 200, {
        memory: machineMemory(memoryProbe()),
        models: {
          endpoint: /^(\S+) reachable/.exec(inference?.detail ?? "")?.[1],
          reachable: inference ? inference.status !== "fail" : false,
          served,
        },
        checks: doctor.checks,
        ok: doctor.ok,
        checkedAt: new Date(doctorCache?.at ?? Date.now()).toISOString(),
        worktrees: worktrees(repoPath),
      });
      return;
    }

    if (url === "/api/playbook") {
      json(res, 200, playbookSnapshot(repoPath));
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
    if (cardMatch && req.method === "GET") {
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
          // The reason is a directive for the card's next attempt: it goes into
          // the card's dossier, which the runner puts in the Worker's prompt.
          await store
            .recordDossierEntry({ cardId, kind: "send_back", text: reason, actor: "human" })
            .catch(() => undefined);
          // The note teaches both the Worker (a candidate rule) and Seshat (the profile).
          await learnFromSendBack(pmApi.learning, card, reason).catch(() => undefined);
          // Every return reason is a candidate playbook rule (design §820):
          // the correction a human had to make once should not be needed twice.
          const dir = join(repoPath, ".sekhemet");
          mkdirSync(dir, { recursive: true });
          appendFileSync(
            join(dir, "playbook_candidates.jsonl"),
            `${JSON.stringify({ cardId, reason, at: new Date().toISOString() })}\n`,
          );
        }
        // A card left Review: cards held on back-pressure can move now.
        if (card.status === "review") {
          await releaseHeldCards({
            repoPath,
            restrictedMode: false,
            cardStore: store,
            boardService: boardService as never,
          }).catch(() => []);
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
      if (query.get("fresh") === "1") doctorCache = undefined;
      json(res, 200, await cachedDoctor());
      return;
    }

    // --- Human commands (B12), runner control (L25, H18, H19), order (B11) -----
    const explainMatch = new RegExp(`^/api/cards/(${CARD_ID})/explain$`).exec(url);
    if (explainMatch && options.cardStore) {
      try {
        json(res, 200, {
          lines: await explainCard(
            {
              repoPath,
              restrictedMode: false,
              cardStore: options.cardStore,
              boardService: boardService as never,
            },
            explainMatch[1] as string,
          ),
        });
      } catch (err) {
        json(res, 404, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    const command = new RegExp(
      `^/api/cards/(${CARD_ID})/(abort|rewind|fork|override|reroute|reorder)$`,
    ).exec(url);
    const projectMatch = /^\/api\/projects\/(proj_[A-Za-z0-9_-]+)$/.exec(url);
    if ((command || projectMatch) && req.method === "POST") {
      if (!isTrustedMutation(req)) {
        json(res, 403, { error: "Commands must come from the dashboard itself" });
        return;
      }
      const store = options.cardStore;
      if (!store) {
        json(res, 501, { error: "This server was started read-only" });
        return;
      }
      const ctx = {
        repoPath,
        restrictedMode: false,
        cardStore: store,
        boardService: boardService as never,
      };
      try {
        const body = await readJsonBody(req);
        if (projectMatch) {
          // Pause or resume a project (B13 cap), set its review hours (B3).
          const id = projectMatch[1] as string;
          if (typeof body.reviewMinutesPerDay === "number") {
            await store.setProjectReviewMinutes(id, body.reviewMinutesPerDay, "human");
            const limit = await (
              boardService as unknown as { calibrateReviewWip(m: number): Promise<number> }
            ).calibrateReviewWip(body.reviewMinutesPerDay);
            json(res, 200, { project: store.getProject(id), reviewWip: limit });
            return;
          }
          const status = body.status;
          if (status !== "active" && status !== "paused" && status !== "archived") {
            json(res, 400, { error: "status must be active, paused or archived" });
            return;
          }
          json(res, 200, { project: await store.setProjectStatus(id, status, "human") });
          return;
        }
        const [, cardId, verb] = command as unknown as [string, string, string];
        const card = await store.getCard(cardId);
        if (!card) {
          json(res, 404, { error: `No card ${cardId}` });
          return;
        }
        if (verb === "abort") {
          const reason = typeof body.reason === "string" ? body.reason : "";
          await requestAbort(store, cardId, reason || "stopped from the dashboard");
          json(res, 200, { ok: true, requested: "abort" });
          return;
        }
        if (verb === "rewind" || verb === "fork") {
          const step = Number(body.step);
          if (!Number.isInteger(step) || step < 0) {
            json(res, 400, { error: "A step number is required" });
            return;
          }
          const r =
            verb === "fork"
              ? await forkCard(
                  ctx,
                  cardId,
                  step,
                  typeof body.attemptId === "string" ? body.attemptId : undefined,
                )
              : await rewindCard(ctx, cardId, step);
          json(res, 200, { ok: true, ...r });
          return;
        }
        if (verb === "override") {
          // Past an entry condition or an illegal edge, as a recorded human decision (B1).
          const to = body.toStatus;
          const reason = typeof body.reason === "string" ? body.reason.trim() : "";
          if (typeof to !== "string" || !reason) {
            json(res, 400, { error: "An override needs toStatus and a reason" });
            return;
          }
          await boardService.transitionCard({
            cardId,
            fromStatus: card.status,
            toStatus: to as never,
            actor: "human",
            reason: `override: ${reason}`,
          });
          json(res, 200, { ok: true, status: to });
          return;
        }
        if (verb === "reroute") {
          // Which model runs the card next (B12 "reroute").
          const executor = typeof body.executor === "string" ? body.executor : undefined;
          const planner = typeof body.planner === "string" ? body.planner : undefined;
          if (!executor && !planner) {
            json(res, 400, { error: "Name an executor or a planner" });
            return;
          }
          const updated = await store.updateCard(
            cardId,
            {
              modelRoute: {
                ...(card.modelRoute ?? {}),
                ...(executor ? { executor } : {}),
                ...(planner ? { planner } : {}),
              },
            },
            "human",
          );
          json(res, 200, { ok: true, modelRoute: updated.modelRoute });
          return;
        }
        // reorder (B11): place the card between two neighbours.
        const updated = await store.reorderCard(cardId, {
          ...(typeof body.afterCardId === "string" ? { afterCardId: body.afterCardId } : {}),
          ...(typeof body.beforeCardId === "string" ? { beforeCardId: body.beforeCardId } : {}),
        });
        json(res, 200, { ok: true, orderKey: updated.orderKey });
      } catch (err) {
        json(res, 409, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // --- Run records, decisions, integrity (K8, K16-K20, S8) ------------------
    if (url === "/api/integrity") {
      const chain = await log.verifyHashChain();
      const projections = options.cardStore
        ? await options.cardStore.verifyProjections()
        : undefined;
      json(res, 200, { chain, ...(projections ? { projections } : {}) });
      return;
    }

    const attemptsMatch = new RegExp(`^/api/cards/(${CARD_ID})/attempts$`).exec(url);
    if (attemptsMatch && options.cardStore) {
      const runs = options.cardStore.runs;
      const attempts = runs.listAttempts(attemptsMatch[1] as string).map((a) => ({
        ...a,
        steps: runs.listSteps(a.id),
        gates: runs.listGateResults(a.id),
      }));
      json(res, 200, { attempts, evidence: runs.listEvidence(attemptsMatch[1] as string) });
      return;
    }

    if (url === "/api/decisions" && req.method !== "POST") {
      if (!options.cardStore) {
        json(res, 200, { decisions: [] });
        return;
      }
      const status = query.get("status");
      json(res, 200, {
        decisions: options.cardStore.runs.listDecisions(
          status === "pending" || status === "answered" || status === "timed_out"
            ? status
            : undefined,
        ),
      });
      return;
    }

    const decisionMatch = /^\/api\/decisions\/(dec_[A-Za-z0-9_-]+)$/.exec(url);
    if (decisionMatch && req.method === "POST") {
      if (!isTrustedMutation(req)) {
        json(res, 403, { error: "Decisions must come from the dashboard itself" });
        return;
      }
      if (!options.cardStore) {
        json(res, 501, { error: "This server was started read-only" });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const decision = options.cardStore.runs.getDecision(decisionMatch[1] as string);
        const option =
          typeof body.option === "number"
            ? body.option
            : typeof body.answer === "string"
              ? (decision?.options.indexOf(body.answer) ?? -1)
              : -1;
        // A planner decision resumes its card when answered (P11).
        if (decision?.kind === "planner") {
          const d = await new DecisionStore({ store: options.cardStore, log }).answer(
            decisionMatch[1] as string,
            option,
            "human",
          );
          json(res, 200, { decision: d.record });
          return;
        }
        json(res, 200, {
          decision: await options.cardStore.runs.answerDecision(
            decisionMatch[1] as string,
            option,
            "human",
          ),
        });
      } catch (err) {
        json(res, 409, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // Planner decisions, goals, standup, signals, the structural diff and the
    // GitHub webhook (wave2_server.ts).
    if (
      await handleWave2Route(req, res, url, {
        repoPath,
        ...(options.cardStore ? { cardStore: options.cardStore } : {}),
        log,
        json,
        isTrustedMutation,
        readJsonBody,
      })
    ) {
      return;
    }

    if (url.startsWith("/api/") && (await pmApi.handle(req, res, url, query))) return;

    json(res, 404, { error: "Not Found", path: url });
  });

  // K6: appends made in this process (triage, PM, decisions) reach the
  // stream at once through the log's subscription; the timer below stays as
  // the fallback for writers in other processes (the queue), which share
  // only the database file.
  let pumpQueued = false;
  const unsubscribe = log.subscribe({}, () => {
    if (pumpQueued || streams.size === 0) return;
    pumpQueued = true;
    setImmediate(() => {
      pumpQueued = false;
      void pump();
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => {
      let ticks = 0;
      timer = setInterval(() => {
        void pump();
        // Memory is pushed on its own cadence: cheap to read, and the sidebar
        // and Machine view should move without a ledger event to carry them.
        ticks++;
        if (streams.size > 0 && ticks % (options.machineEveryTicks ?? 5) === 0) {
          const frame = `event: machine\ndata: ${JSON.stringify({ memory: machineMemory(memoryProbe()) })}\n\n`;
          for (const res of streams) {
            try {
              res.write(frame);
            } catch {
              streams.delete(res);
            }
          }
        }
      }, options.streamIntervalMs ?? 1000);
      // Never hold the process open for the stream ticker alone.
      timer.unref?.();

      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      // H20: push review, park, budget and question events to the user's
      // ntfy or Gotify, when set up. A no-op until then.
      const notifier = startNotifier(options.log, repoPath, {
        dashboard: `http://127.0.0.1:${boundPort}`,
      });
      resolve({
        port: boundPort,
        close: () =>
          new Promise<void>((done) => {
            void notifier.then((n) => n.stop());
            if (timer) clearInterval(timer);
            unsubscribe();
            for (const stream of streams) stream.end();
            streams.clear();
            server.close(() => done());
          }),
      });
    });

    // H1: the same live stream over WebSocket, at /api/ws (loopback origins only).
    server.on("upgrade", (req, socket) => {
      if ((req.url ?? "").split("?")[0] !== "/api/ws") {
        socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
        return;
      }
      const client = acceptWebSocket(req, socket, (c) => streams.delete(c));
      if (client) {
        streams.add(client);
        void pump();
      }
    });
    server.on("error", reject);
  });
}
