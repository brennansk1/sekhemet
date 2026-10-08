import { randomUUID } from "node:crypto";
import {
  constants,
  accessSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { classifyLicence } from "@sekhemet/gates";
import { type CardStore, type EventLog, escapeTomlString, parseToml } from "@sekhemet/kernel";
import {
  AssignmentRefusal,
  CONFIG_ROLES,
  type ConfigRole,
  CopyHashMismatch,
  DEFAULT_SWAP_POLICY,
  DownloadHashMismatch,
  DownloadRefused,
  type FitHost,
  type FitLabel,
  type FoundModel,
  GPU_CEILING_SEED,
  type Graded,
  HEADROOM_DEFAULTS,
  type HeadroomProbe,
  type LlamaBenchResult,
  MANAGED_MODEL_FILES,
  MODEL_ROLES,
  MODEL_SOURCES,
  type ModelEntry,
  type ModelFolder,
  ModelRegistry,
  type ModelRole,
  type ModelSource,
  PRESET_KEYS,
  type PairedCompare,
  ROLE_SETTINGS,
  ROLE_SETTING_FIELDS,
  type RemoteCandidate,
  type RoleAssignment,
  type RoleEvidence,
  type RoleSettingKey,
  type RoleSettingValues,
  SETTINGS_PRESETS,
  SHIPPED_MODELS,
  SHIPPED_ROLE_MODEL_ROLE,
  type ScanResult,
  type SettingsPreset,
  SwapCostBook,
  type SwapEvent,
  type Volume,
  advisePlacement,
  applyFits,
  assignRole,
  cPair,
  capReport,
  checkRoleSettings,
  copyToInternal,
  currentAssignment,
  describeCombination,
  downloadFileName,
  downloadModel,
  estimateRemote,
  fillMetadata,
  fitCeilingBytes,
  fitFor,
  freeBytesAt,
  hardwareFingerprint,
  hashModels,
  hostFingerprintHash,
  isOllamaCloudTag,
  isReferenceHost,
  lookupPublishedFile,
  matchOnHub,
  measureHeadroom,
  memoryBreakdown,
  ollamaCloudRefusal,
  parseRoleSettingsFile,
  predictDecode,
  rankCombinations,
  recommendRole,
  registerModelFile,
  resolveRoleSettings,
  restoreRole,
  roleOf,
  roleSettingsFile,
  scanModelFolders,
  sekhemetConfigDir,
  sha256File,
  simulateDay,
  suggestedModelFolders,
  tableSource,
  timePerCard,
  volumeOf,
} from "@sekhemet/models";
import {
  type EffectiveNetworkPolicy,
  mergeNetworkConfigs,
  policyFetch,
  policyRefusal,
} from "@sekhemet/sandbox";
import { type DoneFacts, REVIEW_MINUTES_REFUSED } from "@sekhemet/ui";
import type { BenchmarkService } from "./benchmark_cmd.js";
import { type ModelFolderSetting, resolveConfig, userConfigPath } from "./config.js";
import { networkConfigs } from "./config_apply.js";
import { createEngineApi } from "./config_engine.js";
import { CONFIG_ROUTES, type ConfigRoute } from "./config_routes.js";
import { egressEvent } from "./egress_event.js";
import { type EgressContext, NOTHING_LEFT, egressRows } from "./egress_view.js";
import { networkHint } from "./github_transport.js";
import { recordWorkerAdopted } from "./m0_path.js";
import { swapHistory } from "./model_access.js";
import { rolePromptVersion } from "./prompt_versions.js";
import { headroomProbeFor } from "./smart_swap.js";
import { REPLAY_EVENT_TYPES, replayDemand } from "./swap_replay.js";
import type { TeamEnginesReport } from "./team_engines.js";

/**
 * The Configuration page's model section, served (B4.1 part b; routes in
 * `config_routes.ts`, shapes in PM_CONTRACT §3 *Configuration*; dashboard
 * NEW-dashboard-6, §2.16 items 1 and 1a; models NEW-models-12/13/14).
 *
 * Folders, the scan, fit and recommendations, assignment, explicit verified
 * downloads, model details with graded numbers, combinations, placement with
 * a hash-verified copy, and the residency timeline. Every number it serves
 * carries its grade (DB-NM14-1). Nothing here downloads, loads, copies or
 * benchmarks on its own initiative: a download or a copy starts only on a
 * person's POST, and a scan reads headers only. Permissions are enforced
 * before a handler runs (`team/access.ts`, `config.manage`); each change is
 * recorded on the ledger with the person's principal.
 */

export interface ConfigApiDeps {
  repoPath: string;
  log: EventLog;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readJsonBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  isTrustedMutation: (req: IncomingMessage) => boolean;
  /** The person a request is for (teams §2.3). */
  principalOf: (req: IncomingMessage) => string;
  /** A `config` frame on `/api/stream` (PM_CONTRACT: scan, hash, download and copy progress). */
  emit?: (data: Record<string, unknown>) => void;
  userConfigPath?: string;
  /**
   * Sekhemet's own write to the user config, recorded as `config/changed`
   * with the person who asked (teams TEAM-27, TEAM-44), so the next start
   * does not report it as a change made outside. Writes directly when omitted.
   */
  recordConfigWrite?: <T>(principal: string, write: () => T) => T;
  env?: NodeJS.ProcessEnv;
  /** `--models-dir`, when the server was started with it. */
  modelsDirFlag?: string;
  registry?: ModelRegistry;
  /** The live headroom (rule 20g); the macOS probe by default where there is one. */
  headroomProbe?: HeadroomProbe | null;
  /** The machine's memory bandwidth (calibration), for the roofline. */
  bandwidth?: Graded;
  /** The Hugging Face hub's base URL (tests point it at a local server). */
  hub?: string;
  /** The effective network policy; the user's and the project's `[network]` by default. */
  policy?: () => EffectiveNetworkPolicy;
  /** The paired sign test (measurement part c's `compareOnItems`). */
  compare?: PairedCompare;
  /** Cached quick scores (measurement part c's `readQuickScores`). */
  quickScores?: () => Promise<
    { role: string; model: string; items: { id: string; score: number }[] }[]
  >;
  /** Load and unload through the residency scheduler (rule 20a); absent in a server that holds no model. */
  residency?: {
    resident(): string[];
    load(
      role: ModelRole,
      model: string,
    ): Promise<{ ok: boolean; reason?: string; unload?: string[] }>;
    unload(role: ModelRole): Promise<{ deferred?: string }>;
    /** A load in flight now: the background hashing waits for it (a USB read never competes with a load). */
    loading?(): boolean;
  };
  /** How often deferred background work checks the scheduler again (ms); default 1 s. */
  yieldPollMs?: number;
  /**
   * Start the quick benchmark of a combination (measurement part c's
   * `startQuick`): *Use the recommended models* screens the recommended
   * combination with it (DB-N6-16).
   */
  startQuick?: BenchmarkService["startQuick"];
  /**
   * *Measure speed* (DB-NM14-3): llama-bench and the first token's time,
   * through the residency scheduler's benchmark rule (`dashboardSpeed`);
   * absent in a server that runs no model.
   */
  measureSpeed?: (input: {
    model: string;
    path: string;
    role: ModelRole;
    depth: number;
  }) => Promise<SpeedMeasurement>;
  /** Rule 27a's check for a role on this host (Qualify to assign). */
  qualify?: (role: ModelRole, model: string) => Promise<{ qualified: boolean; reason?: string }>;
  host?: () => string;
  /** Review capacity is per project (review-git §2.2.3). */
  cardStore?: CardStore;
  /**
   * A project's In review limit now, from its own review minutes a day
   * (the board's `reviewLimitFacts`): shown with the setting and recomputed
   * after a change, for that project alone (DB-N4-2).
   */
  reviewLimitFacts?: (project: string) => Promise<{ limit: number }>;
  /**
   * Whether the person behind a request may change a project's review
   * capacity (`review.capacity`: an Admin, or a person the project's Accept
   * rule names), and why not (DB-N4-2). Defence in depth behind `authorize`.
   */
  mayChangeReviewCapacity?: (
    req: IncomingMessage,
    project: string,
  ) => { allowed: boolean; reason?: string };
  /**
   * The facts of a project's Definition of done (dashboard DB-N14-1): its
   * checks from `gates.toml`, its depth profile and who its Accept rule
   * names. Read-only: it enforces nothing (DB-N14-3).
   */
  definitionOfDone?: (project: string | undefined) => DoneFacts;
  /**
   * Network activity (security item 33a, DB-N24-3): who the reader is, as
   * the rows' visibility and their causes' names need. Default: everything,
   * the install's own person.
   */
  egressContext?: (req: IncomingMessage) => EgressContext;
  /** The hashes already computed, by path, size and modification time; `<user dir>/model-hashes.json`. */
  hashCachePath?: string;
  /** Where a copy to internal storage goes: `~/AI-Models/llm` by default. */
  internalDir?: string;
  volume?: (path: string) => Volume;
  freeBytes?: (dir: string) => number;
  now?: () => Date;
  /**
   * Whether this is the reference host (MD-N21-9, FINDINGS CFG-14): only
   * there does the seed GPU ceiling apply. Default: this machine's fingerprint.
   */
  referenceHost?: () => boolean;
  /**
   * The Team server's engine services checked (`checkTeamEngines`, models
   * MD-N15-3): each role names its service's state in words. Absent in Solo.
   */
  teamEngines?: () => Promise<TeamEnginesReport>;
  /**
   * Whether the person behind a request holds `config.manage`: the engine
   * card's defence in depth behind the access table. Default: yes (Solo).
   */
  mayManage?: (req: IncomingMessage) => boolean;
}

type Json = Record<string, unknown>;

/**
 * One *Measure speed* (dashboard DB-NM14-3): llama-bench's result (Measured
 * only when accepted) and the first token's time with and without the prefix
 * cache; a part that could not run says why.
 */
export interface SpeedMeasurement {
  bench?: LlamaBenchResult;
  benchError?: string;
  ttft?: { withoutCacheMs: Graded; withCacheMs: Graded; runs: number };
  ttftError?: string;
}

/** The depth llama-bench measures a role at: half its context (a design value). */
export const speedDepth = (contextTokens: number): number => Math.round(contextTokens / 2);

/**
 * Which roles' quick screens exist (MS-N5-4b, DB-N6-18): the Reviewer's
 * arrives with B4.8 and the Researcher's with B4.4; until then their quick
 * scores are *Not measured yet*, read nowhere and recommended from the
 * qualification record and the registry alone.
 */
export const SCREEN_BUILT: Readonly<Record<ConfigRole, boolean>> = {
  worker: true,
  planner: true,
  reviewer: false,
  researcher: false,
  vision: false,
};

// ── the user configuration's `[models] folders` ──────────────────────────

/** Rewrite `[models] folders` in the user config, keeping every other line. */
export function writeModelFolders(path: string, folders: readonly ModelFolderSetting[]): void {
  const value = `folders = [${folders
    .map((f) =>
      f.includeSubfolders
        ? `{ path = ${escapeTomlString(f.path)}, subfolders = true }`
        : escapeTomlString(f.path),
    )
    .join(", ")}]`;
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = text.split("\n");
  let section = "";
  let start = -1;
  let end = -1;
  let modelsAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const header = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line);
    if (header) {
      section = (header[1] as string).trim();
      if (section === "models") modelsAt = i;
      continue;
    }
    if (section === "models" && /^\s*folders\s*=/.test(line)) {
      start = i;
      // A multi-line array ends where its brackets balance.
      let depth = 0;
      for (let j = i; j < lines.length; j++) {
        for (const ch of (lines[j] as string).replace(/"(?:[^"\\]|\\.)*"/g, "")) {
          if (ch === "[") depth++;
          else if (ch === "]") depth--;
        }
        if (depth <= 0) {
          end = j;
          break;
        }
      }
      break;
    }
  }
  if (start >= 0) lines.splice(start, end - start + 1, value);
  else if (modelsAt >= 0) lines.splice(modelsAt + 1, 0, value);
  else lines.push(...(text.length && !text.endsWith("\n") ? [""] : []), "[models]", value);
  const out = lines.join("\n");
  parseToml(out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, out.endsWith("\n") ? out : `${out}\n`);
}

// ── the user configuration's `[queue] agent_issues_per_person` ──────────────

/** Why a typed per-person Agent cap is refused (TEAM-30), said beside the field. */
export const QUEUE_CAP_REFUSED = "Agent issues per person is a whole number, 1 or more.";

/**
 * Rewrite `[queue] agent_issues_per_person` in the user config, keeping every
 * other line (teams item 30, TEAM-30): the one key replaced in place, else
 * added under `[queue]`, else a `[queue]` table appended.
 */
export function writeQueueCap(path: string, cap: number): void {
  if (!Number.isInteger(cap) || cap < 1) throw new Error(QUEUE_CAP_REFUSED);
  const value = `agent_issues_per_person = ${cap}`;
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = text.split("\n");
  let section = "";
  let at = -1;
  let queueAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const header = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line);
    if (header) {
      section = (header[1] as string).trim();
      if (section === "queue") queueAt = i;
      continue;
    }
    if (section === "queue" && /^\s*agent_issues_per_person\s*=/.test(line)) {
      at = i;
      break;
    }
  }
  if (at >= 0) lines.splice(at, 1, value);
  else if (queueAt >= 0) lines.splice(queueAt + 1, 0, value);
  else {
    while (lines.length && lines.at(-1) === "") lines.pop();
    lines.push(...(lines.length ? [""] : []), "[queue]", value);
  }
  const out = lines.join("\n");
  parseToml(out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, out.endsWith("\n") ? out : `${out}\n`);
}

