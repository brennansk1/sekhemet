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
import {
  CARD_STATUSES,
  type CardRecord,
  type CardStore,
  EventLog,
  type EventRecord,
  PRINCIPAL_PATTERN,
  STOP_REASONS,
  isCardStatus,
} from "@sekhemet/kernel";
import type { LocalInferenceAdapter, ModelRole } from "@sekhemet/models";
import { DecisionStore } from "@sekhemet/planner";
import {
  ACCOUNT_COPY,
  type RosterRoleLike,
  UI_LIB_DIR,
  UI_LIB_MODULES,
  UI_WEB_DIR,
  appIconSvg,
  describeCard,
  gateLabel,
  generateTokenCss,
  generateTokenJson,
  parseTitle,
  runningCheckText,
  vocabularyTables,
} from "@sekhemet/ui";
import { checkoutNotice, integrationBranch } from "./accept.js";
import { unenforcedInvariants } from "./architecture_gate.js";
import { createBenchmarkApi } from "./benchmark_api.js";
import { type BenchmarkEnv, BenchmarkService, defaultBenchmarkEnv } from "./benchmark_cmd.js";
import {
  cardMessages,
  handBack,
  postCardMessage,
  requestPause,
  submitTakenOver,
  takeOver,
} from "./collaborate.js";
import { resolveConfig, userConfigPath } from "./config.js";
import { type ConfigApiDeps, createConfigApi } from "./config_api.js";
import { effectiveConfig, queueDefaults } from "./config_apply.js";
import {
  type MemorySample,
  activeHardwareTier,
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
import { dashboardQualify, dashboardResidency, dashboardSpeed } from "./dashboard_models.js";
import { runDoctor } from "./doctor.js";
import {
  acceptCard,
  explainCard,
  forkCard,
  releaseHeldCards,
  requestAbort,
  rewindCard,
} from "./execute.js";
import { readLiveGate } from "./live_gate.js";
import {
  type ModelAccess,
  describeModel,
  resolveWorkerName,
  sharedModelAccess,
} from "./model_access.js";
import { startNotifier } from "./notify.js";
import { handlePlanApprovalRoute } from "./plan_approval.js";
import { startGoalTicker } from "./planner_live.js";
import { audienceFromAccess } from "./pm/audience.js";
import { attachDocuments, documentsToAttach } from "./pm/documents.js";
import { dailyStandup } from "./pm/service.js";
import { PmStore } from "./pm/store.js";
import { createPmApi } from "./pm_api.js";
import { modelRoster } from "./pm_api.js";
import { describeError } from "./process_errors.js";
import { projectsOverview } from "./projects_api.js";
import { gateWorker } from "./qualify.js";
import { handleRestExtras } from "./rest_extra.js";
import { reviewDesk } from "./review_desk.js";
import { runnerLease } from "./runner_lease.js";
import { qualifiedSlotCapacity, slotWaitReason } from "./slot_lease.js";
import { PresenceRecorder } from "./smart_swap.js";
import {
  Access,
  AccessRefusedError,
  LastAdminError,
  type Level,
  parseSettingsPatch,
  recordLabelChange,
  recordLevelChange,
  recordSettingsChange,
  refuse,
  routePermissions,
} from "./team/access.js";
import { handleAiTeammateRoute } from "./team/ai_routes.js";
import { type AiTeammatesDeps, aiStates } from "./team/ai_teammates.js";
import { handleAuditRoute } from "./team/audit.js";
import { recordConfigAtStart, recordConfigWrite } from "./team/config_audit.js";
import { identityDir } from "./team/credential_store.js";
import { capNote, personOf, queueStanding, runningAgentIssues } from "./team/fair_queue.js";
import { type InboxDeps, inboxNotifier } from "./team/inbox.js";
import { handleInboxRoute } from "./team/inbox_routes.js";
import { allMembers, personName } from "./team/members.js";
import { Presence, handlePresenceRoute, presenceFrame } from "./team/presence.js";
import { requester as requesterOf } from "./team/requester.js";
import { handleReviewRoute } from "./team/review_routes.js";
import { acceptDismissal, openThreadRefusal, reviewThreads } from "./team/review_threads.js";
import { handleIdentityRoute, identityGate } from "./team/routes.js";
import {
  type ServerIdentityOptions,
  createServerIdentity,
  soloStartBlocked,
} from "./team/serve.js";
import { bindHost } from "./team/settings.js";
import { cardTrace } from "./tracing.js";
import { park, recordReviewOpened, reject, revertAccept, sendBack, unpark } from "./triage.js";
import { generateDashboardHtml } from "./ui_html.js";
import { hookEngineFor } from "./user_hooks.js";
import { approveBaseline, visualCandidates } from "./visual_baseline.js";
import { modelRegistry } from "./wave2.js";
import {
  handleWave2Route,
  reviewBrief,
  startGithubSync,
  startRecurringTicker,
} from "./wave2_server.js";
import {
  MISDIRECTED,
  SAFE_METHODS,
  allowedHosts,
  contentSecurityPolicy,
  hostAllowed,
  hostAllowlistWarning,
  mintMutationToken,
  sameOrigin,
  securityHeaders,
  tokenMatches,
} from "./web_guard.js";
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
  /** How often due recurring templates are cloned (X16); default a minute. */
  recurringEveryMs?: number;
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
  /** Solo or Team (teams §2.1); the user config's `[team] mode` when omitted. */
  setup?: "solo" | "team";
  /**
   * Who is asking (teams §2.3): a person's principal, or undefined when no
   * one is signed in. The install's person when omitted (Solo).
   */
  requester?: (req: IncomingMessage) => string | undefined;
  /**
   * Who a request is (teams §2.3, B4.10): Solo or Team from the user config
   * unless given, the credential store's directory, a clock.
   */
  identity?: ServerIdentityOptions;
  /** The address to bind (runtime item 26): loopback unless the Team setup allows another. */
  host?: string;
  /**
   * The Worker's qualified parallel slots (RUN-35), for the queue standing;
   * read from the qualification of the configured Worker when omitted.
   */
  parallelSlots?: () => number;
  /**
   * The residency scheduler the Configuration page loads and unloads through
   * (rule 20a); the process's shared one — Seshat's and the Researcher's —
   * when omitted. Tests pass one over fake adapters.
   */
  modelAccess?: ModelAccess;
  /** The adapter Qualify to assign measures (rule 27a); `describeModel` when omitted. */
  qualifyAdapter?: (model: string, role: ModelRole) => LocalInferenceAdapter;
  /** Adjust the benchmark's environment (tests script its runner); the real one when omitted. */
  benchmarkEnv?: (env: BenchmarkEnv) => BenchmarkEnv;
  /** Configuration's live headroom probe (rule 20g); `null` fits by total memory (tests). */
  headroomProbe?: ConfigApiDeps["headroomProbe"];
  /** The user config.toml (TEAM-44); `userConfigPath()` when omitted. */
  userConfigPath?: string;
}

/** A body the access check read already, so the route's handler reads the same one. */
const parsedBodies = new WeakMap<IncomingMessage, Record<string, unknown>>();

export { generateDashboardHtml };

/**
 * Read a JSON request body of at most `limit` bytes. Triage payloads are
 * tiny; a route that takes more passes its own limit (Seshat's messages, PM-N10-4).
 * The bytes are decoded once, whole, so a character split across two network
 * chunks arrives intact.
 */
