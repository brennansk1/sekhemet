import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { type CardRecord, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import {
  DELEGATE_LABEL,
  GitHubClient,
  GitHubIssuesAdapter,
  NodeGitSyncAdapter,
  type SyncAdapter,
  intentFor,
  staticToken,
} from "@sekhemet/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AcceptRefusedError,
  acceptCard,
  accepterCheck,
  recordReviewOpened,
} from "../src/accept.js";
import { suggestedAccepters } from "../src/codeowners.js";
import { reviewPosterFromEnv, runExternalReview } from "../src/external_review.js";
import { egressRecorder, integrationFetch } from "../src/github_transport.js";
import { exportBoard, listIntegrations, syncGithub, writeSettings } from "../src/integrations.js";
import { cardBranchHead, ledgerEvidenceSummary, recordLedgerRun } from "../src/ledger_evidence.js";
import {
  advanceOpenPullRequests,
  mirrorAgentStatuses,
  runDependencyVerifications,
  syncViaAdapter,
} from "../src/wave2_github.js";
import {
  applyWebhookIntent,
  detectDeliveryGaps,
  handleWave2Route,
  startGithubSync,
} from "../src/wave2_server.js";

/**
 * integrations P9 and NEW-integrations-2, with review-git RG-N5-3/-4, end to
 * end: a real ledger on disk, real git repositories and a bare remote, a fake
 * `gh` on PATH (item 6: "tested against a fake gh"), and a local server
 * speaking GitHub's REST API with GitHub's documented example payloads
 * (`packages/sync/tests/fixtures/github/`, copied from GitHub's webhook and
 * REST documentation, not captured from live traffic). No request leaves the
 * machine.
 */
const fixtures = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "packages",
  "sync",
  "tests",
  "fixtures",
  "github",
);
const fixture = (name: string) => JSON.parse(readFileSync(join(fixtures, name), "utf8"));

let root: string;
let repo: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;
let holders: string[] | undefined;
const closers: (() => Promise<void>)[] = [];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const write = (base: string, rel: string, text: string) => {
  mkdirSync(dirname(join(base, rel)), { recursive: true });
  writeFileSync(join(base, rel), text);
};

function open(): void {
  db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db, holders ? { acceptHolders: () => holders ?? [] } : {});
  store = new CardStore(db, log);
}
function reopenWith(h: string[]): void {
  holders = h;
  db.close();
  open();
}

/**
 * A fake `gh`: `auth token` prints $FAKE_GH_TOKEN (or fails, not logged in).
 * Any other command fails: the repository comes from `git remote`, never `gh`.
 */
function fakeGh(bin: string): void {
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
}

/** A PATH holding git and node but no gh. */
function binWithoutGh(): string {
  const bin = join(root, "bin-nogh");
  mkdirSync(bin, { recursive: true });
  symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(bin, "git"));
  return bin;
}

interface Api {
  url: string;
  seen: { method: string; url: string; body: unknown; auth?: string }[];
  issues: Map<number, Record<string, unknown>>;
  edit: (n: number, patch: Record<string, unknown>) => void;
  /** Projects v2: each project's Status options, and the issues on it (INT-20b). */
  projects: { id: string; options: string[]; items: Map<number, string | undefined> }[];
  /** Each Status set, as "<project>:<option>", in order. */
  statusLog: string[];
  /** The App's webhook delivery log, newest first (INT-11b). */
  deliveries: Record<string, unknown>[];
  /** The check runs on any head (INT-12b, INT-37). */
  checkRuns: Record<string, unknown>[];
  /** A pull request's head as GitHub holds it (INT-16a). */
  prHeads: Map<number, string>;
  /** A pull request's author and head repository; a same-repository Dependabot PR when unset (M1). */
  prMeta: Map<number, { login: string; type: string; headRepo: string }>;
}

/** A GraphQL query, as the fake reads it: a read, not a write. */
const isGraphqlRead = (s: { url: string; body: unknown }) =>
  s.url === "/api/graphql" && /^\s*query/.test(String((s.body as { query?: string })?.query));
