import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { CardStore, EventLog } from "@sekhemet/kernel";
import {
  type EffectiveNetworkPolicy,
  type NetworkRequestRecord,
  mergeNetworkConfigs,
  policyFetch,
  policyRefusal,
} from "@sekhemet/sandbox";
import {
  type FetchLike,
  GITHUB_DOT_COM,
  GitHubClient,
  type GitHubEndpoints,
  InstallationTokenProvider,
  createAppJwt,
  ghesEndpoints,
  loadPrivateKey,
} from "@sekhemet/sync";
import { effectiveConfig, networkConfigs } from "./config_apply.js";
import { egressEvent } from "./egress_event.js";

/**
 * GitHub's two transports behind one client (integrations item 10): the
 * user's own `gh` login — its token, never its commands — or a GitHub App
 * installed on the repository. Either way every request goes through the
 * network policy and is recorded on the ledger (security items 32–33), and
 * the same `GitHubClient`, adapter and pull-request lifecycle serve both.
 */
export interface GitHubTransport {
  kind: "app" | "gh";
  client: GitHubClient;
  repo: { owner: string; repo: string };
  endpoints: GitHubEndpoints;
}

/** Why the `gh` transport is unavailable, said plainly (INT-15). */
export class GhUnavailableError extends Error {
  constructor(
    public readonly reason: "not_installed" | "not_logged_in" | "no_repository",
    message: string,
  ) {
    super(message);
    this.name = "GhUnavailableError";
  }
}

const run = promisify(execFile);

/** `owner/repo` parsed, or undefined. */
export function ownerRepo(spec: string | undefined): { owner: string; repo: string } | undefined {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec((spec ?? "").trim());
  return m ? { owner: m[1] as string, repo: m[2] as string } : undefined;
}

/** The endpoints the environment names: GHES when `SEKHEMET_GITHUB_HOST` is set. */
export function githubEndpoints(env: NodeJS.ProcessEnv = process.env): GitHubEndpoints {
  return env.SEKHEMET_GITHUB_HOST ? ghesEndpoints(env.SEKHEMET_GITHUB_HOST) : GITHUB_DOT_COM;
}

/**
 * Records a request the policy decided, allowed or refused, on the ledger.
 * It returns the write, so the request can wait for it: a request whose
 * record fails fails too (security item 33).
 */
export type EgressRecorder = (r: NetworkRequestRecord) => undefined | Promise<unknown>;

/**
 * `harness/egress` on the ledger, from an event log or a card store.
 * `redactUrl` when the URL is the credential (a Slack webhook, a push
 * topic): the ledger keeps its origin only (B4.9 part 2, B1).
 */
export function egressRecorder(
  ledger: Pick<EventLog, "append"> | Pick<CardStore, "recordLedgerEvent"> | undefined,
  opts: { redactUrl?: boolean } = {},
): EgressRecorder {
  return (r) => {
    if (!ledger) return undefined;
    const params = { actor: "harness", ...egressEvent(r, opts) };
    return "append" in ledger ? ledger.append(params) : ledger.recordLedgerEvent(params);
  };
}

/** The web host that serves a GitHub API's git: `github.com` for `api.github.com`. */
const gitHostOf = (apiHost: string) => (apiHost === "api.github.com" ? "github.com" : apiHost);

/**
 * The effective network policy with a connected integration allowed: under
 * an allowlist its API host — and the git host that API serves — are allowed
 * destinations, because connecting it was the consent (security item 33);
 * `offline` still refuses them, and a denied host stays denied.
 */
export function connectedPolicy(repoPath: string, apiUrl: string): EffectiveNetworkPolicy {
  const n = networkConfigs(repoPath);
  const policy = mergeNetworkConfigs(n.user, n.project);
  if (policy.mode !== "allowlist") return policy;
  const host = new URL(apiUrl).hostname.toLowerCase();
  const add = [host, gitHostOf(host)].filter((h) => !policy.fetchAllow.includes(h));
  return { ...policy, fetchAllow: [...policy.fetchAllow, ...new Set(add)] };
}

/**
 * What to change to allow a refused host, naming the setting (integrations
 * §4, offline by default): `[network] mode`, `fetch_allow` or `fetch_deny`
 * in the user's config.toml, which a project's may only narrow.
 */
export function networkHint(reason: string, host: string): string {
  // The reasons are `policyRefusal`'s (the sandbox's copy).
  if (reason === "offline") {
    return 'Sekhemet is offline by default: set [network] mode = "allowlist" (a connected integration\'s host is then allowed) or "open" in your user config.toml to connect';
  }
  if (reason === "not in fetch_allow") {
    return `Add ${host} to [network] fetch_allow in your user config.toml, or set [network] mode = "open"`;
  }
  // A denied host's reason names the rule and its file (DS-N4-3): `in fetch_deny [<file>: <rule>]`.
  if (reason === "in fetch_deny" || reason.startsWith("in fetch_deny [")) {
    return `${host} is in [network] fetch_deny; remove it there to connect`;
  }
  return "See [network] mode in your user config.toml";
}