async function readJsonBody(
  req: IncomingMessage,
  limit = 16_384,
): Promise<Record<string, unknown>> {
  const cached = parsedBodies.get(req);
  if (cached) return cached;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    bytes += buf.length;
    if (bytes > limit) throw new Error("request body too large");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const parsed = raw.trim() ? (JSON.parse(raw) as unknown) : {};
  const body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  parsedBodies.set(req, body);
  return body;
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
    // An answer is JSON and read as JSON, never sniffed into a page. The
    // guard's headers (the CSP, no framing, no referrer) are already set on
    // every response before any route runs (web_guard.ts).
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
  /** Who each stream is (Team): live output goes only to those who can see its project. */
  const streamPrincipal = new WeakMap<StreamClient, string>();
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
  // Who each request is (teams §2.1, §2.3): Solo's one person, or the Team
  // setup's sessions, tokens and trusted proxy.
  let serverIdentity: ReturnType<typeof createServerIdentity>;
  try {
    serverIdentity = createServerIdentity(options.db, log, repoPath, options.identity);
  } catch (err) {
    return Promise.reject(err);
  }
  const { identity } = serverIdentity;
  const setup: "solo" | "team" = options.setup ?? identity.mode;
  // M6: a Team install never falls back to Solo, where every request is an Admin.
  const refusal =
    setup === "solo"
      ? soloStartBlocked(options.db, options.identity?.dir ?? identityDir())
      : undefined;
  if (refusal) return Promise.reject(new Error(refusal));
  // TEAM-44: a change to the user config.toml made outside Sekhemet since the
  // last recorded state, recorded now by its keys, never its values.
  const credentialDir = options.identity?.dir ?? identityDir();
  const configPath = options.userConfigPath ?? userConfigPath();
  try {
    recordConfigAtStart({ db: options.db, log, path: configPath, identityDir: credentialDir });
  } catch (err) {
    return Promise.reject(err);
  }
  const host = bindHost(identity.mode, options.host, identity.settings);
  // Security item 37 (gap B-1): the names this server answers to (DNS
  // rebinding), this start's mutation token (Solo), and the headers every
  // response carries, the page's policy hashed from the page itself.
  const hosts = allowedHosts({
    bindHost: host,
    ...(identity.settings.publicUrl ? { publicUrl: identity.settings.publicUrl } : {}),
  });
  const hostWarning = hostAllowlistWarning({
    bindHost: host,
    ...(identity.settings.publicUrl ? { publicUrl: identity.settings.publicUrl } : {}),
  });
  if (hostWarning) console.warn(`sekhemet: ${hostWarning}`);
  const mutationToken = mintMutationToken();
  const guardHeaders = Object.entries(securityHeaders(contentSecurityPolicy(html)));
  /**
   * A write the dashboard's own page sent. Browsers cannot attach a custom
   * header cross-origin without a CORS preflight, which this server never
   * grants. In Solo, where every request is the install's one person at
   * Admin, the write also carries this start's token, which the page reads
   * from `GET /api/session` and no other site can (SEC-25). In either setup
   * any Origin must be the page's own: another loopback port is another site
   * (security item 25). In the Team setup a signed-in session's CSRF token is
   * checked by the identity layer (teams item 13); a request with no Origin
   * is a program's (a bearer token, the CLI), which a browser never sends
   * for a write; a page on the server's public name must be signed in.
   */
  const isTrustedMutation = (req: IncomingMessage): boolean => {
    if (req.headers["x-sekhemet-action"] !== "1") return false;
    const origin = req.headers.origin;
    if (!sameOrigin(origin, req.headers.host)) return false;
    if (identity.mode === "solo") {
      return tokenMatches(req.headers["x-sekhemet-csrf"], mutationToken);
    }
    if (!origin) return true;
    try {
      const url = new URL(origin);
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return true;
      const who = requesterOf(req);
      return who.authenticated && who.via !== "solo";
    } catch {
      return false;
    }
  };
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
    principalOf: (req) => principalOf(req),
    // planner-pm §2.8.5, §2.18 (B4.3): who Seshat answers, from the access module.
    audience: () => audienceFromAccess(() => access, options.db),
    // SEC-27c: the choice to keep secrets in a file is a config write, recorded with the person.
    userConfigPath: configPath,
    recordConfigWrite: (principal, write) =>
      recordConfigWrite(
        { db: options.db, log, path: configPath, identityDir: credentialDir, principal },
        write,
      ),
  });
  const memoryProbe = options.memoryProbe ?? sampleMemory;
  // Configuration's progress (scan, hash, download, copy, benchmark) goes out as `config` frames.
  const emitConfig = (data: Record<string, unknown>) => {
    const frame = `event: config\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of streams) {
      try {
        s.write(frame);
      } catch {
        streams.delete(s);
      }
    }
  };
  const configRegistry = modelRegistry();
  // Configuration › Models (B4.1 part b): Load and Unload through the
  // dashboard's one residency scheduler, Qualify to assign on this host,
  // and "Use the recommended models" through the benchmark's quick screen.
  const configApi = createConfigApi({
    repoPath,
    log,
    json,
    readJsonBody,
    isTrustedMutation,
    principalOf: (req) => principalOf(req),
    ...(options.userConfigPath ? { userConfigPath: options.userConfigPath } : {}),
    // TEAM-27, TEAM-44: Sekhemet's own config writes, recorded with the person.
    recordConfigWrite: (principal, write) =>
      recordConfigWrite(
        { db: options.db, log, path: configPath, identityDir: credentialDir, principal },
        write,
      ),
    registry: configRegistry,
    ...(options.headroomProbe !== undefined ? { headroomProbe: options.headroomProbe } : {}),
    ...(options.cardStore ? { cardStore: options.cardStore } : {}),
    // Review capacity (DB-N4-2): a project's limit from its own minutes a
    // day, recomputed for that project alone; who may change it, and why not.
    reviewLimitFacts: async (project) =>
      (
        boardService as { reviewLimitFacts?: (p?: string) => Promise<{ limit: number }> }
      ).reviewLimitFacts?.(project) ?? Promise.reject(new Error("no review limit")),
    mayChangeReviewCapacity: (req, project) => {
      const name = options.cardStore?.getProject(project)?.name;
      const d = access.decide(principalOf(req), "review.capacity", project, name, ceilingOf(req));
      return d.allowed ? { allowed: true } : { allowed: false, reason: d.message };
    },
    residency: dashboardResidency(() => {
      const access = options.modelAccess ?? sharedModelAccess();
      access.recordSwapsOn(log);
      return access;
    }),
    qualify: dashboardQualify({
      repoPath,
      registry: configRegistry,
      access: () => options.modelAccess ?? sharedModelAccess(),
      ...(options.qualifyAdapter ? { adapterFor: options.qualifyAdapter } : {}),
    }),
    // Measure speed (DB-NM14-3): llama-bench and the first token, a person's
    // confirmed load inside one benchmark run of the same scheduler.
    measureSpeed: dashboardSpeed({
      repoPath,
      access: () => {
        const access = options.modelAccess ?? sharedModelAccess();
        access.recordSwapsOn(log);
        return access;
      },
    }),
    startQuick: (combination, principal) => benchmarkService.startQuick(combination, principal),
    emit: emitConfig,
  });
  // Configuration › Benchmark (B4.1 part c): the two-tier benchmark, its fit
  // from the scanned models (MS-N5-5), each run's change as a `config` frame.
  const benchmarkBase = defaultBenchmarkEnv({
    repoPath,
    log,
    ...(options.cardStore ? { cardStore: options.cardStore } : {}),
    fit: (role, model) => configApi.fitCheck(role, model),
    onChange: (run) => emitConfig({ kind: "benchmark", run }),
    // Its models load through the dashboard's one residency scheduler (rule 20a).
    ...(options.modelAccess ? { modelAccess: options.modelAccess } : {}),
  });
  const benchmarkService = new BenchmarkService(
    options.benchmarkEnv ? options.benchmarkEnv(benchmarkBase) : benchmarkBase,
  );
  const benchmarkApi = createBenchmarkApi({
    service: benchmarkService,
    json,
    readJsonBody,
    isTrustedMutation,
    principalOf: (req) => principalOf(req),
    // Defence in depth behind `authorize`: every change is an Admin's (config.manage).
    mayManage: (req) =>
      access.decide(principalOf(req), "config.manage", undefined, undefined, ceilingOf(req))
        .allowed,
  });
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

  /**
   * When each card first entered In progress: the start of its work item age
   * (dashboard §2.4.4), which a retry that re-enters the column does not reset.
   */
  // Each card's first start into In progress (the tile's age): a card's
  // first start never changes on an append-only ledger, so each board build
  // reads only the entries since the last one — every stream frame builds a
  // board, and the whole ledger is never scanned again.
  const starts = new Map<string, string>();
  let startsThrough = 0;
  const firstStarts = (): ReadonlyMap<string, string> => {
    const top =
      (options.db.prepare("SELECT MAX(seq) AS seq FROM events").get() as { seq: number | null })
        .seq ?? 0;
    if (top < startsThrough) {
      starts.clear();
      startsThrough = 0;
    }
    if (top === startsThrough) return starts;
    const rows = options.db
      .prepare(
        `SELECT card_id AS cardId, payload, created_at AS at FROM events
         WHERE seq > ? AND seq <= ? AND type = 'card/status_changed'
           AND json_extract(payload, '$.toStatus') = 'in_progress'
         ORDER BY seq`,
      )
      .all(startsThrough, top) as { cardId: string; payload: string; at: string }[];
    for (const row of rows) {
      if (!row.cardId || starts.has(row.cardId)) continue;
      try {
        starts.set(
          row.cardId,
          (JSON.parse(row.payload) as { updatedAt?: string }).updatedAt ?? row.at,
        );
      } catch {
        starts.set(row.cardId, row.at);
      }
    }
    startsThrough = top;
    return starts;
  };

  /**
   * A person's name for the tile's owner monogram and delegate chip (dashboard
   * §2.4.4), from the ledger's `person/created`; the install's own person
   * without a recorded name reads as the repository's git user.
   */
  const namesOf = () => {
    const cache = new Map<string, string | undefined>();
    const local = log.localPrincipal();
    return (principal: string | undefined): string | undefined => {
      if (!principal) return undefined;
      if (!cache.has(principal)) {
        const name =
          personName(options.db, principal) ?? (principal === local ? gitUser : undefined);
        cache.set(principal, name);
      }
      return cache.get(principal);
    };
  };

  /** A card with its presentation (`display`) derived by the shared vocabulary. */
  const withDisplay = (
    card: CardRecord,
    all: CardRecord[],
    entries: ReturnType<typeof statusEntries>,
    now: number,
    facts: ReturnType<typeof latestByCard> = latestByCard(options.db, FACT_TYPES),
    starts: ReadonlyMap<string, string> = firstStarts(),
    nameOf: (principal: string | undefined) => string | undefined = namesOf(),
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
    const startedAt = starts.get(card.id);
    const ownerName = nameOf(card.owner);
    const delegateName = card.delegate?.kind === "person" ? nameOf(card.delegate.id) : undefined;
    // DB-N2-10: the check the card's process announced it is running.
    const runningGate = card.status === "verify" ? readLiveGate(repoPath, card.id) : undefined;
    const display = describeCard(card, {
      now,
      ...(evidence ? { evidence } : {}),
      enteredColumnAt: current?.at ?? card.createdAt,
      ...(current?.reason ? { statusReason: current.reason } : {}),
      ...(current?.actor ? { statusActor: current.actor } : {}),
      waitsOn,
      ...(lastStep ? { lastStep } : {}),
      ...(card.status === "done" && accepted?.sha ? { acceptedSha: accepted.sha } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(ownerName ? { ownerName } : {}),
      ...(delegateName ? { delegateName } : {}),
      ...(runningGate ? { runningGate } : {}),
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
    const starts = firstStarts();
    const nameOf = namesOf();
    // How the In review limit was reached, shown with it (dashboard DB-P3-9).
    const reviewLimit = await (
      boardService as {
        reviewLimitFacts?: (projectId?: string) => Promise<Record<string, unknown>>;
      }
    )
      .reviewLimitFacts?.(projectId)
      .catch(() => undefined);
    // Preferences → Estimation, the project's (DEC-31, DB-N7-2): named only
    // when the board is one project's (scoped, or the only one), off by default.
    const active = options.cardStore?.listProjects().filter((p) => p.status !== "archived") ?? [];
    const estimationProject = projectId ?? (active.length === 1 ? active[0]?.id : undefined);
    return {
      ...state,
      cards: state.cards.map((card) =>
        withDisplay(card, state.cards, entries, now, facts, starts, nameOf),
      ),
      epics,
      cycles,
      ...(reviewLimit ? { reviewLimit } : {}),
      ...(estimationProject
        ? { estimation: access.settings(estimationProject).estimation ?? "off" }
        : {}),
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

  /**
   * The Team stream's visibility (PM-N9-8, NEW-dashboard-3, as `liveAudience`
   * does for the model's output): an `append` frame carries, for each
   * person, only the events and board cards of the projects they can see,
   * and no event's private part — names, emails, token names and comment
   * text reach a page through the routes that check who asks, never the
   * broadcast. A person who can see nothing of the workspace (removed, or
   * never a member) gets no frame. `undefined` in Solo: its one person sees
   * everything.
   */
  /**
   * PM-N9-8: a person reads their own part of Seshat's thread, on the stream
   * as on `/api/pm/thread` — a message is its asker's, a reply its `to`'s;
   * one with neither reaches those who see every project.
   */
  const ownSeshatPart = (e: EventRecord, who: string, seesAll: boolean): boolean => {
    if (e.type === "pm/message") return e.principal ? e.principal === who : seesAll;
    if (e.type === "pm/reply") {
      const to = (e.payload as { to?: unknown } | null)?.to;
      return typeof to === "string" ? to === who : seesAll;
    }
    return true;
  };
  const appendView = async (
    events: EventRecord[],
    board: Awaited<ReturnType<typeof boardWithEvidence>>,
  ): Promise<
    | ((who: string | undefined) => {
        events: EventRecord[];
        board: Awaited<ReturnType<typeof boardWithEvidence>>;
      } | null)
    | undefined
  > => {
    if (setup !== "team") return undefined;
    const audience = audienceFromAccess(() => access, options.db);
    const projectOf = new Map<string, string | undefined>(
      board.cards.map((c) => [c.id, projectOfCard(c as unknown as CardRecord)]),
    );
    for (const e of events) {
      if (e.cardId && !projectOf.has(e.cardId)) {
        const card = options.cardStore ? await options.cardStore.getCard(e.cardId) : undefined;
        projectOf.set(e.cardId, projectOfCard(card ?? undefined));
      }
    }
    const eventProject = (e: EventRecord): string | undefined => {
      if (e.cardId) return projectOf.get(e.cardId);
      const p = (e.payload as { project?: unknown } | null)?.project;
      return typeof p === "string" ? p : undefined;
    };
    const projects = options.cardStore?.listProjects() ?? [];
    return (who) => {
      if (!who || !audience.canSee(who, undefined)) return null;
      const sees = (project: string | undefined) => audience.canSee(who, project);
      const seesAll = projects.every((p) => sees(p.id));
      return {
        events: events
          .filter((e) => sees(eventProject(e)) && ownSeshatPart(e, who, seesAll))
          .map(({ private: _private, ...e }) => e as EventRecord),
        board: {
          ...board,
          cards: board.cards.filter((c) => sees(projectOf.get(c.id))),
          epics: board.epics.filter((ep) => sees(projectOf.get(ep.id))),
        },
      };
    };
  };

  const pump = async (): Promise<void> => {
    if (streams.size === 0) return;
    try {
      const events = await log.getEvents(lastSeq + 1, 200);
      if (events.length === 0) return;

      lastSeq = events[events.length - 1]?.seq ?? lastSeq;
      const [board, verification] = await Promise.all([boardWithEvidence(), log.verifyHashChain()]);

      // `id:` is the last ledger seq in the frame: a reconnecting browser sends
      // it back as Last-Event-ID and the stream replays what it missed (U9).
      const frame = `id: ${lastSeq}\nevent: append\ndata: ${JSON.stringify({ events, board, verification })}\n\n`;
      const pmFrames = (await pmApi.streamFrames(events)).join("");
      // Team: each person's own frame, of what they can see (PM-N9-8).
      const view = await appendView(events, board);
      const byPerson = new Map<string, string | null>();
      for (const res of streams) {
        let out = frame + pmFrames;
        if (view) {
          const who = streamPrincipal.get(res) ?? "";
          if (!byPerson.has(who)) {
            const seen = view(who || undefined);
            byPerson.set(
              who,
              seen
                ? `id: ${lastSeq}\nevent: append\ndata: ${JSON.stringify({ ...seen, verification })}\n\n${pmFrames}`
                : null,
            );
          }
          const mine = byPerson.get(who);
          if (!mine) {
            // No longer in the workspace (removed while the page was open): the stream ends.
            streams.delete(res);
            try {
              res.end();
            } catch {
              // Already gone.
            }
            continue;
          }
          out = mine;
        }
        // A slow or dead client must not stall the others.
        try {
          res.write(out);
        } catch {
          streams.delete(res);
        }
      }
    } catch {
      // A transient read failure should not kill the pump.
    }
  };

  // --- Access (teams §2.2, NEW-teams-2; integrations items 24–27) ----------
  const access = new Access({ db: options.db, setup, localPrincipal: () => log.localPrincipal() });
  // The one resolver (team/requester.ts): the install's person in Solo.
  const requester =
    options.requester ??
    ((req: IncomingMessage) => {
      const who = requesterOf(req);
      return who.authenticated ? who.principal : undefined;
    });
  /** A personal token's scope: the ceiling of every check its request meets (B2, TEAM-37). */
  const ceilingOf = (req: IncomingMessage): Level | undefined => {
    if (options.requester) return undefined;
    const who = requesterOf(req);
    return who.authenticated && who.via === "token" ? who.scope : undefined;
  };
  const askers = new WeakMap<IncomingMessage, string>();
  // Smart Swap's presence (models rule 20e, C6): a person's dashboard request,
  // on the ledger at most once per 5 minutes each, read by the queue's scheduler.
  const presence = new PresenceRecorder(log);
  /** The person behind a write the access check passed; the install's person otherwise (Solo). */
  const principalOf = (req: IncomingMessage): string =>
    askers.get(req) ?? requester(req) ?? log.localPrincipal();
  // PM-N9-8: the planning views answer only for projects the person can see.
  const planningCanSee = (req: IncomingMessage, project: string | undefined): boolean =>
    audienceFromAccess(() => access, options.db).canSee(principalOf(req), project);
  const queueSettings = () => {
    try {
      const c = resolveConfig({ repoPath }).config;
      return {
        cap: c.queue.agentIssuesPerPerson,
        maxWaitS: c.scheduler.maxWaitS,
        fairShare: c.scheduler.fairShare,
      };
    } catch {
      return { cap: 1, maxWaitS: 600, fairShare: true };
    }
  };
  /** A card's project: its own, or the workspace's only project. */
  const projectOfCard = (card: CardRecord | undefined): string | undefined => {
    if (card?.projectId) return card.projectId;
    const projects = options.cardStore?.listProjects() ?? [];
    return projects.length === 1 ? projects[0]?.id : undefined;
  };
  /**
   * Members' columns beyond the level (DB-N9-16): the profile label and
   * per-project levels from the access projection, last active from the
   * ledger (a person's latest event, Smart Swap's `session/active` included),
   * active now from the page's presence (in memory), and a lock. The ledger
   * is read once per request, and only when Members asks.
   */
  const memberFactsReader = () => {
    let last: Map<string, string> | undefined;
    return (principal: string) => {
      last ??= new Map(
        (
          options.db
            .prepare(
              "SELECT principal, MAX(created_at) AS at FROM events WHERE principal IS NOT NULL GROUP BY principal",
            )
            .all() as { principal: string; at: string }[]
        ).map((r) => [r.principal, r.at]),
      );
      const m = access.projection().members.get(principal);
      const at = last.get(principal);
      return {
        ...(m?.label ? { label: m.label } : {}),
        ...(m && Object.keys(m.projects).length ? { projects: { ...m.projects } } : {}),
        ...(at ? { lastActive: at } : {}),
        ...(teamPresence.active().includes(principal) ? { active: true } : {}),
        ...(identity.limits.accountLocked(principal) ? { locked: true } : {}),
      };
    };
  };
  /**
   * A person's own per-project levels, the projects they lead and those
   * where they lead a release not yet accepted (DB-N9-17; teams item 28).
   */
  const ownProjects = (principal: string) => {
    const out: Record<string, { level?: string; lead?: boolean; releaseLead?: boolean }> = {};
    const m = access.projection().members.get(principal);
    const ids = new Set([
      ...Object.keys(m?.projects ?? {}),
      ...[...access.projection().projects.entries()]
        .filter(([, settings]) => settings.lead === principal)
        .map(([id]) => id),
      ...access.projection().releaseLeads.keys(),
    ]);
    for (const id of ids) {
      const level = m?.projects[id];
      const lead = access.isLead(principal, id);
      const releaseLead = access.leadsRelease(principal, id);
      if (level || lead || releaseLead)
        out[id] = {
          ...(level ? { level } : {}),
          ...(lead ? { lead } : {}),
          ...(releaseLead ? { releaseLead } : {}),
        };
    }
    return out;
  };
  const atLeastMember = (p: string | undefined, project?: string): p is string => {
    const level: Level | undefined = p ? access.level(p, project) : undefined;
    return level === "member" || level === "admin";
  };
  /** The standing of every Ready card, counting tokens since the running queue began. */
  const standing = async () => {
    const store = options.cardStore;
    if (!store) return [];
    const q = queueSettings();
    const lease = runnerLease(repoPath);
    const since = lease
      ? ((
          options.db
            .prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE created_at < ?")
            .get(lease.startedAt) as { s: number }
        ).s ?? 0)
      : ((
          options.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get() as { s: number }
        ).s ?? 0);
    const ready = await store.listCards({ status: "ready" });
    const entries = await queueStanding(ready, {
      db: options.db,
      cardStore: store,
      cap: q.cap,
      maxWaitS: q.maxWaitS,
      fairShare: q.fairShare,
      sinceSeq: since,
    });
    // RUN-35: why a card waits — every slot busy, or its files overlap a running card's.
    const capacity = qualifiedSlotCapacity({
      mode: setup,
      parallelSlots: (options.parallelSlots ?? workerParallelSlots)(),
    });
    const scopes = new Map(ready.map((c) => [c.id, c.scopeFiles]));
    // TEAM-30: whose issues wait at the per-person cap (the Team setup's), and why.
    const running = setup === "team" ? await runningAgentIssues(store) : new Map<string, number>();
    return entries.map((e) => {
      const waits = slotWaitReason(
        repoPath,
        { id: e.cardId, scopeFiles: scopes.get(e.cardId) ?? [] },
        capacity,
      );
      const n = running.get(e.person) ?? 0;
      return {
        ...e,
        ...(waits ? { waits } : {}),
        ...(n >= q.cap ? { capped: { cap: q.cap, running: n } } : {}),
      };
    });
  };
  /**
   * Whom an `@Name` can mention (teams item 23): the Team workspace's people
   * by name — a removed or pending one too, so a mention of them is held and
   * its author asked (TEAM-22). Solo's one person mentions no one.
   */
  const workspacePeople = (): { principal: string; name: string }[] =>
    setup === "team"
      ? allMembers(options.db).flatMap((m) => {
          const name = personName(options.db, m.principal);
          return name ? [{ principal: m.principal, name }] : [];
        })
      : [];
  /** The AI teammates on an issue (teams NEW-teams-5): comments, `@Agent`, `@Seshat`, start requests. */
  const aiDeps = (): (AiTeammatesDeps & InboxDeps) | undefined =>
    options.cardStore
      ? {
          cardStore: options.cardStore,
          log,
          access,
          audience: audienceFromAccess(() => access, options.db),
          projectOf: (card) => projectOfCard(card),
          // PM-N10-1, -2: an issue comment's @Seshat is a door to Seshat like the
          // composer: kept whole, and a long one committed as a project document.
          askSeshat: async (text, cardId, principal) => {
            const { documents, notice } = await attachDocuments(
              { repoPath, cardStore: options.cardStore as CardStore, log },
              documentsToAttach({ text, documents: [] }),
              principal,
            );
            const message = await pmApi.ask(text, { cardId }, documents);
            return { id: message.id, ...(notice ? { notice } : {}) };
          },
          standing,
          people: workspacePeople,
          localPrincipal: () => log.localPrincipal(),
        }
      : undefined;
  /** RUN-35: the configured Worker's qualified slots, as the queue reads them; one if unqualified. */
  const workerParallelSlots = (): number => {
    try {
      const registry = modelRegistry();
      // SUR-11: the dashboard resolves the Worker as `run` and `queue` do.
      const name = resolveWorkerName(
        undefined,
        queueDefaults(effectiveConfig(repoPath).config, []).worker,
        { registry },
      );
      const gate = gateWorker(registry, describeModel(name, "worker", { registry }), name);
      return gate.refusal ? 1 : gate.combination.settings.parallelSlots;
    } catch {
      return 1;
    }
  };

  /**
   * TEAM-4, TEAM-5, TEAM-30, INT-22: every write from the dashboard, the SDK
   * or the CLI names who asks and needs the permission the action table
   * gives it; a refusal answers 403 and is recorded. Returns true when it
   * answered the request. Requests without the dashboard's header are left to
   * their route's own refusal, which records nothing.
   */
  const authorize = async (req: IncomingMessage, res: ServerResponse, url: string) => {
    if (!url.startsWith("/api/") || !isTrustedMutation(req)) return false;
    const method = req.method ?? "GET";
    let rule = routePermissions(method, url, undefined);
    if (!rule) return false;
    const principal = requester(req);
    if (!principal) {
      json(res, 401, { error: "Sign in to do this.", refused: "unauthenticated" });
      return true;
    }
    askers.set(req, principal);
    if (rule.needsBody) {
      try {
        rule = routePermissions(method, url, await readJsonBody(req)) ?? rule;
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        return true;
      }
    }
    const store = options.cardStore;
    let permissions = rule.permissions;
    let cardId = rule.cardId;
    if (rule.decisionId && store) {
      const d = store.runs.getDecision(rule.decisionId);
      // Only a person the Accept rule names answers a permission request (security 25a).
      if (d?.kind === "permission") permissions = ["permission.answer"];
      cardId = d?.cardId;
    }
    if (rule.suggestionId && store) {
      cardId = (await store.suggestions.get(rule.suggestionId))?.cardId;
    }
    // A new project's group accepts its brief when applied (teams item 6,
    // design-stage §2.9 item 7): `brief.accept` as well, never instead.
    if (rule.proposalId) {
      const p = await pmApi.pmStore.proposal(rule.proposalId);
      if (p?.kind === "start_project")
        permissions = [...permissions, "project.create", "brief.accept"];
    }
    const card = (cardId && store ? await store.getCard(cardId) : undefined) ?? undefined;
    let project = rule.projectId ?? projectOfCard(card);
    // B4.3: a slice or requirement id resolves to its own project, checked to exist.
    if (project === undefined && rule.sliceId && store) {
      project = (await store.slices.get(rule.sliceId))?.projectId;
    }
    if (project === undefined && rule.requirementId && store) {
      project = (await store.requirements.get(rule.requirementId))?.projectId;
    }
    // A project id read from the request body (never the URL's own resource
    // path) is trusted only once it is checked to exist (B4.3): otherwise a
    // fabricated id could pin a favorable per-project level instead of the
    // workspace's own. A missing project still reaches the handler, which
    // answers its own 404.
    if (
      project !== undefined &&
      rule.projectId === project &&
      store &&
      !store.getProject(project)
    ) {
      project = undefined;
    }
    const projectName = project ? store?.getProject(project)?.name : undefined;
    for (const permission of permissions) {
      const decision = access.decide(principal, permission, project, projectName, ceilingOf(req));
      if (decision.allowed) continue;
      const lead = project ? access.settings(project).lead : undefined;
      const askTo = atLeastMember(card?.owner, project)
        ? card?.owner
        : atLeastMember(lead, project)
          ? lead
          : undefined;
      refuse(res, json, log, decision, {
        principal,
        ...(project ? { project } : {}),
        ...(card ? { cardId: card.id } : {}),
        ...(askTo ? { askTo } : {}),
      });
      return true;
    }
    // TEAM-30: at the per-person cap, the next Agent issue waits in the queue.
    // The cap is the Team setup's; Solo's one runner is the lease (runtime item 3).
    if (setup === "team" && card && store && method === "POST" && url.endsWith("/run")) {
      const q = queueSettings();
      if (store.delegatorOf(card.id) !== principal) {
        await store.delegateCard(card.id, { kind: "worker" }, principal);
      }
      const running = (await store.listCards({ status: "in_progress" })).filter(
        (c) => c.id !== card.id && personOf(store, c) === principal,
      ).length;
      if (running >= q.cap) {
        await log.append({
          actor: "human",
          type: "queue/capped",
          principal,
          cardId: card.id,
          payload: { id: card.id, cap: q.cap, running },
        });
        const mine = (await standing()).find((s) => s.cardId === card.id);
        json(res, 202, {
          queued: true,
          cardId: card.id,
          cap: q.cap,
          running,
          // The cap's visible part: the place and estimate, and why it waits.
          capNote: `${capNote("you", running, q.cap)}.`,
          ...(mine
            ? { place: mine.place, estimateSeconds: mine.estimateSeconds, message: mine.message }
            : {
                message: `You have ${running} Agent issue${running === 1 ? "" : "s"} running; this one starts when it is Ready and your turn comes`,
              }),
        });
        return true;
      }
    }
    return false;
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const [url = "/"] = (req.url || "/").split("?");
    // The guard runs first for every request (runtime item 24, security item 37).
    for (const [name, value] of guardHeaders) res.setHeader(name, value);
    // SEC-24: a request naming another host is a rebound page's; nothing runs.
    if (!hostAllowed(req.headers.host, hosts)) {
      json(res, 421, { error: MISDIRECTED, refused: "host" });
      return;
    }
    // The page's token is in the session answer: never kept by a cache.
    if (url === "/api/session") res.setHeader("Cache-Control", "no-store");
    // SEC-25: in Solo every write carries this start's token, with or without
    // an Origin, and any Origin is the page's own (security item 37), here
    // for every route, not only those that ask. A GitHub delivery is signed
    // instead (wave2_server.ts).
    if (
      identity.mode === "solo" &&
      !SAFE_METHODS.has((req.method ?? "GET").toUpperCase()) &&
      url !== "/webhooks/github"
    ) {
      if (!tokenMatches(req.headers["x-sekhemet-csrf"], mutationToken)) {
        // Solo has no sign-in: the sentence says what to do (DEC-31, W1 finding).
        json(res, 403, { error: "csrf", refused: "token", message: ACCOUNT_COPY.csrfSolo });
        return;
      }
      if (!sameOrigin(req.headers.origin, req.headers.host)) {
        json(res, 403, {
          error: "csrf",
          refused: "origin",
          message: ACCOUNT_COPY.csrfSoloOrigin,
        });
        return;
      }
    }
    // Resolve and bind the requester first; in the Team setup a protected
    // endpoint answers 401 before any handler runs (TEAM-12).
    if (identityGate(req, res, url, identity, json)) return;
    if (url.startsWith("/api/")) {
      const who = requesterOf(req);
      if (who.authenticated) presence.seen({ principal: who.principal, via: who.via });
    }
    // Kernel rule 19, K-N2-8: the request's work is the person's who asked, so
    // every event a person causes names them, however deep it is appended.
    const person = requester(req) ?? (setup === "solo" ? log.localPrincipal() : undefined);
    try {
      if (person && PRINCIPAL_PATTERN.test(person)) {
        await EventLog.actingFor(person, () => handleRequest(req, res));
      } else {
        await handleRequest(req, res);
      }
    } catch (err) {
      // One request that fails answers 500 and is recorded on stderr,
      // redacted; the dashboard, and a queue it runs, keep going (runtime
      // item 9). The person reads a plain sentence, not the internals.
      process.stderr.write(
        `sekhemet: a dashboard request failed (${req.method ?? "GET"} ${url}): ${describeError(err)}\n`,
      );
      if (!res.headersSent) {
        json(res, 500, {
          error: "Something went wrong on the server; the details are in its log.",
        });
      } else {
        res.destroy();
      }
    }
  });

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const [url = "/", search = ""] = (req.url || "/").split("?");
    const query = new URLSearchParams(search);
    if (
      url.startsWith("/api/") &&
      (await handleIdentityRoute(req, res, url, query, {
        identity,
        ...(serverIdentity.passkeys ? { passkeys: serverIdentity.passkeys } : {}),
        ...(serverIdentity.sso ? { sso: serverIdentity.sso } : {}),
        json,
        readJsonBody,
        ...(identity.mode === "solo" ? { soloCsrf: mutationToken } : {}),
        memberFacts: memberFactsReader(),
        sessionFacts: (principal) => {
          const label = access.projection().members.get(principal)?.label;
          return { projects: ownProjects(principal), ...(label ? { label } : {}) };
        },
      }))
    ) {
      return;
    }

    if (await authorize(req, res, url)) return;

    // teams TEAM-32: a project's Accept rule, required threads, lead and auto-apply.
    const settingsMatch = /^\/api\/projects\/(proj_[A-Za-z0-9_-]+)\/settings$/.exec(url);
    if (settingsMatch) {
      const id = settingsMatch[1] as string;
      if (req.method === "GET") {
        json(res, 200, { project: id, settings: access.settings(id) });
        return;
      }
      if (req.method === "PATCH") {
        if (!isTrustedMutation(req)) {
          json(res, 403, { error: "Settings must come from the dashboard itself" });
          return;
        }
        if (options.cardStore && !options.cardStore.getProject(id)) {
          json(res, 404, { error: `No project ${id}` });
          return;
        }
        try {
          const patch = parseSettingsPatch(await readJsonBody(req));
          const changed = await recordSettingsChange(log, access, {
            by: principalOf(req),
            project: id,
            patch,
          });
          json(res, 200, { changed, settings: access.settings(id) });
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
    }

    // Teams NEW-teams-10 (TEAM-27): the audit log and its export, an Admin's.
    if (
      handleAuditRoute(req, res, url, query, {
        db: options.db,
        log,
        access,
        json,
        principalOf,
        ceilingOf,
        projectName: (id) => options.cardStore?.getProject(id)?.name,
        ...(options.cardStore
          ? { releases: () => (options.cardStore as CardStore).slices.list() }
          : {}),
      })
    ) {
      return;
    }

    // Teams item 8, DB-N9-16: a person's profile label, an Admin's; it grants nothing.
    const labelMatch = /^\/api\/members\/(p_[0-9a-z]+)\/label$/.exec(url);
    if (labelMatch && req.method === "POST") {
      if (!isTrustedMutation(req)) {
        json(res, 403, { error: "Labels must come from the dashboard itself" });
        return;
      }
      const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>);
      const raw = body.label;
      const label = typeof raw === "string" ? raw.trim() : null;
      if ((raw !== null && typeof raw !== "string") || (label !== null && label.length > 80)) {
        json(res, 400, { error: "A profile label is text of at most 80 characters, or null." });
        return;
      }
      const principal = labelMatch[1] as string;
      const target = access.projection().members.get(principal);
      if (!target || target.removed) {
        json(res, 404, { error: `${principal} is not a member of this workspace` });
        return;
      }
      try {
        await recordLabelChange(log, access, {
          by: principalOf(req),
          principal,
          label: label || null,
        });
      } catch (err) {
        if (err instanceof AccessRefusedError) {
          refuse(res, json, log, err.decision, { principal: principalOf(req) });
          return;
        }
        throw err;
      }
      json(res, 200, { principal, label: label || null });
      return;
    }

    // teams TEAM-6: a person's level, for the workspace or one project.
    const levelMatch = /^\/api\/members\/(p_[0-9a-z]+)\/level$/.exec(url);
    if (levelMatch && req.method === "POST") {
      if (!isTrustedMutation(req)) {
        json(res, 403, { error: "Levels must come from the dashboard itself" });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const project = typeof body.project === "string" ? body.project : undefined;
        const ceiling = ceilingOf(req);
        const input = {
          by: principalOf(req),
          principal: levelMatch[1] as string,
          level: body.level as Level,
          ...(project ? { project } : {}),
          ...(ceiling ? { ceiling } : {}),
        };
        await recordLevelChange(log, access, input);
        json(res, 200, {
          principal: input.principal,
          level: input.level,
          project: project ?? null,
        });
      } catch (err) {
        if (err instanceof AccessRefusedError) {
          refuse(res, json, log, err.decision, { principal: principalOf(req) });
          return;
        }
        if (err instanceof LastAdminError) {
          json(res, 409, { error: err.message, reason: "last_admin" });
          return;
        }
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // teams TEAM-30, item 31: where each queued issue stands.
    if (url === "/api/queue/standing" && req.method === "GET") {
      json(res, 200, { entries: await standing() });
      return;
    }

    if (await configApi.handle(req, res, url, query)) return;
    if (await benchmarkApi.handle(req, res, url, query)) return;

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
        principalOf,
      }))
    ) {
      return;
    }

    // PM-N7-5: a person's approval of a plan's criteria, as `sekhemet approve`.
    if (
      url.startsWith("/api/cards/") &&
      (await handlePlanApprovalRoute(req, res, url, {
        repoPath,
        cardStore: options.cardStore,
        log,
        boardService,
        json,
        readJsonBody,
        trusted: isTrustedMutation,
        principalOf,
        canSee: planningCanSee,
      }))
    ) {
      return;
    }

    // The Sign in page's links (teams items 10, 11): the page, whose router shows them.
    if (
      url === "/" ||
      url === "/index.html" ||
      /^\/(invite|password-reset)\/[A-Za-z0-9_-]+$/.test(url)
    ) {
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
      const lib = /^lib\/([a-z_]+\.js)$/.exec(rel)?.[1];
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
      json(res, 200, vocabularyTables(STOP_REASONS));
      return;
    }

    if (url === "/favicon.svg" || url === "/favicon.ico") {
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=86400" });
      res.end(appIconSvg());
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
      // Only this dashboard's own page may open it (a browser sends an Origin
      // on a cross-site EventSource); a local program sends none.
      if (!sameOrigin(req.headers.origin, req.headers.host)) {
        json(res, 403, { error: "The live stream opens only for this dashboard's own page." });
        return;
      }
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
      const latest = await log.getLastEvent();
      // U9: replay from a checkpoint (the Last-Event-ID the browser sends on
      // reconnect, or ?since=<seq>; ?since=0 is genesis), capped per frame.
      const fromHeader = req.headers["last-event-id"];
      const since = Number(
        (Array.isArray(fromHeader) ? fromHeader[0] : fromHeader) ?? query.get("since") ?? "",
      );
      const upTo = latest?.seq ?? 0;
      if (Number.isInteger(since) && since >= 0 && since < upTo) {
        const missed = await log.getEvents(since + 1, Math.min(5000, upTo - since));
        if (missed.length > 0) {
          const [board, verification] = await Promise.all([
            boardWithEvidence(),
            log.verifyHashChain(),
          ]);
          const through = missed[missed.length - 1]?.seq ?? since;
          const view = await appendView(missed, board);
          const seen = view ? view(principalOf(req)) : { events: missed, board };
          if (seen)
            res.write(
              `id: ${through}\nevent: append\ndata: ${JSON.stringify({ ...seen, verification, replay: { from: since + 1, through, complete: through >= upTo } })}\n\n`,
            );
        }
      }
      streams.add(res);
      streamPrincipal.set(res, principalOf(req));
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

    // The Projects page (dashboard §2.11, DB-N9-9; PM_CONTRACT §3): every
    // project the person can see, the workspace's totals and this server's models.
    if (url === "/api/projects/overview" && req.method === "GET") {
      const store = options.cardStore;
      if (!store) {
        json(res, 501, { error: "This server was started read-only" });
        return;
      }
      const sample = memoryProbe();
      const overview = await projectsOverview({
        cardStore: store,
        log,
        me: principalOf(req),
        audience: audienceFromAccess(() => access, options.db),
        repoPath,
        models: {
          roles: modelRoster(repoPath).roles as RosterRoleLike[],
          slots: {
            // The Coding model's slots (RUN-35) and the issues being built in them.
            inUse: (await store.listCards({ status: "in_progress" })).length,
            capacity: qualifiedSlotCapacity({
              mode: setup,
              parallelSlots: (options.parallelSlots ?? workerParallelSlots)(),
            }),
          },
          queue: (await standing()).length,
          memory: { usedBytes: sample.usedBytes, totalBytes: sample.totalBytes },
        },
      });
      json(res, 200, { overview });
      return;
    }

    if (url === "/api/projects" && req.method !== "POST") {
      const store = options.cardStore;
      // K-N5-3: each project with its derived rollup (active, idle, done, paused, archived).
      const projects = store
        ? await Promise.all(
            store
              .listProjects()
              .map(async (p) => ({ ...p, rollup: await store.projectRollup(p.id) })),
          )
        : [];
      json(res, 200, { projects, activeCap: store?.activeProjectCap });
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
        // The original contract: the first 200 events, oldest first. Team:
        // the view the stream gives this person — their projects' events,
        // their own part of Seshat's thread, no event's private part.
        const [events, verification] = await Promise.all([
          log.getEvents(1, 200),
          log.verifyHashChain(),
        ]);
        const view = await appendView(events, await boardWithEvidence());
        json(res, 200, {
          events: view ? (view(principalOf(req))?.events ?? []) : events,
          verification,
        });
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
      // Team setup: each person's event carries their name, so Activity says
      // who did it rather than "You" (teams item 17; Solo's one person stays "You").
      if (setup === "team" && page.events.length) {
        const nameOf = namesOf();
        const seqs = page.events.map((e) => e.seq);
        const principals = new Map(
          (
            options.db
              .prepare(
                `SELECT seq, principal FROM events WHERE principal IS NOT NULL AND seq IN (${seqs.map(() => "?").join(",")})`,
              )
              .all(...seqs) as { seq: number; principal: string }[]
          ).map((r) => [r.seq, r.principal]),
        );
        // The same view as the stream's: this person's projects and their own
        // part of Seshat's thread (the page carries no private part).
        const records = page.events.map((e) => {
          const principal = principals.get(e.seq);
          return { ...e, ...(principal ? { principal } : {}) } as unknown as EventRecord;
        });
        const view = await appendView(records, await boardWithEvidence());
        const kept = new Set((view?.(principalOf(req))?.events ?? []).map((e) => e.seq));
        page.events = page.events
          .filter((e) => kept.has(e.seq))
          .map((e) => {
            const principalName = nameOf(principals.get(e.seq));
            return principalName ? { ...e, principalName } : e;
          });
      }
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
        json(res, 404, { error: `No issue ${cardId}` });
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
        json(res, 404, { error: `No attempt ${wanted} recorded for this issue` });
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
      json(res, 200, { runs: (await listRuns(repoPath, options.log)).runs });
      return;
    }
    const runMatch = /^\/api\/runs\/([\w.-]+)$/.exec(url);
    if (runMatch) {
      const report = (await listRuns(repoPath, options.log)).reports.get(runMatch[1] as string);
      if (!report) {
        json(res, 404, { error: `No run ${runMatch[1]}` });
        return;
      }
      json(res, 200, { id: runMatch[1], ...report });
      return;
    }
    // RUN-46: a card's trace — card, step, model-request and tool-call spans.
    const traceMatch = new RegExp(`^/api/cards/(${CARD_ID})/traces$`).exec(url);
    if (traceMatch && req.method === "GET") {
      json(res, 200, { spans: cardTrace(repoPath, traceMatch[1] as string) });
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
      const sample = memoryProbe();
      json(res, 200, {
        memory: machineMemory(sample),
        // The active hardware tier and what it decides (DB-N2-9).
        tier: activeHardwareTier(sample.totalBytes),
        models: {
          endpoint: /^(\S+) reachable/.exec(inference?.detail ?? "")?.[1],
          reachable: inference ? inference.status !== "fail" : false,
          served,
        },
        checks: doctor.checks,
        ok: doctor.ok,
        checkedAt: new Date(doctorCache?.at ?? Date.now()).toISOString(),
        worktrees: worktrees(repoPath),
        // The Sekhemet roster (not whatever the local Ollama happens to serve).
        roster: modelRoster(repoPath).roles,
        // The latest M0 run and its pivot condition (measurement MS-M9-6).
        ...(await (async () => {
          const last = (await log.getEventsByTypes(["measure/m0"])).at(-1);
          return last ? { m0: last.payload } : {};
        })()),
      });
      return;
    }

    if (url === "/api/playbook") {
      json(res, 200, await playbookSnapshot(repoPath, log));
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
          json(res, 404, { error: `No attempt ${wanted} recorded for this issue` });
          return;
        }
        json(res, 200, readJsonCached(hit.path));
        return;
      }
      const path = join(evidenceDir, `latest-${cardId}.json`);
      if (!existsSync(path)) {
        json(res, 404, { error: "No evidence recorded for this issue yet" });
        return;
      }
      json(res, 200, JSON.parse(readFileSync(path, "utf8")));
      return;
    }

    // NEW-dashboard-5: what Accept will ask of this viewer, before it is pressed.
    const deskMatch = new RegExp(`^/api/cards/(${CARD_ID})/review$`).exec(url);
    if (deskMatch && req.method === "GET") {
      const store = options.cardStore;
      const card = store ? await store.getCard(deskMatch[1] as string) : undefined;
      // PM-N9-8: a card whose project the person cannot see is no card to them.
      if (!store || !card || !planningCanSee(req, projectOfCard(card))) {
        json(res, 404, { error: `No issue ${deskMatch[1]}` });
        return;
      }
      const holders = access.acceptHolders(projectOfCard(card));
      // Teams item 25 (TEAM-24, -25): the review threads, whether the project
      // requires them resolved and the open one Accept then waits on, and an
      // accept that new commits dismissed.
      const nameOf = namesOf();
      const threads = await reviewThreads(store, card.id, nameOf);
      const requireResolvedThreads =
        access.settings(projectOfCard(card)).require_resolved_threads === true;
      const openThread = requireResolvedThreads ? openThreadRefusal(threads) : undefined;
      const acceptDismissed = await acceptDismissal(store, card.id, nameOf);
      json(res, 200, {
        // P12, P14, RG-N5-3: the route's earlier fields stay in its contract.
        ...(await reviewBrief(repoPath, store, log, card)),
        ...(await reviewDesk(
          { repoPath, cardStore: store, boardService: boardService as never, eventLog: log },
          card,
          principalOf(req),
          { acceptHolders: holders, nameOf },
        )),
        threads,
        requireResolvedThreads,
        ...(openThread ? { openThread } : {}),
        ...(acceptDismissed ? { acceptDismissed } : {}),
      });
      return;
    }

    // One card with its presentation and its attempt history.
    const cardMatch = new RegExp(`^/api/cards/(${CARD_ID})$`).exec(url);
    if (cardMatch && req.method === "GET") {
      const state = await boardService.getBoardState();
      const card = state.cards.find((c) => c.id === cardMatch[1]);
      if (!card) {
        json(res, 404, { error: `No issue ${cardMatch[1]}` });
        return;
      }
      json(res, 200, {
        card: withDisplay(card, state.cards, statusEntries(), Date.now()),
        attempts: attemptsFor(card.id).map((a) => a.summary),
        acceptance: acceptanceSources(card),
        // PM-N8-2: what the card waits on and why (declared, named, imported).
        dependencies: options.cardStore?.getDependencyReasons(card.id) ?? [],
        // TEAM-15: the AI teammates' state on the issue, as the harness knows it.
        ai: await (async () => {
          const deps = aiDeps();
          return deps ? aiStates(deps, card.id, principalOf(req)) : [];
        })(),
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
        // GT-BF-5: the bound on tool-applied lines in force (default 500).
        maxToolAppliedLines: config.project.maxToolAppliedLines,
        sha256: config.sha256,
        // No gates.toml: the defaults ran (GT-T1-10).
        empty: config.empty === true,
        // The brief's invariants the architecture gate cannot check, shown
        // on the board with the forms they could be restated in (GT-N1-1).
        invariants: {
          notEnforced: unenforcedInvariants(join(repoPath, ".sekhemet", "brief.md")),
        },
      });
      return;
    }

    // Gates rule 31 (GT-N4-1): the visual candidates waiting for a person,
    // and a person's approval of one as the baseline, on the ledger with the
    // approver's principal. The command line's `gates approve-baseline` is
    // the same act.
    if (url === "/api/visual/candidates" && req.method === "GET") {
      json(res, 200, { candidates: visualCandidates(repoPath) });
      return;
    }
    const baselineMatch = /^\/api\/visual\/baselines\/([\w.-]+)\/approve$/.exec(url);
    if (baselineMatch && req.method === "POST") {
      if (!isTrustedMutation(req)) {
        json(res, 403, { error: "A baseline approval must come from the dashboard itself" });
        return;
      }
      const store = options.cardStore;
      if (!store) {
        json(res, 503, { error: "No ledger: a baseline approval cannot be recorded" });
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const r = await approveBaseline(store, {
        repoPath,
        key: baselineMatch[1] as string,
        principal: principalOf(req),
        cardId: typeof body.cardId === "string" ? body.cardId : undefined,
        sha256: typeof body.sha256 === "string" ? body.sha256 : undefined,
      });
      if (!r.approved) json(res, r.status, { error: r.reason });
      else json(res, 200, { ok: true, key: r.key, sha256: r.sha256, principal: r.principal });
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

    const action = new RegExp(
      `^/api/cards/(${CARD_ID})/(accept|return|park|unpark|reject|revert|opened)$`,
    ).exec(url);
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
        json(res, 404, { error: `No issue ${cardId}` });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const ctx = {
          repoPath,
          restrictedMode: false,
          cardStore: store,
          boardService: boardService as never,
          // DS-N3-1: the project documents follow a person's accept.
          eventLog: log,
        };
        const strings = (v: unknown): string[] =>
          Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
        // review-git §2.4.3 (RG-S6-6): the files the dashboard showed, recorded.
        if (verb === "opened") {
          await recordReviewOpened(ctx, card, strings(body.filesShown), principalOf(req));
          json(res, 200, { ok: true });
          return;
        }
        if (verb === "accept") {
          // INT-22, INT-23: the project's Accept rule decides, and the
          // accepter's principal is recorded on `card/accepted`.
          const holders = access.acceptHolders(projectOfCard(card));
          const sha = await acceptCard(ctx, card, "human", {
            principal: principalOf(req),
            acknowledgedFindings: strings(body.acknowledgedFindings),
            ...(holders ? { acceptHolders: holders } : {}),
            // TEAM-25: the project's rule, from the same fold as its Accept rule.
            requireResolvedThreads:
              access.settings(projectOfCard(card)).require_resolved_threads === true,
            nameOf: namesOf(),
          });
          // A checkout on the integration branch is told how to catch up (RG-S5-2).
          const notice = sha.startsWith("http")
            ? undefined
            : checkoutNotice(repoPath, integrationBranch(repoPath), sha);
          json(res, 200, {
            ok: true,
            status: sha.startsWith("http") ? "review" : "done",
            sha,
            ...(notice ? { notice } : {}),
          });
          return;
        }
        if (verb === "revert") {
          const sha = await revertAccept(
            ctx,
            card,
            typeof body.reason === "string" ? body.reason : "",
            principalOf(req),
            access.acceptHolders(projectOfCard(card)),
          );
          json(res, 200, { ok: true, status: "ready", sha });
          return;
        }

        // Status's Needs you (DB-P5-1): back where it was parked from, as `sekhemet unpark`.
        if (verb === "unpark") {
          const to = await unpark(
            {
              repoPath,
              cardStore: store,
              boardService: boardService as never,
              log,
              principal: principalOf(req),
            },
            card,
          );
          json(res, 200, { ok: true, status: to });
          return;
        }
        const reason = typeof body.reason === "string" ? body.reason : "";
        if (verb === "return" && !reason.trim()) {
          json(res, 400, { error: "A return needs a reason: it is what the agent is told next" });
          return;
        }
        // One implementation for the board and the command line (triage.ts).
        const triage = {
          repoPath,
          cardStore: store,
          boardService: boardService as never,
          log,
          principal: principalOf(req),
        };
        const to = verb === "return" ? "ready" : verb === "reject" ? "rejected" : "parked";
        if (verb === "return") {
          const comments = Array.isArray(body.comments)
            ? (body.comments as { file?: unknown; line?: unknown; text?: unknown }[]).map((c) => ({
                file: String(c.file ?? ""),
                line: Number(c.line),
                text: String(c.text ?? ""),
              }))
            : [];
          await sendBack(triage, card, reason, { comments });
        } else if (verb === "reject") await reject(triage, card, reason);
        else await park(triage, card, reason);
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

    // Teams NEW-teams-9 (item 26; TEAM-26, DB-N9-20): presence, in memory over the stream.
    // Solo has none (teams item 1): its one person has no one to see.
    if (url === "/api/presence" && setup !== "team") {
      json(res, 200, { viewers: [], active: [] });
      return;
    }
    if (
      await handlePresenceRoute(req, res, url, query, {
        presence: teamPresence,
        cardStore: options.cardStore,
        projectOf: (card) => projectOfCard(card),
        nameOf: namesOf,
        json,
        readJsonBody,
        isTrustedMutation,
        principalOf,
        canSee: planningCanSee,
        changed: () => {
          void pushPresence();
        },
      })
    ) {
      return;
    }

    // Teams NEW-teams-8 (item 25; TEAM-24, -25): review threads, the Comment verdict, resolving.
    if (
      url.startsWith("/api/cards/") &&
      (await handleReviewRoute(req, res, url, {
        cardStore: options.cardStore,
        projectOf: (card) => projectOfCard(card),
        requiresResolved: (project) => access.settings(project).require_resolved_threads === true,
        nameOf: namesOf,
        json,
        readJsonBody,
        isTrustedMutation,
        principalOf,
        canSee: planningCanSee,
      }))
    ) {
      return;
    }

    // Teams NEW-teams-5 (TEAM-15, -39, -40): comments, the AI teammates' state, start requests.
    if (
      (url.startsWith("/api/cards/") ||
        url === "/api/agent/requests" ||
        url === "/api/agent/states") &&
      (await handleAiTeammateRoute(req, res, url, {
        deps: aiDeps,
        json,
        readJsonBody,
        isTrustedMutation,
        principalOf,
        ceilingOf,
        canSee: planningCanSee,
      }))
    ) {
      return;
    }

    // Teams NEW-teams-7 (TEAM-21, -22, -23): the Inbox, its marks, Watch, My issues, a mention's answer.
    if (
      (url === "/api/inbox" ||
        url === "/api/my-issues" ||
        url.startsWith("/api/inbox/") ||
        url.startsWith("/api/issues/") ||
        url.startsWith("/api/cards/")) &&
      (await handleInboxRoute(req, res, search ? `${url}?${search}` : url, {
        deps: aiDeps,
        json,
        readJsonBody,
        isTrustedMutation,
        principalOf,
        canSee: planningCanSee,
      }))
    ) {
      return;
    }

    // WL-N10-1: a card's messages and hand-back notes, each with the step it reached.
    const messagesMatch = new RegExp(`^/api/cards/(${CARD_ID})/messages$`).exec(url);
    if (messagesMatch && req.method === "GET" && options.cardStore) {
      // The issue page's Activity names who wrote each one (DB-N8-1).
      const nameOf = namesOf();
      json(res, 200, {
        messages: (await cardMessages(options.cardStore, messagesMatch[1] as string)).map((m) => {
          const principalName = nameOf(m.principal);
          return principalName ? { ...m, principalName } : m;
        }),
      });
      return;
    }

    const command = new RegExp(
      `^/api/cards/(${CARD_ID})/(abort|rewind|fork|override|reroute|reorder|message|pause|hand-back|take-over|submit-take-over)$`,
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
          json(res, 404, { error: `No issue ${cardId}` });
          return;
        }
        if (verb === "abort") {
          const reason = typeof body.reason === "string" ? body.reason : "";
          await requestAbort(store, cardId, reason || "stopped from the dashboard");
          json(res, 200, { ok: true, requested: "abort" });
          return;
        }
        // WL-N10-1..3: collaborate on a running issue (DEC-34).
        if (verb === "message") {
          const text = typeof body.text === "string" ? body.text.trim() : "";
          if (!text) {
            json(res, 400, { error: "A message needs text" });
            return;
          }
          await postCardMessage(store, cardId, text, principalOf(req));
          json(res, 200, { ok: true });
          return;
        }
        if (verb === "pause") {
          await requestPause(store, cardId, principalOf(req));
          json(res, 200, { ok: true, requested: "pause" });
          return;
        }
        if (verb === "hand-back" || verb === "take-over" || verb === "submit-take-over") {
          try {
            if (verb === "hand-back") {
              await handBack(
                ctx,
                cardId,
                typeof body.note === "string" ? body.note : "",
                principalOf(req),
              );
              json(res, 200, { ok: true });
            } else if (verb === "take-over") {
              json(res, 200, { ok: true, ...(await takeOver(ctx, cardId, principalOf(req))) });
            } else {
              json(res, 200, {
                ok: true,
                ...(await submitTakenOver(ctx, cardId, principalOf(req))),
              });
            }
          } catch (err) {
            json(res, 409, { error: err instanceof Error ? err.message : String(err) });
          }
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
          // K-S7-5: a value outside the nine states is refused before anything is appended.
          if (!isCardStatus(to)) {
            json(res, 400, {
              error: `'${to}' is not an issue state; use one of ${CARD_STATUSES.join(", ")}`,
            });
            return;
          }
          // Rule 28: an override names the person who takes responsibility —
          // the one given, or the install's own person on a solo setup (rule 19).
          // In the Team setup it is always the person who asked (M4).
          const named =
            typeof body.principal === "string" && body.principal.trim()
              ? body.principal.trim()
              : undefined;
          const principal = setup === "team" || !named ? principalOf(req) : named;
          try {
            await boardService.transitionCard({
              cardId,
              fromStatus: card.status,
              toStatus: to,
              actor: "human",
              reason: `override: ${reason}`,
              ...(principal ? { principal } : {}),
            });
          } catch (err) {
            // B12: a security-layer failure is the one refusal an override
            // does not carry. Answered with its own code so the dashboard can
            // say why rather than showing a generic conflict.
            if ((err as { code?: string }).code === "security_gate") {
              json(res, 403, {
                error: err instanceof Error ? err.message : String(err),
                refused: "security_gate",
              });
              return;
            }
            throw err;
          }
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
            { principal: principalOf(req) },
          );
          json(res, 200, { ok: true, modelRoute: updated.modelRoute });
          return;
        }
        // reorder (B11): place the card between two neighbours.
        const updated = await store.reorderCard(
          cardId,
          {
            ...(typeof body.afterCardId === "string" ? { afterCardId: body.afterCardId } : {}),
            ...(typeof body.beforeCardId === "string" ? { beforeCardId: body.beforeCardId } : {}),
          },
          "human",
          { principal: principalOf(req) },
        );
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
            principalOf(req),
          );
          json(res, 200, { decision: d.record });
          return;
        }
        json(res, 200, {
          decision: await options.cardStore.runs.answerDecision(
            decisionMatch[1] as string,
            option,
            "human",
            principalOf(req),
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
        principalOf,
        canSee: planningCanSee,
        // The limit the board shows for the project's In review column (DB-P3-9).
        reviewWip: async (projectId) => {
          const facts = await (
            boardService as {
              reviewLimitFacts?: (projectId?: string) => Promise<{ limit: number }>;
            }
          )
            .reviewLimitFacts?.(projectId)
            .catch(() => undefined);
          return (
            facts?.limit ??
            (await boardService.getBoardState(projectId ? { projectId } : {})).wipLimits.review
          );
        },
      })
    ) {
      return;
    }

    if (url.startsWith("/api/") && (await pmApi.handle(req, res, url, query))) return;

    json(res, 404, { error: "Not Found", path: url });
  };

  // M2: a running card's decoded tokens, from its live file, while the step
  // is still generating (the runner writes .sekhemet/live/<card>.txt).
  const liveSeen = new Map<string, number>();
  /**
   * NEW-dashboard-3 (Team, PM-N9-8): the model's output can hold the files
   * the Worker writes, so a frame goes only to the streams whose person can
   * see the card's project — never filtered in the browser after it arrived.
   */
  const liveAudience = async (
    cardId: string,
  ): Promise<((client: StreamClient) => boolean) | undefined> => {
    if (setup !== "team") return undefined;
    const card = options.cardStore ? await options.cardStore.getCard(cardId) : undefined;
    const project = projectOfCard(card ?? undefined);
    const audience = audienceFromAccess(() => access, options.db);
    return (client) => {
      const who = streamPrincipal.get(client);
      return who !== undefined && audience.canSee(who, project);
    };
  };
  const pushLiveTokens = async (): Promise<void> => {
    if (streams.size === 0) return;
    const dir = join(repoPath, ".sekhemet", "live");
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".txt")) continue;
      const path = join(dir, name);
      let mtime = 0;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (liveSeen.get(name) === mtime) continue;
      liveSeen.set(name, mtime);
      const text = readFileSync(path, "utf8").slice(-2000);
      const cardId = name.slice(0, -4);
      const frame = `event: tokens\ndata: ${JSON.stringify({ cardId, text })}\n\n`;
      const sees = await liveAudience(cardId);
      for (const res of streams) {
        if (sees && !sees(res)) continue;
        try {
          res.write(frame);
        } catch {
          streams.delete(res);
        }
      }
    }
  };

  // DB-N2-10: the running check each card's process announced
  // (`.sekhemet/live/<card>.gate.json`, `live_gate.ts`), pushed as a `gate`
  // frame when it starts, changes or ends — to the streams whose person can
  // see the card's project. In memory; never on the ledger.
  const liveGates = new Map<string, string>();
  const pushLiveGates = async (): Promise<void> => {
    if (streams.size === 0) return;
    const dir = join(repoPath, ".sekhemet", "live");
    const now = new Map<string, string>();
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".gate.json")) continue;
        const cardId = name.slice(0, -".gate.json".length);
        const g = readLiveGate(repoPath, cardId);
        if (g) now.set(cardId, JSON.stringify(g));
      }
    }
    const changed = [...new Set([...liveGates.keys(), ...now.keys()])].filter(
      (id) => liveGates.get(id) !== now.get(id),
    );
    for (const cardId of changed) {
      const g = now.get(cardId);
      if (g) liveGates.set(cardId, g);
      else liveGates.delete(cardId);
      const gate = g ? (JSON.parse(g) as { gate: string; rung: string }) : undefined;
      const frame = `event: gate\ndata: ${JSON.stringify(
        gate ? { cardId, ...gate, label: runningCheckText(gate) } : { cardId, gate: null },
      )}\n\n`;
      const sees = await liveAudience(cardId);
      for (const res of streams) {
        if (sees && !sees(res)) continue;
        try {
          res.write(frame);
        } catch {
          streams.delete(res);
        }
      }
    }
  };

  // TEAM-26, DB-N9-20: who views which issue and drags which card, in
  // memory only (`team/presence.ts`), pushed as a `presence` frame — each
  // stream told only of the issues its person can see. Never on the ledger.
  const teamPresence = new Presence();
  const pushPresence = async (): Promise<void> => {
    if (setup !== "team" || streams.size === 0) return;
    const nameOf = namesOf();
    const audience = audienceFromAccess(() => access, options.db);
    const projects = new Map<string, { project: string | undefined } | undefined>();
    const projectFor = async (id: string) => {
      if (!projects.has(id)) {
        const card = options.cardStore ? await options.cardStore.getCard(id) : undefined;
        projects.set(id, card ? { project: projectOfCard(card) } : undefined);
      }
      return projects.get(id);
    };
    for (const res of streams) {
      const who = streamPrincipal.get(res);
      const frame = await presenceFrame(
        teamPresence,
        async (id) => {
          const found = await projectFor(id);
          if (!found) return false;
          return setup !== "team" || (who !== undefined && audience.canSee(who, found.project));
        },
        nameOf,
      );
      try {
        res.write(`event: presence\ndata: ${JSON.stringify(frame)}\n\n`);
      } catch {
        streams.delete(res);
      }
    }
  };

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
    // TEAM-2: on a Team start with no Admin, the setup token's path is printed.
    identity.ensureSetupToken();
    const stopIdentity = serverIdentity.startTimers();
    server.listen(port, host, () => {
      let ticks = 0;
      timer = setInterval(() => {
        void pump();
        void pushLiveTokens();
        void pushLiveGates();
        if (teamPresence.sweep()) void pushPresence();
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
      // INT-17 to INT-20a: one notifier for push and Slack, budgeted, with
      // Seshat's daily standup when a channel accepts it.
      const standupStore = options.cardStore;
      // TEAM-43: in the Team setup each watcher is notified within their own budget.
      const inboxDeps = setup === "team" ? aiDeps() : undefined;
      const notifier = startNotifier(options.log, repoPath, {
        dashboard: `http://127.0.0.1:${boundPort}`,
        ...(inboxDeps ? { inbox: inboxNotifier(inboxDeps) } : {}),
        ...(standupStore
          ? {
              standup: (person: string) =>
                dailyStandup({
                  repoPath,
                  cardStore: standupStore,
                  pmStore: new PmStore(options.log),
                  ...(options.pmModel ? { pmModel: options.pmModel } : {}),
                  person,
                  // PM-N9-8: only what the recipient can see.
                  audience: audienceFromAccess(() => access, options.db),
                }),
            }
          : {}),
      });
      // X16: due recurring templates clone into Ready cards, once a minute.
      const stopRecurring = options.cardStore
        ? startRecurringTicker(repoPath, options.cardStore, options.log, {
            hours: (() => {
              try {
                return resolveConfig({ repoPath }).config.machine.hours;
              } catch {
                return "none";
              }
            })(),
            ...(options.recurringEveryMs ? { everyMs: options.recurringEveryMs } : {}),
          })
        : () => undefined;
      // PM-N4-1: every active goal is re-evaluated when a card closes, and
      // hourly while the daemon runs without one.
      const goalTicker = options.cardStore
        ? startGoalTicker({ repoPath, cardStore: options.cardStore, log: options.log })
        : undefined;
      // INT-11b, INT-20b: one catch-up pull at start when webhooks are the
      // route (never a timer on the tracker), and linked cards' moves shown
      // on their issues' Projects status.
      const github = options.cardStore
        ? startGithubSync(repoPath, options.cardStore, options.log)
        : undefined;
      resolve({
        port: boundPort,
        close: () =>
          new Promise<void>((done) => {
            void notifier.then((n) => n.stop());
            stopRecurring();
            goalTicker?.stop();
            github?.stop();
            stopIdentity();
            configApi.close();
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
      // The request guard's Host check, for the one route that bypasses it (SEC-24).
      if (!hostAllowed(req.headers.host, hosts)) {
        socket.end("HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n");
        return;
      }
      if ((req.url ?? "").split("?")[0] !== "/api/ws") {
        socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
        return;
      }
      // The live stream needs the same session as the page (runtime item 27).
      if (!identity.resolveHeaders(req.headers, req.socket.remoteAddress).authenticated) {
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      // Only this page's origin may open it (cross-site WebSocket hijacking):
      // the host the page was served from, in both setups; another loopback
      // port is another site. A local program sends no Origin.
      if (!sameOrigin(req.headers.origin, req.headers.host)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      const client = acceptWebSocket(req, socket, (c) => streams.delete(c), req.headers.host);
      if (client) {
        streams.add(client);
        const who = requester(req);
        if (who) streamPrincipal.set(client, who);
        void pump();
      }
    });
    server.on("error", reject);
  });
}
