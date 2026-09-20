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
    },
  ) {}

  public async token(): Promise<string> {
    const now = this.options.now?.() ?? Date.now();
    if (this.cached && this.cached.expiresAt - 300_000 > now) return this.cached.token;
    const jwt = createAppJwt(this.options.appId, this.options.privateKey, Math.floor(now / 1000));
    const base = (this.options.endpoints ?? GITHUB_DOT_COM).apiUrl;
    const res = await fetch(
      `${base}/app/installations/${this.options.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    const text = await res.text();
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

/** REST and GraphQL with auth, API version, idempotency and rate-limit backoff. */
export class GitHubClient {
  constructor(
    private readonly tokens: TokenProvider,
    private readonly endpoints: GitHubEndpoints = GITHUB_DOT_COM,
    private readonly options: { maxRetries?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  public async rest<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.endpoints.apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await this.tokens.token()}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      const limited =
        res.status === 429 ||
        (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") ||
        (res.status === 403 && /secondary rate limit/i.test(text));
      if (limited && attempt < (this.options.maxRetries ?? 3)) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt,
        );
        continue;
      }
      if (!res.ok)
        throw new GitHubApiError(`${method} ${path} failed (${res.status})`, res.status, text);
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }

  public async graphql<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const res = await fetch(this.endpoints.graphqlUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this.tokens.token()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    if (!res.ok) throw new GitHubApiError(`GraphQL failed (${res.status})`, res.status, text);
    const body = JSON.parse(text) as { data?: T; errors?: { message: string }[] };
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

  /** `success` when every check run on the head has succeeded, `pending`, or `failure`. */
  public async checksState(headSha: string): Promise<"success" | "pending" | "failure"> {
    const res = await this.client.rest<{
      check_runs: { status: string; conclusion: string | null }[];
    }>("GET", `${this.base}/commits/${headSha}/check-runs`);
    const runs = res.check_runs;
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

  public async enableAutoMerge(
    pr: PullRequestRef,
    method: "SQUASH" | "MERGE" | "REBASE" = "SQUASH",
  ): Promise<void> {
    await this.client.graphql(
      "mutation($id:ID!,$m:PullRequestMergeMethod!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$m}){pullRequest{number}}}",
      { id: pr.nodeId, m: method },
    );
  }

  /**
   * One lifecycle step, for the queue to call after checks post: ready
   * when checks pass, auto-merge when the policy allows.
   */
  public async advance(
    pr: PullRequestRef,
    policy: { autoMerge: boolean; codeowners?: string; changedFiles?: string[] },
  ): Promise<"waiting" | "failing" | "ready" | "auto_merge"> {
    const state = await this.checksState(pr.headSha);
    if (state === "pending") return "waiting";
    if (state === "failure") return "failing";
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