/** Why the policy refuses a connected integration's `url`, or undefined when it allows it. */
export function integrationRefusal(repoPath: string, apiUrl: string, url = apiUrl) {
  const host = new URL(url).hostname.toLowerCase();
  const reason = policyRefusal(connectedPolicy(repoPath, apiUrl), host);
  return reason ? { host, reason, hint: networkHint(reason, host) } : undefined;
}

/** The refusal's message, the same prefix as `policyFetch`'s, with the setting named. */
const refusalMessage = (r: { host: string; reason: string; hint: string }) =>
  `network policy refused ${r.host}: ${r.reason}. ${r.hint}`;

/**
 * The fetch every GitHub (and Forgejo) call takes (security item 33): the
 * connected policy (`connectedPolicy`), each request, allowed or refused,
 * recorded as `harness/egress` — and the request waits for its record, so a
 * ledger that cannot record it fails it. A refusal names the setting.
 */
export function integrationFetch(
  repoPath: string,
  record: EgressRecorder | undefined,
  apiUrl: string,
  purpose = "integration:github",
): FetchLike {
  const writes: Promise<unknown>[] = [];
  const inner = policyFetch(connectedPolicy(repoPath, apiUrl), {
    purpose,
    record: (r) => {
      const w = record?.(r);
      if (w) writes.push(Promise.resolve(w));
      return undefined;
    },
  });
  return async (input, init) => {
    let res: Response | undefined;
    let failure: unknown;
    try {
      res = await inner(input, init);
    } catch (err) {
      failure = err;
    }
    await Promise.all(writes.splice(0));
    if (failure !== undefined) {
      const refused = integrationRefusal(repoPath, apiUrl, String(input));
      throw refused ? new Error(refusalMessage(refused)) : failure;
    }
    return res as Response;
  };
}

/**
 * Decide a connected integration's request the harness does not send
 * through `fetch` before anything is sent: the API host before a push, and
 * the `git push` itself (B4.9 review B1). A refusal is recorded as
 * `harness/egress` and thrown naming the setting; an allowed `record` — the
 * push — is recorded before it runs.
 */
export async function decideEgress(
  repoPath: string,
  record: EgressRecorder | undefined,
  apiUrl: string,
  request: { url: string; host?: string; detail: string; recordAllowed?: boolean },
  purpose = "integration:github",
): Promise<void> {
  const host = (request.host ?? new URL(request.url).hostname).toLowerCase();
  const reason = policyRefusal(connectedPolicy(repoPath, apiUrl), host);
  if (reason || request.recordAllowed) {
    await record?.({
      url: request.url,
      host,
      purpose,
      allowed: reason === undefined,
      ...(reason ? { reason } : {}),
      payloadHash: createHash("sha256").update(request.detail).digest("hex"),
      at: new Date().toISOString(),
    });
  }
  if (reason) throw new Error(refusalMessage({ host, reason, hint: networkHint(reason, host) }));
}

/**
 * A git remote's URL as the ledger may hold it — no user or token — and its
 * host: `localhost` for a path or `file://` remote on this machine.
 */
export function remoteDestination(url: string): { url: string; host: string } {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:?#]+)(.*)$/i.exec(url);
  if (scheme && scheme[1]?.toLowerCase() !== "file") {
    const host = (scheme[2] as string).replace(/^\[|\]$/g, "");
    return { url: `${scheme[1]}://${scheme[2]}${scheme[3]}`, host };
  }
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.*)$/.exec(url);
  if (scp && !/^[a-z]:\\/i.test(url)) return { url: `${scp[1]}:${scp[2]}`, host: scp[1] as string };
  const path = url.replace(/^file:\/\//i, "");
  return { url: `file://${path}`, host: "localhost" };
}

/** The App's private key from the environment's keychain item or path (item 10). */
function appPrivateKey(env: NodeJS.ProcessEnv): string {
  return loadPrivateKey({
    ...(env.SEKHEMET_GITHUB_APP_KEYCHAIN
      ? { keychainService: env.SEKHEMET_GITHUB_APP_KEYCHAIN }
      : {}),
    ...(env.SEKHEMET_GITHUB_APP_KEY_PATH ? { path: env.SEKHEMET_GITHUB_APP_KEY_PATH } : {}),
  });
}

/**
 * The App itself, authenticated by its JWT rather than an installation token:
 * what reads the App's webhook delivery log (`GET /app/hook/deliveries`,
 * INT-11b). Through the caller's network policy, like every request.
 */
export function appJwtClientFromEnv(
  fetchImpl: FetchLike,
  env: NodeJS.ProcessEnv = process.env,
): GitHubClient | undefined {
  const appId = env.SEKHEMET_GITHUB_APP_ID;
  if (!appId || !env.SEKHEMET_GITHUB_INSTALLATION_ID) return undefined;
  const privateKey = appPrivateKey(env);
  return new GitHubClient(
    { token: async () => createAppJwt(appId, privateKey) },
    githubEndpoints(env),
    { fetch: fetchImpl },
  );
}

