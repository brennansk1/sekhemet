import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DELEGATE_LABEL,
  GitHubApiError,
  GitHubClient,
  GitHubIssuesAdapter,
  InstallationTokenProvider,
  githubIssueId,
  githubWebhookHandler,
  intentFor,
  issueNumberOf,
  mergeThreeWay,
  staticToken,
} from "../src/index.js";

/**
 * integrations P9 in the sync package: one adapter, one ID, pagination, the
 * three-way merge, backoff on every GitHub call, and webhook delivery dedupe.
 *
 * Payloads are GitHub's documented examples (docs.github.com, REST "Get an
 * issue" and the webhook payload examples), trimmed of URL fields no test
 * reads, in `fixtures/github/`; tests change numbers, logins and titles,
 * never the shape.
 */
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "github", name), "utf8"));

interface Seen {
  method: string;
  url: string;
  body: unknown;
}
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

async function fake(
  reply: (s: Seen) => { status?: number; json?: unknown; headers?: Record<string, string> },
) {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const s = { method: req.method ?? "", url: req.url ?? "", body: raw ? JSON.parse(raw) : "" };
      seen.push(s);
      const r = reply(s);
      res.writeHead(r.status ?? 200, { "content-type": "application/json", ...(r.headers ?? {}) });
      res.end(r.json === undefined ? "" : JSON.stringify(r.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, endpoints: { apiUrl: url, graphqlUrl: `${url}/graphql` } };
}

const issue = (n: number, extra: Record<string, unknown> = {}) => ({
  ...fixture("issue.json"),
  number: n,
  html_url: `https://github.com/o/r/issues/${n}`,
  title: `Issue ${n}`,
  ...extra,
});

describe("INT-1: one external identity for a GitHub issue, owner/repo#n", () => {
  it("the adapter pulls, pushes and updates with owner/repo#n; the id parses back to its number", async () => {
    const srv = await fake((s) => {
      if (s.method === "GET") return { json: [issue(1347)] };
      if (s.method === "POST") return { status: 201, json: issue(9) };
      return { json: {} };
    });
    const client = new GitHubClient(staticToken("t"), srv.endpoints, { fetch });
    const gh = new GitHubIssuesAdapter({ owner: "o", repo: "r" }, client);
    const [pulled] = await gh.pull("2020-01-01T00:00:00Z");
    expect(pulled?.ref).toEqual({
      system: "github",
      id: "o/r#1347",
      url: "https://github.com/o/r/issues/1347",
    });
    expect(pulled?.assignee).toBe("octocat");
    const ref = await gh.push({ id: "c1", title: "T", status: "ready", updatedAt: "x" });
    expect(ref.id).toBe("o/r#9");
    await gh.update(ref, { title: "T2" });
    expect(srv.seen.at(-1)).toMatchObject({ method: "PATCH", url: "/repos/o/r/issues/9" });
    expect(githubIssueId({ owner: "o", repo: "r" }, 9)).toBe("o/r#9");
    expect(issueNumberOf("o/r#9")).toBe(9);
    expect(issueNumberOf("9")).toBe(9);
  });

  it("a signed issues.labeled webhook names the same identity", () => {
    const payload = fixture("webhook-issues-labeled.json");
    const intent = intentFor("issues", payload);
    expect(intent).toMatchObject({
      kind: "create_card",
      ref: {
        system: "github",
        id: "octo-org/octo-repo#1347",
        url: "https://github.com/octo-org/octo-repo/issues/1347",
      },
      assignee: "octocat",
      updatedAt: "2011-04-22T13:33:48Z",
    });
  });
});

describe("INT-2: every open issue is pulled, not one page", () => {
  it("follows the Link header until the pages are exhausted", async () => {
    const all = Array.from({ length: 250 }, (_, i) => issue(i + 1));
    const srv = await fake((s) => {
      const page = Number(new URL(s.url, "http://x").searchParams.get("page") ?? "1");
      const slice = all.slice((page - 1) * 100, page * 100);
      const next =
        page < 3
          ? `<${srv.url}/repos/o/r/issues?state=all&per_page=100&page=${page + 1}>; rel="next"`
          : "";
      return { json: slice, headers: next ? { link: next } : {} };
    });
    const client = new GitHubClient(staticToken("t"), srv.endpoints, { fetch });
    const gh = new GitHubIssuesAdapter({ owner: "o", repo: "r" }, client);
    const items = await gh.pull("1970-01-01T00:00:00Z");
    expect(items).toHaveLength(250);
    expect(srv.seen).toHaveLength(3);
    expect(new Set(items.map((i) => i.ref.id)).size).toBe(250);
  });
});

describe("INT-4/5/6: shared fields merge three ways against the last snapshot", () => {
  const base = { title: "A", body: "b", labels: ["x"], assignee: "alice" };
  const at = (updatedAt: string, f: Partial<typeof base> = {}) => ({ ...base, ...f, updatedAt });

  it("INT-3: nothing changed on either side changes nothing and records no conflict", () => {
    const m = mergeThreeWay(base, at("2026-01-02T00:00:00Z"), at("2026-01-01T00:00:00Z"));
    expect(m).toMatchObject({ toBoard: {}, toTracker: {}, history: [] });
  });

  it("INT-4: only the tracker changed the title — the tracker's title wins even when the board is newer", () => {
    const m = mergeThreeWay(
      base,
      at("2026-01-05T00:00:00Z"), // the board moved the card later
      at("2026-01-02T00:00:00Z", { title: "A, edited in GitHub" }),
    );
    expect(m.toBoard).toEqual({ title: "A, edited in GitHub" });
    expect(m.toTracker).toEqual({});
    expect(m.history).toEqual([]);
  });

  it("INT-5: only the board changed a shared field — it is pushed to the tracker", () => {
    const m = mergeThreeWay(
      base,
      at("2026-01-01T00:00:00Z", { title: "A, edited on the board", labels: ["x", "y"] }),
      at("2026-01-05T00:00:00Z"),
    );
    expect(m.toTracker).toEqual({ title: "A, edited on the board", labels: ["x", "y"] });
    expect(m.toBoard).toEqual({});
  });

  it("INT-6: both changed the same field — the newer wins and the other is kept in the history", () => {
    const m = mergeThreeWay(
      base,
      at("2026-01-01T00:00:00Z", { title: "board" }),
      at("2026-01-02T00:00:00Z", { title: "tracker" }),
    );
    expect(m.toBoard).toEqual({ title: "tracker" });
    expect(m.history).toEqual([
      {
        field: "title",
        kept: "tracker",
        lost: "board",
        winner: "tracker",
        at: "2026-01-02T00:00:00Z",
      },
    ]);
  });
});

describe("INT-36: owner and delegate on GitHub", () => {
  it("pushes the owner's login as the assignee and the Worker as a label, never 'worker' as a user", async () => {
    const srv = await fake((s) =>
      s.method === "POST" ? { status: 201, json: issue(4) } : { json: {} },
    );
    const client = new GitHubClient(staticToken("t"), srv.endpoints, { fetch });
    const gh = new GitHubIssuesAdapter({ owner: "o", repo: "r" }, client);
    await gh.push({
      id: "c1",
      title: "T",
      status: "ready",
      updatedAt: "x",
      owner: "alice",
      delegate: "worker",
      labels: ["ui"],
    });
    const sent = srv.seen[0]?.body as { assignees: string[]; labels: string[] };
    expect(sent.assignees).toEqual(["alice"]);
    expect(sent.labels).toEqual(["ui", DELEGATE_LABEL]);
    await gh.push({ id: "c2", title: "T", status: "ready", updatedAt: "x", delegate: "worker" });
    const second = srv.seen[1]?.body as { assignees?: string[] };
    expect(second.assignees ?? []).not.toContain("worker");
    await gh.update({ system: "github", id: "o/r#4", url: "u" }, { owner: "bob", labels: [] });
    expect(srv.seen[2]?.body).toMatchObject({ assignees: ["bob"] });
  });

  it("pulls the delegate label off the tracker's labels and the card marker off the body", async () => {
    const srv = await fake(() => ({
      json: [
        issue(3, {
          body: "Do it.\n\n<!-- sekhemet:card=c3 -->",
          labels: [{ name: "ui" }, { name: DELEGATE_LABEL }],
        }),
      ],
    }));
    const client = new GitHubClient(staticToken("t"), srv.endpoints, { fetch });
    const gh = new GitHubIssuesAdapter({ owner: "o", repo: "r" }, client);
    const [item] = await gh.pull("1970-01-01T00:00:00Z");
    expect(item?.body).toBe("Do it.");
    expect(item?.labels).toEqual(["ui"]);
    expect(item?.delegatedToWorker).toBe(true);
  });
});

describe("INT-8: GraphQL and the token exchange back off on a secondary rate limit", () => {
  const limited = {
    status: 403,
    json: { message: "You have exceeded a secondary rate limit." },
    headers: { "retry-after": "2" },
  };

  it("GraphQL waits the advertised time and retries, then reports the failure past its limit", async () => {
    let calls = 0;
    const srv = await fake(() => (++calls < 3 ? limited : { json: { data: { ok: 1 } } }));
    const waits: number[] = [];
    const client = new GitHubClient(staticToken("t"), srv.endpoints, {
      sleep: async (ms) => void waits.push(ms),
      fetch,
    });
    expect(await client.graphql("query{ok}")).toEqual({ ok: 1 });
    expect(waits).toEqual([2000, 2000]);
    const always = await fake(() => limited);
    const capped = new GitHubClient(staticToken("t"), always.endpoints, {
      maxRetries: 2,
      sleep: async () => undefined,
      fetch,
    });
    const err = await capped.graphql("query{ok}").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect((err as Error).message).toMatch(/rate limit/i);
    expect(always.seen).toHaveLength(3);
  });

  it("GraphQL's own RATE_LIMITED error in a 200 body is retried too", async () => {
    let calls = 0;
    const srv = await fake(() =>
      ++calls < 2
        ? {
            json: { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
            headers: { "retry-after": "1" },
          }
        : { json: { data: { ok: 2 } } },
    );
    const waits: number[] = [];
    const client = new GitHubClient(staticToken("t"), srv.endpoints, {
      sleep: async (ms) => void waits.push(ms),
      fetch,
    });
    expect(await client.graphql("query{ok}")).toEqual({ ok: 2 });
    expect(waits).toEqual([1000]);
  });

  it("the installation token exchange waits and retries", async () => {
    let calls = 0;
    const srv = await fake(() =>
      ++calls < 2
        ? limited
        : { status: 201, json: { token: "ghs_x", expires_at: "2099-01-01T00:00:00Z" } },
    );
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const waits: number[] = [];
    const tokens = new InstallationTokenProvider({
      appId: 1,
      installationId: 2,
      privateKey,
      endpoints: srv.endpoints,
      sleep: async (ms) => void waits.push(ms),
      fetch,
    });
    expect(await tokens.token()).toBe("ghs_x");
    expect(waits).toEqual([2000]);
  });

  it("every call goes through the fetch it is given (the network policy's)", async () => {
    const srv = await fake(() => ({ json: { data: {} } }));
    const hosts: string[] = [];
    const client = new GitHubClient(staticToken("t"), srv.endpoints, {
      fetch: async (input, init) => {
        hosts.push(new URL(String(input)).pathname);
        return fetch(input, init);
      },
    });
    await client.rest("GET", "/repos/o/r");
    await client.graphql("query{ok}");
    expect(hosts).toEqual(["/repos/o/r", "/graphql"]);
  });
});

describe("INT-9/10/11: webhook intake", () => {
  const secret = "s3cret";
  const sign = (body: string) =>
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  async function serve(claim?: (id: string) => boolean) {
    const intents: string[] = [];
    const server = createServer(
      githubWebhookHandler({
        secret,
        onIntent: (i) => void intents.push(i.kind),
        ...(claim ? { claimDelivery: claim } : {}),
      }),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as AddressInfo).port;
    const post = (s: string, headers: Record<string, string>) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const req = request(
          { host: "127.0.0.1", port, method: "POST", path: "/", headers },
          (res) => {
            let b = "";
            res.on("data", (c) => {
              b += c;
            });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
          },
        );
        req.end(s);
      });
    return { intents, post };
  }

  it("INT-9: a delivery already processed is answered 202 and does nothing", async () => {
    const claimed = new Set<string>();
    const { intents, post } = await serve((id) => {
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    });
    const body = JSON.stringify(fixture("webhook-issues-labeled.json"));
    const headers = {
      "x-hub-signature-256": sign(body),
      "x-github-event": "issues",
      "x-github-delivery": "d-1",
    };
    expect((await post(body, headers)).status).toBe(202);
    const again = await post(body, headers);
    expect(again.status).toBe(202);
    expect(JSON.parse(again.body)).toMatchObject({ duplicate: true });
    expect(intents).toEqual(["create_card"]);
  });

  it("INT-10: a missing or wrong signature is 401 and nothing is parsed", async () => {
    const { intents, post } = await serve();
    const notJson = "{this is not json";
    expect((await post(notJson, { "x-github-event": "issues" })).status).toBe(401);
    expect(
      (await post(notJson, { "x-github-event": "issues", "x-hub-signature-256": "sha256=00" }))
        .status,
    ).toBe(401);
    expect(intents).toEqual([]);
  });

  it("INT-11: a comment command other than /review is ignored, not recorded", () => {
    const payload = fixture("webhook-issue_comment-created.json");
    expect(intentFor("issue_comment", payload).kind).toBe("ignored");
    for (const cmd of ["/split", "/estimate"]) {
      payload.comment.body = `${cmd} please`;
      expect(intentFor("issue_comment", payload).kind).toBe("ignored");
    }
  });

  it("INT-13/14: a closed pull request carries its merge commit and who closed it", () => {
    const intent = intentFor("pull_request", fixture("webhook-pull_request-closed.json"));
    expect(intent).toEqual({
      kind: "pull_request_closed",
      pr: 5,
      merged: true,
      mergeCommit: "c4295bd74fb0f4fda03689c3df3f2803b658fd85",
      closedBy: "hubot",
      repo: "octo-org/octo-repo",
    });
  });
});