/** The GraphQL issue-page queries a sync sent (INT-11c). */
const issuePages = (api: Api) =>
  api.seen.filter(
    (s) => isGraphqlRead(s) && /issues\(first:/.test(String((s.body as { query: string }).query)),
  );

/** GitHub's REST API for o/r under GHES paths (`/api/v3`), issues held in memory. */
async function fakeGitHub(): Promise<Api> {
  const issues = new Map<number, Record<string, unknown>>();
  // GitHub's clock: every change is later than the last, and than now.
  let clock = Date.now() - 60_000;
  const tick = () => {
    clock = Math.max(clock + 1, Date.now());
    return new Date(clock).toISOString();
  };
  const seen: Api["seen"] = [];
  const projects: Api["projects"] = [];
  const statusLog: string[] = [];
  const deliveries: Api["deliveries"] = [];
  const checkRuns: Api["checkRuns"] = [{ status: "completed", conclusion: "success" }];
  const prHeads = new Map<number, string>();
  const prMeta: Api["prMeta"] = new Map();
  let points = 0;
  let next = 100;
  const make = (n: number, fields: Record<string, unknown>) => ({
    ...fixture("issue.json"),
    number: n,
    html_url: `https://github.com/o/r/issues/${n}`,
    assignee: null,
    assignees: [],
    labels: [],
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
      const send = (status: number, json: unknown, graphql = false) => {
        // GitHub meters REST and GraphQL apart, and says which in its headers.
        res.writeHead(status, {
          "content-type": "application/json",
          "x-ratelimit-resource": graphql ? "graphql" : "core",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": graphql ? String(5000 - points) : "4990",
        });
        res.end(JSON.stringify(json));
      };
      const path = url.replace(/\?.*$/, "");
      if (req.method === "POST" && path === "/api/graphql") {
        const q = String((body as { query?: string }).query ?? "");
        const vars = ((body as { variables?: Record<string, unknown> }).variables ?? {}) as Record<
          string,
          unknown
        >;
        points += 1;
        const rateLimit = { cost: 1, limit: 5000, remaining: 5000 - points, used: points };
        if (/issues\(first:/.test(q)) {
          const since = Date.parse(String(vars.since ?? "1970-01-01"));
          const nodes = [...issues.values()]
            .filter((i) => Date.parse(String(i.updated_at)) >= since)
            .map((i) => ({
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
          return send(
            200,
            {
              data: {
                rateLimit,
                repository: {
                  issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
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
        const meta = prMeta.get(n) ?? { login: "dependabot[bot]", type: "Bot", headRepo: "o/r" };
        return send(200, {
          number: n,
          node_id: `PR_${n}`,
          html_url: `https://github.com/o/r/pull/${n}`,
          user: { login: meta.login, type: meta.type },
          head: { sha: prHeads.get(n) ?? "0".repeat(40), repo: { full_name: meta.headRepo } },
          base: { ref: "main", repo: { full_name: "o/r" } },
        });
      }
      if (req.method === "GET" && path === "/api/v3/repos/o/r/issues") {
        // As GitHub does: only issues updated at or after `since`.
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
      if (req.method === "POST" && /\/pulls\/\d+\/requested_reviewers$/.test(path)) {
        return send(201, {});
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
    prMeta,
    edit: (n, patch) => {
      const cur = issues.get(n) ?? make(n, {});
      issues.set(n, { ...cur, ...patch, updated_at: tick() });
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sek-ghfirst-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Jane Doe");
  git(repo, "config", "user.email", "jane@example.com");
  write(repo, "src/a.ts", "export const a = 1;\n");
  write(repo, ".gitignore", ".sekhemet/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  // The GitHub repository is read from the remote locally, never asked of `gh`.
  git(repo, "remote", "add", "origin", "https://github.com/o/r.git");
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  vi.stubEnv("SEKHEMET_CONFIG_DIR", join(root, "config"));
  vi.stubEnv("SEKHEMET_USER_CONFIG", join(root, "config", "config.toml"));
  vi.stubEnv("SEKHEMET_KEYCHAIN", "off");
  for (const k of Object.keys(process.env).filter((x) => x.startsWith("SEKHEMET_GITHUB"))) {
    vi.stubEnv(k, "");
  }
  fakeGh(join(root, "bin"));
  vi.stubEnv("PATH", `${join(root, "bin")}:${process.env.PATH}`);
  vi.stubEnv("FAKE_GH_TOKEN", "gho_fake");
  holders = undefined;
  open();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  while (closers.length) await closers.pop()?.();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const byRef = async (id: string) =>
  (await store.listCards()).filter(
    (c) => c.externalRef?.system === "github" && c.externalRef.id === id,
  );
const conflicts = async () => (await log.getEventsByTypes(["sync/conflict"])).length;
const must = async (id: string): Promise<CardRecord> => {
  const c = await store.getCard(id);
  if (!c) throw new Error(`no card ${id}`);
  return c;
};

describe("INT-1: one card per issue, whichever path brings it", () => {
  it("the gh transport, the App adapter and a webhook all land on the one card o/r#1347", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    api.edit(1347, { title: "Found a bug", body: "I'm having a problem with this." });
    const viaGh = await syncGithub(repo, store, "both", log);
    expect(viaGh.errors).toEqual([]);
    expect(viaGh.created).toBe(1);

    const client = new GitHubClient(
      staticToken("app"),
      { apiUrl: `${api.url}/api/v3`, graphqlUrl: "" },
      { fetch },
    );
    const app = new GitHubIssuesAdapter({ owner: "o", repo: "r" }, client);
    const viaApp = await syncViaAdapter(app, store, log, "1970-01-01T00:00:00Z");
    expect(viaApp.created).toBe(0);

    const hook = fixture("webhook-issues-labeled.json");
    hook.repository.full_name = "o/r";
    hook.issue.html_url = "https://github.com/o/r/issues/1347";
    await applyWebhookIntent(store, intentFor("issues", hook), "d-1");

    const cards = await byRef("o/r#1347");
    expect(cards).toHaveLength(1);
    expect((await store.listCards()).filter((c) => c.externalRef)).toHaveLength(1);
    // The Worker tags a linked card's text as untrusted (S9); the card keeps it as written.
    expect(cards[0]?.spec).toBe("I'm having a problem with this.");
  });

  it("on the gh transport, the install's person is linked to the gh login once", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    await syncGithub(repo, store, "both", log);
    await syncGithub(repo, store, "both", log);
    expect(store.handleOf(store.localPrincipal(), "github")).toBe("jane-gh");
    expect(api.seen.filter((s) => s.url === "/api/v3/user")).toHaveLength(1);
  });

  it("security item 33: every GitHub request goes through the network policy and is recorded; offline refuses", async () => {
    vi.stubEnv("SEKHEMET_GITHUB_HOST", "https://ghes.example.invalid");
    const r = await syncGithub(repo, store, "both", log);
    expect(r.errors.join(" ")).toMatch(/network policy refused ghes\.example\.invalid/);
    // Offline by default: the refusal names the setting that would allow it.
    expect(r.errors.join(" ")).toMatch(/\[network\] mode/);
    const egress = await log.getEventsByTypes(["harness/egress"]);
    expect(egress.at(-1)?.payload).toMatchObject({
      host: "ghes.example.invalid",
      purpose: "integration:github",
      allowed: false,
    });
  });

  it("a card linked before the one ID (a bare number) is found and moved to owner/repo#n", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    api.edit(7, { title: "Old link" });
    const old = await store.createCard({
      tier: "task",
      title: "Old link",
      externalRef: { system: "github", id: "7", url: "https://github.com/o/r/issues/7" },
    });
    await syncGithub(repo, store, "both", log);
    expect((await must(old.id)).externalRef?.id).toBe("o/r#7");
    expect(await byRef("o/r#7")).toHaveLength(1);
  });
});

describe("M5: every request goes through the network policy, and its record is not optional", () => {
  it("a ledger that cannot record the request fails the request", async () => {
    const api = await fakeGitHub();
    const failing = {
      append: () => Promise.reject(new Error("ledger unavailable")),
    } as unknown as EventLog;
    const f = integrationFetch(repo, egressRecorder(failing), `${api.url}/api/v3`);
    await expect(f(`${api.url}/api/v3/user`)).rejects.toThrow(/ledger unavailable/);
  });

  it("Forgejo goes through the policy: refused offline, recorded", async () => {
    vi.stubEnv("SEKHEMET_FORGEJO_URL", "https://forgejo.example.invalid");
    vi.stubEnv("SEKHEMET_FORGEJO_TOKEN", "tok");
    vi.stubEnv("SEKHEMET_FORGEJO_REPO", "o/r");
    const r = await syncGithub(repo, store, "both", log);
    expect(r.errors.join(" ")).toMatch(/network policy refused forgejo\.example\.invalid/);
    const egress = await log.getEventsByTypes(["harness/egress"]);
    expect(egress.at(-1)?.payload).toMatchObject({
      host: "forgejo.example.invalid",
      purpose: "integration:forgejo",
      allowed: false,
    });
  });

  it("the external review's poster goes through the policy", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    writeFileSync(join(root, "key.pem"), privateKey);
    vi.stubEnv("SEKHEMET_GITHUB_APP_ID", "1");
    vi.stubEnv("SEKHEMET_GITHUB_INSTALLATION_ID", "2");
    vi.stubEnv("SEKHEMET_GITHUB_APP_KEY_PATH", join(root, "key.pem"));
    vi.stubEnv("SEKHEMET_GITHUB_HOST", "https://ghes.example.invalid");
    vi.stubEnv("SEKHEMET_GITHUB_REPO", "o/r");
    const poster = reviewPosterFromEnv(repo, log);
    await expect(poster?.client.rest("GET", "/x")).rejects.toThrow(
      /network policy refused ghes\.example\.invalid/,
    );
    expect((await log.getEventsByTypes(["harness/egress"])).at(-1)?.payload).toMatchObject({
      host: "ghes.example.invalid",
      allowed: false,
    });
  });
});

describe("offline by default: the setting is named", () => {
  it("the Integrations status says GitHub is blocked by network mode, and not once the mode allows it", async () => {
    const list = await listIntegrations(repo);
    expect(list.find((i) => i.id === "github")?.detail).toMatch(/blocked by network mode/);
    expect(list.find((i) => i.id === "github")?.detail).toMatch(/\[network\] mode/);
    expect(list.find((i) => i.id === "github-pr")?.detail).toMatch(/blocked by network mode/);
    write(root, "config/config.toml", '[network]\nmode = "open"\n');
    const open = await listIntegrations(repo);
    expect(open.find((i) => i.id === "github")?.detail).not.toMatch(/blocked/);
    expect(open.find((i) => i.id === "github")?.detail).toBe("o/r");
  });
});

describe("B2: logins and issue text stay off the chain", () => {
  it("a snapshot keeps its ref, updatedAt and hashes public and the rest private; erasing leaves no copy of a login", async () => {
    const me = store.localPrincipal();
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    await store.linkIdentity(me, "github", "alice-gh", me);
    api.edit(8, { title: "Private title", body: "Private body", assignee: { login: "alice-gh" } });
    await syncGithub(repo, store, "both", log);
    api.edit(8, { assignee: { login: "stranger-gh" } });
    await syncGithub(repo, store, "both", log);
    const hook = fixture("webhook-issues-labeled.json");
    hook.issue.assignee = { login: "alice-gh" };
    await applyWebhookIntent(store, intentFor("issues", hook), "d-b2");
    const snaps = await log.getEventsByTypes(["sync/snapshot"]);
    expect(snaps.length).toBeGreaterThan(1);
    for (const e of snaps) {
      expect(Object.keys(e.payload as object).sort()).toEqual([
        "agreedHash",
        "boardOwner",
        "itemHash",
        "ref",
        "updatedAt",
        "worker",
      ]);
      expect(JSON.stringify(e.payload)).not.toMatch(/alice-gh|Private title|Private body/);
    }
    expect(await conflicts()).toBe(1);
    const ids = (
      db.prepare("SELECT event_id AS id FROM event_private").all() as { id: string }[]
    ).map((r) => r.id);
    await log.erase({ eventIds: ids, reason: "erasure", principal: me });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];
    for (const { name } of tables) {
      const rows = JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all());
      expect(rows, name).not.toContain("alice-gh");
      expect(rows, name).not.toContain("stranger-gh");
    }
    // An erased snapshot is no base, not an error: the sync goes on.
    expect((await syncGithub(repo, store, "both", log)).errors).toEqual([]);
  });
});

describe("M6: the sync's direction is honoured", () => {
  // A GraphQL query is a read, though it is a POST (INT-11c).
  const writes = (api: Api) =>
    api.seen.filter((s) => s.method !== "GET" && !isGraphqlRead(s)).length;

  it("pull takes the tracker's changes, pushes nothing and opens no issue", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    api.edit(11, { title: "Tracker", body: "Before" });
    await syncGithub(repo, store, "both", log);
    const [card] = await byRef("o/r#11");
    const id = card?.id as string;
    await store.updateCard(id, { title: "Board edit" });
    api.edit(11, { body: "Tracker body" });
    await store.createCard({ tier: "task", title: "Local only" });
    const before = writes(api);
    const r = await syncGithub(repo, store, "pull", log);
    expect(r.errors).toEqual([]);
    expect(writes(api)).toBe(before);
    expect((await must(id)).spec).toBe("Tracker body");
    expect((await must(id)).title).toBe("Board edit");
    // The board's edit waits for a sync that sends.
    await syncGithub(repo, store, "both", log);
    expect(api.issues.get(11)?.title).toBe("Board edit");
    expect(await conflicts()).toBe(0);
  });

  it("push sends the board's changes and changes nothing on the board", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    api.edit(12, { title: "T", body: "Before" });
    await syncGithub(repo, store, "both", log);
    const [card] = await byRef("o/r#12");
    const id = card?.id as string;
    api.edit(12, { body: "Tracker body" });
    api.edit(13, { title: "New on the tracker" });
    await store.updateCard(id, { title: "Board title" });
    const cards = (await store.listCards()).length;
    const r = await syncGithub(repo, store, "push", log);
    expect(r.errors).toEqual([]);
    expect(api.issues.get(12)?.title).toBe("Board title");
    expect((await must(id)).spec).toBe("Before");
    expect((await store.listCards()).length).toBe(cards);
    // The tracker's changes wait for a sync that takes them.
    await syncGithub(repo, store, "both", log);
    expect((await must(id)).spec).toBe("Tracker body");
    expect(await byRef("o/r#13")).toHaveLength(1);
    expect(await conflicts()).toBe(0);
  });
});

describe("INT-11e: pushing deeper than the tracker nests", () => {
  it("writes no item deeper than maxDepth, links a deeper card to its nearest written ancestor, and reports the clamp", async () => {
    // A tracker with no hierarchy (Forgejo declares maxDepth 1); the board nests a subtask.
    const pushed: string[] = [];
    const flat: SyncAdapter = {
      system: "forgejo",
      capabilities: { hierarchy: false, dependencies: true, webhooks: true, maxDepth: 1 },
      pull: async () => [],
      push: async (c) => {
        pushed.push(c.title);
        return { system: "forgejo", id: String(pushed.length), url: `f/${pushed.length}` };
      },
      update: async () => undefined,
    };
    const story = await store.createCard({ tier: "story", title: "Story" });
    const sub = await store.createCard({ tier: "task", title: "Sub", parentId: story.id });
    const r = await syncViaAdapter(flat, store, log, "1970-01-01T00:00:00Z");
    expect(r.errors).toEqual([]);
    expect(r.clamped).toEqual([{ id: sub.id, ancestor: story.id }]);
    expect(pushed).toEqual(["Story"]);
    expect((await must(sub.id)).externalRef).toBeUndefined();
    const [link] = await store.cardEvents(sub.id, ["sync/clamped"]);
    expect(link?.payload).toEqual({ id: sub.id, ancestor: story.id, ref: "1", maxDepth: 1 });
    // Linked once; the next sync still reports it and writes nothing new.
    const again = await syncViaAdapter(flat, store, log, "1970-01-01T00:00:00Z");
    expect(again.clamped).toEqual([{ id: sub.id, ancestor: story.id }]);
    expect(await store.cardEvents(sub.id, ["sync/clamped"])).toHaveLength(1);
    expect(pushed).toEqual(["Story"]);
  });
});

describe("M1/M2: labels", () => {
  it("M1: a delegate change pushes the merged labels, keeping a label the tracker added", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    api.edit(10, { title: "Labels", labels: [{ name: "a" }] });
    await syncGithub(repo, store, "both", log);
    const [card] = await byRef("o/r#10");
    const id = card?.id as string;
    api.edit(10, { labels: [{ name: "a" }, { name: "b" }] });
    await store.delegateCard(id, { kind: "worker" }, store.localPrincipal());
    await syncGithub(repo, store, "both", log);
    const names = (api.issues.get(10)?.labels as { name: string }[]).map((l) => l.name).sort();
    expect(names).toEqual(["a", "b", DELEGATE_LABEL]);
    expect([...((await must(id)).labels ?? [])].sort()).toEqual(["a", "b"]);
  });

  it("M2: a webhook's card carries the issue's labels in its snapshot; the sub-issues note is never synced", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    const hook = fixture("webhook-issues-labeled.json");
    hook.repository.full_name = "o/r";
    hook.issue.html_url = "https://github.com/o/r/issues/1347";
    hook.issue.labels = [{ name: "sekhemet" }, { name: "bug" }];
    hook.issue.sub_issues = [{ number: 1348 }];
    hook.issue.assignee = null;
    const id = (await applyWebhookIntent(store, intentFor("issues", hook), "d-m2")) as string;
    expect([...((await must(id)).labels ?? [])].sort()).toEqual([
      "bug",
      "sekhemet",
      "sub-issues:1348",
    ]);
    // GitHub holds the same issue; nothing changed on either side since.
    api.edit(1347, {
      title: hook.issue.title,
      body: hook.issue.body,
      labels: hook.issue.labels,
      html_url: hook.issue.html_url,
    });
    await syncGithub(repo, store, "both", log);
    expect(api.seen.filter((s) => s.method === "PATCH")).toEqual([]);
    expect(await conflicts()).toBe(0);
    expect((await must(id)).labels).toContain("sub-issues:1348");
    // A board label is pushed without the sub-issues note.
    await store.updateCard(id, { labels: [...((await must(id)).labels ?? []), "ui"] });
    await syncGithub(repo, store, "both", log);
    const pushed = api.seen.find((s) => s.method === "PATCH")?.body as { labels: string[] };
    expect([...pushed.labels].sort()).toEqual(["bug", "sekhemet", "ui"]);
    expect((await must(id)).labels).toContain("sub-issues:1348");
  });
});

describe("INT-3/4/5/7: the sync is idempotent and merges three ways", () => {
  it("INT-3: a second sync with no change reports nothing created or updated and no conflict", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    api.edit(1, { title: "One" });
    await store.createCard({ tier: "task", title: "Board card", spec: "From the board." });
    const first = await syncGithub(repo, store, "both", log);
    expect(first.created).toBe(2); // one pulled, one pushed
    // A GraphQL query is a read, though it is a POST (INT-11c).
    const writeCount = () => api.seen.filter((s) => s.method !== "GET" && !isGraphqlRead(s)).length;
    const writes = writeCount();
    const second = await syncGithub(repo, store, "both", log);
    expect(second).toMatchObject({ created: 0, updated: 0, errors: [] });
    expect(writeCount()).toBe(writes);
    expect(await conflicts()).toBe(0);
  });

  it("INT-4: the tracker's title wins when only the tracker changed it, even after a board move", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    api.edit(2, { title: "Before" });
    await syncGithub(repo, store, "both", log);
    const [card] = await byRef("o/r#2");
    await store.updateCardStatus(card?.id as string, "ready", "planned", "human", {
      override: true,
    });
    api.edit(2, { title: "After, edited in GitHub" });
    await syncGithub(repo, store, "both", log);
    expect((await must(card?.id as string)).title).toBe("After, edited in GitHub");
    expect(await conflicts()).toBe(0);
  });

  it("INT-5: a title changed only on the board is pushed to the tracker", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    api.edit(3, { title: "Tracker title" });
    await syncGithub(repo, store, "both", log);
    const [card] = await byRef("o/r#3");
    await store.updateCard(card?.id as string, { title: "Board title" });
    await syncGithub(repo, store, "both", log);
    expect(api.issues.get(3)?.title).toBe("Board title");
    expect(await conflicts()).toBe(0);
  });

  it("INT-7: a title edited while the card runs is applied when the card leaves the run", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    api.edit(4, { title: "Running" });
    await syncGithub(repo, store, "both", log);
    const [card] = await byRef("o/r#4");
    const id = card?.id as string;
    await store.updateCardStatus(id, "in_progress", "run", "harness", { override: true });
    api.edit(4, { title: "Renamed mid-run" });
    await syncGithub(repo, store, "both", log);
    expect((await must(id)).title).toBe("Running");
    await store.updateCardStatus(id, "review", "gates passed", "harness", { override: true });
    await syncGithub(repo, store, "both", log);
    expect((await must(id)).title).toBe("Renamed mid-run");
  });
});

describe("INT-9: a redelivered webhook changes nothing", () => {
  it("answers 202 and creates nothing the second time, across a restart", async () => {
    const secret = "hook";
    const serve = async () => {
      const server = createServer((req, res) => {
        void handleWave2Route(req, res, req.url ?? "", {
          repoPath: repo,
          cardStore: store,
          log,
          json: (r, status, body) => r.writeHead(status).end(JSON.stringify(body)),
          isTrustedMutation: () => false,
          readJsonBody: async () => ({}),
          webhookSecret: secret,
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      closers.push(() => new Promise<void>((r) => server.close(() => r())));
      return (server.address() as AddressInfo).port;
    };
    const body = JSON.stringify(fixture("webhook-issues-labeled.json"));
    const { createHmac } = await import("node:crypto");
    const headers = {
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      "x-github-event": "issues",
      "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    };
    const post = (port: number) =>
      new Promise<number>((resolve) => {
        const req = request(
          { host: "127.0.0.1", port, method: "POST", path: "/webhooks/github", headers },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.end(body);
      });
    expect(await post(await serve())).toBe(202);
    const events = log.lastSeq();
    db.close();
    open(); // a restart: the delivery is remembered on the ledger, not in memory
    expect(await post(await serve())).toBe(202);
    expect(log.lastSeq()).toBe(events);
    expect(await byRef("octo-org/octo-repo#1347")).toHaveLength(1);
  });
});

describe("NEW-integrations-2: owner and delegate on GitHub; independence from the ledger", () => {
  const alice = "p_alice";
  const bob = "p_bob";
  const carol = "p_carol";

  it("INT-36: the owner's login is the assignee and the Worker a label, never 'worker' as a user", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    await store.linkIdentity(alice, "github", "alice-gh", alice);
    const card = await store.createCard({ tier: "task", title: "Delegated" });
    await store.changeOwner(card.id, alice, alice);
    await store.delegateCard(card.id, { kind: "worker" }, alice);
    await syncGithub(repo, store, "both", log);
    const created = api.seen.find(
      (s) => s.method === "POST" && s.url === "/api/v3/repos/o/r/issues",
    )?.body as {
      assignees: string[];
      labels: string[];
    };
    expect(created.assignees).toEqual(["alice-gh"]);
    expect(created.labels).toContain(DELEGATE_LABEL);
    expect(JSON.stringify(api.seen.map((s) => s.body))).not.toMatch(/"assignees":\["worker"\]/);
    expect(await conflicts()).toBe(0);
  });

  it("INT-36: exports write the delegate as a label and the owner's login as a GitHub assignee, never 'worker'", async () => {
    await store.linkIdentity(alice, "github", "alice-gh", alice);
    const card = await store.createCard({ tier: "task", title: "Exported", labels: ["ui"] });
    await store.changeOwner(card.id, alice, alice);
    await store.delegateCard(card.id, { kind: "worker" }, alice);
    const cards = await store.listCards();
    const people = { handleOf: (p: string, sys: string) => store.handleOf(p, sys) };
    const gh = JSON.parse(exportBoard(cards, [], "github-json", people).body) as {
      assignees: string[];
      labels: string[];
    }[];
    expect(gh[0]?.assignees).toEqual(["alice-gh"]);
    expect(gh[0]?.labels).toEqual(["ui", DELEGATE_LABEL]);
    for (const format of ["jira-csv", "linear-csv"] as const) {
      const body = exportBoard(cards, [], format, people).body;
      expect(body).toContain(DELEGATE_LABEL);
      expect(body).not.toMatch(/(^|[,\s"])worker([,\s"]|$)/m);
    }
    const raw = exportBoard(cards, [], "json", people).body;
    expect(raw).not.toContain('"assignee": "worker"');
  });

  it("INT-40: a tracker reassignment changes the owner, the delegator still may not accept, the new owner may", async () => {
    reopenWith([alice, bob, carol]);
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    await store.linkIdentity(alice, "github", "alice-gh", alice);
    await store.linkIdentity(bob, "github", "bob-gh", bob);
    const card = await store.createCard({ tier: "task", title: "Reassigned" });
    await store.changeOwner(card.id, alice, alice);
    await store.delegateCard(card.id, { kind: "worker" }, alice);
    await syncGithub(repo, store, "both", log);
    const n = Number(String((await must(card.id)).externalRef?.id).split("#")[1]);
    api.edit(n, { assignee: { login: "bob-gh" } });
    await syncGithub(repo, store, "both", log);
    expect((await must(card.id)).owner).toBe(bob);
    const refused = await accepterCheck(store, card.id, alice).catch((e: unknown) => e);
    expect((refused as AcceptRefusedError).code).toBe("not_independent");
    expect((refused as Error).message).toContain(bob);
    expect(await accepterCheck(store, card.id, bob)).toEqual({ independent: true });
    // The tracker's assignee stays the owner's login: nothing pushes it back.
    expect((api.issues.get(n)?.assignee as { login: string }).login).toBe("bob-gh");
  });

  it("INT-41: an assignee who maps to no principal leaves the owner and records a conflict naming them", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    await store.linkIdentity(alice, "github", "alice-gh", alice);
    const card = await store.createCard({ tier: "task", title: "Stranger" });
    await store.changeOwner(card.id, alice, alice);
    await syncGithub(repo, store, "both", log);
    const n = Number(String((await must(card.id)).externalRef?.id).split("#")[1]);
    api.edit(n, { assignee: { login: "stranger-gh" } });
    await syncGithub(repo, store, "both", log);
    expect((await must(card.id)).owner).toBe(alice);
    const recorded = await log.getEventsByTypes(["sync/conflict"]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.payload).toMatchObject({ field: "assignee", reason: "unmapped" });
    expect(recorded[0]?.private).toEqual({ assignee: "stranger-gh" });
    // Recorded once, not on every sync; and the person's assignment is not pushed back over.
    await syncGithub(repo, store, "both", log);
    expect(await conflicts()).toBe(1);
    expect((api.issues.get(n)?.assignee as { login: string }).login).toBe("stranger-gh");
  });
});

// ------------------------------------------------------ Accept with a pull request

let board: BoardServiceImpl;
let upstream: string;

/** A card built on its branch from develop, verified, with its evidence on the ledger, in Review. */
async function inReview(
  id: string,
  files: Record<string, string>,
  base = "develop",
): Promise<void> {
  const adapter = new NodeGitSyncAdapter(repo);
  await store.createCard({ id, tier: "story", title: `Card ${id}`, scopeFiles: ["src/**"] });
  const wt = await adapter.createWorktree(id, base, `Card ${id}`);
  for (const [f, t] of Object.entries(files)) write(wt, f, t);
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
const ctx = () => ({ repoPath: repo, cardStore: store, boardService: board });
const opened = async (id: string, principal?: string) =>
  recordReviewOpened(ctx(), await must(id), ["src/b.ts"], principal);

describe("INT-12/12a/15/39: Accept opens a draft pull request and the card waits for its merge", () => {
  beforeEach(() => {
    upstream = join(root, "upstream.git");
    execFileSync("git", ["init", "-q", "--bare", upstream]);
    git(repo, "remote", "add", "upstream", upstream);
    git(repo, "branch", "develop");
    write(
      repo,
      ".sekhemet/config.toml",
      '[review]\nintegration_branch = "develop"\nremote = "upstream"\n',
    );
    board = new BoardServiceImpl(store, { entryConditions: true, customLimits: { review: 5 } });
    writeSettings(repo, { githubPrOnAccept: true });
  });

  it("INT-12, INT-12a, INT-39: pushes to the configured remote, opens a draft against develop with the evidence, names the accepter", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    await inReview("p1", { "src/b.ts": "export const b = 2;\n" });
    await opened("p1");
    const url = await acceptCard(ctx(), await must("p1"));
    expect(url).toBe("https://github.com/o/r/pull/5");
    const pr = api.seen.find((s) => s.url === "/api/v3/repos/o/r/pulls")?.body as {
      head: string;
      base: string;
      draft: boolean;
      body: string;
    };
    expect(pr).toMatchObject({ base: "develop", draft: true });
    expect(pr.body).toContain("### Gates\n- pass unit (12 ms)");
    expect(pr.body).toContain("### Coverage");
    expect(pr.body).toContain("### Tried and abandoned");
    expect(pr.body).toContain("Accepted by Jane Doe");
    // The accepter's display name, never their email.
    expect(pr.body).not.toContain("jane@example.com");
    expect(git(repo, "ls-remote", "upstream")).toContain(`refs/heads/${pr.head}`);
    // The push was decided by the policy and recorded, like every request.
    const pushes = (await log.getEventsByTypes(["harness/egress"]))
      .map((e) => ({
        ...(e.payload as { allowed: boolean; purpose: string; url?: string }),
        // The URL is the event's private part; the chain holds only its hash.
        url: (e.private as { url: string }).url,
        inPayload: (e.payload as { url?: string }).url,
      }))
      .filter((p) => p.url.includes("upstream.git"));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ allowed: true, purpose: "integration:github" });
    expect(pushes[0]?.inPayload).toBeUndefined();
    const card = await must("p1");
    expect(card.status).toBe("review");
    expect(card.hold).toMatchObject({ kind: "awaitingMerge", pr: 5 });
  });

  it("INT-12b: on the gh transport, once every check passes the draft is marked ready and the code owners asked to review", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    git(repo, "checkout", "-q", "develop");
    write(repo, ".github/CODEOWNERS", "/src/ @alice-gh @octo-org/reviewers\n");
    git(repo, "add", ".github/CODEOWNERS");
    git(repo, "commit", "-q", "-m", "owners");
    git(repo, "checkout", "-q", "main");
    await inReview("p7", { "src/b.ts": "export const b = 2;\n" });
    await opened("p7");
    await acceptCard(ctx(), await must("p7"));
    expect(await advanceOpenPullRequests(repo, store, log)).toEqual([
      { number: 5, state: "ready" },
    ]);
    const ready = api.seen.find((s) => s.url === "/api/graphql" && !isGraphqlRead(s));
    expect(JSON.stringify(ready?.body)).toContain("markPullRequestReadyForReview");
    expect(api.seen.find((s) => s.url.endsWith("/requested_reviewers"))?.body).toEqual({
      reviewers: ["alice-gh"],
      team_reviewers: ["reviewers"],
    });
    // Advanced once: the next pass asks GitHub nothing.
    const asked = api.seen.length;
    expect(await advanceOpenPullRequests(repo, store, log)).toEqual([]);
    expect(api.seen.length).toBe(asked);
  });

  it("M4: a declared blocking check not passing at the PR's current head keeps it from ready and from auto-merge", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    vi.stubEnv("SEKHEMET_GITHUB_AUTOMERGE", "1");
    write(
      repo,
      ".sekhemet/config.toml",
      '[review]\nintegration_branch = "develop"\nremote = "upstream"\nblocking_checks = ["ci/build"]\n',
    );
    await inReview("p8", { "src/b.ts": "export const b = 2;\n" });
    await opened("p8");
    await acceptCard(ctx(), await must("p8"));
    const head = "ec26c3e57ca3a959ca5aad62de7213c562f8c821";
    api.prHeads.set(5, head);
    const writes = () => api.seen.filter((s) => s.url === "/api/graphql" && !isGraphqlRead(s));
    const own = {
      name: "sekhemet/unit",
      status: "completed",
      conclusion: "success",
      head_sha: head,
    };
    const build = (conclusion: string, at: string, n: number) => ({
      name: "ci/build",
      status: "completed",
      conclusion,
      head_sha: at,
      html_url: `https://ci.example.test/run/${n}`,
    });
    // Declared but not reported: every run there is passes, and still it waits.
    api.checkRuns.splice(0, api.checkRuns.length, own);
    expect(await advanceOpenPullRequests(repo, store, log)).toEqual([
      { number: 5, state: "waiting" },
    ]);
    // Declared and failing.
    api.checkRuns.splice(0, api.checkRuns.length, own, build("failure", head, 1));
    expect(await advanceOpenPullRequests(repo, store, log)).toEqual([
      { number: 5, state: "failing" },
    ]);
    // Passing at the head Sekhemet opened, but the PR's head has moved: no evidence for it.
    const moved = "f".repeat(40);
    api.prHeads.set(5, moved);
    api.checkRuns.splice(0, api.checkRuns.length, own, build("success", head, 2));
    expect(await advanceOpenPullRequests(repo, store, log)).toEqual([
      { number: 5, state: "waiting" },
    ]);
    expect(writes()).toEqual([]);
    // Passing at the current head: ready, and auto-merge pinned to that head.
    api.prHeads.set(5, head);
    expect(await advanceOpenPullRequests(repo, store, log)).toEqual([
      { number: 5, state: "auto_merge" },
    ]);
    const merge = writes().find((s) =>
      /enablePullRequestAutoMerge/.test(String((s.body as { query?: string }).query)),
    );
    expect((merge?.body as { variables: unknown }).variables).toMatchObject({ id: "PR_5", head });
  });

  it("B1: offline, nothing is pushed: the API host is refused before any push, and the refusal names the setting", async () => {
    vi.stubEnv("SEKHEMET_GITHUB_HOST", "https://ghes.example.invalid");
    await inReview("p5", { "src/b.ts": "export const b = 2;\n" });
    await opened("p5");
    const err = await acceptCard(ctx(), await must("p5")).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/network policy refused ghes\.example\.invalid/);
    expect((err as Error).message).toMatch(/\[network\] mode/);
    expect(git(repo, "ls-remote", "upstream")).toBe("");
    const card = await must("p5");
    expect(card.status).toBe("review");
    expect(card.hold).toBeUndefined();
  });

  it("B1: a remote on a host the policy refuses is not pushed to; the refusal is recorded as harness/egress", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    git(repo, "remote", "set-url", "upstream", "https://git.example.invalid/o/r.git");
    await inReview("p6", { "src/b.ts": "export const b = 2;\n" });
    await opened("p6");
    const err = await acceptCard(ctx(), await must("p6")).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/network policy refused git\.example\.invalid/);
    expect((err as Error).message).toMatch(/\[network\] mode/);
    expect((await log.getEventsByTypes(["harness/egress"])).at(-1)?.payload).toMatchObject({
      host: "git.example.invalid",
      purpose: "integration:github",
      allowed: false,
    });
    expect(api.seen.filter((s) => s.url.endsWith("/pulls"))).toEqual([]);
    expect((await must("p6")).status).toBe("review");
  });

  it("INT-15: without gh, Accept says gh is not installed and the card stays in Review, nothing pushed", async () => {
    vi.stubEnv("PATH", binWithoutGh());
    await inReview("p2", { "src/b.ts": "export const b = 2;\n" });
    await opened("p2");
    const err = await acceptCard(ctx(), await must("p2")).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/gh CLI is not installed/);
    const card = await must("p2");
    expect(card.status).toBe("review");
    expect(card.hold).toBeUndefined();
    expect(git(repo, "ls-remote", "upstream")).toBe("");
  });

  it("INT-15: with gh logged out, Accept says so and the card stays in Review", async () => {
    vi.stubEnv("FAKE_GH_TOKEN", "");
    await inReview("p3", { "src/b.ts": "export const b = 2;\n" });
    await opened("p3");
    const err = await acceptCard(ctx(), await must("p3")).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/gh is not logged in/);
    expect((await must("p3")).status).toBe("review");
    expect(git(repo, "ls-remote", "upstream")).toBe("");
  });
});

