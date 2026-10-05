import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventLog } from "@sekhemet/kernel";
import {
  type DownloadProgress,
  ENGINE_PIN,
  type EngineInstalled,
  type EnginePin,
  type EnginePlatform,
  type EngineStatus,
  engineOfferText,
  engineStatus,
  getEngine,
} from "@sekhemet/models";
import { mergeNetworkConfigs, policyFetch, policyRefusal } from "@sekhemet/sandbox";
import { userConfigPath as defaultUserConfigPath } from "./config.js";
import { networkConfigs } from "./config_apply.js";
import { CONFIG_ROUTES, type ConfigRoute } from "./config_routes.js";
import { egressEvent } from "./egress_event.js";
import { networkHint } from "./github_transport.js";

/**
 * *Get the inference engine* (models rule 6b, NEW-models-19; DEC-53 c7):
 * the one implementation behind Configuration › Models's engine card
 * (`config_engine.js`, `GET`/`POST /api/config/engine…`) and `sekhemet
 * engine status|get`. It shows the pinned release, file, size and licence
 * before anything is fetched, downloads only on a person's yes through the
 * one network policy (purpose *engine download*, every hop recorded as
 * egress and refused in `offline` with the setting named), and records
 * `engine/downloaded` with the person's principal once it is installed.
 */

export interface EngineServiceDeps {
  repoPath: string;
  log: Pick<EventLog, "append">;
  userConfigPath?: string;
  /** The user directory (`SEKHEMET_CONFIG_DIR`, else `~/.sekhemet`). */
  userDir?: string;
  env?: NodeJS.ProcessEnv;
  pin?: EnginePin;
  platform?: EnginePlatform;
}

/** The engine as the page and the terminal show it: the status and, where one exists, the offer in words. */
export interface EngineView extends EngineStatus {
  offerText?: string;
  /**
   * Why the network settings refuse the download, in words, before anyone
   * presses (dashboard §2.16, FINDINGS CFG-10; B1-C3 review); the page then
   * disables *Get the inference engine* and shows the fixes beside it.
   */
  refusal?: string;
}

/**
 * The network policy's refusal of the engine's download, in words: every
 * host the pinned download may reach (`EnginePin.hosts`, redirects included)
 * is checked as the download checks it. Undefined when the policy allows them.
 */
export function engineDownloadRefusal(deps: EngineServiceDeps): string | undefined {
  const n = networkConfigs(deps.repoPath, deps.userConfigPath ?? defaultUserConfigPath());
  const policy = mergeNetworkConfigs(n.user, n.project);
  const pin = deps.pin ?? ENGINE_PIN;
  const refused = pin.hosts.filter((h) => policyRefusal(policy, h) !== undefined);
  if (refused.length === 0) return undefined;
  const reason = policyRefusal(policy, refused[0] as string) as string;
  const hosts = pin.hosts.join(", ");
  const why =
    reason === "offline"
      ? "Downloads are off: Sekhemet is offline by default."
      : reason.startsWith("in fetch_deny")
        ? `Downloads from ${refused.join(", ")} are refused by the network settings (fetch_deny).`
        : `Downloads from ${refused.join(", ")} are not on the network settings' allowlist.`;
  return `${why} To get the engine here, allow ${hosts} in the network settings ([network] in your user config.toml: mode "open", or "allowlist" with those hosts in fetch_allow), or install llama.cpp yourself as below.`;
}

export function engineView(deps: Omit<EngineServiceDeps, "log" | "repoPath">): EngineView {
  const s = engineStatus({
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.userDir ? { userDir: deps.userDir } : {}),
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(deps.pin ? { pin: deps.pin } : {}),
  });
  const offerText = engineOfferText(s);
  return { ...s, ...(offerText ? { offerText } : {}) };
}

/**
 * Download, verify and install the pinned engine for this platform, then
 * record `engine/downloaded`. Only called on a person's yes.
 */