// ── helpers ───────────────────────────────────────────────────────────────

const gbText = (b: number) => `${(b / 1e9).toFixed(1)} GB`;

/** A model role as a person reads it (DEC-31): the Coding, Planning, Review or Research model. */
const ROLE_WORDS: Record<string, string> = {
  worker: "Coding model",
  planner: "Planning model",
  reviewer: "Review model",
  researcher: "Research model",
};
const roleWords = (role: string): string => ROLE_WORDS[role] ?? role;

function matchRoute(
  method: string,
  url: string,
): { route: ConfigRoute; params: Record<string, string> } | undefined {
  for (const route of CONFIG_ROUTES) {
    if (route.module !== "config_api" || route.method !== method) continue;
    const names: string[] = [];
    const re = new RegExp(
      `^${route.path.replace(/:([A-Za-z]+)/g, (_m, n: string) => {
        names.push(n);
        return "([^/]+)";
      })}$`,
    );
    const m = re.exec(url);
    if (m) {
      return {
        route,
        params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1] ?? "")])),
      };
    }
  }
  return undefined;
}

/** The registry id a found model is known by: its registry match, else a slug of its name. */
export function modelKey(m: Pick<FoundModel, "registryId" | "name">): string {
  return (
    m.registryId ??
    m.name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
  );
}

interface ActiveTask {
  id: string;
  controller: AbortController;
  model: string;
}

/** The Configuration API's model section; `handle` answers a request or returns false. */
/**
 * The model page's licence warning: a model whose licence is not permissive,
 * judged by the one licence classifier (design-stage P7), asks the person to
 * check it allows their use. A model file that names no licence gets none.
 */
export function modelLicenceWarning(license: string | undefined): string | undefined {
  if (!license) return undefined;
  return classifyLicence(license).usable
    ? undefined
    : `Its licence is ${license}: check it allows your use.`;
}

