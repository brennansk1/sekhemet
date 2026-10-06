import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";

/**
 * A local HTTP stub for the web a research run reads (the C2d entry-point
 * tests): pages keyed by `host/path`, served on 127.0.0.1 to the spawned
 * binary, whose preload (`g2_model.ts`, `G2_STUB_PORT`) sends every request
 * for a `.test` host here. Every request is recorded, so a test can show a
 * refused host was never asked.
 */
export interface StubPage {
  status?: number;
  type?: string;
  body: string;
}

export interface WebStub {
  port: number;
  /** Each request as `host/path?query`, in order. */
  requests: string[];
  close: () => Promise<void>;
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
});

/**
 * `pages` maps `host/path` (no scheme, e.g. `docs.lib.example.test/guide`) to
 * a page; a function value gets the query string. Anything else is a 404.
 */
export async function webStub(
  pages: Record<string, StubPage | ((query: URLSearchParams) => StubPage)>,
  /** Answers what no page names, given the original `https://host/path?query`. */
  fallback?: (url: URL) => Promise<Response>,
): Promise<WebStub> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://stub");
    const key = u.pathname.replace(/^\//, "");
    requests.push(`${key}${u.search}`);
    const entry = pages[key];
    const page = typeof entry === "function" ? entry(u.searchParams) : entry;
    if (!page && fallback) {
      const original = new URL(`https://${key}${u.search}`);
      void fallback(original).then(async (r) => {
        res.writeHead(r.status, {
          "content-type": r.headers.get("content-type") ?? "application/json",
        });
        res.end(Buffer.from(await r.arrayBuffer()));
      });
      return;
    }
    if (!page) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(page.status ?? 200, { "content-type": page.type ?? "text/html; charset=utf-8" });
    res.end(page.body);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** A plain HTML page with a title and paragraphs, long enough to read as content. */
export function htmlPage(title: string, paragraphs: string[]): StubPage {
  return {
    body: `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1>${paragraphs
      .map((p) => `<p>${p}</p>`)
      .join("")}</main></body></html>`,
  };
}
