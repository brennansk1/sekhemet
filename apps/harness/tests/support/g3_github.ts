import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import type { CardStore } from "@sekhemet/kernel";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach } from "vitest";
import { recordLedgerRun } from "../../src/ledger_evidence.js";

/**
 * GitHub for the integrations entry-point tests (C2d, FINDINGS_C1 TST-01):
 * a local server speaking GitHub's REST and GraphQL APIs under GHES paths
 * (`/api/v3`, `/api/graphql`), issues held in memory, built from GitHub's
 * documented example payloads (`packages/sync/tests/fixtures/github/`), and
 * a fake `gh` whose `auth token` prints `$FAKE_GH_TOKEN`. The product reaches
 * it as it reaches a GitHub Enterprise Server (`SEKHEMET_GITHUB_HOST`), so no
 * request leaves the machine. Adapted from `github_first.spec.ts`'s fake,
 * with the issue list paged as GitHub pages it (100 a page, INT-2), a
 * secondary rate limit on demand (INT-8) and Check Run writes recorded with
 * their annotations (INT-47).
 */

const FIXTURES = resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "sync",
  "tests",
  "fixtures",
  "github",
);
/** GitHub's JSON as its documentation gives it: any shape a test edits. */
// biome-ignore lint/suspicious/noExplicitAny: GitHub's payloads, edited field by field in tests.
export type Loose = any;

export const ghFixture = (name: string) =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, Loose>;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
export const writeIn = (base: string, rel: string, text: string) => {
  mkdirSync(dirname(join(base, rel)), { recursive: true });
  writeFileSync(join(base, rel), text);
};

/** A fake `gh`: `auth token` prints $FAKE_GH_TOKEN, or fails as a logged-out `gh` does. */
export function fakeGh(bin: string): string {
  mkdirSync(bin, { recursive: true });
  const script = [
    "#!/bin/sh",
    'case "$1 $2" in',
    '  "auth token") if [ -n "$FAKE_GH_TOKEN" ]; then echo "$FAKE_GH_TOKEN"; exit 0; fi; echo "no oauth token found for github.com" >&2; exit 1;;',
    "esac",
    'echo "fake gh: unexpected $*" >&2; exit 2',
  ].join("\n");
  writeFileSync(join(bin, "gh"), `${script}\n`);
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

/** A directory holding git and nothing else: a PATH with no `gh` on it. */
export function binWithoutGh(root: string): string {
  const bin = join(root, "bin-nogh");
  mkdirSync(bin, { recursive: true });
  symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(bin, "git"));
  return bin;
}

export interface Seen {
  method: string;
  url: string;
  body: Loose;
  auth?: string;
}

export interface FakeGitHub {
  url: string;
  seen: Seen[];
  issues: Map<number, Record<string, Loose>>;
  edit: (n: number, patch: Record<string, unknown>) => void;
  projects: { id: string; options: string[]; items: Map<number, string | undefined> }[];
  statusLog: string[];
  deliveries: Record<string, unknown>[];
  checkRuns: Record<string, unknown>[];
  prHeads: Map<number, string>;
  /** The next `n` GraphQL requests answer GitHub's secondary rate limit (INT-8). */
  limitNext: (n: number) => void;
  /** Each Check Run write: its id and the annotations it carried (INT-47). */
  checkRunWrites: { id: number; method: string; name?: string; annotations: unknown[] }[];
}

/** A GraphQL query, as the fake reads it: a read, not a write. */
export const isGraphqlRead = (s: { url: string; body: unknown }) =>
  s.url === "/api/graphql" && /^\s*query/.test(String((s.body as { query?: string })?.query));
