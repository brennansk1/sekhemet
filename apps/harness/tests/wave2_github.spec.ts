import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { GitHubClient, staticToken } from "@sekhemet/sync";
import { afterEach, describe, expect, it } from "vitest";
import { syncGithub } from "../src/integrations.js";
import { runPackageGates } from "../src/wave2.js";
import { advancePullRequests, openPullRequestViaApp } from "../src/wave2_github.js";
import { githubAppFromEnv } from "../src/wave2_server.js";

const closers: (() => Promise<void>)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  for (const k of Object.keys(process.env).filter(
    (x) => x.startsWith("SEKHEMET_FORGEJO") || x.startsWith("SEKHEMET_GITHUB"),
  )) {
    Reflect.deleteProperty(process.env, k);
  }
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sek-w2gh-"));
  dirs.push(d);
  return d;
};
const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

async function fake(
  reply: (method: string, url: string, body: unknown) => { status?: number; json?: unknown },
) {
  const seen: { method: string; url: string; body: unknown }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method ?? "", url: req.url ?? "", body });
      const r = reply(req.method ?? "", req.url ?? "", body);
      res.writeHead(r.status ?? 200, { "content-type": "application/json" });
      res.end(r.json === undefined ? "" : JSON.stringify(r.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function kernel() {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const log = new EventLog(db);
  return { log, cardStore: new CardStore(db, log) };
}

describe("Y12: the App client comes from the environment", () => {
  it("is absent without an App id, and built from a key path with GHES endpoints", () => {
    expect(githubAppFromEnv({})).toBeUndefined();
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const dir = tmp();
    writeFileSync(join(dir, "key.pem"), privateKey);
    const c = githubAppFromEnv({
      SEKHEMET_GITHUB_APP_ID: "1",
      SEKHEMET_GITHUB_INSTALLATION_ID: "2",
      SEKHEMET_GITHUB_APP_KEY_PATH: join(dir, "key.pem"),
      SEKHEMET_GITHUB_HOST: "https://ghes.corp",
    });
    expect(c).toBeInstanceOf(GitHubClient);
  });
});

describe("Y14/Y15/Y16: the PR through the App", () => {
  it("opens a draft with the evidence, posts a check run per gate, uploads SARIF, then advances it", async () => {
    const repo = tmp();
    write(
      repo,
      ".sekhemet/evidence/latest-c1.json",
      JSON.stringify({
        passed: false,
        rungResults: [
          { gate: "typecheck", passed: false, durationMs: 10 },
          { gate: "test", passed: true, durationMs: 20 },
        ],
        failures: [{ gate: "typecheck", errorExcerpt: "src/a.ts(3,1): error TS2322: bad" }],
        diff: "+++ b/src/a.ts\n",
      }),
    );
    write(repo, ".sekhemet/evidence/c1.sarif", '{"version":"2.1.0","runs":[]}');
    write(repo, ".github/CODEOWNERS", "/src/ @alice\n");
    let checks = [{ status: "completed", conclusion: "success" }];
    const srv = await fake((method, url) => {
      if (method === "POST" && url === "/repos/o/r/pulls") {
        return {
          status: 201,
          json: { number: 7, node_id: "PR7", html_url: "https://gh/pr/7", head: { sha: "h" } },
        };
      }
      if (url.endsWith("/check-runs") && method === "POST") return { status: 201, json: { id: 1 } };
      if (url.startsWith("/repos/o/r/commits/h/check-runs"))
        return { json: { check_runs: checks } };
      if (url === "/graphql") return { json: { data: {} } };
      return { status: 200, json: {} };
    });
    const client = new GitHubClient(staticToken("t"), {
      apiUrl: srv.url,
      graphqlUrl: `${srv.url}/graphql`,
    });
    const { log, cardStore } = kernel();
    await cardStore.createCard({
      id: "c1",
      tier: "task",
      title: "Fix a",
      status: "review",
      spec: "S",
    });
    const card = await cardStore.getCard("c1");
    const pr = await openPullRequestViaApp(
      client,
      repo,
      { owner: "o", repo: "r" },
      card as never,
      "b",
      "h",
      log,
    );
    expect(pr.url).toBe("https://gh/pr/7");
    const draft = srv.seen.find((s) => s.url === "/repos/o/r/pulls")?.body as {
      draft: boolean;
      body: string;
    };
    expect(draft.draft).toBe(true);
    expect(draft.body).toContain("FAIL typecheck");
    expect(
      srv.seen.filter((s) => s.method === "POST" && s.url.endsWith("/check-runs")),
    ).toHaveLength(2);
    expect(srv.seen.some((s) => s.url.endsWith("/code-scanning/sarifs"))).toBe(true);
    const advanced = await advancePullRequests(client, repo, log, { autoMerge: true });
    expect(advanced).toEqual([{ number: 7, state: "auto_merge" }]);
    expect(srv.seen.find((s) => s.url.endsWith("/requested_reviewers"))?.body).toEqual({
      reviewers: ["alice"],
      team_reviewers: [],
    });
    // Already advanced: nothing to do next pass.
    checks = [];
    expect(await advancePullRequests(client, repo, log, { autoMerge: true })).toEqual([]);
  });
});

describe("Y10/Y11/Y20: syncGithub goes through the tracker adapter when configured", () => {
  it("pulls a Forgejo issue into a card, pushes unlinked cards, and pauses a running card on a scope change", async () => {
    let body = "Touch src/a.ts";
    let updated = "2026-09-19T00:00:00Z";
    const srv = await fake((method, url) => {
      if (method === "GET" && url.startsWith("/api/v1/repos/o/r/issues")) {
        return {
          json: [
            {
              number: 4,
              html_url: "f/4",
              title: "Fix A",
              body,
              labels: [],
              assignee: null,
              state: "open",
              updated_at: updated,
            },
          ],
        };
      }
      if (method === "POST" && url === "/api/v1/repos/o/r/issues")
        return { status: 201, json: { number: 9, html_url: "f/9" } };
      return { json: {} };
    });
    process.env.SEKHEMET_FORGEJO_URL = srv.url;
    process.env.SEKHEMET_FORGEJO_TOKEN = "tok";
    process.env.SEKHEMET_FORGEJO_REPO = "o/r";
    process.env.SEKHEMET_CONFIG_DIR = tmp();
    const repo = tmp();
    const { log, cardStore } = kernel();
    await cardStore.createCard({ id: "local", tier: "task", title: "Local only", status: "ready" });
    const first = await syncGithub(repo, cardStore, "both", log);
    expect(first.errors).toEqual([]);
    const pulled = (await cardStore.listCards()).find((c) => c.externalRef?.id === "4");
    expect(pulled?.title).toBe("Fix A");
    expect((await cardStore.getCard("local"))?.externalRef?.id).toBe("9");
    // The card starts running; then the issue's scope changes.
    await cardStore.updateCardStatus(pulled?.id as string, "in_progress");
    body = "Touch src/a.ts and src/b.ts";
    updated = "2026-09-20T00:00:00Z";
    await syncGithub(repo, cardStore, "both", log);
    expect((await cardStore.getCard(pulled?.id as string))?.status).toBe("parked");
    Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
  });
});

describe("Y19: per-package gates for a monorepo change", () => {
  it("runs the gates of each touched package", async () => {
    const root = tmp();
    write(root, "pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
    write(root, "packages/a/package.json", JSON.stringify({ name: "@x/a" }));
    write(
      root,
      "packages/a/.sekhemet/gates.toml",
      '[[gates]]\nrung = "unit"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\n',
    );
    write(root, "packages/b/package.json", JSON.stringify({ name: "@x/b" }));
    write(
      root,
      "packages/b/.sekhemet/gates.toml",
      '[[gates]]\nrung = "unit"\ncommand = "node"\nargs = ["-e", "process.exit(1)"]\n',
    );
    const lines: string[] = [];
    const r = await runPackageGates(root, root, ["packages/a/x.ts", "packages/b/y.ts"], (l) =>
      lines.push(l),
    );
    expect(r.map((x) => `${x.package}:${x.passed}`)).toEqual(["@x/a:true", "@x/b:false"]);
    expect(lines.join("\n")).toContain("FAIL @x/b:unit");
  });
});
