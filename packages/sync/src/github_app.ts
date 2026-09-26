import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

/**
 * The GitHub App (Y12, Y14, Y15, Y16; design "GitHub integration"). Auth is
 * an RS256 JWT signed with the App's private key, exchanged for a one-hour
 * installation token; no personal access token is ever used. The private
 * key comes from the macOS keychain (or a path), never from config. GHES
 * is an API base URL. Every call goes through `GitHubClient`, which backs
 * off on rate limits.
 */

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** An RS256 JWT for a GitHub App (iat 60 s in the past, exp 9 minutes out). */
export function createAppJwt(
  appId: string | number,
  privateKeyPem: string,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: String(appId) }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(privateKeyPem))}`;
}

export interface PrivateKeySource {
  /** Keychain service name (macOS `security find-generic-password -s`). */
  keychainService?: string;
  keychainAccount?: string;
  path?: string;
  /** Injectable for tests: runs `security`. */
  exec?: (cmd: string, args: string[]) => string;
}

/** Load the App's private key: keychain first, then a file path. */
export function loadPrivateKey(source: PrivateKeySource): string {
  if (source.keychainService) {
    const run = source.exec ?? ((c, a) => execFileSync(c, a, { encoding: "utf8" }));
    const args = ["find-generic-password", "-s", source.keychainService, "-w"];
    if (source.keychainAccount) args.splice(3, 0, "-a", source.keychainAccount);
    const pem = run("security", args).trim();
    if (pem.includes("PRIVATE KEY")) return pem;
    throw new Error(`Keychain item ${source.keychainService} is not a PEM private key`);
  }
  if (source.path) return readFileSync(source.path, "utf8");
  throw new Error("No private key source: set a keychain service or a key path");
}

export interface GitHubEndpoints {
  /** REST base, `https://api.github.com` or `https://ghes.example/api/v3`. */
  apiUrl: string;
  graphqlUrl: string;
}

export const GITHUB_DOT_COM: GitHubEndpoints = {
  apiUrl: "https://api.github.com",
  graphqlUrl: "https://api.github.com/graphql",
};

