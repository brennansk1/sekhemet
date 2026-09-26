import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
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
import { reviewPosterFromEnv } from "../src/external_review.js";
import { egressRecorder, integrationFetch } from "../src/github_transport.js";
import { exportBoard, listIntegrations, syncGithub, writeSettings } from "../src/integrations.js";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { advanceOpenPullRequests, syncViaAdapter } from "../src/wave2_github.js";
import { applyWebhookIntent, handleWave2Route } from "../src/wave2_server.js";

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
  seen: { method: string; url: string; body: unknown }[];
  issues: Map<number, Record<string, unknown>>;
  edit: (n: number, patch: Record<string, unknown>) => void;
}

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
      seen.push({ method: req.method ?? "", url, body });
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      const path = url.replace(/\?.*$/, "");
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
        return send(200, { check_runs: [{ status: "completed", conclusion: "success" }] });
      }
      if (req.method === "POST" && path === "/api/graphql") return send(200, { data: {} });
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
  const writes = (api: Api) => api.seen.filter((s) => s.method !== "GET").length;

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
    const writes = api.seen.filter((s) => s.method !== "GET").length;
    const second = await syncGithub(repo, store, "both", log);
    expect(second).toMatchObject({ created: 0, updated: 0, errors: [] });
    expect(api.seen.filter((s) => s.method !== "GET").length).toBe(writes);
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
    const created = api.seen.find((s) => s.method === "POST")?.body as {
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
    const ready = api.seen.find((s) => s.url === "/api/graphql");
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