describe("INT-13/14: the pull request's close, from its webhook", () => {
  const bob = "p_bob";
  async function awaiting(id: string, accepter: string): Promise<void> {
    await store.createCard({ id, tier: "task", title: id });
    await store.updateCardStatus(id, "review", "verified", "harness", { override: true });
    await store.recordPullRequestOpened(id, {
      pr: 5,
      url: "https://github.com/octo-org/octo-repo/pull/5",
      headSha: "h",
      accepter,
    });
  }

  it("INT-13: merged, the card is Done with the merge commit and the merger recorded", async () => {
    await store.linkIdentity(bob, "github", "hubot", bob);
    await awaiting("m1", store.localPrincipal());
    const hook = fixture("webhook-pull_request-closed.json");
    await applyWebhookIntent(store, intentFor("pull_request", hook), "d-merge");
    expect((await must("m1")).status).toBe("done");
    const [closed] = await store.cardEvents("m1", ["card/pr_closed"]);
    expect(closed?.payload).toMatchObject({
      merged: true,
      mergeCommit: "c4295bd74fb0f4fda03689c3df3f2803b658fd85",
      closedBy: bob,
    });
  });

  it("INT-14: closed unmerged, the hold and accepter clear, the card counts in Review again, the closer recorded", async () => {
    await awaiting("m2", store.localPrincipal());
    const hook = fixture("webhook-pull_request-closed.json");
    hook.pull_request.merged = false;
    hook.pull_request.merged_at = null;
    hook.pull_request.merge_commit_sha = null;
    hook.pull_request.merged_by = null;
    hook.sender.login = "octocat";
    await applyWebhookIntent(store, intentFor("pull_request", hook), "d-close");
    const card = await must("m2");
    expect(card.status).toBe("review");
    expect(card.hold).toBeUndefined();
    expect(card.accepter).toBeUndefined();
    const [closed] = await store.cardEvents("m2", ["card/pr_closed"]);
    expect(closed?.payload).toEqual({ id: "m2", pr: 5, merged: false });
    expect(closed?.private).toEqual({ closedByHandle: "octocat" });
  });

  it("M3: a close in another repository with the same number moves nothing", async () => {
    await awaiting("m3", store.localPrincipal());
    const hook = fixture("webhook-pull_request-closed.json");
    hook.repository.full_name = "someone/else";
    hook.pull_request.html_url = "https://github.com/someone/else/pull/5";
    expect(await applyWebhookIntent(store, intentFor("pull_request", hook), "d-other")).toBe(
      undefined,
    );
    const card = await must("m3");
    expect(card.status).toBe("review");
    expect(card.hold).toMatchObject({ kind: "awaitingMerge", pr: 5 });
  });
});

