import { type Server, createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  estimateLocal,
  estimateRemote,
  parseGgufParserJson,
  predictDecode,
} from "../src/gguf_estimate.js";
import { LLAMA_BENCH_RUNS, MAX_BENCH_SPREAD, runLlamaBench } from "../src/llama_bench.js";
import { SMALL, ggufBytes } from "./support/gguf_fixture.js";

// MD-N13-3, DB-NM14-3, DB-NM14-5: speed predicted by the roofline per engine
// until measured; llama-bench accepted only at a spread of 3% or less; a
// remote estimate reads only the header's byte ranges.

const GB = 1e9;

describe("predictDecode (MD-N13-3, amended per engine by DEC-45)", () => {
  it("is efficiency × bandwidth ÷ bytes per token, graded estimated, per engine", () => {
    const meta = { parametersActive: 3e9, bitsPerWeight: 4 };
    const bw = { value: 120 * GB, grade: "measured" as const };
    const cpp = predictDecode(meta, 10 * GB, bw, "llama.cpp");
    const mlx = predictDecode(meta, 10 * GB, bw, "mlx");
    // 3e9 × 4 / 8 = 1.5 GB per token; 0.6 × 120 / 1.5 = 48 tok/s.
    expect(cpp?.value).toBeCloseTo(48, 5);
    expect(cpp?.grade).toBe("estimated");
    expect(cpp?.low).toBeLessThan(48);
    expect(cpp?.high).toBeGreaterThan(48);
    expect(mlx?.value).toBeCloseTo(68, 5);
  });

  it("uses the file size for a dense model with no parameter count", () => {
    const v = predictDecode({}, 12 * GB, { value: 120 * GB, grade: "measured" }, "llama.cpp");
    expect(v?.value).toBeCloseTo(6, 5);
  });

  it("returns undefined without a bandwidth", () => {
    expect(predictDecode({}, GB, undefined, "llama.cpp")).toBeUndefined();
  });
});

describe("runLlamaBench (DB-NM14-3)", () => {
  const out = (pp: number, tg: number) =>
    JSON.stringify([
      { n_prompt: 512, n_gen: 0, avg_ts: pp },
      { n_prompt: 0, n_gen: 128, avg_ts: tg },
    ]);

  it("runs one warm-up and five runs at the role's depth, and accepts a spread of 3% or less", async () => {
    const calls: string[][] = [];
    const tg = [99, 30, 30.2, 29.9, 30.1, 30.3];
    let i = 0;
    const r = await runLlamaBench({
      modelPath: "/models/m.gguf",
      depth: 16384,
      exec: async (_cmd, args) => {
        calls.push(args);
        const v = tg[i++] ?? 30;
        return out(400, v);
      },
    });
    expect(calls).toHaveLength(1 + LLAMA_BENCH_RUNS);
    expect(calls[0]).toEqual(
      expect.arrayContaining(["-m", "/models/m.gguf", "-d", "16384", "-o", "json"]),
    );
    expect(r.accepted).toBe(true);
    expect(r.decode.grade).toBe("measured");
    expect(r.decode.value).toBeCloseTo(30.1, 5);
    expect(r.decode.spread).toBeLessThanOrEqual(MAX_BENCH_SPREAD);
  });

  it("does not accept a run whose spread is over 3%, and grades it not measured", async () => {
    const tg = [30, 30, 25, 31, 30, 33];
    let i = 0;
    const r = await runLlamaBench({
      modelPath: "/m.gguf",
      depth: 0,
      exec: async () => out(400, tg[i++] ?? 30),
    });
    expect(r.accepted).toBe(false);
    expect(r.decode.grade).toBe("estimated");
    expect(r.reason).toMatch(/spread/);
  });
});