export function createConfigApi(deps: ConfigApiDeps) {
  /** The project a review-capacity request names, or the workspace's only active one. */
  const reviewProject = (named: string | undefined): string | undefined => {
    if (named) return named;
    const active = deps.cardStore?.listProjects().filter((p) => p.status === "active") ?? [];
    return active.length === 1 ? active[0]?.id : undefined;
  };
  const env = deps.env ?? process.env;
  const cfgPath = deps.userConfigPath ?? userConfigPath();
  const configWrite = <T>(principal: string, write: () => T): T =>
    deps.recordConfigWrite ? deps.recordConfigWrite(principal, write) : write();
  const registry = deps.registry ?? new ModelRegistry();
  const probe =
    deps.headroomProbe === null ? undefined : (deps.headroomProbe ?? headroomProbeFor(true));
  const host = deps.host ?? hostFingerprintHash;
  const referenceHost = deps.referenceHost ?? (() => isReferenceHost(hardwareFingerprint()));
  const volume = deps.volume ?? ((p: string) => volumeOf(p));
  const freeBytes = deps.freeBytes ?? freeBytesAt;
  const internalDir = deps.internalDir ?? join(homedir(), "AI-Models", "llm");
  const emit = deps.emit ?? (() => {});
  const state: {
    scan?: ScanResult;
    models: FoundModel[];
    hashing?: AbortController;
    hashes: Map<string, string>;
    /** A model's earlier id (path and size) → its path, so a link made before hashing still opens it. */
    aliases: Map<string, string>;
  } = { models: [], hashes: new Map(), aliases: new Map() };
  // Hashing 13 GB from a USB drive takes minutes: a file's hash is kept by
  // its path, size and modification time, so it is computed once.
  const hashCachePath = deps.hashCachePath ?? join(sekhemetConfigDir(env), "model-hashes.json");
  const fileKey = (path: string, size: number) => {
    try {
      return `${path}\0${size}\0${Math.round(statSync(path).mtimeMs)}`;
    } catch {
      return `${path}\0${size}`;
    }
  };
  try {
    const saved = JSON.parse(readFileSync(hashCachePath, "utf8")) as Record<string, string>;
    for (const [k, v] of Object.entries(saved))
      if (/^[0-9a-f]{64}$/.test(v)) state.hashes.set(k, v);
  } catch {
    // No cache yet.
  }
  const rememberHash = (path: string, size: number, sha: string) => {
    state.hashes.set(fileKey(path, size), sha);
    try {
      mkdirSync(dirname(hashCachePath), { recursive: true });
      writeFileSync(hashCachePath, JSON.stringify(Object.fromEntries(state.hashes)));
    } catch {
      // The cache is a convenience; a failed write only means hashing again.
    }
  };
  const downloads = new Map<string, ActiveTask>();
  const copies = new Map<string, ActiveTask>();

  const policy = () =>
    deps.policy?.() ??
    (() => {
      const n = networkConfigs(deps.repoPath, cfgPath);
      return mergeNetworkConfigs(n.user, n.project);
    })();
  const recordEgress = (r: Parameters<typeof egressEvent>[0]) =>
    deps.log.append({ actor: "harness", ...egressEvent(r) });
  const lookupFetch = () =>
    policyFetch(policy(), { purpose: "model lookup", research: true, record: recordEgress });
  const downloadFetch = () =>
    policyFetch(policy(), { purpose: "model download", record: recordEgress, stream: true });
  const downloadRefusal = (sourceHost: string): string | undefined => {
    const reason = policyRefusal(policy(), sourceHost);
    return reason ? `${networkHint(reason, sourceHost)} ([network] mode)` : undefined;
  };

  // ── folders ────────────────────────────────────────────────────────────
  const configured = (): (ModelFolderSetting & { source: ModelFolder["source"] })[] => {
    let fromConfig: ModelFolderSetting[] = [];
    try {
      fromConfig = resolveConfig({ repoPath: deps.repoPath, userConfigPath: cfgPath }).config.models
        .folders;
    } catch {
      fromConfig = [];
    }
    const out: (ModelFolderSetting & { source: ModelFolder["source"] })[] = fromConfig.map((f) => ({
      ...f,
      source: "config",
    }));
    const add = (path: string | undefined, source: ModelFolder["source"]) => {
      if (!path) return;
      if (out.some((f) => resolve(f.path) === resolve(path))) return;
      out.push({ path, includeSubfolders: false, source });
    };
    add(deps.modelsDirFlag, "flag");
    add(env.SEKHEMET_MODELS_DIR?.trim(), "env");
    return out;
  };

  /** Whether a folder is there, a folder, and writable now (an unplugged drive is not). */
  const writableNow = (path: string): boolean => {
    try {
      if (!statSync(path).isDirectory()) return false;
      accessSync(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * The folder a download is written to (DB-N6-6): the one the person saw in
   * the confirmation, which must be a configured folder that is there and
   * writable now. Never created: a missing folder is an unmounted drive.
   */
  const downloadFolder = (want: unknown): { path: string } | { error: string } => {
    if (typeof want !== "string" || !want.trim())
      return {
        error: "Name the folder the download is written to, as the confirmation showed it.",
      };
    const folder = configured().find((f) => resolve(f.path) === resolve(want));
    if (!folder) return { error: "Downloads go only into a model folder you added." };
    if (!writableNow(folder.path))
      return {
        error: `${folder.path} is not there or cannot be written (is its drive connected?); nothing was downloaded.`,
      };
    return { path: folder.path };
  };

  /** The folder the confirmation offers: the first configured one that can take a download now. */
  const offeredFolder = (): string | undefined =>
    configured().find((f) => writableNow(f.path))?.path;

  // ── fit against the live headroom ──────────────────────────────────────
  let bookCache: { at: number; book: SwapCostBook; events: SwapEvent[] } | undefined;
  const swapBook = async () => {
    if (bookCache && Date.now() - bookCache.at < 5000) return bookCache;
    const events = await swapHistory(deps.log);
    const book = new SwapCostBook();
    for (const e of events) {
      const p = e.payload as {
        model?: string;
        volume?: Volume;
        cache?: "cold" | "warm";
        bytes?: number;
        loadMs?: number;
        unloadMs?: number;
      };
      if (e.type === "model/loaded" && p.model && p.volume && p.cache && p.loadMs !== undefined) {
        book.add({
          model: p.model,
          volume: p.volume,
          cache: p.cache,
          bytes: p.bytes ?? 0,
          loadMs: p.loadMs,
        });
      }
      if (e.type === "model/unloaded" && p.model && p.unloadMs !== undefined)
        book.addUnload(p.model, p.unloadMs);
    }
    bookCache = { at: Date.now(), book, events };
    return bookCache;
  };

  const fitHost = async (): Promise<FitHost & { reading?: string }> => {
    const { book, events } = await swapBook();
    const swapSeconds: FitHost["swapSeconds"] = (m) => {
      const p = book.predict({
        model: modelKey(m),
        volume: volume(m.path),
        cache: "cold",
        bytes: m.sizeBytes,
      });
      return {
        value: Math.round(p.medianMs / 1000),
        grade: p.basis === "measured" ? "measured" : "estimated",
      };
    };
    // MD-N21-9 (CFG-14): the ceilings this host recorded; the seed only on the reference host.
    const recorded = events
      .filter((e) => e.type === "model/gpu_ceiling")
      .map((e) => e.payload as { basis: string; bytes: number });
    const ceiling = fitCeilingBytes(recorded, referenceHost(), GPU_CEILING_SEED.bytes);
    const withCeiling = ceiling !== undefined ? { gpuCeilingBytes: ceiling } : {};
    if (probe) {
      try {
        const r = await probe.read();
        const h = measureHeadroom(r, { computeBufferBytes: 0 });
        // MD-N21-8 (CFG-02): this machine's usable memory, not the momentary free memory.
        const theirs = r.processes.filter((p) => !p.ours).reduce((n, p) => n + p.footprintBytes, 0);
        const usable = Math.max(
          0,
          Math.min(
            r.gpuWiredLimitBytes - HEADROOM_DEFAULTS.gpuMarginBytes,
            r.totalBytes - HEADROOM_DEFAULTS.macosReserveBytes - HEADROOM_DEFAULTS.harnessPeakBytes,
          ) - theirs,
        );
        return {
          headroom: { value: h.bytes, grade: "measured" },
          usableBytes: { value: usable, grade: "measured" },
          resident: r.processes.map((p) => ({
            name: p.name,
            footprintBytes: p.footprintBytes,
            ours: p.ours,
          })),
          gpuWiredLimitBytes: r.gpuWiredLimitBytes,
          ...withCeiling,
          swapSeconds,
          reading: "measured",
        };
      } catch {
        // Fall through to the estimate.
      }
    }
    const total = totalmem();
    const share = total > 36 * 1024 ** 3 ? 0.75 : 2 / 3;
    return {
      headroom: { value: Math.max(0, total * share - 1024 ** 3), grade: "estimated" },
      gpuWiredLimitBytes: total * share,
      ...withCeiling,
      swapSeconds,
      reading: "estimated",
    };
  };

  const published = (m: FoundModel) => {
    const entry = registryEntryFor(m);
    const sha = entry?.sha256 ?? entry?.source?.sha256;
    return entry && sha ? { registryId: entry.id, sha256: sha } : undefined;
  };

  /** The registry entry a found model is: by hash, by id, or by the managed file's name. */
  const registryEntryFor = (
    m: Pick<FoundModel, "sha256" | "name" | "path" | "registryId">,
  ): ModelEntry | undefined => {
    if (m.registryId) return registry.get(m.registryId);
    if (m.sha256) {
      const byHash = registry.bySha256(m.sha256);
      if (byHash) return byHash;
    }
    const file = m.path.split("/").pop() ?? "";
    for (const e of registry.list()) {
      if (e.id === m.name || e.id === modelKey({ name: m.name })) return e;
      if ((e.copies ?? []).some((c) => c.path === m.path)) return e;
    }
    for (const [role, managed] of Object.entries(MANAGED_MODEL_FILES)) {
      if (managed.endsWith(`/${file}`))
        return registry.get(role) ?? { id: managed.split("/")[0] ?? role };
    }
    return undefined;
  };

  const refit = async (models: FoundModel[]) => applyFits(models, await fitHost());

  const startHashing = () => {
    state.hashing?.abort();
    const ac = new AbortController();
    state.hashing = ac;
    const pending = state.models.filter((m) => m.hash === "pending");
    void hashModels(pending, {
      published,
      signal: ac.signal,
      known: (path, size) => state.hashes.get(fileKey(path, size)),
      // A first hash of 13 GB from a USB drive never competes with a model
      // load: it waits while the scheduler has one in flight.
      beforeRead: async () => {
        while (deps.residency?.loading?.() && !ac.signal.aborted) {
          await new Promise((r) => setTimeout(r, deps.yieldPollMs ?? 1000));
        }
      },
      onHashed: (m) => {
        if (m.sha256) rememberHash(m.path, m.sizeBytes, m.sha256);
        for (const x of state.models)
          if (x.path === m.path && x.id !== m.id) state.aliases.set(x.id, m.path);
        state.models = state.models.map((x) =>
          x.path === m.path
            ? { ...m, fits: x.fits, fitReason: x.fitReason, ...(x.fit ? { fit: x.fit } : {}) }
            : x,
        );
        emit({
          kind: "hash",
          id: m.id,
          file: m.file,
          hash: m.hash,
          ...(m.verified !== undefined ? { verified: m.verified } : {}),
        });
      },
    }).catch(() => undefined);
  };

  const scan = async (principal?: string) => {
    const folders = configured();
    const result = await scanModelFolders(folders, {
      onFolder: (p) => emit({ kind: "scan", ...p }),
      ...(deps.now ? { now: deps.now } : {}),
    });
    // Keep what hashing already learned for an unchanged file.
    const models = result.models.map((m) => {
      const sha = m.format === "gguf" ? state.hashes.get(fileKey(m.path, m.sizeBytes)) : undefined;
      if (!sha) return m;
      state.aliases.set(m.id, m.path);
      const pub = published({ ...m, sha256: sha });
      return {
        ...m,
        id: sha,
        sha256: sha,
        hash: pub
          ? pub.sha256 === sha
            ? ("verified" as const)
            : ("hash_differs" as const)
          : ("not_registry" as const),
        ...(pub ? { verified: pub.sha256 === sha, registryId: pub.registryId } : {}),
      };
    });
    state.scan = result;
    state.models = await refit(models);
    await deps.log.append({
      actor: principal ? "human" : "harness",
      type: "models/scanned",
      ...(principal ? { principal } : {}),
      payload: {
        folderCount: folders.length,
        depth: result.depth,
        fileLimit: result.fileLimit,
        found: result.models.length,
        skipped: result.skipped.length,
        truncated: result.truncated,
      },
      private: { folders: folders.map((f) => f.path) },
    });
    startHashing();
    return result;
  };

  const modelsBody = async () => {
    if (!state.scan) await scan();
    const folders = configured();
    const scanned = new Map((state.scan?.folders ?? []).map((f) => [resolve(f.path), f]));
    return {
      folders: folders.map((f) => {
        const s = scanned.get(resolve(f.path));
        const writable = writableNow(f.path);
        return s
          ? { ...s, source: f.source, includeSubfolders: f.includeSubfolders, writable }
          : { ...f, readable: true, writable };
      }),
      suggestedFolders: suggestedModelFolders({ env, configured: folders.map((f) => f.path) }),
      models: state.models,
      skipped: state.scan?.skipped ?? [],
      truncated: state.scan?.truncated ?? false,
      scannedAt: state.scan?.scannedAt,
    };
  };

  // ── qualification and evidence ─────────────────────────────────────────
  // The model's qualification for the role on this build (CX-N6-1, CX-N6-4):
  // its newest record under this build's prompt version for the role. A
  // record another build made under its own version is that build's (F23);
  // one qualified only under another version is owed a re-qualification here.
  const qualificationOf = (model: string, role: ModelRole): RoleEvidence["qualification"] => {
    const e = registry.get(model);
    if (!e) return "missing";
    const all = e.qualifications ?? [];
    // A registry from before combinations were recorded: its per-model record.
    if (all.length === 0) return e.qualification?.status ?? "missing";
    const version = rolePromptVersion(role);
    const mine = all.filter((q) => roleOf(q.combination) === role);
    const newest = mine.filter((q) => q.combination.settings.contextVersion === version).at(-1);
    // MD-N21-3: a person's values changed an element since it qualified.
    if (newest?.status === "qualified" && verificationOf(model, role).state === "needs_verifying")
      return "invalidated";
    if (newest) return newest.status;
    return mine.some((q) => q.status === "qualified") ? "invalidated" : "missing";
  };
  /** A role's verification as a person's values now make its combination (MD-N21-3). */
  const verificationOf = (model: string, role: ModelRole) =>
    registry.roleVerification(model, role, rolePromptVersion(role));

  let evalMod: { compareOnItems?: unknown; readQuickScores?: unknown } | undefined;
  const loadEval = async () => {
    if (evalMod) return evalMod;
    try {
      evalMod = (await import("@sekhemet/eval")) as unknown as typeof evalMod;
    } catch {
      evalMod = {};
    }
    return evalMod ?? {};
  };
  const compareFn = async (): Promise<PairedCompare | undefined> => {
    if (deps.compare) return deps.compare;
    const ev = await loadEval();
    const f = ev.compareOnItems as
      | ((
          role: ModelRole,
          a: unknown,
          b: unknown,
        ) => { better: number; worse: number; indistinguishable: boolean })
      | undefined;
    return f ? (a, b) => f("worker", a, b) : undefined;
  };
  const quick = async () => {
    if (deps.quickScores) return deps.quickScores();
    const ev = await loadEval();
    const f = ev.readQuickScores as
      | ((
          log: EventLog,
        ) => Promise<{ role: string; model: string; items?: { id: string; score: number }[] }[]>)
      | undefined;
    if (!f) return [];
    return (await f(deps.log)).map((s) => ({ role: s.role, model: s.model, items: s.items ?? [] }));
  };

  const assignedModel = (role: ModelRole) => {
    const a = currentAssignment(registry, host(), role);
    return a && a.model !== "(unfilled)" ? a.model : undefined;
  };
  /** A model's family: the registry's, the scan's, else the shipped table's (rule 3). */
  const familyOfModel = (id: string) =>
    registry.get(id)?.family ??
    state.models.find((m) => modelKey(m) === id)?.family ??
    SHIPPED_MODELS.find((m) => m.id === id)?.family;
  /**
   * The Coding model's family: the assigned one's, else — while none is
   * assigned — the recommended one's, so the Review model is never suggested
   * of the family the Coding model it is suggested beside has (rule 3; B1-C3
   * review).
   */
  const workerFamily = (recommended?: string) => {
    const w = assignedModel("worker") ?? recommended;
    return w ? familyOfModel(w) : undefined;
  };

  /**
   * Models with a source that are not in any folder (rule 4c: "up to the
   * strongest"): the registry's, and the shipped set's (rule 3), each shipped
   * row a default for its own role — so a clean machine, whose registry is
   * empty, is offered the shipped set (MD-N18-3; B1-C3 review).
   */
  const remoteCandidates = async (role: ConfigRole): Promise<RemoteCandidate[]> => {
    const present = new Set(state.models.map((m) => registryEntryFor(m)?.id).filter(Boolean));
    const fh = await fitHost();
    const usable =
      fh.headroom.value +
      (fh.resident ?? []).filter((r) => r.ours).reduce((n, r) => n + r.footprintBytes, 0);
    const need = (sizeBytes: number) =>
      memoryBreakdown({ sizeBytes, metadata: {} }, ROLE_SETTINGS[role]).totalBytes.value;
    const out: RemoteCandidate[] = [];
    for (const e of registry.list()) {
      if (present.has(e.id) || !e.source || !e.sizeBytes) continue;
      const shipped = SHIPPED_MODELS.find((m) => m.id === e.id);
      out.push({
        id: e.id,
        name: e.id,
        ...(e.family ? { family: e.family } : {}),
        fits: need(e.sizeBytes) <= usable ? "yes" : "no",
        footprintBytes: need(e.sizeBytes),
        registryDefault:
          (e.roles ?? []).includes(role as ModelRole) ||
          (shipped !== undefined && SHIPPED_ROLE_MODEL_ROLE[shipped.role] === role),
        source: e.source,
      });
    }
    for (const m of SHIPPED_MODELS) {
      if (!m.id || !m.source || present.has(m.id) || out.some((o) => o.id === m.id)) continue;
      const source = tableSource(m.id, deps.hub);
      if (!source) continue;
      out.push({
        id: m.id,
        name: m.name ?? m.id,
        ...(m.family ? { family: m.family } : {}),
        fits: need(m.source.sizeBytes) <= usable ? "yes" : "no",
        footprintBytes: need(m.source.sizeBytes),
        registryDefault: SHIPPED_ROLE_MODEL_ROLE[m.role] === role,
        source,
      });
    }
    return out;
  };

  /**
   * The roles whose suggestion a person kept on this machine (DB-N27-1, *Keep*;
   * B1-C3 review): the latest `models/suggestion_kept` per role, a keep naming
   * the model it kept, so it lapses once another model is assigned.
   */
  const keptRoles = async (): Promise<Map<ModelRole, string>> => {
    const out = new Map<ModelRole, string>();
    for (const e of await deps.log.getEventsByTypes(["models/suggestion_kept"])) {
      const p = e.payload as { role: ModelRole; model: string; kept: boolean; host: string };
      if (p.host !== host()) continue;
      if (p.kept) out.set(p.role, p.model);
      else out.delete(p.role);
    }
    return out;
  };

  /** The Team server's engine check for one role, in words (MD-N15-3), or undefined. */
  const engineFor = (report: TeamEnginesReport | undefined, role: ModelRole) => {
    const e = report?.engines.find((x) => x.roles.some((r) => SHIPPED_ROLE_MODEL_ROLE[r] === role));
    if (!e) return undefined;
    return {
      service: e.service,
      state: e.state,
      line:
        e.state === "ok"
          ? `${e.service}: answering on port ${e.port}, matches its profile.`
          : e.state === "no-engine"
            ? `${e.service}: ${e.reason ?? `no engine answers on port ${e.port}`}.`
            : `${e.service}: refused — ${e.reason ?? "it does not match its profile"}.`,
    };
  };

  /**
   * A role's checks in words (DB-N27-1): fit, verification, the Review
   * model's family — for the assigned model, else the recommended one (the
   * first hour: nothing assigned, every row still states its checks).
   * `remoteFit` is a model not in any folder: the fit of its download.
   * A Review model of the Coding model's family is a failing check, never
   * left out (B1-C3 review).
   */
  const checksFor = (
    role: ModelRole,
    model: string | undefined,
    qualified: boolean,
    opts: { remoteFit?: FitLabel; worker?: string } = {},
  ): string[] => {
    if (!model) return [];
    const out: string[] = [];
    const found = state.models.find((m) => modelKey(m) === model);
    const fit = found?.fits[role] ?? opts.remoteFit;
    if (fit === "yes" || fit === "swaps") out.push("Fits in memory");
    else if (fit === "no") out.push(found?.fitReason[role] ?? "Does not fit in memory");
    const v = verificationOf(model, role);
    if (v.state === "needs_verifying")
      out.push(`Needs verifying: ${(v.changed ?? []).join(", ") || "its settings"} changed`);
    else out.push(qualified ? "Verified on this machine" : "Not verified on this machine yet");
    if (role === "reviewer") {
      const family = familyOfModel(model);
      const wf = workerFamily(opts.worker);
      if (!family) out.push("Not shown to be of another family: its family is unknown");
      else if (wf && family === wf)
        out.push(`Not from another family: the Coding model's is ${wf} too`);
      else if (wf) out.push("Review model from another family");
    }
    return out;
  };

  const rolesBody = async (): Promise<{ roles: (RoleAssignment & Json)[] }> => {
    if (!state.scan) await scan();
    const scores = await quick();
    const compare = await compareFn();
    const resident = new Set(deps.residency?.resident() ?? []);
    const engines = await deps.teamEngines?.().catch(() => undefined);
    const roles: (RoleAssignment & Json)[] = [];
    const keeps = await keptRoles();
    /** The recommended Coding model, while none is assigned (MODEL_ROLES lists it first). */
    let recommendedWorker: string | undefined;
    for (const role of MODEL_ROLES) {
      const model = assignedModel(role);
      const history = registry
        .roleAssignments(host())
        .filter((a) => a.role === role && a.scope === "personal");
      const previous = [...history].reverse().find((a) => a.model !== model)?.model;
      const r = recommendRole({
        role,
        present: state.models.map((m) => ({ ...m, id: modelKey(m) })),
        remote: await remoteCandidates(role),
        workerFamily: role === "reviewer" ? workerFamily(recommendedWorker) : undefined,
        screenBuilt: SCREEN_BUILT[role],
        ...(compare ? { compare } : {}),
        evidence: (id) => {
          const q = scores.filter((s) => s.role === role && s.model === id).at(-1);
          const entry = registry.get(id);
          return {
            qualification: qualificationOf(id, role),
            ...(q?.items.length ? { quick: { items: q.items } } : {}),
            ...((entry?.roles ?? []).includes(role) ? { registryDefault: true } : {}),
          };
        },
      });
      const rec = r.recommendation;
      const download = rec?.download
        ? {
            ...rec.download,
            ...(downloadRefusal(rec.download.source)
              ? { blockedBy: downloadRefusal(rec.download.source) }
              : {}),
          }
        : undefined;
      if (role === "worker" && !model) recommendedWorker = rec?.model;
      // The row's model: the assigned one, else the recommended one (DB-N27-1).
      const shown = model ?? rec?.model;
      const qualified = shown
        ? ["qualified", "overridden"].includes(qualificationOf(shown, role))
        : false;
      const remoteFit =
        shown && rec && !rec.present && rec.model === shown
          ? (await remoteCandidates(role)).find((c) => c.id === shown)?.fits
          : undefined;
      const kept = model !== undefined && keeps.get(role) === model;
      const engine = engineFor(engines, role);
      roles.push({
        role,
        ...(model ? { model } : {}),
        state: !model ? "not_configured" : resident.has(model) ? "resident" : "swapped_out",
        qualified: model ? qualified : false,
        checks: checksFor(role, shown, qualified, {
          ...(remoteFit ? { remoteFit } : {}),
          ...(recommendedWorker ? { worker: recommendedWorker } : {}),
        }),
        ...(kept ? { kept: true } : {}),
        ...(model ? { verification: verificationOf(model, role) } : {}),
        ...(engine ? { engine } : {}),
        ...(!model && r.unfilledReason ? { unfilledReason: r.unfilledReason } : {}),
        ...(!model && !r.unfilledReason
          ? { unfilledReason: "No model is assigned to this role yet." }
          : {}),
        ...(rec ? { recommendation: { ...rec, ...(download ? { download } : {}) } } : {}),
        ...(previous ? { previous } : {}),
        screen: SCREEN_BUILT[role] ? "built" : "not_measured",
        ...(role === "planner" ? { note: "Seshat, the project manager, runs on this model." } : {}),
      });
    }
    return { roles };
  };

  // ── model details (DB-NM14-1–4) ────────────────────────────────────────
  const findModel = (id: string) =>
    state.models.find(
      (m) =>
        m.id === id ||
        modelKey(m) === id ||
        m.sha256 === id ||
        m.name === id ||
        state.aliases.get(id) === m.path,
    );

  /** A model's load cost from the book on its volume, cold: what C_pair is made of. */
  const loadCost = (book: SwapCostBook, found: FoundModel) => {
    const p = book.predict({
      model: modelKey(found),
      volume: volume(found.path),
      cache: "cold",
      bytes: found.sizeBytes,
    });
    return { median: p.medianMs, p90: p.p90Ms };
  };
  const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;
  /**
   * The aging caps this model cannot meet (MD-N14-20): for the role asked and
   * Seshat's interactive answers, a cap below the round trip to this model
   * from the assigned Coding model (C_pair, p90), with the predicted wait
   * (the round trip at its median) instead.
   */
  const infeasibleCaps = (
    found: FoundModel,
    key: string,
    role: string,
    book: SwapCostBook,
  ): string[] => {
    const homeKey = assignedModel("worker");
    const home =
      homeKey && homeKey !== key ? state.models.find((x) => modelKey(x) === homeKey) : undefined;
    const sides = [
      home ? { load: loadCost(book, home) } : undefined,
      { load: loadCost(book, found) },
    ] as const;
    const p90 = cPair(sides[0], sides[1]);
    const median = cPair(sides[0], sides[1], { basis: "median" });
    if (p90 === undefined) return [];
    const classes = ["interactive", ...(MODEL_ROLES.includes(role as ModelRole) ? [role] : [])];
    const report = capReport(
      DEFAULT_SWAP_POLICY,
      0,
      Object.fromEntries(classes.map((c) => [c, p90])),
    );
    return report.caps
      .filter((c) => classes.includes(c.cls) && !c.feasible)
      .map(
        (c) =>
          `Its aging cap for ${c.cls === "interactive" ? "Seshat's quick answers" : `the ${roleWords(c.cls as ModelRole)}`} (${minutes(c.capMs)}) is below its round trip: the predicted wait is about ${minutes(median ?? c.predictedWaitMs ?? p90)} instead.`,
      );
  };

  const detailsBody = async (m: FoundModel, query: URLSearchParams) => {
    const role = (query.get("role") as ConfigRole | null) ?? "worker";
    const settings = ROLE_SETTINGS[CONFIG_ROLES.includes(role) ? role : "worker"];
    // DB-N27-6 (CFG-13): the chosen role's context and KV type as this model runs them there.
    const runs = MODEL_ROLES.includes(role as ModelRole)
      ? resolved(modelKey(m), role as ModelRole)
      : undefined;
    const ran = (k: RoleSettingKey) => runs?.find((v) => v.key === k)?.value;
    const context =
      Number(query.get("context") ?? "") || Number(ran("contextTokens") ?? settings.contextTokens);
    const kvType = query.get("kvType") || String(ran("kvType") ?? settings.kvType);
    const fh = await fitHost();
    const memory = memoryBreakdown(m, { contextTokens: context, kvType });
    const engines = m.format === "mlx" ? ["mlx"] : ["llama.cpp"];
    const recorded = await lastSpeed(modelKey(m), role);
    const speeds = engines.map((engine) => {
      const d = predictDecode(m.metadata, m.sizeBytes, deps.bandwidth, engine);
      return {
        engine,
        decodeTokensPerSecond: d ?? { value: 0, grade: "design" as const },
        ...(d
          ? {}
          : { note: "Not estimated: this machine's memory bandwidth has not been measured." }),
        efficiency: {
          value: DEFAULT_SWAP_POLICY.engineEfficiency[engine] ?? 0,
          grade: "design" as const,
        },
        ...(engine === "llama.cpp" && recorded ? speedShown(recorded) : {}),
      };
    });
    const { book, events } = await swapBook();
    const key = modelKey(m);
    const loads = (["internal", "external"] as Volume[]).map((v) => {
      const cold = book.predict({ model: key, volume: v, cache: "cold", bytes: m.sizeBytes });
      const warm = book.predict({ model: key, volume: v, cache: "warm", bytes: m.sizeBytes });
      const grade = (b: string) =>
        b === "measured" ? ("measured" as const) : ("estimated" as const);
      return {
        volume: v,
        coldMs: { value: cold.medianMs, grade: grade(cold.basis), high: cold.p90Ms },
        warmMs: { value: warm.medianMs, grade: grade(warm.basis), high: warm.p90Ms },
      };
    });
    const warnings: string[] = [];
    for (const r of MODEL_ROLES) {
      if (m.fits[r] === "no") warnings.push(`It won't fit for the ${r}: ${m.fitReason[r] ?? ""}`);
    }
    if (volume(m.path) === "external") {
      warnings.push(
        "It is on a slow drive: loads take minutes. Copy to internal storage to cut them.",
      );
    }
    for (const r of MODEL_ROLES) {
      if (!["qualified", "overridden"].includes(qualificationOf(key, r))) {
        warnings.push(`Not verified on this machine for the ${roleWords(r)} yet.`);
      }
    }
    const licence = modelLicenceWarning(m.metadata.license);
    if (licence) warnings.push(licence);
    // DB-NM14-4: an Ollama requantisation (models rule 20h), in words.
    const requantised = events
      .filter((e) => e.type === "model/requantised")
      .map((e) => e.payload as { model?: string; servedQuant?: string; fileQuant?: string })
      .filter((p) => p.model === key || p.model === m.name)
      .at(-1);
    if (requantised) {
      const what =
        requantised.servedQuant && requantised.fileQuant
          ? ` (${requantised.servedQuant} where the file is ${requantised.fileQuant})`
          : "";
      warnings.push(
        `Ollama serves it requantised${what}: its answers may not match the file's. Run it on llama-server instead.`,
      );
    }
    // DB-NM14-4, MD-N14-20: an aging cap below the model's round trip is
    // infeasible; the person sees the predicted wait instead.
    for (const line of infeasibleCaps(m, key, role, book)) warnings.push(line);
    const entry = registryEntryFor(m);
    return {
      model: {
        ...m,
        identity: {
          family: m.family,
          parametersTotal:
            m.metadata.parametersTotal !== undefined
              ? {
                  value: m.metadata.parametersTotal,
                  // The header's count is read from the file; the hub's is its claim.
                  grade:
                    m.metadata.sources?.parametersTotal === "huggingface" ? "estimated" : "file",
                }
              : undefined,
          parametersActive:
            m.metadata.parametersActive !== undefined
              ? { value: m.metadata.parametersActive, grade: "estimated" }
              : undefined,
          quantisation: m.quantisation,
          engine:
            m.format === "mlx" ? "MLX" : m.format === "gguf" ? "llama.cpp (GGUF)" : "none here",
          sizeBytes: { value: m.sizeBytes, grade: "file" },
          contextLength: { value: m.contextLength, grade: "file" },
          license: m.metadata.license,
          source: entry?.source?.url ?? (entry ? "registry" : "found in your folder"),
          sha256: m.sha256,
          hash: m.hash,
        },
      },
      role,
      memory,
      headroom: fh.headroom,
      fit: CONFIG_ROLES.includes(role) ? (m.fit?.[role] ?? undefined) : undefined,
      speeds,
      loads,
      qualification: Object.fromEntries(MODEL_ROLES.map((r) => [r, qualificationOf(key, r)])),
      warnings,
    };
  };

  // ── Measure speed (DB-NM14-3) ──────────────────────────────────────────
  type SpeedRecord = {
    model: string;
    role: string;
    host: string;
    accepted: boolean;
    decodeTokensPerSecond?: number;
    prefillTokensPerSecond?: number;
    spread?: number;
    ttftWithoutCacheMs?: number;
    ttftWithCacheMs?: number;
    reason?: string;
  };
  /** The last *Measure speed* recorded for a model and role on this host. */
  const lastSpeed = async (model: string, role: string): Promise<SpeedRecord | undefined> => {
    const all = await deps.log.getEventsByTypes(["model/speed_measured"]);
    const mine = all
      .map((e) => ({
        ...(e.payload as SpeedRecord),
        ...((e.private as { reason?: string } | undefined)?.reason
          ? { reason: (e.private as { reason: string }).reason }
          : {}),
      }))
      .filter((p) => p.model === model && p.role === role && p.host === host());
    return mine.at(-1);
  };
  /** What the page shows of a record: llama-bench's speed Measured only when accepted. */
  const speedShown = (r: SpeedRecord) => ({
    ...(r.accepted && r.decodeTokensPerSecond !== undefined
      ? {
          measuredDecodeTokensPerSecond: {
            value: r.decodeTokensPerSecond,
            grade: "measured" as const,
          },
        }
      : {}),
    ...(r.accepted && r.prefillTokensPerSecond !== undefined
      ? {
          measuredPrefillTokensPerSecond: {
            value: r.prefillTokensPerSecond,
            grade: "measured" as const,
          },
        }
      : {}),
    ...(!r.accepted && r.reason ? { benchNotAccepted: r.reason } : {}),
    ...(r.ttftWithoutCacheMs !== undefined && r.ttftWithCacheMs !== undefined
      ? {
          ttft: {
            withoutCacheMs: { value: r.ttftWithoutCacheMs, grade: "measured" as const },
            withCacheMs: { value: r.ttftWithCacheMs, grade: "measured" as const },
          },
        }
      : {}),
  });
  let speedRunning: string | undefined;

  const startSpeed = async (req: IncomingMessage, res: ServerResponse, id: string, body: Json) => {
    const m = findModel(id);
    if (!m) {
      deps.json(res, 404, { error: "No model with that id was found in your folders." });
      return;
    }
    const role = (typeof body.role === "string" ? body.role : "worker") as ConfigRole;
    if (!MODEL_ROLES.includes(role as ModelRole)) {
      deps.json(res, 400, { error: "role is worker, planner, reviewer or researcher." });
      return;
    }
    if (m.format !== "gguf") {
      deps.json(res, 409, { error: "llama-bench measures a GGUF model on llama.cpp only." });
      return;
    }
    if (!deps.measureSpeed) {
      deps.json(res, 409, { error: "This server runs no model, so it cannot measure speed." });
      return;
    }
    if (speedRunning) {
      deps.json(res, 409, { error: `A speed measurement of ${speedRunning} is running.` });
      return;
    }
    const settings = ROLE_SETTINGS[role];
    const memoryBytes = memoryBreakdown(m, settings).totalBytes.value;
    const key = modelKey(m);
    // DB-NM14-3: it loads the model, so a person confirms it by name and memory.
    if (body.confirm !== true || body.model !== key || body.memoryBytes !== memoryBytes) {
      deps.json(res, 409, {
        error: `Measuring speed loads ${m.name} (about ${(memoryBytes / 1e9).toFixed(1)} GB) for a few minutes; no other model loads meanwhile. Confirm to run it.`,
        needs: "confirmation",
        model: key,
        name: m.name,
        memoryBytes,
      });
      return;
    }
    if (m.fits[role] === "no") {
      deps.json(res, 409, { error: `It won't fit for the ${role}: ${m.fitReason[role] ?? ""}` });
      return;
    }
    const principal = deps.principalOf(req);
    const depth = speedDepth(settings.contextTokens);
    speedRunning = m.name;
    deps.json(res, 202, { model: key, role, depth });
    emit({ kind: "speed", model: key, role, state: "running" });
    void (async () => {
      try {
        const r = await (deps.measureSpeed as NonNullable<ConfigApiDeps["measureSpeed"]>)({
          model: key,
          path: m.path,
          role: role as ModelRole,
          depth,
        });
        const b = r.bench;
        await deps.log.append({
          actor: "human",
          type: "model/speed_measured",
          principal,
          payload: {
            model: key,
            role,
            host: host(),
            depth,
            principal,
            accepted: b?.accepted ?? false,
            ...(b?.decode.runs.length ? { decodeTokensPerSecond: b.decode.value } : {}),
            ...(b?.prefill.runs.length ? { prefillTokensPerSecond: b.prefill.value } : {}),
            ...(b
              ? { spread: Math.max(b.decode.spread, b.prefill.runs.length ? b.prefill.spread : 0) }
              : {}),
            ...(r.ttft
              ? {
                  ttftWithoutCacheMs: r.ttft.withoutCacheMs.value,
                  ttftWithCacheMs: r.ttft.withCacheMs.value,
                }
              : {}),
          },
          // Why a part did not count is free text: private, never on the chain.
          ...((b?.reason ?? r.benchError)
            ? { private: { reason: (b?.reason ?? r.benchError) as string } }
            : {}),
        });
        emit({
          kind: "speed",
          model: key,
          role,
          state: "done",
          ...(r.benchError ? { benchError: r.benchError } : {}),
          ...(r.ttftError ? { ttftError: r.ttftError } : {}),
        });
      } catch (err) {
        emit({
          kind: "speed",
          model: key,
          role,
          state: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        speedRunning = undefined;
      }
    })();
  };

  // ── combinations, residency and placement ─────────────────────────────
  // Live-test F15: the replay's demand is the whole ledger's — the cards,
  // a person's chat with Seshat, research requests and presence.
  const demand = async () => replayDemand(await deps.log.getEventsByTypes([...REPLAY_EVENT_TYPES]));

  const combinationsBody = async () => {
    if (!state.scan) await scan();
    const { book } = await swapBook();
    const replay = await demand();
    const cards = replay.cards;
    const candidates: Partial<
      Record<
        ModelRole,
        {
          id: string;
          family?: string;
          footprintBytes: number;
          fits: "yes" | "swaps" | "no";
          floorOk: boolean;
          model: FoundModel;
        }[]
      >
    > = {};
    for (const role of MODEL_ROLES) {
      // The three that fit best per role: at most 81 combinations to replay.
      const order = { yes: 0, swaps: 1, no: 2 } as const;
      candidates[role] = state.models
        .filter((m) => !m.noEngine)
        .sort((a, b) => order[a.fits[role] ?? "yes"] - order[b.fits[role] ?? "yes"])
        .slice(0, 3)
        .map((m) => ({
          id: modelKey(m),
          ...(m.family ? { family: m.family } : {}),
          footprintBytes: m.fit?.[role]?.requiredBytes.value ?? m.sizeBytes,
          fits: m.fits[role] ?? "yes",
          floorOk: ["qualified", "overridden"].includes(qualificationOf(modelKey(m), role)),
          model: m,
        }));
    }
    const lookup = (id: string) => state.models.find((m) => modelKey(m) === id);
    const loadCost = (id: string) => {
      const m = lookup(id);
      const p = book.predict({
        model: id,
        volume: m ? volume(m.path) : "external",
        cache: "cold",
        bytes: m?.sizeBytes ?? 0,
      });
      return { median: p.medianMs, p90: p.p90Ms, basis: p.basis };
    };
    const ranked = rankCombinations({
      roles: candidates,
      limit: 200,
      estimate: (c) => {
        const ids = MODEL_ROLES.map((r) => c[r]).filter((x): x is string => Boolean(x));
        const distinct = [...new Set(ids)];
        const pairs: Record<string, Graded> = {};
        for (const a of distinct) {
          for (const b of distinct) {
            if (a >= b) continue;
            const la = loadCost(a);
            const lb = loadCost(b);
            const v =
              cPair(
                { load: { median: la.median, p90: la.p90 } },
                { load: { median: lb.median, p90: lb.p90 } },
              ) ?? 0;
            pairs[`${a}|${b}`] = {
              value: v,
              grade: la.basis === "measured" && lb.basis === "measured" ? "measured" : "estimated",
            };
          }
        }
        const worker = c.worker ?? distinct[0] ?? "";
        const reviewer = c.reviewer;
        const cPairMs =
          reviewer && reviewer !== worker
            ? (pairs[[worker, reviewer].sort().join("|")]?.value ?? 0)
            : 0;
        let swaps = reviewer && reviewer !== worker ? 1 : 0;
        let attempts = 1;
        let computeMs = 10 * 30_000;
        let waits: Record<string, unknown> = {};
        if (cards.length > 0) {
          const weights: Record<string, { loadMs: number[]; unloadMs: number[] }> = {};
          for (const id of distinct) {
            const l = loadCost(id);
            weights[id] = { loadMs: [l.median, l.p90], unloadMs: [2000] };
          }
          const day = { day: "replay", reserved: [], ...replay };
          try {
            const sim = simulateDay(day, {
              params: DEFAULT_SWAP_POLICY,
              seed: 1,
              queues: {
                worker,
                chat: c.planner ?? worker,
                planner: c.planner ?? worker,
                reviewer: reviewer ?? worker,
                researcher: c.researcher ?? c.planner ?? worker,
              },
              home: worker,
              weights,
              memory: { models: 1 },
            });
            swaps = sim.metrics.swaps / cards.length;
            waits = sim.metrics.waits;
          } catch {
            // The replay could not run: the design estimate stands.
          }
          attempts = cards.reduce((n, k) => n + k.attempts.length, 0) / cards.length;
          computeMs =
            cards.reduce(
              (n, k) => n + k.attempts.reduce((s, a) => s + a.steps.reduce((x, y) => x + y, 0), 0),
              0,
            ) / cards.reduce((n, k) => n + k.attempts.length, 0);
        }
        const t = timePerCard({ attempts, computeMs, swaps, cPairMs, n: cards.length });
        const nightMs = 8 * 3_600_000;
        return {
          timePerCardMs: t,
          expectedSwaps: { value: swaps, grade: t.grade },
          expectedAttempts: { value: attempts, grade: t.grade },
          cPair: pairs,
          waits,
          acceptedPerNight: {
            value: t.value > 0 ? Math.floor(nightMs / t.value) : 0,
            grade: t.grade,
          },
          cardsReplayed: cards.length,
        };
      },
    });
    return {
      combinations: ranked.map((r: (typeof ranked)[number]) => ({
        ...r,
        peakBytes: { value: r.peakBytes, grade: "estimated" },
        coResident: [],
      })),
      order:
        "quality floors, then time per issue including swaps, then footprint (no combined score)",
    };
  };

  const placementBody = async () => {
    if (!state.scan) await scan();
    const { book, events } = await swapBook();
    const loadsPerDay = new Map<string, number>();
    const firstAt = events[0]?.at ?? Date.now();
    const days = Math.max(1, (Date.now() - firstAt) / 86_400_000);
    for (const e of events) {
      const p = e.payload as { model?: string };
      if (e.type === "model/loaded" && p.model)
        loadsPerDay.set(p.model, (loadsPerDay.get(p.model) ?? 0) + 1);
    }
    const internal = state.models.filter((m) => volume(m.path) === "internal" && m.sha256);
    // A copy made by hand where the page would copy it (the Worker's, on
    // 2026-09-26) is recognised by its hash, not only when its folder is added.
    const handCopy = async (m: FoundModel): Promise<string | undefined> => {
      if (!m.sha256) return undefined;
      const path = copyDestination(m);
      try {
        if (statSync(path).size !== m.sizeBytes) return undefined;
      } catch {
        return undefined;
      }
      const known = state.hashes.get(fileKey(path, m.sizeBytes));
      const sha = known ?? (await sha256File(path).catch(() => undefined));
      if (sha && !known) rememberHash(path, m.sizeBytes, sha);
      return sha === m.sha256 ? path : undefined;
    };
    const handCopies = new Map<string, string>();
    for (const m of state.models.filter((x) => volume(x.path) === "external")) {
      const at = await handCopy(m);
      if (at) handCopies.set(m.path, at);
    }
    const candidates = state.models
      .filter((m) => volume(m.path) === "external")
      .map((m) => {
        const key = modelKey(m);
        const ext = book.predict({
          model: key,
          volume: "external",
          cache: "cold",
          bytes: m.sizeBytes,
        });
        const int = book.predict({
          model: key,
          volume: "internal",
          cache: "cold",
          bytes: m.sizeBytes,
        });
        const recorded = loadsPerDay.get(key);
        const same = m.sha256
          ? (internal.find((i) => i.sha256 === m.sha256) ??
            (handCopies.has(m.path) ? { path: handCopies.get(m.path) as string } : undefined))
          : undefined;
        return {
          model: key,
          name: m.name,
          sizeBytes: m.sizeBytes,
          path: m.path,
          volume: "external" as const,
          ...(m.sha256 ? { sha256: m.sha256 } : {}),
          swapsPerDay:
            recorded !== undefined
              ? { value: recorded / days, grade: "estimated" as const }
              : { value: 2, grade: "design" as const },
          loadExternalMs: {
            value: ext.medianMs,
            grade: ext.basis === "measured" ? ("measured" as const) : ("estimated" as const),
          },
          loadInternalMs: {
            value: int.medianMs,
            grade: int.basis === "measured" ? ("measured" as const) : ("estimated" as const),
          },
          ...(same ? { internalCopy: same.path } : {}),
        };
      });
    let free: Graded = { value: 0, grade: "estimated" };
    try {
      free = { value: freeBytes(internalDir), grade: "measured" };
    } catch {
      // Unknown free space: nothing is suggested.
    }
    return {
      ...advisePlacement({ candidates, internalFreeBytes: free }),
      destination: internalDir,
    };
  };

  const residencyBody = async (hours: number) => {
    const { events } = await swapBook();
    const now = (deps.now?.() ?? new Date()).getTime();
    const from = now - hours * 3_600_000;
    const open = new Map<string, number>();
    const segments: { model: string; from: number; to: number }[] = [];
    const swapMs = new Array<number>(hours).fill(0);
    for (const e of events) {
      const p = e.payload as { model?: string; loadMs?: number; unloadMs?: number };
      if (!p.model) continue;
      if (e.type === "model/loaded") {
        open.set(p.model, e.at);
        if (e.at >= from) {
          const h = Math.min(hours - 1, Math.floor((e.at - from) / 3_600_000));
          swapMs[h] = (swapMs[h] ?? 0) + (p.loadMs ?? 0);
        }
      }
      if (e.type === "model/unloaded") {
        const start = open.get(p.model);
        if (start !== undefined) segments.push({ model: p.model, from: start, to: e.at });
        open.delete(p.model);
        if (e.at >= from) {
          const h = Math.min(hours - 1, Math.floor((e.at - from) / 3_600_000));
          swapMs[h] = (swapMs[h] ?? 0) + (p.unloadMs ?? 0);
        }
      }
    }
    for (const [model, start] of open) segments.push({ model, from: start, to: now });
    return {
      from: new Date(from).toISOString(),
      to: new Date(now).toISOString(),
      segments: segments
        .filter((s) => s.to >= from)
        .map((s) => ({
          model: s.model,
          from: new Date(Math.max(s.from, from)).toISOString(),
          to: new Date(s.to).toISOString(),
        })),
      thetaByHour: swapMs.map((ms) => ({ value: ms / 3_600_000, grade: "measured" as const })),
    };
  };

  // ── downloads ─────────────────────────────────────────────────────────
  const sourceFor = async (model: string): Promise<ModelSource | undefined> => {
    const entry = registry.get(model);
    if (entry?.source) return entry.source;
    // A table row with its hash is the source, with no request (DB-N6-16).
    const recorded = tableSource(model, deps.hub);
    if (recorded) {
      registry.recordSource(model, recorded);
      return recorded;
    }
    const table = MODEL_SOURCES[model];
    if (!table) return undefined;
    const found = await lookupPublishedFile(table.repo, table.file, {
      fetch: lookupFetch(),
      ...(deps.hub ? { hub: deps.hub } : {}),
    });
    if (found) registry.recordSource(model, found);
    return found;
  };

  const startDownload = async (req: IncomingMessage, res: ServerResponse, body: Json) => {
    const model = typeof body.model === "string" ? body.model : "";
    const principal = deps.principalOf(req);
    let source: ModelSource | undefined;
    try {
      source = await sourceFor(model);
    } catch (err) {
      deps.json(res, 409, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!source) {
      deps.json(res, 409, {
        error: `${model || "This model"} has no registered source and hash, so it cannot be downloaded here.`,
      });
      return;
    }
    const blocked = downloadRefusal(source.host);
    if (blocked) {
      deps.json(res, 409, { error: `Download is disabled: ${blocked}`, setting: "[network] mode" });
      return;
    }
    if (configured().length === 0) {
      deps.json(res, 409, { error: "Add a model folder first: the download is written there." });
      return;
    }
    const folder = downloadFolder(body.folder);
    if ("error" in folder) {
      deps.json(res, 409, { error: folder.error, needs: "folder" });
      return;
    }
    // A file of that name already there is never replaced: another name, or none.
    let fileName: string;
    try {
      fileName = downloadFileName(
        source.url,
        typeof body.fileName === "string" && body.fileName.trim() ? body.fileName : undefined,
      );
    } catch (err) {
      deps.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (existsSync(join(folder.path, fileName))) {
      deps.json(res, 409, {
        error: `${folder.path} already has a file named ${fileName}; it is not replaced. Give the download another name, or move that file first.`,
        needs: "fileName",
        fileName,
      });
      return;
    }
    const id = `dl_${randomUUID().slice(0, 8)}`;
    const controller = new AbortController();
    downloads.set(id, { id, controller, model });
    deps.json(res, 202, {
      downloadId: id,
      destination: folder.path,
      sizeBytes: source.sizeBytes ?? 0,
      sha256: source.sha256,
    });
    void runDownload(model, source, folder.path, principal, id, controller, fileName).catch(
      () => undefined,
    );
  };

  /**
   * One verified download into a model folder (MD-N12-6): recorded as
   * `model/downloaded` with the person's principal, verified or not, and the
   * folder scanned again. Throws when it failed, after saying so as a frame.
   */
  const runDownload = async (
    model: string,
    src: ModelSource,
    destDir: string,
    principal: string,
    id: string,
    controller: AbortController,
    fileName?: string,
  ): Promise<void> => {
    downloads.set(id, { id, controller, model });
    try {
      const done = await downloadModel({
        model,
        source: src,
        destDir,
        ...(fileName !== undefined ? { fileName } : {}),
        fetch: downloadFetch(),
        refusal: downloadRefusal,
        signal: controller.signal,
        onProgress: (p) => emit({ kind: "download", downloadId: id, ...p }),
      });
      await deps.log.append({
        actor: "human",
        type: "model/downloaded",
        principal,
        payload: {
          model,
          source: src.host,
          sha256: done.sha256,
          bytes: done.bytes,
          principal,
          verified: true,
        },
      });
      registry.recordWeights(model, {
        path: done.path,
        volume: volume(done.path),
        sha256: done.sha256,
      });
      rememberHash(done.path, done.bytes, done.sha256);
      await scan(principal);
    } catch (err) {
      if (err instanceof DownloadHashMismatch) {
        await deps.log.append({
          actor: "human",
          type: "model/downloaded",
          principal,
          payload: {
            model,
            source: src.host,
            sha256: src.sha256,
            bytes: 0,
            principal,
            verified: false,
          },
        });
      }
      emit({
        kind: "download",
        downloadId: id,
        bytes: 0,
        total: src.sizeBytes ?? 0,
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      downloads.delete(id);
    }
  };

  // ── copies to internal storage ────────────────────────────────────────
  const startCopy = async (req: IncomingMessage, res: ServerResponse, body: Json) => {
    const id = typeof body.model === "string" ? body.model : "";
    const m = findModel(id);
    if (!m || m.format !== "gguf" || m.parts) {
      deps.json(res, 404, {
        error: "No single-file model with that id was found in your folders.",
      });
      return;
    }
    if (!m.sha256) {
      deps.json(res, 409, { error: "Its hash is still being computed; try again when it shows." });
      return;
    }
    const entry = registryEntryFor(m);
    const expected = entry?.sha256 ?? m.sha256;
    const destDir = dirname(copyDestination(m));
    const principal = deps.principalOf(req);
    const copyId = `cp_${randomUUID().slice(0, 8)}`;
    const controller = new AbortController();
    let free = 0;
    try {
      free = freeBytes(internalDir);
    } catch {
      free = 0;
    }
    // A copy already there (made by hand, or earlier) is only verified: no space is used.
    let already = false;
    try {
      already = statSync(copyDestination(m)).size === m.sizeBytes;
    } catch {
      already = false;
    }
    if (!already && free - m.sizeBytes < 20e9) {
      deps.json(res, 409, {
        error: `Not copied: it would leave ${gbText(free - m.sizeBytes)} free, and at least 20 GB is kept free on internal storage.`,
      });
      return;
    }
    copies.set(copyId, { id: copyId, controller, model: modelKey(m) });
    deps.json(res, 202, {
      copyId,
      destination: destDir,
      sizeBytes: m.sizeBytes,
      sha256: expected,
      freeAfterBytes: free - m.sizeBytes,
    });
    void (async () => {
      try {
        const done = await copyToInternal({
          source: m.path,
          destDir,
          sha256: expected,
          freeBytes,
          signal: controller.signal,
          onProgress: (p) => emit({ kind: "copy", copyId, ...p }),
        });
        const key = entry?.id ?? modelKey(m);
        if (!entry)
          registry.upsert(key, {
            ...(m.family ? { family: m.family } : {}),
            sizeBytes: m.sizeBytes,
          });
        registry.recordWeights(key, { path: m.path, volume: volume(m.path), sha256: expected });
        registry.recordWeights(key, { path: done.path, volume: "internal", sha256: done.sha256 });
        await deps.log.append({
          actor: "human",
          type: "model/copied",
          principal,
          payload: {
            model: key,
            sha256: done.sha256,
            bytes: done.bytes,
            from: volume(m.path),
            to: "internal",
            principal,
            verified: true,
          },
        });
        rememberHash(done.path, done.bytes, done.sha256);
      } catch (err) {
        if (err instanceof CopyHashMismatch) {
          await deps.log.append({
            actor: "human",
            type: "model/copied",
            principal,
            payload: {
              model: modelKey(m),
              sha256: expected,
              bytes: m.sizeBytes,
              from: volume(m.path),
              to: "internal",
              principal,
              verified: false,
            },
          });
        }
        emit({
          kind: "copy",
          copyId,
          bytes: 0,
          total: m.sizeBytes,
          state: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        copies.delete(copyId);
      }
    })();
  };

  /** Where a model's internal copy goes: its folder's layout under `internalDir`. */
  function copyDestination(m: FoundModel): string {
    const sub = m.file.includes("/") ? dirname(m.file) : modelKey(m);
    return join(internalDir, sub, basename(m.path));
  }

  // ── assignment ────────────────────────────────────────────────────────
  /**
   * Assign a role as `sekhemet models assign` does (models rule 30a): only
   * a model qualified for the role on this host, the Reviewer of another
   * family than the Worker, recorded as `models/assigned` with the person's
   * principal. Throws `AssignmentRefusal` with the reason.
   */
  const assignAs = async (
    role: ModelRole,
    id: string,
    principal: string,
    status: RoleEvidence["qualification"] = qualificationOf(id, role),
    family: string | undefined = findModel(id)?.family ?? registry.get(id)?.family,
  ) => {
    const wf = workerFamily();
    const r = assignRole(registry, {
      role,
      model: id,
      scope: "personal",
      by: principal,
      host: host(),
      qualification: status,
      families: { ...(family ? { model: family } : {}), ...(wf ? { worker: wf } : {}) },
    });
    await deps.log.append({
      actor: "human",
      type: "models/assigned",
      principal,
      payload: {
        role,
        model: id,
        scope: "personal",
        qualification: status,
        ...(r.previous ? { previous: r.previous.model } : {}),
      },
    });
    // MD-N21-11 (FINDINGS CFG-04, MS-M9-6): a Coding model adopted here owes
    // its M0, through the helper `sekhemet models assign worker` uses.
    if (role === "worker") {
      const version = rolePromptVersion("worker");
      const verified = (registry.get(id)?.qualifications ?? [])
        .filter(
          (q) =>
            q.status === "qualified" &&
            roleOf(q.combination) === "worker" &&
            q.combination.settings.contextVersion === version,
        )
        .at(-1);
      await recordWorkerAdopted(deps.log, {
        worker: id,
        combination: verified
          ? describeCombination(verified.combination)
          : "not yet verified on this machine",
      });
    }
    return r;
  };

  // ── Use the recommended models (DB-N6-16) ─────────────────────────────
  type RecommendedDownload = {
    model: string;
    roles: ModelRole[];
    url: string;
    host: string;
    sizeBytes: number;
    sha256: string;
    /** Its SPDX licence where the shipped set records one (MD-N18-3). */
    license?: string;
    blockedBy?: string;
  };
  type RecommendedRun = {
    state: "downloading" | "benchmarking" | "assigning" | "done";
    principal: string;
    combination: Partial<Record<ModelRole, string>>;
    downloads: { model: string; verified: boolean; error?: string }[];
    benchmark?: { runId?: string; state: string; partial?: boolean; reason?: string };
    assigned: { role: ModelRole; model: string }[];
    notAssigned: { role: ModelRole; model?: string; reason: string }[];
  };
  let recommended: { run: RecommendedRun; done: Promise<void> } | undefined;

  /** What *Use the recommended models* would do: the combination, every download (source, size, hash), the unfilled roles. */
  const recommendedPlan = async () => {
    const { roles } = await rolesBody();
    const combination: Partial<Record<ModelRole, string>> = {};
    const unfilled: { role: ModelRole; reason: string }[] = [];
    const downloads: RecommendedDownload[] = [];
    /** Roles a person kept: their own model stays, and the suggestion steps aside (DB-N27-1). */
    const kept: { role: ModelRole; model: string }[] = [];
    for (const r of roles) {
      const role = r.role as ModelRole;
      if (r.kept && r.model) {
        combination[role] = r.model as string;
        kept.push({ role, model: r.model as string });
        continue;
      }
      const rec = r.recommendation;
      if (!rec) {
        unfilled.push({ role, reason: r.unfilledReason ?? "No model is recommended for it." });
        continue;
      }
      combination[role] = rec.model;
      // A copy already recorded on this machine (`models fetch`, an earlier
      // download) is not downloaded again (MD-N18-3: what is still to fetch).
      const copy = registry.preferredWeights(rec.model);
      if (rec.present || (copy !== undefined && existsSync(copy))) continue;
      const known = downloads.find((d) => d.model === rec.model);
      if (known) {
        known.roles.push(role);
        continue;
      }
      // The registered source (the registry's, or the table's with its hash): no request.
      const source = registry.get(rec.model)?.source ?? tableSource(rec.model, deps.hub);
      if (!source) {
        unfilled.push({ role, reason: `${rec.model} has no registered source and hash.` });
        delete combination[role];
        continue;
      }
      const blocked = downloadRefusal(source.host);
      const license = SHIPPED_MODELS.find((m) => m.id === rec.model)?.source?.license;
      downloads.push({
        model: rec.model,
        roles: [role],
        url: source.url,
        host: source.host,
        sizeBytes: source.sizeBytes ?? rec.download?.sizeBytes ?? 0,
        sha256: source.sha256,
        ...(license ? { license } : {}),
        ...(blocked ? { blockedBy: blocked } : {}),
      });
    }
    // The folder the confirmation shows; the person's confirmation names it back.
    const folder = downloads.length > 0 ? offeredFolder() : undefined;
    // MD-N18-3, MD-N22-3: the set's total size and each licence, before the yes.
    const totalBytes = downloads.reduce((n, d) => n + d.sizeBytes, 0);
    const licenses = [
      ...new Set(
        Object.values(combination)
          .map((m) => SHIPPED_MODELS.find((x) => x.id === m)?.source?.license)
          .filter((l): l is string => Boolean(l)),
      ),
    ];
    return {
      combination,
      downloads,
      unfilled,
      kept,
      totalBytes,
      licenses,
      ...(folder ? { folder } : {}),
    };
  };

  /** Download and verify, screen the combination with the quick benchmark, then assign (DB-N6-16). */
  const runRecommended = async (
    run: RecommendedRun,
    plan: Awaited<ReturnType<typeof recommendedPlan>>,
    folder: string | undefined,
  ): Promise<void> => {
    const tell = () => emit({ kind: "recommended", ...run });
    const failed = new Map<string, string>();
    for (const d of plan.downloads) {
      const why =
        d.blockedBy ??
        (folder ? undefined : "Add a model folder first: the download is written there.");
      if (why) {
        failed.set(d.model, why);
        run.downloads.push({ model: d.model, verified: false, error: why });
        continue;
      }
      try {
        await runDownload(
          d.model,
          registry.get(d.model)?.source ?? (tableSource(d.model, deps.hub) as ModelSource),
          folder as string,
          run.principal,
          `dl_${randomUUID().slice(0, 8)}`,
          new AbortController(),
        );
        run.downloads.push({ model: d.model, verified: true });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        failed.set(d.model, reason);
        run.downloads.push({ model: d.model, verified: false, error: reason });
      }
      tell();
    }
    run.state = "benchmarking";
    tell();
    const c = run.combination;
    const usable = (m?: string) => (m && !failed.has(m) ? m : undefined);
    const worker = usable(c.worker);
    const planner = usable(c.planner);
    if (!deps.startQuick) {
      run.benchmark = { state: "not_run", reason: "The quick benchmark is not wired here." };
    } else if (!worker || !planner) {
      run.benchmark = {
        state: "not_run",
        reason: "The quick benchmark needs a Coding model and a Planning model; one is missing.",
      };
    } else {
      const reviewer = usable(c.reviewer);
      const researcher = usable(c.researcher);
      try {
        const s = await deps.startQuick(
          {
            worker,
            planner,
            ...(reviewer ? { reviewer } : {}),
            ...(researcher ? { researcher } : {}),
          },
          run.principal,
        );
        run.benchmark = { runId: s.run.runId, state: "running" };
        tell();
        const result = await s.finished;
        run.benchmark = {
          runId: s.run.runId,
          state: "done",
          ...(result.partial ? { partial: true } : {}),
        };
      } catch (err) {
        run.benchmark = {
          state: "refused",
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }
    run.state = "assigning";
    tell();
    for (const u of plan.unfilled) run.notAssigned.push(u);
    // The Worker first: the Reviewer's family is judged against it.
    for (const role of MODEL_ROLES) {
      const model = c[role];
      if (!model) continue;
      // A kept role is assigned already; the suggestion stepped aside for it.
      if (plan.kept.some((k) => k.role === role)) continue;
      if (failed.has(model)) {
        run.notAssigned.push({
          role,
          model,
          reason: `Its download did not complete: ${failed.get(model)}`,
        });
        continue;
      }
      const status = qualificationOf(model, role);
      if (status !== "qualified" && status !== "overridden") {
        run.notAssigned.push({
          role,
          model,
          reason: `${model} is not verified on this machine as the ${roleWords(role)} yet; Verify on this machine to assign runs the check.`,
        });
        continue;
      }
      try {
        await assignAs(role, model, run.principal, status);
        run.assigned.push({ role, model });
      } catch (err) {
        run.notAssigned.push({
          role,
          model,
          reason: (err instanceof Error ? err.message : String(err)).replace(
            / Qualify it first:.*$/,
            "",
          ),
        });
      }
    }
    run.state = "done";
    tell();
  };

  // ── a role's settings (NEW-models-21, NEW-dashboard-27) ───────────────
  const engineApi = createEngineApi({
    service: { repoPath: deps.repoPath, log: deps.log, userConfigPath: cfgPath, env },
    json: deps.json,
    readJsonBody: deps.readJsonBody,
    isTrustedMutation: deps.isTrustedMutation,
    principalOf: deps.principalOf,
    mayManage: deps.mayManage ?? (() => true),
  });

  /** The model a settings request is about: the one named, else the role's. */
  const settingsModel = (named: unknown, role: ModelRole): string | undefined => {
    if (typeof named === "string" && named.trim()) {
      const m = findModel(named.trim());
      return m ? modelKey(m) : named.trim();
    }
    return assignedModel(role);
  };

  /** The fit at a context for a found model and role (MD-N21-4, DB-N27-2), or undefined. */
  const fitAt = async (model: string, role: ModelRole, contextTokens: number, kvType: string) => {
    const m = findModel(model);
    if (!m) return undefined;
    const fh = await fitHost();
    const v = fitFor(m, role, { ...fh, roleSettings: { [role]: { contextTokens, kvType } } });
    return {
      contextTokens,
      fits: v.fits,
      reason: v.reason,
      requiredBytes: v.requiredBytes,
    };
  };

  const resolved = (model: string, role: ModelRole) =>
    resolveRoleSettings(registry.get(model), role, { env });

  const settingsBody = async (role: ModelRole, model: string, context?: number) => {
    const values = resolved(model, role);
    const get = (k: RoleSettingKey) => values.find((v) => v.key === k)?.value;
    const record = registry.roleSettings(model, role);
    const floor = String(get("reasoningFloor") ?? "none");
    const fit = await fitAt(
      model,
      role,
      context ?? Number(get("contextTokens")),
      String(get("kvType") ?? "q8_0"),
    );
    return {
      role,
      model,
      values,
      fields: ROLE_SETTING_FIELDS,
      verification: verificationOf(model, role),
      hints: checkRoleSettings(record?.values ?? {}, { role, floor }).hints,
      ...(fit ? { fit } : {}),
      ...(record?.preset ? { preset: record.preset } : {}),
    };
  };

  /** Check values as a save would (MD-N21-4): the refusal, or the hints. */
  const checkValues = async (role: ModelRole, model: string, values: RoleSettingValues) => {
    const current = resolved(model, role);
    const floor = String(current.find((v) => v.key === "reasoningFloor")?.value ?? "none");
    const kvType = String(
      values.kvType ?? current.find((v) => v.key === "kvType")?.value ?? "q8_0",
    );
    const fit =
      values.contextTokens !== undefined
        ? await fitAt(model, role, values.contextTokens, kvType)
        : undefined;
    return checkRoleSettings(values, {
      role,
      floor,
      ...(fit ? { fit: () => (fit.fits === "no" ? fit.reason : undefined) } : {}),
    });
  };

  const recordSettings = async (
    req: IncomingMessage,
    p: { model: string; role: ModelRole; action: "set" | "reset" | "import"; keys: string[] },
  ) => {
    const principal = deps.principalOf(req);
    await deps.log.append({
      actor: "human",
      type: "models/settings_changed",
      principal,
      payload: {
        ...p,
        needsVerifying: verificationOf(p.model, p.role).state === "needs_verifying",
        principal,
      },
    });
  };

  const settingsRoute = async (
    req: IncomingMessage,
    res: ServerResponse,
    key: string,
    roleParam: string,
    body: Json,
    query: URLSearchParams,
  ): Promise<void> => {
    const role = roleParam as ModelRole;
    if (!MODEL_ROLES.includes(role)) {
      deps.json(res, 404, { error: "No such role." });
      return;
    }
    if (!state.scan) await scan();
    const model = settingsModel(key.startsWith("GET") ? query.get("model") : body.model, role);
    if (!model) {
      deps.json(res, 400, {
        error: "Name the model whose settings these are: this role has none yet.",
      });
      return;
    }
    if (key === "GET /api/config/roles/:role/settings") {
      const context = Number(query.get("context") ?? "");
      deps.json(res, 200, await settingsBody(role, model, context > 0 ? context : undefined));
      return;
    }
    if (key === "GET /api/config/roles/:role/settings/export") {
      deps.json(res, 200, roleSettingsFile(model, role, registry.roleSettings(model, role)));
      return;
    }
    if (key === "POST /api/config/roles/:role/settings/reset") {
      const known = new Set(ROLE_SETTING_FIELDS.map((f) => f.key as string));
      const keys = Array.isArray(body.keys) ? body.keys.map(String) : undefined;
      const unknown = keys?.find((k) => !known.has(k));
      if (unknown) {
        deps.json(res, 400, {
          error: `${unknown} is not a setting Sekhemet knows.`,
          key: unknown,
          refused: "unknown",
        });
        return;
      }
      const had = Object.keys(registry.roleSettings(model, role)?.values ?? {});
      registry.resetRoleSettings(model, role, keys as RoleSettingKey[] | undefined);
      await recordSettings(req, { model, role, action: "reset", keys: keys ?? had });
      deps.json(res, 200, await settingsBody(role, model));
      return;
    }
    // A save or an import: the values checked first, nothing recorded on a refusal.
    let values: RoleSettingValues;
    let preset: SettingsPreset | undefined;
    const extraHints: { key: string; text: string }[] = [];
    if (key === "POST /api/config/roles/:role/settings/import") {
      try {
        const file = parseRoleSettingsFile(body.file);
        values = file.values;
        if (file.model && file.model !== model)
          extraHints.push({
            key: "import",
            text: `This file was made for ${file.model}; its values now apply to ${model}.`,
          });
        if (file.role && file.role !== role)
          extraHints.push({
            key: "import",
            text: `This file was made for the ${roleWords(file.role)}; its values now apply to the ${roleWords(role)}.`,
          });
      } catch (err) {
        deps.json(res, 400, {
          error: err instanceof Error ? err.message : String(err),
          refused: "format",
        });
        return;
      }
    } else {
      if (!body.values || typeof body.values !== "object" || Array.isArray(body.values)) {
        deps.json(res, 400, { error: "Send the values to save as an object.", refused: "unknown" });
        return;
      }
      values = body.values as RoleSettingValues;
      if (body.preset !== undefined) {
        if (typeof body.preset !== "string" || !(body.preset in SETTINGS_PRESETS)) {
          deps.json(res, 400, {
            error: "The preset is fast, balanced or careful.",
            key: "preset",
            refused: "range",
          });
          return;
        }
        preset = body.preset as SettingsPreset;
        values = { ...SETTINGS_PRESETS[preset](role), ...values };
      }
    }
    const check = await checkValues(role, model, values);
    if (check.refusal) {
      deps.json(res, 400, check.refusal);
      return;
    }
    if (preset === "balanced") registry.resetRoleSettings(model, role, PRESET_KEYS);
    if (Object.keys(values).length > 0 || preset)
      registry.setRoleSettings(model, role, values, deps.principalOf(req), preset);
    await recordSettings(req, {
      model,
      role,
      action: key.endsWith("/import") ? "import" : "set",
      keys: preset === "balanced" ? [...PRESET_KEYS] : Object.keys(values),
    });
    const out = await settingsBody(role, model);
    deps.json(res, 200, { ...out, hints: [...extraHints, ...out.hints] });
  };

  // ── the handler ───────────────────────────────────────────────────────
  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    query: URLSearchParams,
  ): Promise<boolean> => {
    if (!url.startsWith("/api/config")) return false;
    // The engine card's routes (C3-2's `config_engine`, mounted here).
    if (url.startsWith("/api/config/engine")) return engineApi.handle(req, res, url);
    const method = req.method ?? "GET";
    const hit = matchRoute(method, url);
    if (!hit) return false;
    if (method !== "GET" && !deps.isTrustedMutation(req)) {
      deps.json(res, 403, { error: "This change needs the dashboard's own request header." });
      return true;
    }
    const key = `${method} ${hit.route.path}`;
    const body = method === "GET" ? {} : await deps.readJsonBody(req).catch(() => ({}) as Json);
    try {
      switch (key) {
        case "GET /api/config": {
          const r = resolveConfig({ repoPath: deps.repoPath, userConfigPath: cfgPath });
          // The project's review capacity (DB-N4-1, -2): its minutes, the
          // limit they give, and whether this person may change them.
          const project = reviewProject(query.get("project") ?? undefined);
          const record = project ? deps.cardStore?.getProject(project) : undefined;
          const capacity = record
            ? await (async () => {
                const may = deps.mayChangeReviewCapacity?.(req, record.id) ?? { allowed: true };
                const facts = await deps.reviewLimitFacts?.(record.id).catch(() => undefined);
                return {
                  project: record.id,
                  minutesPerDay: record.reviewMinutesPerDay,
                  ...(facts ? { reviewWip: facts.limit } : {}),
                  allowed: may.allowed,
                  ...(!may.allowed && may.reason ? { reason: may.reason } : {}),
                };
              })()
            : undefined;
          // DB-N14-1 and DB-N25-1: the Definition of done, and where the project's repository is.
          const done = (() => {
            try {
              return deps.definitionOfDone?.(project);
            } catch {
              return undefined;
            }
          })();
          deps.json(res, 200, {
            config: r.config,
            layers: r.layers,
            problems: r.problems,
            sources: r.sources,
            ...(capacity ? { reviewCapacity: capacity } : {}),
            ...(done ? { definitionOfDone: done } : {}),
            ...(record
              ? { project: { id: record.id, name: record.name, rootPath: record.rootPath } }
              : {}),
          });
          return true;
        }
        case "GET /api/config/egress": {
          // DB-N24-1..3: the rows `sekhemet egress` prints, read-only, newest first.
          const project = query.get("project") ?? undefined;
          const ctx = deps.egressContext?.(req) ?? {};
          const titles = new Map<string, { title: string; projectId?: string }>();
          for (const c of (await deps.cardStore?.listCards()) ?? [])
            titles.set(c.id, {
              title: c.title,
              ...(c.projectId ? { projectId: c.projectId } : {}),
            });
          const rows = await egressRows(
            deps.log,
            {
              ...(query.get("since") ? { since: query.get("since") as string } : {}),
              refusedOnly: query.get("refused") === "1" || query.get("refused") === "true",
            },
            { issue: (id) => titles.get(id), ...ctx, ...(project ? { project } : {}) },
          );
          deps.json(res, 200, { rows, empty: NOTHING_LEFT });
          return true;
        }
        case "PUT /api/config/review": {
          // Review capacity (dashboard §2.16 item 3, review-git §2.2.3):
          // above 0, recorded per project (`project/review_hours`) with the
          // person's principal; the limit it gives is that project's alone.
          const minutes = body.minutesPerDay ?? body.reviewMinutesPerDay;
          if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
            deps.json(res, 400, {
              error: REVIEW_MINUTES_REFUSED,
              key: "review_minutes_per_day",
            });
            return true;
          }
          const project = reviewProject(
            typeof body.project === "string" ? body.project : undefined,
          );
          if (!deps.cardStore || !project) {
            deps.json(res, 400, { error: "Name the project whose review capacity changes." });
            return true;
          }
          const may = deps.mayChangeReviewCapacity?.(req, project) ?? { allowed: true };
          if (!may.allowed) {
            deps.json(res, 403, {
              error: may.reason ?? "You can't change this project's review capacity.",
              refused: "permission",
              permission: "review.capacity",
            });
            return true;
          }
          await deps.cardStore.setProjectReviewMinutes(
            project,
            minutes,
            "human",
            deps.principalOf(req),
          );
          const facts = await deps.reviewLimitFacts?.(project).catch(() => undefined);
          deps.json(res, 200, {
            project,
            minutesPerDay: minutes,
            ...(facts ? { reviewWip: facts.limit } : {}),
          });
          return true;
        }
        case "PUT /api/config/queue": {
          // The per-person Agent cap (teams item 30, TEAM-30; dashboard §2.16):
          // an Admin's (`queue.caps`, checked before this handler), written to
          // the user config and recorded as their configuration change; the
          // queue reads the config on every pass, so it applies at once.
          const cap = body.agentIssuesPerPerson;
          if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1) {
            deps.json(res, 400, { error: QUEUE_CAP_REFUSED, key: "agent_issues_per_person" });
            return true;
          }
          configWrite(deps.principalOf(req), () => writeQueueCap(cfgPath, cap));
          deps.json(res, 200, { agentIssuesPerPerson: cap });
          return true;
        }
        case "GET /api/config/models":
          deps.json(res, 200, await modelsBody());
          return true;
        case "POST /api/config/models/folders": {
          const path = typeof body.path === "string" ? body.path.trim() : "";
          if (!path || !path.startsWith("/")) {
            deps.json(res, 400, { error: "Name the folder by its full path, starting with /." });
            return true;
          }
          const include = body.includeSubfolders === true;
          const current = resolveConfig({ repoPath: deps.repoPath, userConfigPath: cfgPath }).config
            .models.folders;
          const next = [
            ...current.filter((f) => resolve(f.path) !== resolve(path)),
            { path, includeSubfolders: include },
          ];
          const principal = deps.principalOf(req);
          configWrite(principal, () => writeModelFolders(cfgPath, next));
          await deps.log.append({
            actor: "human",
            type: "models/folder_added",
            principal,
            payload: { principal, includeSubfolders: include },
            private: { path },
          });
          await scan(principal);
          deps.json(res, 200, await modelsBody());
          return true;
        }
        case "DELETE /api/config/models/folders": {
          const path = typeof body.path === "string" ? body.path : "";
          const current = resolveConfig({ repoPath: deps.repoPath, userConfigPath: cfgPath }).config
            .models.folders;
          const kept = current.filter((f) => resolve(f.path) !== resolve(path));
          if (kept.length === current.length) {
            deps.json(res, 404, {
              error:
                "That folder is not in your configuration (a folder named by --models-dir or SEKHEMET_MODELS_DIR is removed where it was set).",
            });
            return true;
          }
          const principal = deps.principalOf(req);
          configWrite(principal, () => writeModelFolders(cfgPath, kept));
          await deps.log.append({
            actor: "human",
            type: "models/folder_removed",
            principal,
            payload: { principal },
            private: { path },
          });
          await scan(principal);
          deps.json(res, 200, await modelsBody());
          return true;
        }
        case "POST /api/config/models/scan":
          await scan(deps.principalOf(req));
          deps.json(res, 200, await modelsBody());
          return true;
        case "POST /api/config/models/:id/speed":
          await startSpeed(req, res, hit.params.id ?? "", body);
          return true;
        case "GET /api/config/models/:id": {
          if (!state.scan) await scan();
          const m = findModel(hit.params.id ?? "");
          if (!m) {
            deps.json(res, 404, { error: "No model with that id was found in your folders." });
            return true;
          }
          const details = await detailsBody(m, query);
          if (query.get("lookup") === "1") {
            const match = await matchOnHub(
              { ...(m.metadata.baseModel || m.name ? { name: m.name } : {}), metadata: m.metadata },
              {
                fetch: lookupFetch(),
                research: policy().research === "yes",
                ...(deps.hub ? { hub: deps.hub } : {}),
              },
            ).catch((err) => ({
              lookedUp: true,
              note: err instanceof Error ? err.message : String(err),
            }));
            deps.json(res, 200, {
              ...details,
              lookup: match,
              ...("metadata" in match && match.metadata
                ? { metadata: fillMetadata(m.metadata, match.metadata, "huggingface") }
                : {}),
            });
            return true;
          }
          deps.json(res, 200, details);
          return true;
        }
        case "GET /api/config/roles":
          deps.json(res, 200, await rolesBody());
          return true;
        case "GET /api/config/roles/:role/settings":
        case "PUT /api/config/roles/:role/settings":
        case "POST /api/config/roles/:role/settings/reset":
        case "GET /api/config/roles/:role/settings/export":
        case "POST /api/config/roles/:role/settings/import":
          await settingsRoute(req, res, key, hit.params.role ?? "", body as Json, query);
          return true;
        case "PUT /api/config/roles/:role":
        case "POST /api/config/roles/:role/qualify": {
          const role = hit.params.role as ModelRole;
          if (!MODEL_ROLES.includes(role)) {
            deps.json(res, 404, { error: "No such role." });
            return true;
          }
          if (!state.scan) await scan();
          const wanted = typeof body.model === "string" ? body.model : "";
          const m = findModel(wanted);
          const id = m ? modelKey(m) : wanted;
          if (!id) {
            deps.json(res, 400, { error: "Name the model to assign." });
            return true;
          }
          // Models rule 14c, MD-N20-1: refused before any check that would send it a request.
          if (isOllamaCloudTag(id)) {
            deps.json(res, 409, { error: ollamaCloudRefusal(id, role), needs: "local-model" });
            return true;
          }
          if (m && m.fits[role] === "no") {
            deps.json(res, 409, {
              error: `${m.name} does not fit this machine for the ${role}: ${m.fitReason[role] ?? ""}`,
            });
            return true;
          }
          const family = m?.family ?? registry.get(id)?.family;
          const wf = workerFamily();
          if (role === "reviewer" && (!family || (wf && family === wf))) {
            deps.json(res, 409, {
              error: !family
                ? `${m?.name ?? id}'s family is unknown, so it cannot be shown to differ from the Coding model's; the Review model needs another family.`
                : `${m?.name ?? id} is of the Coding model's family (${family}); the Review model needs another family.`,
              needs: "other-family",
            });
            return true;
          }
          if (m) {
            if (!registry.get(id))
              registry.upsert(id, { ...(family ? { family } : {}), sizeBytes: m.sizeBytes });
            if (m.sha256) {
              try {
                // MD-N12-9: a GGUF is registered as `sekhemet models add` does
                // — weights, hash, size and header — so the role can run it
                // under a managed llama-server (MD-N12-10).
                if (m.format === "gguf")
                  await registerModelFile(registry, m.path, {
                    id,
                    sha256: m.sha256,
                    volume,
                  });
                else
                  registry.recordWeights(id, {
                    path: m.path,
                    volume: volume(m.path),
                    sha256: m.sha256,
                  });
              } catch {
                // A file whose hash differs from the registry's is not recorded as its weights.
              }
            }
          }
          let status = qualificationOf(id, role);
          let qualifyReason: string | undefined;
          if (key.endsWith("/qualify") && !["qualified", "overridden"].includes(status)) {
            if (!deps.qualify) {
              deps.json(res, 409, {
                error:
                  "The check that verifies a model on this machine runs where the models run; it is not available from this server yet.",
                needs: "qualification",
              });
              return true;
            }
            const q = await deps.qualify(role, id);
            qualifyReason = q.reason;
            status = q.qualified ? "qualified" : "failed";
            if (!q.qualified) {
              deps.json(res, 200, {
                role: (await rolesBody()).roles.find((r) => r.role === role),
                qualified: false,
                reason: q.reason ?? "It did not pass the check.",
              });
              return true;
            }
          }
          if (!["qualified", "overridden"].includes(status)) {
            deps.json(res, 409, {
              error: `${m?.name ?? id} is not verified on this machine as the ${roleWords(role)} (a check of a few minutes: tool calls, a multi-turn tool conversation, recall). Verify on this machine to assign runs it.`,
              needs: "qualification",
            });
            return true;
          }
          const principal = deps.principalOf(req);
          try {
            await assignAs(role, id, principal, status, family);
          } catch (err) {
            if (err instanceof AssignmentRefusal) {
              deps.json(res, 409, { error: err.message.replace(/ Qualify it first:.*$/, "") });
              return true;
            }
            throw err;
          }
          const role_ = (await rolesBody()).roles.find((r) => r.role === role);
          deps.json(
            res,
            200,
            key.endsWith("/qualify")
              ? {
                  role: role_,
                  qualified: true,
                  ...(qualifyReason ? { reason: qualifyReason } : {}),
                }
              : { role: role_ },
          );
          return true;
        }
        case "POST /api/config/roles/:role/restore": {
          const role = hit.params.role as ModelRole;
          if (!MODEL_ROLES.includes(role)) {
            deps.json(res, 404, { error: "No such role." });
            return true;
          }
          const principal = deps.principalOf(req);
          try {
            const r = restoreRole(registry, host(), role, { by: principal });
            await deps.log.append({
              actor: "human",
              type: "models/restored",
              principal,
              payload: {
                role,
                model: r.assignment.model,
                scope: "personal",
                ...(r.replaced ? { replaced: r.replaced.model } : {}),
              },
            });
          } catch (err) {
            if (err instanceof AssignmentRefusal) {
              deps.json(res, 409, { error: err.message });
              return true;
            }
            throw err;
          }
          deps.json(res, 200, { role: (await rolesBody()).roles.find((r) => r.role === role) });
          return true;
        }
        case "POST /api/config/roles/:role/keep": {
          // DB-N27-1: *Keep* (kept true) or *Change* (kept false) for the
          // role's suggestion, recorded so Apply suggestion and a reload read it.
          const role = hit.params.role as ModelRole;
          const model = assignedModel(role);
          if (!MODEL_ROLES.includes(role) || !model) {
            deps.json(res, 409, {
              error: "No model is assigned to this role, so there is none to keep.",
            });
            return true;
          }
          if (typeof body.kept !== "boolean") {
            deps.json(res, 400, {
              error: "Say whether the role's model is kept: kept is true or false.",
            });
            return true;
          }
          const principal = deps.principalOf(req);
          await deps.log.append({
            actor: "human",
            type: "models/suggestion_kept",
            principal,
            payload: { role, model, kept: body.kept, host: host(), principal },
          });
          deps.json(res, 200, { role: (await rolesBody()).roles.find((r) => r.role === role) });
          return true;
        }
        case "POST /api/config/roles/:role/load":
        case "POST /api/config/roles/:role/unload": {
          const role = hit.params.role as ModelRole;
          const model = assignedModel(role);
          if (!MODEL_ROLES.includes(role) || !model) {
            deps.json(res, 409, { error: "No model is assigned to this role." });
            return true;
          }
          if (!deps.residency) {
            deps.json(res, 409, {
              error:
                "Models load through the residency scheduler where issues run; this server holds no model.",
            });
            return true;
          }
          if (key.endsWith("/load")) {
            const r = await deps.residency.load(role, model);
            if (!r.ok) {
              deps.json(res, 409, {
                error: r.reason ?? "It does not fit in memory now.",
                ...(r.unload?.length ? { unload: r.unload } : {}),
              });
              return true;
            }
          } else {
            const r = await deps.residency.unload(role);
            if (r.deferred) {
              deps.json(res, 200, {
                role: (await rolesBody()).roles.find((x) => x.role === role),
                deferred: r.deferred,
              });
              return true;
            }
          }
          deps.json(res, 200, { role: (await rolesBody()).roles.find((x) => x.role === role) });
          return true;
        }
        case "GET /api/config/downloads/estimate": {
          const model = query.get("model") ?? "";
          const source = await sourceFor(model).catch(() => undefined);
          if (!source) {
            deps.json(res, 404, { error: `${model || "This model"} has no registered source.` });
            return true;
          }
          const settings =
            ROLE_SETTINGS[(query.get("role") as ConfigRole) ?? "worker"] ?? ROLE_SETTINGS.worker;
          const est = await estimateRemote(source.url, {
            fetch: lookupFetch(),
            engine: "llama.cpp",
            ...settings,
            ...(deps.bandwidth ? { bandwidth: deps.bandwidth } : {}),
          });
          deps.json(res, 200, { estimate: est, fetchedWeights: false });
          return true;
        }
        case "POST /api/config/downloads":
          await startDownload(req, res, body);
          return true;
        case "DELETE /api/config/downloads/:id": {
          const t = downloads.get(hit.params.id ?? "");
          if (!t) {
            deps.json(res, 404, { error: "No download with that id is running." });
            return true;
          }
          t.controller.abort();
          deps.json(res, 200, { cancelled: t.id });
          return true;
        }
        case "GET /api/config/combinations":
          deps.json(res, 200, await combinationsBody());
          return true;
        case "GET /api/config/placement":
          deps.json(res, 200, await placementBody());
          return true;
        case "POST /api/config/placement/copies":
          await startCopy(req, res, body);
          return true;
        case "GET /api/config/residency": {
          const hours = Math.min(168, Math.max(1, Number(query.get("hours") ?? "24") || 24));
          deps.json(res, 200, await residencyBody(hours));
          return true;
        }
        case "GET /api/config/recommended": {
          deps.json(res, 200, {
            ...(await recommendedPlan()),
            ...(recommended ? { last: recommended.run } : {}),
          });
          return true;
        }
        case "POST /api/config/recommended": {
          if (recommended && recommended.run.state !== "done") {
            deps.json(res, 409, { error: "The recommended models are being set up already." });
            return true;
          }
          const plan = await recommendedPlan();
          // DB-N6-16: one confirmation listing every download before any request.
          if (plan.downloads.length > 0 && body.confirm !== true) {
            deps.json(res, 409, {
              error: "Confirm the downloads first: each is listed with its source, size and hash.",
              needs: "confirmation",
              downloads: plan.downloads,
              ...(plan.folder ? { folder: plan.folder } : {}),
            });
            return true;
          }
          // The confirmation names what the person saw — each download's model
          // and published hash, and the folder — and it must be the plan
          // recomputed now; a plan that changed since is confirmed again.
          const said = Array.isArray(body.downloads) ? (body.downloads as Json[]) : [];
          const key = (d: { model?: unknown; sha256?: unknown }) =>
            `${String(d.model)}\u0000${String(d.sha256)}`;
          const sameDownloads =
            said.length === plan.downloads.length &&
            [...said.map(key)].sort().join("\n") === [...plan.downloads.map(key)].sort().join("\n");
          if (!sameDownloads) {
            deps.json(res, 409, {
              error:
                "The downloads you confirmed are not the ones recommended now; review them again.",
              needs: "confirmation",
              downloads: plan.downloads,
              ...(plan.folder ? { folder: plan.folder } : {}),
            });
            return true;
          }
          let folder: string | undefined;
          if (plan.downloads.length > 0) {
            const f = downloadFolder(body.folder);
            if ("error" in f) {
              deps.json(res, 409, {
                error: f.error,
                needs: "folder",
                downloads: plan.downloads,
                ...(plan.folder ? { folder: plan.folder } : {}),
              });
              return true;
            }
            folder = f.path;
          }
          const run: RecommendedRun = {
            state: plan.downloads.length > 0 ? "downloading" : "benchmarking",
            principal: deps.principalOf(req),
            combination: plan.combination,
            downloads: [],
            assigned: [],
            notAssigned: [],
          };
          const done = runRecommended(run, plan, folder).catch((err: unknown) => {
            run.notAssigned.push(
              ...MODEL_ROLES.filter(
                (r) =>
                  !run.assigned.some((a) => a.role === r) &&
                  !run.notAssigned.some((a) => a.role === r),
              ).map((role) => ({
                role,
                reason: `It stopped: ${err instanceof Error ? err.message : String(err)}`,
              })),
            );
            run.state = "done";
            emit({ kind: "recommended", ...run });
          });
          recommended = { run, done };
          deps.json(res, 202, { ...plan, run });
          return true;
        }
        default:
          return false;
      }
    } catch (err) {
      deps.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
  };

  /**
   * A model's fit for a role, as the benchmark refuses by it before anything
   * loads (MS-N5-5): part (b)'s `fitFor` over the scanned models. A model not
   * found in any folder is not judged here.
   */
  const fitCheck = (
    role: ModelRole,
    model: string,
  ): { fits: boolean; needsGb?: number; swapSecondsPerSwitch?: number } => {
    const m = findModel(model);
    const v = m?.fit?.[role];
    if (!v) return { fits: true };
    if (v.fits === "no")
      return { fits: false, needsGb: Math.ceil(Math.max(0, -v.headroomBytes.value) / 1e9) };
    return v.fits === "swaps" && v.swapSeconds
      ? { fits: true, swapSecondsPerSwitch: v.swapSeconds.value }
      : { fits: true };
  };

  return {
    handle,
    fitCheck,
    /** Re-scan now (tests, and a watcher later). */
    scan,
    /** The hashing in progress, for tests. */
    hashingDone: async () => {
      for (
        let i = 0;
        i < 400 && state.models.some((m) => m.hash === "pending" && m.format === "gguf");
        i++
      ) {
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    close: () => {
      state.hashing?.abort();
      for (const t of [...downloads.values(), ...copies.values()]) t.controller.abort();
    },
  };
}