describe("RG-N5-3/-4: CODEOWNERS suggest accepters, and may be required", () => {
  const alice = "p_alice";
  const bob = "p_bob";
  const codeowners = "* @carol-gh\n/src/ @alice-gh @octo-org/reviewers\n/docs/ @bob-gh\n";
  /** CODEOWNERS committed on `branch`: what the integration branch says, not the working tree. */
  const commitCodeowners = (branch: string, text: string) => {
    const back = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
    if (branch !== back) git(repo, "checkout", "-q", branch);
    write(repo, ".github/CODEOWNERS", text);
    git(repo, "add", ".github/CODEOWNERS");
    git(repo, "commit", "-q", "-m", "codeowners");
    if (branch !== back) git(repo, "checkout", "-q", back);
  };

  it("RG-N5-3: suggested accepters come from the last matching pattern for each file in scope", async () => {
    commitCodeowners("main", codeowners);
    await store.linkIdentity(alice, "github", "alice-gh", alice);
    const card = await store.createCard({ tier: "task", title: "S", scopeFiles: ["src/a.ts"] });
    expect(suggestedAccepters(repo, store, card)).toEqual({
      principals: [alice],
      unmapped: ["@octo-org/reviewers"],
    });
    const none = await store.createCard({ tier: "task", title: "N" });
    expect(suggestedAccepters(repo, store, none)).toEqual({ principals: [], unmapped: [] });
  });

  it("RG-N5-3: CODEOWNERS is read from the integration branch, not the working tree", async () => {
    write(repo, ".sekhemet/config.toml", '[review]\nintegration_branch = "develop"\n');
    git(repo, "branch", "develop");
    commitCodeowners("develop", codeowners);
    write(repo, ".github/CODEOWNERS", "* @mallory-gh\n");
    await store.linkIdentity(alice, "github", "alice-gh", alice);
    const card = await store.createCard({ tier: "task", title: "B", scopeFiles: ["src/a.ts"] });
    expect(suggestedAccepters(repo, store, card)).toEqual({
      principals: [alice],
      unmapped: ["@octo-org/reviewers"],
    });
  });

  it("RG-N5-4: with code-owner acceptance required, a principal who owns none of the card's files is refused; an owner accepts", async () => {
    reopenWith([alice, bob]);
    board = new BoardServiceImpl(store, { entryConditions: true, customLimits: { review: 5 } });
    git(repo, "branch", "develop");
    commitCodeowners("develop", codeowners);
    write(
      repo,
      ".sekhemet/config.toml",
      '[review]\nintegration_branch = "develop"\nrequire_code_owner_accept = true\n',
    );
    await store.linkIdentity(alice, "github", "alice-gh", alice);
    await store.linkIdentity(bob, "github", "bob-gh", bob);
    await inReview("o1", { "src/b.ts": "export const b = 2;\n" });
    for (const p of [alice, bob]) await opened("o1", p);
    const err = await acceptCard(ctx(), await must("o1"), "human", { principal: bob }).catch(
      (e: unknown) => e,
    );
    expect((err as AcceptRefusedError).code).toBe("not_code_owner");
    expect((err as Error).message).toContain(alice);
    await acceptCard(ctx(), await must("o1"), "human", { principal: alice });
    expect((await must("o1")).status).toBe("done");
  });
});