describe("estimateRemote (DB-NM14-5)", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  it("reads only the header's byte ranges, never the weights, and grades the result estimated", async () => {
    const file = ggufBytes({ ...SMALL, padBytes: 6_000_000 });
    const requests: { method: string; range?: string }[] = [];
    server = createServer((req, res) => {
      requests.push({ method: req.method ?? "", range: req.headers.range });
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "");
      if (!m) {
        res.writeHead(200, { "content-length": file.length });
        res.end(file);
        return;
      }
      const start = Number(m[1]);
      const end = Math.min(file.length - 1, Number(m[2]));
      res.writeHead(206, { "content-range": `bytes ${start}-${end}/${file.length}` });
      res.end(file.subarray(start, end + 1));
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const est = await estimateRemote(`http://127.0.0.1:${port}/repo/resolve/main/m.gguf`, {
      fetch,
      contextTokens: 16384,
      kvType: "q8_0",
      bandwidth: { value: 120 * GB, grade: "measured" },
      engine: "llama.cpp",
    });
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      expect(r.method).toBe("GET");
      expect(r.range).toMatch(/^bytes=\d+-\d+$/);
      const [a, b] = (r.range ?? "").replace("bytes=", "").split("-").map(Number);
      expect((b ?? 0) - (a ?? 0)).toBeLessThan(4_000_000);
    }
    expect(est.source).toBe("estimator");
    expect(est.sizeBytes).toBe(file.length);
    expect(est.memory.totalBytes.grade).toBe("estimated");
    expect(est.memory.kvBytes.value).toBeGreaterThan(0);
    expect(est.decode?.grade).toBe("estimated");
    expect(est.metadata.architecture).toBe("llama");
  });

  it("refuses a host that ignores Range, reading only a capped amount of what it sends", async () => {
    let sent = 0;
    server = createServer((_req, res) => {
      // Ignores Range: a 200 with the whole (endless) file.
      res.writeHead(200, { "content-type": "application/octet-stream" });
      const chunk = Buffer.alloc(1024 * 1024, 1);
      const pump = () => {
        while (sent < 2 * 1024 ** 3) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      pump();
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await expect(
      estimateRemote(`http://127.0.0.1:${port}/m.gguf`, {
        fetch,
        contextTokens: 16384,
        kvType: "q8_0",
        engine: "llama.cpp",
      }),
    ).rejects.toThrow(/ignored the range request/);
    // What the server managed to push before the body was cancelled, not the file.
    expect(sent).toBeLessThan(256 * 1024 * 1024);
  });

  it("stops a header read past its byte cap", async () => {
    const file = ggufBytes({ ...SMALL, padBytes: 6_000_000 });
    server = createServer((req, res) => {
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "");
      const start = Number(m?.[1] ?? 0);
      const end = Math.min(file.length - 1, Number(m?.[2] ?? file.length - 1));
      res.writeHead(206, { "content-range": `bytes ${start}-${end}/${file.length}` });
      res.end(file.subarray(start, end + 1));
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await expect(
      estimateRemote(`http://127.0.0.1:${port}/m.gguf`, {
        fetch,
        contextTokens: 16384,
        kvType: "q8_0",
        engine: "llama.cpp",
        maxBytes: 1000,
      }),
    ).rejects.toThrow(/more than 1000 bytes/);
  });

  it("uses gguf-parser-go only for a local file, by --path, never its --url", async () => {
    const seen: string[][] = [];
    const est = await estimateLocal("/models/m.gguf", {
      contextTokens: 16384,
      kvType: "q8_0",
      engine: "llama.cpp",
      parser: {
        run: async (args) => {
          seen.push(args);
          return JSON.stringify({
            metadata: {
              size: 13_600_000_000,
              parameters: 35e9,
              bitsPerWeight: 3.1,
              architecture: "qwen3moe",
            },
            estimate: { items: [{ vrams: [{ uma: 14_000_000_000 }], ram: { uma: 500_000_000 } }] },
          });
        },
      },
    });
    expect(est?.source).toBe("gguf-parser-go");
    expect(est?.memory.totalBytes.value).toBe(14_500_000_000);
    expect(est?.memory.totalBytes.grade).toBe("estimated");
    expect(seen[0]).toEqual(expect.arrayContaining(["--path", "/models/m.gguf"]));
    expect(seen.flat()).not.toContain("--url");
    await expect(
      estimateLocal("https://example.test/m.gguf", {
        contextTokens: 1,
        kvType: "q8_0",
        engine: "llama.cpp",
        parser: { run: async () => "{}" },
      }),
    ).rejects.toThrow(/local file/);
  });

  it("parses gguf-parser-go's JSON defensively", () => {
    expect(parseGgufParserJson("not json")).toBeUndefined();
    expect(parseGgufParserJson(JSON.stringify({ metadata: {} }))).toBeUndefined();
  });
});