describe("INT-11c: a page of issues through GraphQL, and GraphQL's own budget", () => {
  /** GraphQL's issue node for issue n, as GitHub's schema names its fields. */
  const node = (n: number, extra: Record<string, unknown> = {}) => ({
    number: n,
    url: `https://github.com/o/r/issues/${n}`,
    title: `Issue ${n}`,
    body: `Body ${n}`,
    state: "OPEN",
    updatedAt: "2026-09-01T00:00:00Z",
    closedAt: null,
    assignees: { nodes: [{ login: "octocat" }] },
    labels: { nodes: [{ name: "bug" }, { name: DELEGATE_LABEL }] },
    parent: null,
    subIssues: { nodes: [] },
    ...extra,
  });

  it("fetches each page's issues with their sub-issues and labels in one query, every page, and no REST issue call", async () => {
    const srv = await fake((s) => {
      if (s.url !== "/graphql") return { status: 404, json: { message: "Not Found" } };
      const vars = (s.body as { variables: { after?: string | null } }).variables;
      const first = !vars.after;
      return {
        headers: {
          "x-ratelimit-resource": "graphql",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": first ? "4999" : "4998",
          "x-ratelimit-used": first ? "1" : "2",
          "x-ratelimit-reset": "1790000000",
        },
        json: {
          data: {
            rateLimit: {
              cost: 1,
              limit: 5000,
              remaining: first ? 4999 : 4998,
              used: first ? 1 : 2,
              resetAt: "2026-09-25T13:00:00Z",
            },
            repository: {
              issues: {
                pageInfo: { hasNextPage: first, endCursor: first ? "c1" : "c2" },
                nodes: first
                  ? [
                      node(1, {
                        subIssues: {
                          nodes: [{ number: 2, repository: { nameWithOwner: "o/r" } }],
                        },
                      }),
                      node(2, { parent: { number: 1, repository: { nameWithOwner: "o/r" } } }),
                    ]
                  : [node(3, { state: "CLOSED", closedAt: "2026-09-02T00:00:00Z" })],
              },
            },
          },
        },
      };
    });
    const client = new GitHubClient(staticToken("t"), srv.endpoints, { fetch });
    const adapter = new GitHubIssuesAdapter({ owner: "o", repo: "r" }, client, { pull: "graphql" });
    const items = await adapter.pull("2026-01-01T00:00:00Z");
    // One query per page, two pages; nothing per issue, nothing through REST.
    expect(srv.seen.map((s) => s.url)).toEqual(["/graphql", "/graphql"]);
    const q = (srv.seen[0]?.body as { query: string }).query;
    expect(q).toMatch(/subIssues\(first:/);
    expect(q).toMatch(/labels\(first:/);
    expect((srv.seen[0]?.body as { variables: unknown }).variables).toMatchObject({
      owner: "o",
      name: "r",
      since: "2026-01-01T00:00:00Z",
    });
    expect(items.map((i) => i.ref.id)).toEqual(["o/r#1", "o/r#2", "o/r#3"]);
    expect(items[0]).toMatchObject({
      title: "Issue 1",
      body: "Body 1",
      labels: ["bug"],
      delegatedToWorker: true,
      assignee: "octocat",
      state: "open",
      subIssues: ["o/r#2"],
    });
    expect(items[1]?.parent).toBe("o/r#1");
    expect(items[2]).toMatchObject({ state: "closed", closedAt: "2026-09-02T00:00:00Z" });
    // GraphQL's points are tracked apart from REST's requests.
    const budget = client.budget();
    expect(budget.graphql).toMatchObject({ requests: 2, spent: 2, remaining: 4998, limit: 5000 });
    expect(budget.rest).toMatchObject({ requests: 0, spent: 0 });
    expect(budget.rest.remaining).toBeUndefined();
  });

  it("REST requests count against the REST budget only", async () => {
    const srv = await fake(() => ({
      headers: {
        "x-ratelimit-resource": "core",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4990",
        "x-ratelimit-used": "10",
        "x-ratelimit-reset": "1790000000",
      },
      json: [],
    }));
    const client = new GitHubClient(staticToken("t"), srv.endpoints, { fetch });
    await client.restPages("/repos/o/r/issues");
    await client.rest("GET", "/repos/o/r");
    expect(client.budget().rest).toMatchObject({ requests: 2, remaining: 4990, limit: 5000 });
    expect(client.budget().graphql).toMatchObject({ requests: 0, spent: 0 });
  });
});

describe("INT-16a and INT-20c at intake", () => {
  it("a Dependabot PR's opening names the pull request, its head and its URL", () => {
    const hook = fixture("webhook-pull_request-closed.json");
    hook.action = "opened";
    hook.pull_request.user = { login: "dependabot[bot]", id: 49699333, type: "Bot" };
    hook.pull_request.head.repo = { full_name: "octo-org/octo-repo" };
    hook.pull_request.base.repo = { full_name: "octo-org/octo-repo" };
    expect(intentFor("pull_request", hook)).toEqual({
      kind: "verify_dependency_pr",
      pr: 5,
      author: "dependabot[bot]",
      headSha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
      url: "https://github.com/octo-org/octo-repo/pull/5",
      repo: "octo-org/octo-repo",
    });
    hook.pull_request.user = { login: "octocat", id: 1, type: "User" };
    expect(intentFor("pull_request", hook).kind).toBe("ignored");
    // M1: the bot is its [bot] login, a Bot account, and a branch of this repository.
    hook.pull_request.user = { login: "renovate", id: 2, type: "Bot" };
    expect(intentFor("pull_request", hook).kind).toBe("ignored");
    hook.pull_request.user = { login: "renovate[bot]", id: 2, type: "User" };
    expect(intentFor("pull_request", hook).kind).toBe("ignored");
    hook.pull_request.user = { login: "renovate[bot]", id: 2, type: "Bot" };
    hook.pull_request.head.repo = { full_name: "mallory/octo-repo" };
    expect(intentFor("pull_request", hook).kind).toBe("ignored");
    hook.pull_request.head.repo = { full_name: "octo-org/octo-repo" };
    expect(intentFor("pull_request", hook).kind).toBe("verify_dependency_pr");
  });

  it("an issue closed on the tracker is an intent, by its one identity and when it closed", () => {
    const hook = fixture("webhook-issues-labeled.json");
    hook.action = "closed";
    hook.issue.state = "closed";
    hook.issue.closed_at = "2026-09-20T10:00:00Z";
    expect(intentFor("issues", hook)).toEqual({
      kind: "issue_closed",
      ref: {
        system: "github",
        id: "octo-org/octo-repo#1347",
        url: hook.issue.html_url,
      },
      closedAt: "2026-09-20T10:00:00Z",
    });
  });
});

describe("INT-11b: every verified delivery is seen, even one that is not a trigger", () => {
  it("calls afterDelivery once the signature holds, never before", async () => {
    const secret = "s3cret";
    const seen: string[] = [];
    const server = createServer(
      githubWebhookHandler({
        secret,
        onIntent: () => undefined,
        afterDelivery: (event, delivery) => void seen.push(`${event}:${delivery}`),
      }),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as AddressInfo).port;
    const post = (s: string, headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const req = request(
          { host: "127.0.0.1", port, method: "POST", path: "/", headers },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.end(s);
      });
    const body = JSON.stringify({ action: "edited", issue: { number: 1 } });
    const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(await post(body, { "x-github-event": "issues", "x-github-delivery": "g-1" })).toBe(401);
    expect(
      await post(body, {
        "x-github-event": "issues",
        "x-github-delivery": "g-2",
        "x-hub-signature-256": sig,
      }),
    ).toBe(202);
    expect(seen).toEqual(["issues:g-2"]);
  });
});