// ------------------------------------------------------------- B4.9 part 2

/** The App on the fake's GHES paths, with a real RSA key (INT-11b). */
function useApp(api: Api): void {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  writeFileSync(join(root, "app.pem"), privateKey);
  vi.stubEnv("SEKHEMET_GITHUB_APP_ID", "1");
  vi.stubEnv("SEKHEMET_GITHUB_INSTALLATION_ID", "2");
  vi.stubEnv("SEKHEMET_GITHUB_APP_KEY_PATH", join(root, "app.pem"));
  vi.stubEnv("SEKHEMET_GITHUB_REPO", "o/r");
  vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
}

/** The dashboard's webhook route on a port, and a signed POST to it. */
async function hookRoute(secret: string, extra: { gapCheckEveryMs?: number } = {}) {
  const { createHmac } = await import("node:crypto");
  const server = createServer((req, res) => {
    void handleWave2Route(req, res, req.url ?? "", {
      repoPath: repo,
      cardStore: store,
      log,
      json: (r, status, body) => r.writeHead(status).end(JSON.stringify(body)),
      isTrustedMutation: () => false,
      readJsonBody: async () => ({}),
      webhookSecret: secret,
      ...extra,
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as AddressInfo).port;
  return (event: string, delivery: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    return new Promise<number>((resolve) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/webhooks/github",
          headers: {
            "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
            "x-github-event": event,
            "x-github-delivery": delivery,
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.end(body);
    });
  };
}

describe("INT-11c: issues come a page at a time through GraphQL, on GraphQL's own budget", () => {
  it("one query per page brings the issues with their labels and sub-issues; the budgets are apart", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    api.edit(40, { title: "Parent", labels: [{ name: "epic" }], sub_issues: [41, 42] });
    api.edit(41, { title: "Child one" });
    api.edit(42, { title: "Child two" });
    const r = await syncGithub(repo, store, "pull", log);
    expect(r.errors).toEqual([]);
    expect(r.created).toBe(3);
    // One GraphQL query for the page; no REST issue list and no call per issue.
    expect(issuePages(api)).toHaveLength(1);
    expect(api.seen.filter((s) => /\/issues(\/|\?|$)/.test(s.url) && s.method === "GET")).toEqual(
      [],
    );
    expect((await byRef("o/r#40"))[0]?.labels).toEqual(["epic"]);
    // The sub-issues arrived in the same query: the snapshot holds them.
    const snap = (await log.getEventsByTypes(["sync/snapshot"])).find(
      (e) => (e.payload as { ref: { id: string } }).ref.id === "o/r#40",
    );
    expect((snap?.private as { item: { subIssues: string[] } }).item.subIssues).toEqual([
      "o/r#41",
      "o/r#42",
    ]);
    // GraphQL's points are counted apart from REST's requests (the `gh` login's /user is REST).
    expect(r.budget?.graphql).toMatchObject({ requests: 1, spent: 1, limit: 5000 });
    expect(r.budget?.rest.requests).toBe(1);
    expect(r.budget?.rest.remaining).toBe(4990);
  });
});

describe("INT-11b: webhooks first; a pull only to catch up", () => {
  it("at server start with a webhook route, one catch-up pull takes what changed while it was down, and nothing polls on a timer", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    api.edit(50, { title: "Before the restart" });
    await syncGithub(repo, store, "both", log);
    const [card] = await byRef("o/r#50");
    api.edit(50, { title: "Edited while the server was down" });
    vi.stubEnv("SEKHEMET_GITHUB_WEBHOOK_SECRET", "hook");
    const pagesBefore = issuePages(api).length;
    const sync = startGithubSync(repo, store, log, { mirrorEveryMs: 10 });
    closers.push(async () => sync.stop());
    await sync.started;
    expect((await must(card?.id as string)).title).toBe("Edited while the server was down");
    expect(issuePages(api).length).toBe(pagesBefore + 1);
    const [caught] = await log.getEventsByTypes(["github/catch_up"]);
    expect(caught?.payload).toMatchObject({ reason: "restart", created: 0, updated: 1, errors: 0 });
    // The server runs on: no timer pulls the tracker.
    await new Promise((r) => setTimeout(r, 200));
    expect(issuePages(api).length).toBe(pagesBefore + 1);
  });

  it("without a webhook route, or before the project was ever synced, the server pulls nothing at start", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    api.edit(51, { title: "Never synced" });
    vi.stubEnv("SEKHEMET_GITHUB_WEBHOOK_SECRET", "hook");
    const first = startGithubSync(repo, store, log, { mirrorEveryMs: 10 });
    await first.started;
    first.stop();
    expect(issuePages(api)).toHaveLength(0);
    await syncGithub(repo, store, "both", log);
    vi.stubEnv("SEKHEMET_GITHUB_WEBHOOK_SECRET", "");
    const second = startGithubSync(repo, store, log, { mirrorEveryMs: 10 });
    await second.started;
    second.stop();
    expect(issuePages(api)).toHaveLength(1);
    expect(await log.getEventsByTypes(["github/catch_up"])).toEqual([]);
  });

  it("on the App, a delivery the log shows failed is a gap: the next delivery's check pulls to catch up, once", async () => {
    const api = await fakeGitHub();
    useApp(api);
    api.edit(52, { title: "Before the gap" });
    await syncGithub(repo, store, "both", log);
    const [card] = await byRef("o/r#52");
    const post = await hookRoute("hook", { gapCheckEveryMs: 0 });
    // A delivery GitHub could not make: the server answered nothing (GitHub's log records it).
    api.edit(52, { title: "Edited during the gap" });
    await new Promise((r) => setTimeout(r, 5));
    const later = new Date().toISOString();
    api.deliveries.push({
      id: 9001,
      guid: "0b989ba4-242f-11e5-81e1-c7b6966d2516",
      delivered_at: later,
      redelivery: false,
      duration: 10,
      status: "Invalid HTTP Response: 502",
      status_code: 502,
      event: "issues",
      action: "edited",
      installation_id: 2,
      repository_id: 1,
    });
    // An ordinary delivery arrives: not a trigger, but its arrival runs the check.
    expect(await post("issues", "d-ok-1", { action: "edited", issue: { number: 52 } })).toBe(202);
    await vi.waitFor(async () =>
      expect(await log.getEventsByTypes(["github/catch_up"])).toHaveLength(1),
    );
    const [caught] = await log.getEventsByTypes(["github/catch_up"]);
    expect(caught?.payload).toMatchObject({ reason: "gap", gaps: 1, updated: 1, errors: 0 });
    expect((await must(card?.id as string)).title).toBe("Edited during the gap");
    // The App's delivery log is read with the App's JWT, not an installation token.
    const read = api.seen.find((s) => s.url.startsWith("/api/v3/app/hook/deliveries"));
    expect(read?.auth).toMatch(/^Bearer eyJ/);
    // The same failed delivery is not a second gap.
    expect(await post("issues", "d-ok-2", { action: "edited", issue: { number: 52 } })).toBe(202);
    await new Promise((r) => setTimeout(r, 300));
    expect(await log.getEventsByTypes(["github/catch_up"])).toHaveLength(1);
  });

  it("on the gh transport a gap cannot be seen, and it says so", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    const r = await detectDeliveryGaps(repo, log);
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/gh/);
    expect(r.reason).toMatch(/restart/);
    expect(api.seen.filter((s) => s.url.includes("/hook/deliveries"))).toEqual([]);
  });
});

