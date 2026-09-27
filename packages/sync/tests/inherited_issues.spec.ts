import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  ForgejoIssuesAdapter,
  GitHubClient,
  GitHubIssuesAdapter,
  openIssues,
  staticToken,
} from "../src/index.js";

// Reading a taken-over repository's inherited issues, and the one write a
// person's applied reconciliation adds (design-stage DS-TO-13; integrations
// INT-42, INT-43): every open issue through the adapter's REST pull, pull
// requests and closed issues left out, and a comment on an issue through
// the same adapter. A real HTTP server stands in for the tracker.

interface Seen {
  method: string;
  url: string;
  body: unknown;
}
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

async function fake(reply: (s: Seen) => { status?: number; json?: unknown }) {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const s = {
        method: req.method ?? "",
        url: req.url ?? "",
        body: raw ? JSON.parse(raw) : undefined,
      };
      seen.push(s);
      const r = reply(s);
      res.writeHead(r.status ?? 200, { "content-type": "application/json" });
      res.end(r.json === undefined ? "" : JSON.stringify(r.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const restIssue = (n: number, state: string, pr = false) => ({
  number: n,
  html_url: `https://github.invalid/o/r/issues/${n}`,
  title: `Issue ${n}`,
  body: "text",
  labels: [{ name: "bug" }],
  assignee: null,
  state,
  updated_at: "2026-01-01T00:00:00Z",
  ...(pr ? { pull_request: {} } : {}),
});

describe("inherited issues on GitHub (INT-42)", () => {
  it("reads every open issue through the REST pull, since the beginning, without pull requests", async () => {
    const srv = await fake((s) =>
      s.method === "GET"
        ? { json: [restIssue(1, "open"), restIssue(2, "closed"), restIssue(3, "open", true)] }
        : { status: 201, json: {} },
    );
    const a = new GitHubIssuesAdapter(
      { owner: "o", repo: "r" },
      new GitHubClient(staticToken("t"), { apiUrl: srv.url, graphqlUrl: "" }, { fetch }),
    );
    const items = await openIssues(a);
    expect(items.map((i) => i.ref.id)).toEqual(["o/r#1"]);
    expect(items[0]?.labels).toEqual(["bug"]);
    expect(srv.seen[0]?.url).toBe(
      "/repos/o/r/issues?state=all&per_page=100&since=1970-01-01T00%3A00%3A00Z",
    );
  });

  it("comments on an issue through the same adapter (INT-43)", async () => {
    const srv = await fake(() => ({ status: 201, json: { id: 9 } }));
    const a = new GitHubIssuesAdapter(
      { owner: "o", repo: "r" },
      new GitHubClient(staticToken("t"), { apiUrl: srv.url, graphqlUrl: "" }, { fetch }),
    );
    await a.comment({ system: "github", id: "o/r#7", url: "" }, "Already done: commit abc.");
    expect(srv.seen.at(-1)).toMatchObject({
      method: "POST",
      url: "/repos/o/r/issues/7/comments",
      body: { body: "Already done: commit abc." },
    });
  });
});

describe("inherited issues on Forgejo (INT-42, INT-43)", () => {
  it("reads the open ones and comments through the Gitea API", async () => {
    const srv = await fake((s) =>
      s.method === "GET"
        ? {
            json: [
              { ...restIssue(4, "open"), html_url: "f4" },
              { ...restIssue(5, "closed"), html_url: "f5" },
            ],
          }
        : { status: 201, json: { id: 1 } },
    );
    const f = new ForgejoIssuesAdapter(srv.url, { owner: "o", repo: "r" }, "tok", fetch);
    expect((await openIssues(f)).map((i) => i.ref.id)).toEqual(["4"]);
    await f.comment({ system: "forgejo", id: "4", url: "" }, "Stale: src/a.ts was deleted.");
    expect(srv.seen.at(-1)).toMatchObject({
      method: "POST",
      url: "/api/v1/repos/o/r/issues/4/comments",
      body: { body: "Stale: src/a.ts was deleted." },
    });
  });
});