/** The GraphQL issue-page queries a sync sent. */
export const issuePages = (api: FakeGitHub) =>
  api.seen.filter(
    (s) => isGraphqlRead(s) && /issues\(first:/.test(String((s.body as { query: string }).query)),
  );
/** Requests that change something on GitHub (a GraphQL query is a read, though a POST). */
export const githubWrites = (api: FakeGitHub) =>
  api.seen.filter((s) => s.method !== "GET" && !isGraphqlRead(s));

/** GitHub for o/r under GHES paths, issues held in memory. */
export async function fakeGitHub(): Promise<FakeGitHub> {
  const issues = new Map<number, Record<string, Loose>>();
  let clock = Date.now() - 60_000;
  const tick = () => {
    clock = Math.max(clock + 1, Date.now());
    return new Date(clock).toISOString();
  };
  const seen: Seen[] = [];
  const projects: FakeGitHub["projects"] = [];
  const statusLog: string[] = [];
  const deliveries: FakeGitHub["deliveries"] = [];
  const checkRuns: FakeGitHub["checkRuns"] = [{ status: "completed", conclusion: "success" }];
  const checkRunWrites: FakeGitHub["checkRunWrites"] = [];
  const prHeads = new Map<number, string>();
  let limited = 0;
  let points = 0;
  let next = 100;
  let runId = 1000;
  const make = (n: number, fields: Record<string, unknown>) => ({
    ...ghFixture("issue.json"),
    number: n,
    html_url: `https://github.com/o/r/issues/${n}`,
    assignee: null,
    assignees: [],
    labels: [],
    state: "open",
    ...fields,
    updated_at: tick(),
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const url = req.url ?? "";
      seen.push({
        method: req.method ?? "",
        url,
        body,
        auth: String(req.headers.authorization ?? ""),
      });
      const send = (status: number, json: unknown, graphql = false, extra = {}) => {
        res.writeHead(status, {
          "content-type": "application/json",
          "x-ratelimit-resource": graphql ? "graphql" : "core",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": graphql ? String(5000 - points) : "4990",
          ...extra,
        });
        res.end(JSON.stringify(json));
      };
      const path = url.replace(/\?.*$/, "");
      if (req.method === "POST" && path === "/api/graphql") {
        if (limited > 0) {
          limited--;
          return send(
            403,
            { message: "You have exceeded a secondary rate limit. Please wait a few minutes." },
            true,
            { "retry-after": "1" },
          );
        }
        const q = String((body as { query?: string }).query ?? "");
        const vars = ((body as { variables?: Record<string, unknown> }).variables ?? {}) as Record<
          string,
          unknown
        >;
        points += 1;
        const rateLimit = { cost: 1, limit: 5000, remaining: 5000 - points, used: points };
        if (/issues\(first:/.test(q)) {
          const since = Date.parse(String(vars.since ?? "1970-01-01"));
          const all = [...issues.values()]
            .filter((i) => Date.parse(String(i.updated_at)) >= since)
            .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
          // As GitHub pages it: 100 a page, the cursor the last one's index.
          const from = vars.after ? Number(vars.after) : 0;
          const page = all.slice(from, from + 100);
          const nodes = page.map((i) => ({
            number: i.number,
            url: i.html_url,
            title: i.title,
            body: i.body ?? null,
            state: i.state === "closed" ? "CLOSED" : "OPEN",
            updatedAt: i.updated_at,
            closedAt: i.closed_at ?? null,
            assignees: { nodes: i.assignee ? [i.assignee] : [] },
            labels: {
              nodes: ((i.labels as { name: string }[]) ?? []).map((l) => ({ name: l.name })),
            },
            parent: null,
            subIssues: {
              nodes: ((i.sub_issues as number[]) ?? []).map((n) => ({ number: n })),
            },
          }));
          const more = from + 100 < all.length;
          return send(
            200,
            {
              data: {
                rateLimit,
                repository: {
                  issues: {
                    pageInfo: { hasNextPage: more, endCursor: more ? String(from + 100) : null },
                    nodes,
                  },
                },
              },
            },
            true,
          );
        }
        if (/projectItems/.test(q)) {
          const n = Number(vars.n);
          const nodes = projects
            .filter((p) => p.items.has(n))
            .map((p) => ({
              id: `${p.id}:item:${n}`,
              project: {
                id: p.id,
                field: {
                  id: `${p.id}:status`,
                  options: p.options.map((o) => ({ id: `${p.id}:${o}`, name: o })),
                },
              },
            }));
          return send(200, { data: { repository: { issue: { projectItems: { nodes } } } } }, true);
        }
        if (/updateProjectV2ItemFieldValue/.test(q)) {
          const p = projects.find((x) => x.id === vars.p);
          const option = String(vars.o).slice(`${String(vars.p)}:`.length);
          const n = Number(String(vars.i).split(":item:")[1]);
          p?.items.set(n, option);
          statusLog.push(`${String(vars.p)}:${option}`);
          return send(
            200,
            { data: { updateProjectV2ItemFieldValue: { projectV2Item: {} } } },
            true,
          );
        }
        return send(200, { data: {} }, true);
      }
      if (
        req.method === "POST" &&
        /^\/api\/v3\/app\/installations\/\d+\/access_tokens$/.test(path)
      ) {
        return send(201, {
          token: "ghs_installation",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (req.method === "GET" && path === "/api/v3/app/hook/deliveries") {
        return send(200, deliveries);
      }
      const pull = /^\/api\/v3\/repos\/o\/r\/pulls\/(\d+)$/.exec(path);
      if (pull && req.method === "GET") {
        const n = Number(pull[1]);
        return send(200, {
          number: n,
          node_id: `PR_${n}`,
          html_url: `https://github.com/o/r/pull/${n}`,
          user: { login: "dependabot[bot]", type: "Bot" },
          head: { sha: prHeads.get(n) ?? "0".repeat(40), repo: { full_name: "o/r" } },
          base: { ref: "main", repo: { full_name: "o/r" } },
        });
      }
      if (req.method === "GET" && path === "/api/v3/repos/o/r/issues") {
        const since = Date.parse(
          new URL(url, "http://x").searchParams.get("since") ?? "1970-01-01",
        );
        return send(
          200,
          [...issues.values()].filter((i) => Date.parse(String(i.updated_at)) >= since),
        );
      }
      if (req.method === "POST" && path === "/api/v3/repos/o/r/issues") {
        const n = next++;
        const b = body as { title: string; body: string; labels?: string[]; assignees?: string[] };
        issues.set(
          n,
          make(n, {
            title: b.title,
            body: b.body,
            labels: (b.labels ?? []).map((name) => ({ name })),
            assignee: b.assignees?.[0] ? { login: b.assignees[0] } : null,
          }),
        );
        return send(201, issues.get(n));
      }
      const one = /^\/api\/v3\/repos\/o\/r\/issues\/(\d+)$/.exec(path);
      if (one && req.method === "PATCH") {
        const n = Number(one[1]);
        const cur = issues.get(n) ?? make(n, {});
        const b = body as Record<string, unknown>;
        issues.set(n, {
          ...cur,
          ...(b.title !== undefined ? { title: b.title } : {}),
          ...(b.body !== undefined ? { body: b.body } : {}),
          ...(b.state !== undefined ? { state: b.state } : {}),
          ...(b.labels !== undefined
            ? { labels: (b.labels as string[]).map((name) => ({ name })) }
            : {}),
          ...(b.assignees !== undefined
            ? {
                assignee: (b.assignees as string[])[0]
                  ? { login: (b.assignees as string[])[0] }
                  : null,
              }
            : {}),
          updated_at: tick(),
        });
        return send(200, issues.get(n));
      }
      if (req.method === "GET" && path === "/api/v3/user") {
        return send(200, { login: "jane-gh", id: 7, type: "User" });
      }
      if (req.method === "GET" && /^\/api\/v3\/repos\/o\/r\/commits\/\w+\/check-runs$/.test(path)) {
        return send(200, { total_count: checkRuns.length, check_runs: checkRuns });
      }
      if (req.method === "POST" && path === "/api/v3/repos/o/r/check-runs") {
        const id = runId++;
        checkRunWrites.push({
          id,
          method: "POST",
          name: (body as { name?: string }).name,
          annotations: (body as { output?: { annotations?: unknown[] } }).output?.annotations ?? [],
        });
        return send(201, { id, html_url: `https://github.com/o/r/runs/${id}` });
      }
      const run = /^\/api\/v3\/repos\/o\/r\/check-runs\/(\d+)$/.exec(path);
      if (run && req.method === "PATCH") {
        checkRunWrites.push({
          id: Number(run[1]),
          method: "PATCH",
          annotations: (body as { output?: { annotations?: unknown[] } }).output?.annotations ?? [],
        });
        return send(200, { id: Number(run[1]) });
      }
      const comment = /^\/api\/v3\/repos\/o\/r\/issues\/(\d+)\/comments$/.exec(path);
      if (comment && req.method === "POST") {
        return send(201, { id: runId++, body: (body as { body?: string }).body ?? "" });
      }
      if (req.method === "POST" && /\/pulls\/\d+\/requested_reviewers$/.test(path)) {
        return send(201, {});
      }
      if (req.method === "POST" && /\/code-scanning\/sarifs$/.test(path)) {
        return send(202, { id: "sarif" });
      }
      if (req.method === "POST" && path === "/api/v3/repos/o/r/pulls") {
        return send(201, {
          number: 5,
          node_id: "PR_5",
          html_url: "https://github.com/o/r/pull/5",
          head: { sha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821" },
        });
      }
      return send(404, { message: "Not Found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    seen,
    issues,
    projects,
    statusLog,
    deliveries,
    checkRuns,
    prHeads,
    checkRunWrites,
    limitNext: (n) => {
      limited = n;
    },
    edit: (n, patch) => {
      const cur = issues.get(n) ?? make(n, {});
      issues.set(n, { ...cur, ...patch, updated_at: tick() });
    },
  };
}

/** Headers of a webhook delivery GitHub signs with `secret`. */
export function signedDelivery(
  secret: string,
  event: string,
  delivery: string,
  body: string,
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    "x-github-event": event,
    "x-github-delivery": delivery,
  };
}

/**
 * A card built on its branch from `base`, verified, its passing evidence on
 * the ledger, in Review: as the runner leaves a card a person may accept.
 */
export async function builtInReview(
  repo: string,
  store: CardStore,
  id: string,
  files: Record<string, string>,
  base = "main",
  extra: Record<string, unknown> = {},
): Promise<void> {
  const adapter = new NodeGitSyncAdapter(repo);
  await store.createCard({
    id,
    tier: "story",
    title: `Card ${id}`,
    scopeFiles: ["src/**"],
    ...extra,
  });
  const wt = await adapter.createWorktree(id, base, `Card ${id}`);
  for (const [f, t] of Object.entries(files)) writeIn(wt, f, t);
  await adapter.commitCheckpoint({
    cardId: id,
    step: 1,
    gateStatus: "pass",
    agentModel: "nail",
    agentHarness: "sekhemet",
    agentRole: "implementer",
  });
  const evidence = {
    id: `ev_${id}`,
    cardId: id,
    attempt: 1,
    passed: true,
    rungResults: [
      {
        gate: "unit",
        rung: "test",
        layer: "functional",
        passed: true,
        exitCode: 0,
        durationMs: 12,
      },
    ],
    filesTouched: Object.keys(files),
    linesAdded: Object.keys(files).length,
    linesRemoved: 0,
    settings: { modelId: "nail" },
    stopReason: "gate_passed",
    repoState: await adapter.getRepoStateHash(id),
  };
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
  writeFileSync(join(repo, ".sekhemet", "evidence", `${evidence.id}.json`), body);
  await recordLedgerRun(store, {
    cardId: id,
    modelId: "nail",
    passed: true,
    stopReason: "gate_passed",
    evidenceId: evidence.id,
    path: join(".sekhemet", "evidence", `${evidence.id}.json`),
    body,
    filesTouched: evidence.filesTouched,
  });
  await store.updateCardStatus(id, "review", "verified", "harness", { override: true });
}
