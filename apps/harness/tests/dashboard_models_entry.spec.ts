import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { ModelRegistry } from "@sekhemet/models";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SMALL, ggufBytes } from "../../../packages/models/tests/support/gguf_fixture.js";
import { startDashboardServer } from "../src/server.js";

// The pre-download estimate through its door (C2d, FINDINGS_C1 TST-01;
// dashboard DB-NM14-5): Configuration's `GET /api/config/downloads/estimate`
// on a real server, against a model whose registered source is a GGUF served
// by a local stand-in for the hub. The stand-in records every request, so
// the test sees that only the header's byte ranges were asked for. Nothing
// leaves the machine; no weights are fetched; no model is loaded.

/** A GGUF of a real header and 6 MB standing in for weights. */
const FILE = ggufBytes({ ...SMALL, padBytes: 6_000_000 });

interface Hub {
  url: string;
  requests: { method: string; range?: string; status: number; bytes: number }[];
  close: () => Promise<void>;
}

/** A local hub: honours Range with a 206, or ignores it and sends the whole file. */
async function hub(honoursRange: boolean): Promise<Hub> {
  const requests: Hub["requests"] = [];
  const server: Server = createServer((req, res) => {
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "");
    if (!honoursRange || !m) {
      requests.push({
        method: req.method ?? "",
        ...(req.headers.range ? { range: req.headers.range } : {}),
        status: 200,
        bytes: FILE.length,
      });
      res.writeHead(200, { "content-length": FILE.length });
      res.end(FILE);
      return;
    }
    const start = Number(m[1]);
    const end = Math.min(FILE.length - 1, Number(m[2]));
    requests.push({
      method: req.method ?? "",
      range: req.headers.range,
      status: 206,
      bytes: end - start + 1,
    });
    res.writeHead(206, { "content-range": `bytes ${start}-${end}/${FILE.length}` });
    res.end(FILE.subarray(start, end + 1));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const a = server.address();
  const port = typeof a === "object" && a ? a.port : 0;
  return {
    url: `http://127.0.0.1:${port}/org/model-GGUF/resolve/main/model-Q4_K_M.gguf`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

describe("the pre-download estimate over HTTP (DB-NM14-5)", () => {
  let dir: string;
  let db: DatabaseSync;
  let server: { port: number; close: () => Promise<void> };
  let base: string;
  let good: Hub;
  let deaf: Hub;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-estimate-"));
    vi.stubEnv("SEKHEMET_MODEL_REGISTRY", join(dir, "models.json"));
    vi.stubEnv("SEKHEMET_CONFIG_DIR", join(dir, "user"));
    good = await hub(true);
    deaf = await hub(false);
    const registry = new ModelRegistry(join(dir, "models.json"));
    const sha256 = createHash("sha256").update(FILE).digest("hex");
    for (const [id, h] of [
      ["remote-model", good],
      ["deaf-model", deaf],
    ] as const)
      registry.recordSource(id, {
        url: h.url,
        host: new URL(h.url).host,
        sha256,
        sizeBytes: FILE.length,
      });
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const store = new CardStore(db, log);
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 10_000,
      headroomProbe: null,
    });
    base = `http://127.0.0.1:${server.port}`;
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await good?.close();
    await deaf?.close();
    db?.close();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "DB-NM14-5: the estimate reads only the GGUF header's byte ranges, is labelled Estimated, and fetches no weights",
    { timeout: 60_000 },
    async () => {
      const r = await fetch(`${base}/api/config/downloads/estimate?model=remote-model&role=worker`);
      const body = (await r.json()) as {
        fetchedWeights?: boolean;
        estimate?: {
          source: string;
          sizeBytes?: number;
          memory: { totalBytes: { grade: string; value: number }; kvBytes: { value: number } };
          metadata: { architecture?: string };
        };
        error?: string;
      };
      expect(r.status, body.error).toBe(200);
      expect(body.fetchedWeights).toBe(false);
      expect(body.estimate?.memory.totalBytes.grade).toBe("estimated");
      expect(body.estimate?.memory.kvBytes.value).toBeGreaterThan(0);
      expect(body.estimate?.sizeBytes).toBe(FILE.length);
      expect(body.estimate?.metadata.architecture).toBe("llama");
      // What the hub saw: range requests only, each answered 206, never the weights.
      expect(good.requests.length).toBeGreaterThan(0);
      for (const q of good.requests) {
        expect(q.method).toBe("GET");
        expect(q.range).toMatch(/^bytes=\d+-\d+$/);
        expect(q.status).toBe(206);
      }
      const read = good.requests.reduce((n, q) => n + q.bytes, 0);
      expect(read).toBeLessThan(FILE.length / 2);
    },
  );

  it(
    "DB-NM14-5: a host that ignores Range (anything but a 206) is refused, and no estimate is made",
    { timeout: 60_000 },
    async () => {
      const r = await fetch(`${base}/api/config/downloads/estimate?model=deaf-model&role=worker`);
      const text = await r.text();
      expect(r.status).not.toBe(200);
      expect(text).toMatch(/ignored the range request \(it answered 200\)/);
      expect(text).not.toMatch(/"estimate"/);
    },
  );
});