export async function installEngine(
  deps: EngineServiceDeps,
  principal: string,
  opts: { onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal } = {},
): Promise<EngineInstalled> {
  const n = networkConfigs(deps.repoPath, deps.userConfigPath ?? defaultUserConfigPath());
  const policy = mergeNetworkConfigs(n.user, n.project);
  const record = (r: Parameters<typeof egressEvent>[0]) =>
    deps.log.append({ actor: "harness", principal, ...egressEvent(r) });
  const pin = deps.pin ?? ENGINE_PIN;
  const done = await getEngine({
    fetch: policyFetch(policy, { purpose: "engine download", record, stream: true }),
    refusal: (host) => {
      const reason = policyRefusal(policy, host);
      return reason ? `${networkHint(reason, host)} ([network] mode)` : undefined;
    },
    pin,
    ...(deps.userDir ? { userDir: deps.userDir } : {}),
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  await deps.log.append({
    actor: "human",
    type: "engine/downloaded",
    principal,
    payload: {
      release: done.release,
      asset: done.asset,
      source: new URL(pin.baseUrl ?? `https://github.com/${pin.repo}`).hostname,
      sha256: done.sha256,
      bytes: done.bytes,
      principal,
    },
  });
  return done;
}

export interface EngineApiContext {
  service: EngineServiceDeps;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readJsonBody: (req: IncomingMessage, limit?: number) => Promise<Record<string, unknown>>;
  isTrustedMutation: (req: IncomingMessage) => boolean;
  principalOf: (req: IncomingMessage) => string | undefined;
  /** Whether the person behind a request holds `config.manage` (defence in depth behind the access table). */
  mayManage: (req: IncomingMessage) => boolean;
}

/** The download in progress or last finished, as the card polls it. */
export interface EngineDownloadState extends DownloadProgress {
  release: string;
  error?: string;
}

const ROUTES = CONFIG_ROUTES.filter((r) => r.module === "config_engine");

function match(method: string, path: string): ConfigRoute | undefined {
  return ROUTES.find((r) => r.method === method && r.path === path);
}

/**
 * The engine card's routes (PM_CONTRACT §3 *Configuration*): the rows of
 * `config_routes.ts` whose module is `config_engine`. `GET` reads the
 * engine's state, the offer and the download's progress; `POST …/get`
 * starts the download only with `{ "confirm": true }`, the person's yes
 * after the offer was shown; without it nothing is fetched.
 */
export function createEngineApi(ctx: EngineApiContext) {
  let download: EngineDownloadState | undefined;
  let running: Promise<unknown> | undefined;
  const view = () => {
    const v = engineView(ctx.service);
    const refusal = v.offer ? engineDownloadRefusal(ctx.service) : undefined;
    return { ...v, ...(refusal ? { refusal } : {}), ...(download ? { download } : {}) };
  };
  const handlers: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
    "GET /api/config/engine": async (_req, res) => ctx.json(res, 200, view()),
    "POST /api/config/engine/get": async (req, res) => {
      const body = await ctx.readJsonBody(req);
      const v = engineView(ctx.service);
      if (!v.offer)
        return ctx.json(res, 409, { error: v.noAsset ?? "Nothing is offered here.", ...v });
      // Refused before any request: the same words the page shows beside the button.
      const refusal = engineDownloadRefusal(ctx.service);
      if (refusal) return ctx.json(res, 409, { error: refusal, ...v, refusal });
      if (v.installed)
        return ctx.json(res, 409, {
          error: `llama.cpp ${v.offer.release} is already installed.`,
          ...v,
        });
      if (body.confirm !== true)
        return ctx.json(res, 400, {
          error: "Nothing was downloaded: confirm after reading what will be fetched.",
          offerText: v.offerText,
        });
      if (running) return ctx.json(res, 409, { error: "The engine is already downloading." });
      const principal = ctx.principalOf(req);
      if (!principal)
        return ctx.json(res, 403, { error: "Only a signed-in person can get the engine." });
      download = { release: v.offer.release, bytes: 0, total: v.offer.sizeBytes, state: "running" };
      running = installEngine(ctx.service, principal, {
        onProgress: (p) => {
          download = { release: v.offer?.release ?? "", ...p };
        },
      })
        .then(() => {
          download = {
            release: v.offer?.release ?? "",
            bytes: download?.bytes ?? 0,
            total: download?.total ?? 0,
            state: "done",
          };
        })
        .catch((err: unknown) => {
          download = {
            release: v.offer?.release ?? "",
            bytes: download?.bytes ?? 0,
            total: download?.total ?? 0,
            state: "failed",
            error: err instanceof Error ? err.message : String(err),
          };
        })
        .finally(() => {
          running = undefined;
        });
      ctx.json(res, 202, { download });
    },
  };
  return {
    routes: ROUTES,
    /** For a test or shutdown: the download in flight, if any. */
    settled: () => running ?? Promise.resolve(),
    async handle(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
      const route = match(req.method ?? "GET", url);
      if (!route) return false;
      if (route.method !== "GET" && !ctx.isTrustedMutation(req)) {
        ctx.json(res, 403, { error: "Actions must come from the dashboard itself" });
        return true;
      }
      if (route.permission !== "read" && !ctx.mayManage(req)) {
        ctx.json(res, 403, {
          error: "Only an Admin can get the inference engine.",
          permission: route.permission,
          needs: "admin",
        });
        return true;
      }
      try {
        await handlers[`${route.method} ${route.path}`]?.(req, res);
      } catch (err) {
        ctx.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    },
  };
}