describe("INT-16a/16: a dependency bot's pull request is verified by the full gates", () => {
  let head: string;
  beforeEach(() => {
    git(repo, "checkout", "-q", "-b", "dependabot/npm/left-pad-2");
    write(repo, "package.json", '{ "dependencies": { "left-pad": "2.0.0" } }\n');
    git(repo, "add", "package.json");
    git(repo, "commit", "-q", "-m", "Bump left-pad");
    head = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "main");
  });
  const openedBy = async (login: string) => {
    const hook = fixture("webhook-pull_request-closed.json");
    hook.action = "opened";
    hook.repository.full_name = "o/r";
    hook.pull_request.html_url = "https://github.com/o/r/pull/9";
    hook.pull_request.number = 9;
    hook.pull_request.merged = false;
    hook.pull_request.user = { login, id: 49699333, type: "Bot" };
    hook.pull_request.head.sha = head;
    hook.pull_request.head.repo = { full_name: "o/r" };
    hook.pull_request.base.repo = { full_name: "o/r" };
    const id = await applyWebhookIntent(store, intentFor("pull_request", hook), "d-dep");
    return must(id as string);
  };
  const verifyBoard = () =>
    new BoardServiceImpl(store, {
      entryConditions: true,
      evidenceFor: (id) => ledgerEvidenceSummary(store, repo, id),
    });
  /** The project's gates, run in the checkout they are given: here, that the bump is there. */
  const gatesSeeing = (want: string) => async (cwd: string) => {
    const text = readFileSync(join(cwd, "package.json"), "utf8");
    const passed = text.includes(want);
    return {
      passed,
      durationMs: 3,
      rungResults: [{ gate: "deps", rung: "test", passed, durationMs: 3 }],
      failures: passed
        ? []
        : [{ gate: "deps", rung: "test", exitCode: 1, errorExcerpt: "left-pad missing" }],
    } as never;
  };

  it("INT-16a: every gate passes on the PR's head and the project allows it: auto-merge is enabled; the Worker never sees it", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    api.prHeads.set(9, head);
    write(repo, ".sekhemet/config.toml", "[review]\nauto_merge_dependencies = true\n");
    const card = await openedBy("dependabot[bot]");
    expect(card).toMatchObject({ status: "ready", labels: ["dependency-update"] });
    // Linked to its pull request, so no sync opens an issue for it.
    expect(card.externalRef).toEqual({
      system: "github",
      id: "pr/9",
      url: "https://github.com/o/r/pull/9",
    });
    const left = await runDependencyVerifications(repo, [card], {
      store,
      board: verifyBoard(),
      runGates: gatesSeeing('"left-pad": "2.0.0"'),
    });
    expect(left).toEqual([]);
    expect((await must(card.id)).status).toBe("review");
    const merge = api.seen.find((s) =>
      /enablePullRequestAutoMerge/.test(String((s.body as { query?: string })?.query)),
    );
    // Only at the head the gates ran on (GitHub refuses it at any other).
    expect((merge?.body as { variables: unknown }).variables).toMatchObject({ id: "PR_9", head });
    expect(String((merge?.body as { query: string }).query)).toContain("expectedHeadOid");
    const [verified] = await store.cardEvents(card.id, ["github/dependency_verified"]);
    expect(verified?.payload).toMatchObject({
      id: card.id,
      pr: 9,
      headSha: head,
      passed: true,
      autoMerge: "enabled",
    });
  });

  it("INT-16: every gate passes but the project does not allow auto-merge: it is left for a person, in Review", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    api.prHeads.set(9, head);
    const card = await openedBy("renovate[bot]");
    await runDependencyVerifications(repo, [card], {
      store,
      board: verifyBoard(),
      runGates: gatesSeeing('"left-pad": "2.0.0"'),
    });
    expect((await must(card.id)).status).toBe("review");
    expect(
      api.seen.filter((s) =>
        /enablePullRequestAutoMerge/.test(String((s.body as { query?: string })?.query)),
      ),
    ).toEqual([]);
    const [verified] = await store.cardEvents(card.id, ["github/dependency_verified"]);
    expect(verified?.payload).toMatchObject({ passed: true, autoMerge: "not_allowed" });
  });

  it("a failing gate, or a head that moved since the gates ran, enables nothing", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    write(repo, ".sekhemet/config.toml", "[review]\nauto_merge_dependencies = true\n");
    const failing = await openedBy("dependabot[bot]");
    await runDependencyVerifications(repo, [failing], {
      store,
      board: verifyBoard(),
      runGates: gatesSeeing("3.0.0"),
    });
    expect((await must(failing.id)).status).toBe("parked");
    const [f] = await store.cardEvents(failing.id, ["github/dependency_verified"]);
    expect(f?.payload).toMatchObject({ passed: false, autoMerge: "gates_failed" });
    await store.deleteCard?.(failing.id).catch?.(() => undefined);
    api.prHeads.set(9, "f".repeat(40));
    const moved = await store.createCard({
      id: "card_deps9b",
      tier: "task",
      title: "Verify dependabot[bot] PR #9",
      status: "ready",
      spec: `Run the full gates against PR #9 at ${head} and report.`,
      labels: ["dependency-update"],
      externalRef: { system: "github", id: "pr/9", url: "https://github.com/o/r/pull/9" },
    });
    await runDependencyVerifications(repo, [moved], {
      store,
      board: verifyBoard(),
      runGates: gatesSeeing('"left-pad": "2.0.0"'),
    });
    const [m] = await store.cardEvents(moved.id, ["github/dependency_verified"]);
    expect(m?.payload).toMatchObject({ passed: true, autoMerge: "head_moved" });
    expect(
      api.seen.filter((s) =>
        /enablePullRequestAutoMerge/.test(String((s.body as { query?: string })?.query)),
      ),
    ).toEqual([]);
  });
  it("M1: auto-merge only for the bot's own branch in this repository, checked again on GitHub", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    api.prHeads.set(9, head);
    write(repo, ".sekhemet/config.toml", "[review]\nauto_merge_dependencies = true\n");
    const merges = () =>
      api.seen.filter((s) =>
        /enablePullRequestAutoMerge/.test(String((s.body as { query?: string })?.query)),
      );
    // At intake: a login that only looks like the bot, or a fork's branch, makes no card.
    for (const [login, type, fork] of [
      ["dependabot", "Bot", false],
      ["dependabot[bot]", "User", false],
      ["dependabot[bot]", "Bot", true],
    ] as const) {
      const hook = fixture("webhook-pull_request-closed.json");
      hook.action = "opened";
      hook.repository.full_name = "o/r";
      hook.pull_request.user = { login, id: 1, type };
      hook.pull_request.head.repo = { full_name: fork ? "mallory/r" : "o/r" };
      hook.pull_request.base.repo = { full_name: "o/r" };
      expect(intentFor("pull_request", hook).kind, `${login} ${type} ${fork}`).toBe("ignored");
    }
    // Before auto-merge: GitHub says the pull request now comes from a fork.
    api.prMeta.set(9, { login: "dependabot[bot]", type: "Bot", headRepo: "mallory/r" });
    const card = await store.createCard({
      id: "card_deps9m",
      tier: "task",
      title: "Verify dependabot[bot] PR #9",
      status: "ready",
      spec: `Run the full gates against PR #9 at ${head} and report.`,
      labels: ["dependency-update"],
      externalRef: { system: "github", id: "pr/9", url: "https://github.com/o/r/pull/9" },
    });
    await runDependencyVerifications(repo, [card], {
      store,
      board: verifyBoard(),
      runGates: gatesSeeing('"left-pad": "2.0.0"'),
    });
    expect(merges()).toEqual([]);
    const [v] = await store.cardEvents(card.id, ["github/dependency_verified"]);
    expect(v?.payload).toMatchObject({ passed: true, autoMerge: "not_dependency_bot" });
  });
});