/** GHES endpoints from its host. */
export function ghesEndpoints(host: string): GitHubEndpoints {
  const base = host.replace(/\/+$/, "");
  return { apiUrl: `${base}/api/v3`, graphqlUrl: `${base}/api/graphql` };
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export interface TokenProvider {
  token(): Promise<string>;
}

/** A static token (tests, or a pre-exchanged installation token). */
export const staticToken = (t: string): TokenProvider => ({ token: async () => t });

/** The `fetch` every GitHub call goes through: the network policy's (security item 33). */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface BackoffOptions {
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A client's options: its `fetch` is required — every GitHub request goes
 * through the caller's network policy and is recorded (security item 33);
 * nothing falls back to the global `fetch`.
 */
export interface ClientOptions extends BackoffOptions {
  fetch: FetchLike;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A primary or secondary rate limit, however GitHub reports it (INT-8). */
function rateLimited(res: Response, text: string): boolean {
  if (res.status === 429) return true;
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") return true;
  if (res.status === 403 && /secondary rate limit/i.test(text)) return true;
  // GraphQL reports its own limit in a 200 body.
  return res.status === 200 && /"type"\s*:\s*"RATE_LIMITED"/.test(text);
}

/**
 * One GitHub request with the backoff every call shares — REST, GraphQL and
 * the token exchange (integrations item 11, INT-8): on a rate limit it waits
 * `retry-after` (else exponentially), up to `maxRetries`, then reports it.
 */
async function sendWithBackoff(
  label: string,
  send: () => Promise<Response>,
  options: BackoffOptions,
): Promise<{ res: Response; text: string }> {
  const sleep = options.sleep ?? realSleep;
  const max = options.maxRetries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const res = await send();
    const text = await res.text();
    if (!rateLimited(res, text)) return { res, text };
    if (attempt >= max) {
      throw new GitHubApiError(
        `${label} hit GitHub's rate limit ${attempt + 1} times; giving up`,
        res.status,
        text,
      );
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt,
    );
  }
}

/**
 * Installation tokens, exchanged from the App JWT and cached until five
 * minutes before they expire.
 */
export class InstallationTokenProvider implements TokenProvider {
  private cached: { token: string; expiresAt: number } | undefined;

  constructor(
    private readonly options: {
      appId: string | number;
      installationId: string | number;
      privateKey: string;
      endpoints?: GitHubEndpoints;
      now?: () => number;
    } & ClientOptions,
  ) {}

  public async token(): Promise<string> {
    const now = this.options.now?.() ?? Date.now();
    if (this.cached && this.cached.expiresAt - 300_000 > now) return this.cached.token;
    const jwt = createAppJwt(this.options.appId, this.options.privateKey, Math.floor(now / 1000));
    const base = (this.options.endpoints ?? GITHUB_DOT_COM).apiUrl;
    const doFetch = this.options.fetch;
    const { res, text } = await sendWithBackoff(
      "The installation token exchange",
      () =>
        doFetch(`${base}/app/installations/${this.options.installationId}/access_tokens`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }),
      this.options,
    );
    if (!res.ok)
      throw new GitHubApiError(
        `Installation token exchange failed (${res.status})`,
        res.status,
        text,
      );
    const body = JSON.parse(text) as { token: string; expires_at: string };
    this.cached = { token: body.token, expiresAt: Date.parse(body.expires_at) };
    return body.token;
  }
}

/** The `rel="next"` URL of a `Link` header, if any (REST pagination). */
function nextLink(header: string | null): string | undefined {
  for (const part of (header ?? "").split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * One of GitHub's two meters as this client has seen it (integrations item
 * 11a, INT-11c): REST counts requests, GraphQL counts points, and GitHub
 * meters them apart. `limit`, `remaining`, `used` and `resetAt` are the last
 * response's; `requests` and `spent` (points for GraphQL, requests for REST)
 * are this client's own.
 */
export interface RateBudget {
  requests: number;
  spent: number;
  limit?: number;
  remaining?: number;
  used?: number;
  resetAt?: string;
}

/** GraphQL's `rateLimit` object, when a query asks for it. */
interface GraphqlRateLimit {
  cost?: number;
  limit?: number;
  remaining?: number;
  used?: number;
  resetAt?: string;
}

const num = (v: string | null | undefined) =>
  v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined;

/** REST and GraphQL with auth, API version, pagination and rate-limit backoff. */
export class GitHubClient {
  private readonly budgets: { rest: RateBudget; graphql: RateBudget } = {
    rest: { requests: 0, spent: 0 },
    graphql: { requests: 0, spent: 0 },
  };

  constructor(
    private readonly tokens: TokenProvider,
    private readonly endpoints: GitHubEndpoints,
    private readonly options: ClientOptions,
  ) {}

  /** The REST and GraphQL budgets, apart (INT-11c). */
  public budget(): { rest: RateBudget; graphql: RateBudget } {
    return { rest: { ...this.budgets.rest }, graphql: { ...this.budgets.graphql } };
  }

  /** Note a response against its meter: the headers GitHub sent, and a GraphQL query's cost. */
  private note(meter: "rest" | "graphql", res: Response, rateLimit?: GraphqlRateLimit): void {
    const b = this.budgets[meter];
    b.requests += 1;
    b.spent += meter === "graphql" ? (rateLimit?.cost ?? 1) : 1;
    const limit = rateLimit?.limit ?? num(res.headers.get("x-ratelimit-limit"));
    const remaining = rateLimit?.remaining ?? num(res.headers.get("x-ratelimit-remaining"));
    const used = rateLimit?.used ?? num(res.headers.get("x-ratelimit-used"));
    const reset = num(res.headers.get("x-ratelimit-reset"));
    const resetAt =
      rateLimit?.resetAt ??
      (reset !== undefined ? new Date(reset * 1000).toISOString() : undefined);
    if (limit !== undefined) b.limit = limit;
    if (remaining !== undefined) b.remaining = remaining;
    if (used !== undefined) b.used = used;
    if (resetAt !== undefined) b.resetAt = resetAt;
  }

  private async request(
    method: string,
    pathOrUrl: string,
    body?: unknown,
  ): Promise<{ res: Response; text: string }> {
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${this.endpoints.apiUrl}${pathOrUrl}`;
    const doFetch = this.options.fetch;
    const { res, text } = await sendWithBackoff(
      `${method} ${pathOrUrl}`,
      async () =>
        doFetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${await this.tokens.token()}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
      this.options,
    );
    this.note("rest", res);
    if (!res.ok)
      throw new GitHubApiError(`${method} ${pathOrUrl} failed (${res.status})`, res.status, text);
    return { res, text };
  }

  public async rest<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const { text } = await this.request(method, path, body);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * Every page of a list endpoint, following `Link: rel="next"` until it is
   * exhausted (integrations item 11, INT-2) — never only the first page.
   */
  public async restPages<T = unknown>(
    path: string,
    maxPages = 1000,
    /** Stop after a page it holds true for (a newest-first log read back to a date). */
    stopAfter?: (page: T[]) => boolean,
  ): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    for (let page = 0; next && page < maxPages; page++) {
      const { res, text } = await this.request("GET", next);
      const items = (text ? JSON.parse(text) : []) as T[];
      out.push(...items);
      if (stopAfter?.(items)) break;
      next = nextLink(res.headers.get("link"));
      // The token goes only to the configured API: a next link elsewhere stops.
      if (next && new URL(next).origin !== new URL(this.endpoints.apiUrl).origin) {
        throw new GitHubApiError(`A next page outside ${this.endpoints.apiUrl}: ${next}`, 0, "");
      }
    }
    return out;
  }

  public async graphql<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const doFetch = this.options.fetch;
    const { res, text } = await sendWithBackoff(
      "GraphQL",
      async () =>
        doFetch(this.endpoints.graphqlUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${await this.tokens.token()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query, variables }),
        }),
      this.options,
    );
    if (!res.ok) {
      this.note("graphql", res);
      throw new GitHubApiError(`GraphQL failed (${res.status})`, res.status, text);
    }
    const body = JSON.parse(text) as { data?: T; errors?: { message: string }[] };
    const rateLimit = (body.data as { rateLimit?: GraphqlRateLimit } | undefined)?.rateLimit;
    this.note("graphql", res, rateLimit ?? undefined);
    if (body.errors?.length)
      throw new GitHubApiError(`GraphQL: ${body.errors[0]?.message}`, 200, text);
    return body.data as T;
  }
}

// ------------------------------------------------------------- Y14 check runs

export interface GateFailureLike {
  rung: string;
  errorExcerpt: string;
  suggestedFixFiles?: string[];
}

export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "failure" | "warning" | "notice";
  message: string;
  title: string;
  raw_details?: string;
}

const LOCATION = /([\w./@-]+\.[a-z]{1,5})(?::(\d+)(?::\d+)?|\((\d+),\d+\))/g;

/** Typed gate failures to line-level annotations (one per located line). */
export function annotationsFromFailures(failures: readonly GateFailureLike[]): CheckAnnotation[] {
  const out: CheckAnnotation[] = [];
  for (const f of failures) {
    for (const line of f.errorExcerpt.split("\n")) {
      for (const m of line.matchAll(LOCATION)) {
        const n = Number(m[2] ?? m[3]);
        if (!m[1] || !n) continue;
        out.push({
          path: m[1].replace(/^\.\//, ""),
          start_line: n,
          end_line: n,
          annotation_level: "failure",
          message:
            line
              .slice(line.indexOf(m[0]) + m[0].length)
              .replace(/^[\s:-]+/, "")
              .slice(0, 400) || line.slice(0, 400),
          title: `Gate Failure: ${f.rung}`,
          raw_details: /\b(TS\d{4}|E\d{3,4})\b/.exec(line)?.[0] ?? f.rung,
        });
      }
    }
  }
  return out;
}

/**
 * Post a gate run as a Check Run: created in_progress, completed with the
 * conclusion; annotations go in batches of 50 (GitHub's per-request limit).
 */
export async function postCheckRun(
  client: GitHubClient,
  repo: { owner: string; repo: string },
  input: {
    name: string;
    headSha: string;
    passed: boolean;
    summary: string;
    failures: GateFailureLike[];
  },
): Promise<{ id: number; annotations: number }> {
  const base = `/repos/${repo.owner}/${repo.repo}/check-runs`;
  const created = await client.rest<{ id: number }>("POST", base, {
    name: input.name,
    head_sha: input.headSha,
    status: "in_progress",
    started_at: new Date().toISOString(),
  });
  const annotations = annotationsFromFailures(input.failures);
  const title = input.passed ? "All gates passed" : `${input.failures.length} gate failure(s)`;
  const batches = Math.max(1, Math.ceil(annotations.length / 50));
  for (let i = 0; i < batches; i++) {
    const last = i === batches - 1;
    await client.rest("PATCH", `${base}/${created.id}`, {
      ...(last
        ? {
            status: "completed",
            conclusion: input.passed ? "success" : "failure",
            completed_at: new Date().toISOString(),
          }
        : {}),
      output: {
        title,
        summary: input.summary,
        annotations: annotations.slice(i * 50, i * 50 + 50),
      },
    });
  }
  return { id: created.id, annotations: annotations.length };
}

// ----------------------------------------------------------------- Y15 SARIF

/** gzip then base64, as the code-scanning API requires. */
export function encodeSarif(sarif: unknown): string {
  return gzipSync(Buffer.from(typeof sarif === "string" ? sarif : JSON.stringify(sarif))).toString(
    "base64",
  );
}

export async function uploadSarif(
  client: GitHubClient,
  repo: { owner: string; repo: string },
  input: { commitSha: string; ref: string; sarif: unknown; toolName?: string },
): Promise<{ id: string }> {
  return client.rest("POST", `/repos/${repo.owner}/${repo.repo}/code-scanning/sarifs`, {
    commit_sha: input.commitSha,
    ref: input.ref,
    sarif: encodeSarif(input.sarif),
    ...(input.toolName ? { tool_name: input.toolName } : {}),
  });
}

// ------------------------------------------------------------ Y16 PR lifecycle

export interface PullRequestRef {
  number: number;
  nodeId: string;
  url: string;
  headSha: string;
}

/** A check run as GitHub's REST API lists it: ours (`sekhemet/<gate>`) or someone else's CI. */
export interface CheckRunInfo {
  name?: string;
  status: string;
  conclusion: string | null;
  head_sha?: string;
  html_url?: string | null;
  details_url?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

/** The conclusions GitHub counts as passing. */
const PASSING = new Set(["success", "skipped", "neutral"]);

/** GitHub's combined rule: any completed run not success, skipped or neutral fails. */
export function checksStateOf(runs: readonly CheckRunInfo[]): "success" | "pending" | "failure" {
  if (
    runs.some(
      (r) =>
        r.status === "completed" &&
        r.conclusion !== "success" &&
        r.conclusion !== "skipped" &&
        r.conclusion !== "neutral",
    )
  ) {
    return "failure";
  }
  if (runs.length === 0 || runs.some((r) => r.status !== "completed")) return "pending";
  return "success";
}

/**
 * The PR lifecycle (design "Pull request lifecycle"): a draft with the
 * evidence summary, then ready once every check succeeds (reviewers from
 * CODEOWNERS), review threads resolved after repair, and auto-merge per
 * policy.
 */
export class PullRequestLifecycle {
  constructor(
    private readonly client: GitHubClient,
    private readonly repo: { owner: string; repo: string },
  ) {}

  private get base(): string {
    return `/repos/${this.repo.owner}/${this.repo.repo}`;
  }

  public async openDraft(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequestRef> {
    const pr = await this.client.rest<{
      number: number;
      node_id: string;
      html_url: string;
      head: { sha: string };
    }>("POST", `${this.base}/pulls`, { ...input, draft: true });
    return { number: pr.number, nodeId: pr.node_id, url: pr.html_url, headSha: pr.head.sha };
  }

  /** Every check run on a head, ours and anyone else's (INT-12b, INT-37). */
  public async checkRuns(headSha: string): Promise<CheckRunInfo[]> {
    const res = await this.client.rest<{ check_runs: CheckRunInfo[] }>(
      "GET",
      `${this.base}/commits/${headSha}/check-runs?per_page=100`,
    );
    return res.check_runs;
  }

  /** `success` when every check run on the head has succeeded, `pending`, or `failure`. */
  public async checksState(headSha: string): Promise<"success" | "pending" | "failure"> {
    return checksStateOf(await this.checkRuns(headSha));
  }

  /** Mark ready (GraphQL) and request reviewers from CODEOWNERS for the changed files. */
  public async markReady(
    pr: PullRequestRef,
    codeowners?: string,
    changedFiles: string[] = [],
  ): Promise<string[]> {
    await this.client.graphql(
      "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}",
      { id: pr.nodeId },
    );
    const owners = codeowners ? ownersFor(codeowners, changedFiles) : [];
    const users = owners.filter((o) => !o.includes("/")).map((o) => o.replace(/^@/, ""));
    const teams = owners.filter((o) => o.includes("/")).map((o) => o.split("/")[1] as string);
    if (users.length || teams.length) {
      await this.client.rest("POST", `${this.base}/pulls/${pr.number}/requested_reviewers`, {
        reviewers: users,
        team_reviewers: teams,
      });
    }
    return owners;
  }

  /** Unresolved review threads (the inbound review comments). */
  public async openThreads(
    pr: PullRequestRef,
  ): Promise<{ id: string; path: string; line: number | null; body: string }[]> {
    const data = await this.client.graphql<{
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: {
              id: string;
              isResolved: boolean;
              path: string;
              line: number | null;
              comments: { nodes: { body: string }[] };
            }[];
          };
        };
      };
    }>(
      "query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved path line comments(first:1){nodes{body}}}}}}}",
      { o: this.repo.owner, r: this.repo.repo, n: pr.number },
    );
    return data.repository.pullRequest.reviewThreads.nodes
      .filter((t) => !t.isResolved)
      .map((t) => ({
        id: t.id,
        path: t.path,
        line: t.line,
        body: t.comments.nodes[0]?.body ?? "",
      }));
  }

  public async resolveThread(
    threadId: string,
    reply?: { prNumber: number; commentBody: string; inReplyTo?: number },
  ): Promise<void> {
    if (reply?.inReplyTo) {
      await this.client.rest(
        "POST",
        `${this.base}/pulls/${reply.prNumber}/comments/${reply.inReplyTo}/replies`,
        {
          body: reply.commentBody,
        },
      );
    }
    await this.client.graphql(
      "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}",
      { id: threadId },
    );
  }

  /**
   * Auto-merge, pinned to `pr.headSha` (`expectedHeadOid`): GitHub refuses
   * it when the pull request's head is no longer the one Sekhemet checked.
   */
  public async enableAutoMerge(
    pr: PullRequestRef,
    method: "SQUASH" | "MERGE" | "REBASE" = "SQUASH",
  ): Promise<void> {
    await this.client.graphql(
      "mutation($id:ID!,$m:PullRequestMergeMethod!,$head:GitObjectID){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$m,expectedHeadOid:$head}){pullRequest{number}}}",
      { id: pr.nodeId, m: method, head: pr.headSha },
    );
  }

  /**
   * One lifecycle step, for the queue to call after checks post: ready
   * when checks pass, auto-merge when the policy allows. `onChecks` sees the
   * runs it decided on: where results from someone else's CI are recorded as
   * external (INT-37).
   *
   * A check the project declares blocking (`[review] blocking_checks`) must
   * have passed at the pull request's current head, as GitHub reports it now:
   * one not yet reported, or reported only at another head — the PR's head
   * moved since Sekhemet opened it — keeps it waiting; one that failed there
   * keeps it failing. Either way it is not marked ready and auto-merge is
   * not enabled (B4.9 part 2, M4).
   */
  public async advance(
    pr: PullRequestRef,
    policy: {
      autoMerge: boolean;
      codeowners?: string;
      changedFiles?: string[];
      onChecks?: (runs: CheckRunInfo[]) => Promise<void>;
      blockingChecks?: readonly string[];
    },
  ): Promise<"waiting" | "failing" | "ready" | "auto_merge"> {
    const runs = await this.checkRuns(pr.headSha);
    await policy.onChecks?.(runs);
    const state = checksStateOf(runs);
    if (state === "pending") return "waiting";
    if (state === "failure") return "failing";
    const blocking = policy.blockingChecks ?? [];
    if (blocking.length > 0) {
      const now = await this.client.rest<{ head: { sha: string } }>(
        "GET",
        `${this.base}/pulls/${pr.number}`,
      );
      if (now.head.sha !== pr.headSha) return "waiting";
      for (const name of blocking) {
        const at = runs.filter((r) => r.name === name && r.head_sha === now.head.sha);
        if (at.some((r) => r.status === "completed" && !PASSING.has(r.conclusion ?? ""))) {
          return "failing";
        }
        if (!at.some((r) => r.status === "completed" && PASSING.has(r.conclusion ?? ""))) {
          return "waiting";
        }
      }
    }
    await this.markReady(pr, policy.codeowners, policy.changedFiles ?? []);
    if (policy.autoMerge) {
      await this.enableAutoMerge(pr);
      return "auto_merge";
    }
    return "ready";
  }
}

/** CODEOWNERS: the last matching pattern wins (GitHub semantics, simplified globs). */
export function ownersFor(codeowners: string, files: readonly string[]): string[] {
  const rules = codeowners
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [pattern, ...owners] = l.split(/\s+/);
      return { pattern: pattern as string, owners };
    });
  const toRe = (p: string) => {
    const anchored = p.startsWith("/");
    const body = p
      .replace(/^\//, "")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      // NUL stands in for `**` while single `*` is expanded, so the two
      // cannot be confused. It cannot occur in a path, which is the point.
      .replace(/\*\*/g, " ")
      .replace(/\*/g, "[^/]*")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the same sentinel, consumed
      .replace(/ /g, ".*");
    const tail = p.endsWith("/") ? ".*" : "(/.*)?";
    return new RegExp(`${anchored ? "^" : "(^|/)"}${body}${tail}$`);
  };
  const out = new Set<string>();
  for (const f of files) {
    let owners: string[] = [];
    for (const r of rules) if (toRe(r.pattern).test(f)) owners = r.owners;
    for (const o of owners) out.add(o);
  }
  return [...out].sort();
}