/** The GitHub App client from the environment, when configured (item 10). */
export function appClientFromEnv(
  fetchImpl: FetchLike,
  env: NodeJS.ProcessEnv = process.env,
): GitHubClient | undefined {
  const appId = env.SEKHEMET_GITHUB_APP_ID;
  const installationId = env.SEKHEMET_GITHUB_INSTALLATION_ID;
  if (!appId || !installationId) return undefined;
  const endpoints = githubEndpoints(env);
  const privateKey = appPrivateKey(env);
  const options = { fetch: fetchImpl };
  return new GitHubClient(
    new InstallationTokenProvider({ appId, installationId, privateKey, endpoints, ...options }),
    endpoints,
    options,
  );
}

/** Run `gh`, turning a missing binary into a named reason (INT-15). */
async function gh(repoPath: string, args: string[], timeout = 15_000): Promise<string> {
  try {
    const { stdout } = await run("gh", args, { cwd: repoPath, timeout });
    return stdout.trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") {
      throw new GhUnavailableError(
        "not_installed",
        "The gh CLI is not installed: install it from https://cli.github.com, or configure the GitHub App",
      );
    }
    throw err;
  }
}

/**
 * `owner/repo` of a git remote's URL on a GitHub host — `github.com`, or the
 * configured GHES host — or undefined.
 */
export function githubRepoOfUrl(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const dest = remoteDestination(url.trim());
  const hosts = new Set(["github.com"]);
  if (env.SEKHEMET_GITHUB_HOST) hosts.add(new URL(env.SEKHEMET_GITHUB_HOST).hostname);
  if (!hosts.has(dest.host.toLowerCase())) return undefined;
  const m = /[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(dest.url);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/**
 * The GitHub repository this project maps to: `SEKHEMET_GITHUB_REPO`, else
 * read locally from the git remotes — `[review] remote` first, then
 * `origin`, then any other — never by asking `gh` (which calls GitHub).
 */
export async function githubRepoOf(
  repoPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ repo?: string; error?: GhUnavailableError }> {
  const named = ownerRepo(env.SEKHEMET_GITHUB_REPO);
  if (named) return { repo: `${named.owner}/${named.repo}` };
  const git = async (...args: string[]) =>
    (await run("git", args, { cwd: repoPath, timeout: 10_000 })).stdout.trim();
  let remotes: string[] = [];
  try {
    remotes = (await git("remote")).split("\n").filter(Boolean);
  } catch {
    remotes = [];
  }
  const preferred = effectiveConfig(repoPath).config.review.remote;
  const order = [...new Set([preferred, "origin", ...remotes].filter((r) => remotes.includes(r)))];
  for (const name of order) {
    try {
      const repo = githubRepoOfUrl(await git("remote", "get-url", name), env);
      if (repo) return { repo };
    } catch {
      // A remote git cannot resolve names no repository.
    }
  }
  return {
    error: new GhUnavailableError(
      "no_repository",
      "This repository has no GitHub remote: add one (git remote add origin …) or set SEKHEMET_GITHUB_REPO",
    ),
  };
}

/**
 * The `gh` transport: the user's own login's token (`gh auth token`) behind
 * the one client. Throws `GhUnavailableError` naming whether `gh` is missing
 * or not logged in (INT-15).
 */
export async function ghTransport(
  repoPath: string,
  record: EgressRecorder | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitHubTransport> {
  const endpoints = githubEndpoints(env);
  const host = env.SEKHEMET_GITHUB_HOST ? new URL(env.SEKHEMET_GITHUB_HOST).host : "github.com";
  let token: string;
  try {
    token = await gh(repoPath, ["auth", "token", "--hostname", host]);
  } catch (err) {
    if (err instanceof GhUnavailableError) throw err;
    throw new GhUnavailableError(
      "not_logged_in",
      `gh is not logged in to ${host}: run gh auth login`,
    );
  }
  if (!token) {
    throw new GhUnavailableError(
      "not_logged_in",
      `gh is not logged in to ${host}: run gh auth login`,
    );
  }
  const found = await githubRepoOf(repoPath, env);
  if (found.error) throw found.error;
  const repo = ownerRepo(found.repo) as { owner: string; repo: string };
  const fetchImpl = integrationFetch(repoPath, record, endpoints.apiUrl);
  const client = new GitHubClient({ token: async () => token }, endpoints, { fetch: fetchImpl });
  return { kind: "gh", client, repo, endpoints };
}

/**
 * The GitHub transport for this project: the App when it is configured with
 * a repository, else the user's `gh` login.
 */
export async function githubTransport(
  repoPath: string,
  record: EgressRecorder | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitHubTransport> {
  const repo = ownerRepo(env.SEKHEMET_GITHUB_REPO);
  const endpoints = githubEndpoints(env);
  const app = repo
    ? appClientFromEnv(integrationFetch(repoPath, record, endpoints.apiUrl), env)
    : undefined;
  if (app && repo) return { kind: "app", client: app, repo, endpoints };
  return ghTransport(repoPath, record, env);
}