describe("INT-20b: the card's state as the issue's project status; the assignee untouched", () => {
  it("Ready, In progress, Review and Done set queued, working, waiting for review and completed in turn", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    const alice = store.localPrincipal();
    await store.linkIdentity(alice, "github", "alice-gh", alice);
    api.edit(60, { title: "Mirrored", assignee: { login: "alice-gh" } });
    // One project uses GitHub's agent names, another the default board's.
    api.projects.push(
      {
        id: "PVT_agent",
        options: ["Queued", "Working", "Waiting for review", "Completed"],
        items: new Map([[60, undefined]]),
      },
      {
        id: "PVT_board",
        options: ["Todo", "In Progress", "Done"],
        items: new Map([[60, undefined]]),
      },
    );
    await syncGithub(repo, store, "both", log);
    const [card] = await byRef("o/r#60");
    const id = card?.id as string;
    const patchesBefore = api.seen.filter((s) => s.method === "PATCH").length;
    for (const status of ["ready", "in_progress", "review", "done"] as const) {
      await store.updateCardStatus(id, status, "moved", "harness", { override: true });
      await mirrorAgentStatuses(repo, store, log);
    }
    expect(api.statusLog.filter((l) => l.startsWith("PVT_agent:"))).toEqual([
      "PVT_agent:Queued",
      "PVT_agent:Working",
      "PVT_agent:Waiting for review",
      "PVT_agent:Completed",
    ]);
    expect(api.statusLog.filter((l) => l.startsWith("PVT_board:"))).toEqual([
      "PVT_board:Todo",
      "PVT_board:In Progress",
      "PVT_board:In Progress",
      "PVT_board:Done",
    ]);
    // The mirror wrote no issue field: the assignee is still the person.
    expect(api.seen.filter((s) => s.method === "PATCH").length).toBe(patchesBefore);
    expect((api.issues.get(60)?.assignee as { login: string }).login).toBe("alice-gh");
    const recorded = await store.cardEvents(id, ["github/agent_status"]);
    expect(recorded.map((e) => (e.payload as { status: string }).status)).toEqual([
      "queued",
      "working",
      "waiting_for_review",
      "completed",
    ]);
    // Nothing moved, nothing set.
    await mirrorAgentStatuses(repo, store, log);
    expect(api.statusLog).toHaveLength(8);
  });

  it("the server mirrors a move from the ledger, without a sync", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    api.edit(61, { title: "Tailed" });
    api.projects.push({
      id: "PVT_1",
      options: ["Queued", "Working"],
      items: new Map([[61, undefined]]),
    });
    await syncGithub(repo, store, "pull", log);
    const [card] = await byRef("o/r#61");
    const sync = startGithubSync(repo, store, log, { mirrorEveryMs: 10 });
    closers.push(async () => sync.stop());
    await sync.started;
    await store.updateCardStatus(card?.id as string, "ready", "moved", "harness", {
      override: true,
    });
    await vi.waitFor(() => expect(api.statusLog).toEqual(["PVT_1:Queued"]));
  });
});

describe("INT-20c: the tracker's Done does not move the board", () => {
  it("an issue closed before the card passed its gates and was accepted keeps the card where it is and records one sync/conflict", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    api.edit(70, { title: "Closed early" });
    await syncGithub(repo, store, "both", log);
    const [card] = await byRef("o/r#70");
    const id = card?.id as string;
    await store.updateCardStatus(id, "in_progress", "running", "harness", { override: true });
    api.edit(70, { state: "closed", closed_at: "2026-09-20T10:00:00Z" });
    expect((await syncGithub(repo, store, "both", log)).errors).toEqual([]);
    expect((await must(id)).status).toBe("in_progress");
    const recorded = await log.getEventsByTypes(["sync/conflict"]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.payload).toEqual({
      field: "state",
      reason: "done_before_accept",
      at: "2026-09-20T10:00:00Z",
    });
    // The board does not reopen the person's issue, and records the closure once.
    await syncGithub(repo, store, "both", log);
    expect(await conflicts()).toBe(1);
    expect(api.issues.get(70)?.state).toBe("closed");
  });

  it("the issues.closed webhook records it at once; the next sync adds nothing; an accepted card's closure is no conflict", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    api.edit(71, { title: "Closed by hook" });
    api.edit(72, { title: "Merged and closed" });
    await syncGithub(repo, store, "both", log);
    const [early] = await byRef("o/r#71");
    const [accepted] = await byRef("o/r#72");
    await store.updateCardStatus(early?.id as string, "review", "verified", "harness", {
      override: true,
    });
    await store.updateCardStatus(accepted?.id as string, "review", "verified", "harness", {
      override: true,
    });
    await store.recordPullRequestOpened(accepted?.id as string, {
      pr: 8,
      url: "https://github.com/o/r/pull/8",
      headSha: "h",
      accepter: store.localPrincipal(),
    });
    const post = await hookRoute("hook");
    for (const n of [71, 72]) {
      api.edit(n, { state: "closed", closed_at: `2026-09-21T10:00:0${n - 71}Z` });
      const hook = fixture("webhook-issues-labeled.json");
      hook.action = "closed";
      hook.repository.full_name = "o/r";
      hook.issue = { ...api.issues.get(n) };
      expect(await post("issues", `d-close-${n}`, hook)).toBe(202);
    }
    expect((await must(early?.id as string)).status).toBe("review");
    const recorded = await log.getEventsByTypes(["sync/conflict"]);
    expect(recorded.map((e) => e.cardId)).toEqual([early?.id]);
    await syncGithub(repo, store, "both", log);
    expect(await conflicts()).toBe(1);
  });
});

