"""A warm Crawl4AI browser behind a loopback HTTP endpoint, for Sekhemet's Researcher.

This product includes software developed by UncleCode (https://x.com/unclecode)
as part of the Crawl4AI project (https://github.com/unclecode/crawl4ai).

Why a sidecar: Crawl4AI is Python; the harness is TypeScript. Starting a
browser per page costs seconds, so one crawler stays warm and the harness
asks it for pages. It binds to 127.0.0.1 only and reads nothing but the URL
it is given. Robots, pacing and private-address refusal happen in the harness
(polite.ts) before a URL ever reaches it.

POST /md {"url": str, "query": str | null}
  -> {"ok": true, "title": str, "markdown": str, "fit": bool, "links": int}
  With a query, BM25 filtering keeps the parts of the page about the query
  (Crawl4AI's "fit markdown"); without one, pruning drops navigation and
  boilerplate.
GET /health -> {"ok": true}
"""

import asyncio
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
from crawl4ai.content_filter_strategy import BM25ContentFilter, PruningContentFilter
from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator

PORT = int(os.environ.get("SEKHEMET_CRAWL4AI_PORT", "11235"))
UA = os.environ.get("SEKHEMET_USER_AGENT", "Sekhemet-Researcher/1.1")

loop = asyncio.new_event_loop()
crawler = AsyncWebCrawler(
    config=BrowserConfig(headless=True, user_agent=UA, text_mode=True, verbose=False)
)
loop.run_until_complete(crawler.start())


async def crawl(url, query):
    content_filter = (
        BM25ContentFilter(user_query=query, bm25_threshold=1.0)
        if query
        else PruningContentFilter(threshold=0.45, threshold_type="dynamic")
    )
    cfg = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,  # the harness caches; one cache, one TTL
        markdown_generator=DefaultMarkdownGenerator(content_filter=content_filter),
        page_timeout=30000,
        excluded_tags=["nav", "footer", "header", "aside", "form"],
        remove_overlay_elements=True,
    )
    result = await crawler.arun(url=url, config=cfg)
    if not result.success:
        return {"ok": False, "error": result.error_message or f"status {result.status_code}"}
    md = result.markdown
    fit = (md.fit_markdown or "").strip()
    raw = (md.raw_markdown or "").strip()
    # A filter that keeps almost nothing has misread the page: fall back to the whole.
    use_fit = len(fit) >= min(800, len(raw) // 4)
    return {
        "ok": True,
        "title": (result.metadata or {}).get("title") or "",
        "markdown": fit if use_fit else raw,
        "fit": use_fit,
        "links": len((result.links or {}).get("internal", [])),
        "status": result.status_code,
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(200 if self.path == "/health" else 404, {"ok": self.path == "/health"})

    def do_POST(self):
        if self.path != "/md":
            return self._send(404, {"ok": False})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(n) or b"{}")
            url = str(req.get("url", ""))
            if not url.startswith(("http://", "https://")):
                return self._send(400, {"ok": False, "error": "http(s) only"})
            fut = asyncio.run_coroutine_threadsafe(crawl(url, req.get("query")), loop)
            self._send(200, fut.result(timeout=60))
        except Exception as e:  # report, never crash the sidecar
            self._send(200, {"ok": False, "error": str(e)[:300]})

    def log_message(self, *args):
        pass


def main():
    import threading

    threading.Thread(target=loop.run_forever, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"crawl4ai sidecar on 127.0.0.1:{PORT}", flush=True)
    try:
        server.serve_forever()
    finally:
        asyncio.run_coroutine_threadsafe(crawler.close(), loop).result(timeout=10)


if __name__ == "__main__":
    sys.exit(main())