describe("INT-37/38: someone else's CI results name their source, and count only at the card's head", () => {
  beforeEach(() => {
    upstream = join(root, "upstream.git");
    execFileSync("git", ["init", "-q", "--bare", upstream]);
    git(repo, "remote", "add", "upstream", upstream);
    git(repo, "branch", "develop");
    write(
      repo,
      ".sekhemet/config.toml",
      '[review]\nintegration_branch = "develop"\nremote = "upstream"\n',
    );
    board = new BoardServiceImpl(store, { entryConditions: true, customLimits: { review: 5 } });
    writeSettings(repo, { githubPrOnAccept: true });
  });

  it("INT-37: each external check is recorded as source external with its name, run URL and head SHA; advisory unless declared blocking", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    await inReview("x1", { "src/b.ts": "export const b = 2;\n" });
    await opened("x1");
    await acceptCard(ctx(), await must("x1"));
    const branchHead = cardBranchHead(repo, "x1") as string;
    api.checkRuns.splice(
      0,
      api.checkRuns.length,
      { name: "sekhemet/unit", status: "completed", conclusion: "success", head_sha: branchHead },
      {
        name: "ci/build",
        status: "completed",
        conclusion: "failure",
        head_sha: branchHead,
        html_url: "https://github.com/o/r/runs/11",
        details_url: "https://ci.example/build/11",
      },
      {
        name: "ci/lint",
        status: "completed",
        conclusion: "success",
        head_sha: branchHead,
        html_url: "https://github.com/o/r/runs/12",
      },
      { name: "ci/slow", status: "in_progress", conclusion: null, head_sha: branchHead },
    );
    await advanceOpenPullRequests(repo, store, log);
    const results = (await store.cardEvents("x1", ["gate/result"]))
      .map(
        (e) =>
          e.payload as { gate: string; source: string; passed: boolean; externalRef?: unknown },
      )
      .filter((r) => r.source === "external");
    // Our own check is not someone else's; one still running has no result yet.
    expect(results.map((r) => r.gate).sort()).toEqual(["ci/build", "ci/lint"]);
    expect(results.find((r) => r.gate === "ci/build")).toMatchObject({
      passed: false,
      externalRef: {
        system: "github",
        checkName: "ci/build",
        runUrl: "https://github.com/o/r/runs/11",
        headSha: branchHead,
      },
    });
    // Recorded once, however often the queue asks.
    await advanceOpenPullRequests(repo, store, log);
    expect(
      (await store.cardEvents("x1", ["gate/result"])).filter(
        (e) => (e.payload as { source: string }).source === "external",
      ),
    ).toHaveLength(2);
    // Advisory: the failing ci/build does not fail the card's evidence.
    const head = () => branchHead;
    expect((await ledgerEvidenceSummary(store, repo, "x1", { branchHead: head }))?.passed).toBe(
      true,
    );
    // Declared blocking, it counts.
    const blocking = await ledgerEvidenceSummary(store, repo, "x1", {
      blockingChecks: ["ci/build"],
      branchHead: head,
    });
    expect(blocking?.passed).toBe(false);
  });

  it("INT-38: a result for a SHA other than the card branch's head is not evidence for the card", async () => {
    const api = await fakeGitHub();
    vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
    await inReview("x2", { "src/b.ts": "export const b = 2;\n" });
    await opened("x2");
    await acceptCard(ctx(), await must("x2"));
    api.checkRuns.splice(0, api.checkRuns.length, {
      name: "ci/build",
      status: "completed",
      conclusion: "failure",
      head_sha: "a".repeat(40),
      html_url: "https://github.com/o/r/runs/21",
    });
    await advanceOpenPullRequests(repo, store, log);
    // Recorded as what it is — a result at another head …
    const [external] = (await store.cardEvents("x2", ["gate/result"]))
      .map((e) => e.payload as { source: string; externalRef?: { headSha: string } })
      .filter((r) => r.source === "external");
    expect(external?.externalRef?.headSha).toBe("a".repeat(40));
    expect(cardBranchHead(repo, "x2")).not.toBe("a".repeat(40));
    // … and, though declared blocking and failing, not counted for the card.
    const summary = await ledgerEvidenceSummary(store, repo, "x2", {
      blockingChecks: ["ci/build"],
      branchHead: (id) => cardBranchHead(repo, id),
    });
    expect(summary?.passed).toBe(true);
    expect(summary?.gatesRun).toBe(1);
  });
});

describe("B3: the external review's git fetch goes through the network policy", () => {
  const reviewCard = (id: string) =>
    store.createCard({
      id,
      tier: "task",
      title: "Review PR #12",
      status: "ready",
      spec: "Run the full gates against PR #12 at its head and report.",
      labels: ["external-review"],
      externalRef: { system: "github", id: "pr/12", url: "https://github.com/o/r/pull/12" },
    });
  const review = async (id: string) =>
    runExternalReview(repo, await must(id), {
      store,
      board: new BoardServiceImpl(store, {
        entryConditions: true,
        evidenceFor: (c) => ledgerEvidenceSummary(store, repo, c),
      }),
      runGates: async () => ({ passed: true, failures: [], durationMs: 1 }) as never,
    });

  it("offline, a PR head on a remote host is not fetched; the refusal is recorded and names the setting", async () => {
    const trace = join(root, "git-trace.log");
    vi.stubEnv("GIT_TRACE", trace);
    await reviewCard("card_rev12");
    const r = await review("card_rev12");
    expect(r.error).toMatch(/network policy refused github\.com/);
    expect(r.error).toMatch(/\[network\] mode/);
    const egress = (await log.getEventsByTypes(["harness/egress"])).map((e) => e.payload);
    expect(egress).toMatchObject([{ host: "github.com", allowed: false }]);
    const traced = existsSync(trace) ? readFileSync(trace, "utf8") : "";
    expect(traced).not.toMatch(/git fetch|'fetch'/);
    expect((await must("card_rev12")).status).toBe("ready");
  });

  it("a remote the policy allows is fetched, recorded before it runs", async () => {
    const prs = join(root, "prs.git");
    execFileSync("git", ["init", "-q", "--bare", prs]);
    git(repo, "checkout", "-q", "-b", "pr-12");
    write(repo, "src/c.ts", "export const c = 3;\n");
    git(repo, "add", "src/c.ts");
    git(repo, "commit", "-q", "-m", "PR 12");
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "push", "-q", prs, "pr-12:refs/pull/12/head");
    git(repo, "checkout", "-q", "main");
    git(repo, "remote", "set-url", "origin", prs);
    await reviewCard("card_rev12b");
    const r = await review("card_rev12b");
    expect(r.error).toBeUndefined();
    expect(r.headSha).toBe(head);
    const egress = await log.getEventsByTypes(["harness/egress"]);
    expect(egress.map((e) => e.payload)).toMatchObject([
      { host: "localhost", allowed: true, purpose: "integration:github" },
    ]);
    expect((egress[0]?.private as { url: string }).url).toBe(`file://${prs}`);
  });
});

describe("the ledger tail backs off after a refused egress", () => {
  it("a refused mirror is not retried on every move of the board", async () => {
    // A GitHub the offline policy refuses.
    vi.stubEnv("SEKHEMET_GITHUB_HOST", "https://ghe.example.test");
    await store.createCard({
      id: "card_mb",
      tier: "task",
      title: "Mirrored",
      status: "backlog",
      externalRef: { system: "github", id: "o/r#80", url: "https://github.com/o/r/issues/80" },
    });
    const refusals = async () =>
      (await log.getEventsByTypes(["harness/egress"])).filter(
        (e) => !(e.payload as { allowed: boolean }).allowed,
      ).length;
    const sync = startGithubSync(repo, store, log, { mirrorEveryMs: 10 });
    closers.push(async () => sync.stop());
    await sync.started;
    await store.updateCardStatus("card_mb", "ready", "moved", "harness", { override: true });
    await vi.waitFor(async () => expect(await refusals()).toBeGreaterThan(0));
    const after = await refusals();
    for (const to of ["in_progress", "verify", "review"] as const) {
      await store.updateCardStatus("card_mb", to, "moved", "harness", { override: true });
      await new Promise((r) => setTimeout(r, 40));
    }
    expect(await refusals()).toBe(after);
  });
});
