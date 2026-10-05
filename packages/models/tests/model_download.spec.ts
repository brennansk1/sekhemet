import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lookupPublishedFile, matchOnHub } from "../src/hf_lookup.js";
import {
  DownloadHashMismatch,
  DownloadRefused,
  downloadModel,
  downloadVerified,
} from "../src/model_download.js";
import { ModelRegistry } from "../src/registry.js";

// MD-N12-6, MD-N12-7, SEC-53, DB-N6-6/7: one explicit download, from the
// registered source only, through the network policy, verified by SHA-256
// before the file is used. MD-N13-2, SEC-N10-3: a lookup sends a name only.

const WEIGHTS = Buffer.alloc(300_000, 7);
const SHA = createHash("sha256").update(WEIGHTS).digest("hex");

let server: Server;
let base = "";
let requests: string[] = [];
/** The Range header of each request, in order (MD-N18-1). */
let ranges: (string | undefined)[] = [];
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sek-dl-"));
  dirs.push(d);
  return d;
};

beforeEach(async () => {
  requests = [];
  ranges = [];
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    ranges.push(req.headers.range);
    const url = new URL(req.url ?? "/", "http://x");
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    const from = range ? Number(range[1]) : 0;
    // A source that honours Range: 206 with the rest of the file.
    if (
      url.pathname === "/range/model-Q4_K_M.gguf" ||
      (url.pathname === "/drop/model-Q4_K_M.gguf" && range)
    ) {
      if (!range) {
        res.writeHead(200, { "content-length": WEIGHTS.length });
        res.end(WEIGHTS);
        return;
      }
      if (from >= WEIGHTS.length) {
        res.writeHead(416, { "content-range": `bytes */${WEIGHTS.length}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "content-length": WEIGHTS.length - from,
        "content-range": `bytes ${from}-${WEIGHTS.length - 1}/${WEIGHTS.length}`,
      });
      res.end(WEIGHTS.subarray(from));
      return;
    }
    // The connection drops mid-stream: half the file, then the socket closes.
    if (url.pathname === "/drop/model-Q4_K_M.gguf") {
      res.writeHead(200, { "content-length": WEIGHTS.length });
      res.write(WEIGHTS.subarray(0, WEIGHTS.length / 2), () => {
        setTimeout(() => res.socket?.destroy(), 50);
      });
      return;
    }
    // Half the file, then the connection stays open with nothing more: a
    // person cancels while it waits (rule 4e). Closed after 5 s regardless.
    if (url.pathname === "/stall/model-Q4_K_M.gguf") {
      res.writeHead(200, { "content-length": WEIGHTS.length });
      res.write(WEIGHTS.subarray(0, WEIGHTS.length / 2));
      setTimeout(() => res.socket?.destroy(), 5000).unref();
      return;
    }
    // A source that ignores Range: always 200 and the whole file.
    if (url.pathname === "/norange/model-Q4_K_M.gguf") {
      res.writeHead(200, { "content-length": WEIGHTS.length });
      res.end(WEIGHTS);
      return;
    }
    // A 206 that starts somewhere other than the kept length: the whole file from 0.
    if (url.pathname === "/fromzero/model-Q4_K_M.gguf") {
      res.writeHead(206, {
        "content-length": WEIGHTS.length,
        "content-range": `bytes 0-${WEIGHTS.length - 1}/${WEIGHTS.length}`,
      });
      res.end(WEIGHTS);
      return;
    }
    if (url.pathname === "/org/model-GGUF/resolve/main/model-Q4_K_M.gguf") {
      res.writeHead(200, { "content-length": WEIGHTS.length });
      res.end(WEIGHTS);
      return;
    }
    if (url.pathname === "/api/models/org/model-GGUF/tree/main") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify([
          { type: "file", path: "README.md", size: 10 },
          {
            type: "file",
            path: "model-Q4_K_M.gguf",
            size: WEIGHTS.length,
            lfs: { oid: SHA, size: WEIGHTS.length },
          },
        ]),
      );
      return;
    }
    if (url.pathname === "/api/models" && url.searchParams.get("search")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ id: "org/Tiny-Llama-1B-GGUF" }]));
      return;
    }
    if (url.pathname === "/api/models/org/Tiny-Llama-1B-GGUF") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "org/Tiny-Llama-1B-GGUF",
          gguf: { total: 1_100_000_000, architecture: "llama", context_length: 32768 },
          cardData: { license: "apache-2.0", base_model: "org/Tiny-Llama-1B" },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const source = () => ({
  url: `${base}/org/model-GGUF/resolve/main/model-Q4_K_M.gguf`,
  host: "127.0.0.1",
  sha256: SHA,
  sizeBytes: WEIGHTS.length,
});

describe("downloadModel (MD-N12-6, SEC-53)", () => {
  it("fetches from the registered source into the named folder and verifies the hash before use", async () => {
    const dest = tmp();
    const states: string[] = [];
    const r = await downloadModel({
      model: "tiny",
      source: source(),
      destDir: dest,
      fetch,
      onProgress: (p) => states.push(p.state),
    });
    expect(r).toMatchObject({ sha256: SHA, bytes: WEIGHTS.length, verified: true });
    expect(r.path).toBe(join(dest, "model-Q4_K_M.gguf"));
    expect(readFileSync(r.path).equals(WEIGHTS)).toBe(true);
    expect(readdirSync(dest)).toEqual(["model-Q4_K_M.gguf"]);
    expect(states[0]).toBe("running");
    expect(states).toContain("verifying");
    expect(states.at(-1)).toBe("done");
  });

  it("deletes a file whose hash differs and says so (DB-N6-7)", async () => {
    const dest = tmp();
    await expect(
      downloadModel({
        model: "tiny",
        source: { ...source(), sha256: "0".repeat(64) },
        destDir: dest,
        fetch,
      }),
    ).rejects.toBeInstanceOf(DownloadHashMismatch);
    expect(readdirSync(dest)).toEqual([]);
  });

  it("refuses a model with no registered source and hash, making no request", async () => {
    await expect(downloadModel({ model: "tiny", destDir: tmp(), fetch })).rejects.toThrow(
      /no registered source/,
    );
    await expect(
      downloadModel({ model: "tiny", source: { ...source(), sha256: "" }, destDir: tmp(), fetch }),
    ).rejects.toBeInstanceOf(DownloadRefused);
    expect(requests).toEqual([]);
  });

  it("refuses when the network policy does not allow the source host, naming the setting (offline)", async () => {
    const err = await downloadModel({
      model: "tiny",
      source: source(),
      destDir: tmp(),
      fetch,
      refusal: () => "[network] mode is offline",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DownloadRefused);
    expect(String(err.message)).toMatch(/\[network\] mode/);
    expect(requests).toEqual([]);
  });

  it("never creates the folder: a missing one (an unmounted drive) is refused before any request", async () => {
    const gone = join(tmp(), "Passport", "llm");
    const err = await downloadModel({
      model: "tiny",
      source: source(),
      destDir: gone,
      fetch,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DownloadRefused);
    expect(String(err.message)).toMatch(/is not there/);
    expect(existsSync(join(gone, ".."))).toBe(false);
    expect(requests).toEqual([]);
  });

  it("never replaces a different file of the same name; another name may be given", async () => {
    const dest = tmp();
    writeFileSync(join(dest, "model-Q4_K_M.gguf"), "someone else's file");
    const err = await downloadModel({
      model: "tiny",
      source: source(),
      destDir: dest,
      fetch,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DownloadRefused);
    expect(String(err.message)).toMatch(/already has a file named model-Q4_K_M\.gguf/);
    expect(readFileSync(join(dest, "model-Q4_K_M.gguf"), "utf8")).toBe("someone else's file");
    expect(requests).toEqual([]);
    const r = await downloadModel({
      model: "tiny",
      source: source(),
      destDir: dest,
      fetch,
      fileName: "../tiny-copy.gguf",
    });
    expect(r.path).toBe(join(dest, "tiny-copy.gguf"));
    expect(readFileSync(join(dest, "model-Q4_K_M.gguf"), "utf8")).toBe("someone else's file");
  });

  it("cancels before starting: nothing is written (a cancel mid-stream keeps the .part, rule 4e)", async () => {
    const dest = tmp();
    const ac = new AbortController();
    ac.abort();
    await expect(
      downloadModel({ model: "tiny", source: source(), destDir: dest, fetch, signal: ac.signal }),
    ).rejects.toThrow(/cancel/i);
    expect(readdirSync(dest)).toEqual([]);
  });
});

describe("downloads that resume and fit (NEW-models-18)", () => {
  const at = (route: string) => ({
    url: `${base}/${route}/model-Q4_K_M.gguf`,
    host: "127.0.0.1",
    sha256: SHA,
    sizeBytes: WEIGHTS.length,
  });

  it("keeps the .part file when the connection drops mid-stream, and resumes it with a Range request (MD-N18-1)", async () => {
    const dest = tmp();
    const part = join(dest, "model-Q4_K_M.gguf.part");
    const first = await downloadModel({
      model: "tiny",
      source: at("drop"),
      destDir: dest,
      fetch,
    }).catch((e) => e);
    expect(first).toBeInstanceOf(Error);
    expect(String(first.message)).toMatch(/kept/);
    expect(existsSync(part)).toBe(true);
    const kept = statSync(part).size;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(WEIGHTS.length);
    expect(readFileSync(part).equals(WEIGHTS.subarray(0, kept))).toBe(true);

    const states: { bytes: number; state: string }[] = [];
    const r = await downloadModel({
      model: "tiny",
      source: at("drop"),
      destDir: dest,
      fetch,
      onProgress: (p) => states.push({ bytes: p.bytes, state: p.state }),
    });
    expect(ranges.at(-1)).toBe(`bytes=${kept}-`);
    expect(r).toMatchObject({ sha256: SHA, bytes: WEIGHTS.length, verified: true });
    expect(readFileSync(r.path).equals(WEIGHTS)).toBe(true);
    expect(readdirSync(dest)).toEqual(["model-Q4_K_M.gguf"]);
    // The progress starts at the kept bytes, not at nothing.
    expect(states[0]).toEqual({ bytes: kept, state: "running" });
  });

  it("starts again from nothing when the source answers a Range request with 200", async () => {
    const dest = tmp();
    writeFileSync(join(dest, "model-Q4_K_M.gguf.part"), WEIGHTS.subarray(0, 1000));
    const r = await downloadModel({ model: "tiny", source: at("norange"), destDir: dest, fetch });
    expect(ranges.at(-1)).toBe("bytes=1000-");
    expect(r.bytes).toBe(WEIGHTS.length);
    expect(readFileSync(r.path).equals(WEIGHTS)).toBe(true);
  });

  it("starts again from a 206 whose range is not the kept length's", async () => {
    const dest = tmp();
    writeFileSync(join(dest, "model-Q4_K_M.gguf.part"), WEIGHTS.subarray(0, 1000));
    const r = await downloadModel({ model: "tiny", source: at("fromzero"), destDir: dest, fetch });
    expect(readFileSync(r.path).equals(WEIGHTS)).toBe(true);
  });

  it("hashes the kept bytes too: a kept prefix that is not the file's is caught and deleted", async () => {
    const dest = tmp();
    writeFileSync(join(dest, "model-Q4_K_M.gguf.part"), Buffer.alloc(1000, 9));
    const err = await downloadModel({
      model: "tiny",
      source: at("range"),
      destDir: dest,
      fetch,
    }).catch((e) => e);
    expect(ranges.at(-1)).toBe("bytes=1000-");
    expect(err).toBeInstanceOf(DownloadHashMismatch);
    expect(readdirSync(dest)).toEqual([]);
  });

  // C4 (C3's review): MD-N18-4's 416 path. A kept `.part` longer than the
  // file, when the source names no size, asks for a range past the end; the
  // source answers 416, and the download asks again without a range and
  // starts from nothing.
  it("starts again from nothing after a 416 to its Range request (MD-N18-4)", async () => {
    const dest = tmp();
    const stale = Buffer.concat([WEIGHTS, Buffer.alloc(500, 1)]);
    writeFileSync(join(dest, "model-Q4_K_M.gguf.part"), stale);
    const { sizeBytes: _unknown, ...noSize } = at("range");
    const r = await downloadModel({ model: "tiny", source: noSize, destDir: dest, fetch });
    expect(ranges).toEqual([`bytes=${stale.length}-`, undefined]);
    expect(r).toMatchObject({ sha256: SHA, bytes: WEIGHTS.length, verified: true });
    expect(readFileSync(r.path).equals(WEIGHTS)).toBe(true);
    expect(readdirSync(dest)).toEqual(["model-Q4_K_M.gguf"]);
  });

  // C4 (C3's review): a person's cancel mid-stream keeps what was received,
  // and the next run resumes from it.
  it("keeps the .part when a person cancels mid-stream, and the next run resumes it", async () => {
    const dest = tmp();
    const part = join(dest, "model-Q4_K_M.gguf.part");
    const ac = new AbortController();
    const err = await downloadModel({
      model: "tiny",
      source: at("stall"),
      destDir: dest,
      fetch: async (url, init) => {
        const res = await fetch(url, init);
        setTimeout(() => ac.abort(), 300);
        return res;
      },
      signal: ac.signal,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(/cancelled.*kept in model-Q4_K_M\.gguf\.part/);
    const kept = statSync(part).size;
    expect(kept).toBe(WEIGHTS.length / 2);
    expect(readFileSync(part).equals(WEIGHTS.subarray(0, kept))).toBe(true);
    const r = await downloadModel({ model: "tiny", source: at("range"), destDir: dest, fetch });
    expect(ranges.at(-1)).toBe(`bytes=${kept}-`);
    expect(readFileSync(r.path).equals(WEIGHTS)).toBe(true);
  });

  it("places a kept file that is already whole after checking its hash, with no request", async () => {
    const dest = tmp();
    writeFileSync(join(dest, "model-Q4_K_M.gguf.part"), WEIGHTS);
    const r = await downloadModel({ model: "tiny", source: at("range"), destDir: dest, fetch });
    expect(requests).toEqual([]);
    expect(r).toMatchObject({ sha256: SHA, verified: true });
    expect(readdirSync(dest)).toEqual(["model-Q4_K_M.gguf"]);
  });

  it("refuses before starting when the volume has less free space than the download needs, naming both sizes (MD-N18-2)", async () => {
    const dest = tmp();
    const s = statfsSync(dest);
    const free = Number(s.bavail) * Number(s.bsize);
    const err = await downloadModel({
      model: "tiny",
      source: { ...at("range"), sizeBytes: free + 50e9 },
      destDir: dest,
      fetch,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DownloadRefused);
    expect(String(err.message)).toMatch(/needs [\d.]+ GB.*has [\d.]+ [GMk]?B free/);
    expect(requests).toEqual([]);
    expect(readdirSync(dest)).toEqual([]);
  });

  it("is one function for any verified file: downloadVerified(source, dest), as the engine's download uses it", async () => {
    const dest = tmp();
    const r = await downloadVerified(
      at("range"),
      { dir: dest, fileName: "llama-b10809-bin-macos-arm64.zip" },
      { label: "llama.cpp b10809", fetch },
    );
    expect(r.path).toBe(join(dest, "llama-b10809-bin-macos-arm64.zip"));
    expect(readFileSync(r.path).equals(WEIGHTS)).toBe(true);
    const refused = await downloadVerified(
      { url: at("range").url, sha256: "" },
      { dir: dest },
      { label: "llama.cpp b10809", fetch },
    ).catch((e) => e);
    expect(refused).toBeInstanceOf(DownloadRefused);
    expect(String(refused.message)).toMatch(/llama\.cpp b10809/);
  });
});

describe("hf_lookup (the model sources table, MD-N13-2, SEC-N10-3)", () => {
  it("looks up a registered file's official URL and published SHA-256", async () => {
    const found = await lookupPublishedFile("org/model-GGUF", "model-Q4_K_M.gguf", {
      fetch,
      hub: base,
    });
    expect(found).toEqual({
      url: `${base}/org/model-GGUF/resolve/main/model-Q4_K_M.gguf`,
      host: "127.0.0.1",
      sha256: SHA,
      sizeBytes: WEIGHTS.length,
      repo: "org/model-GGUF",
      file: "model-Q4_K_M.gguf",
    });
  });

  it("matches by the header's name only and fills what the header lacks, marking each value's source", async () => {
    const r = await matchOnHub(
      { name: "Tiny Llama 1B", metadata: { architecture: "llama", contextLength: 32768 } },
      { fetch, hub: base, research: true },
    );
    expect(r.lookedUp).toBe(true);
    expect(r.metadata).toMatchObject({
      architecture: "llama",
      parametersTotal: 1_100_000_000,
      license: "apache-2.0",
      baseModel: "org/Tiny-Llama-1B",
      sources: { parametersTotal: "huggingface", license: "huggingface", baseModel: "huggingface" },
    });
    expect(r.metadata?.sources?.architecture).toBeUndefined();
    // Never a path or a file name from this machine.
    for (const url of requests) expect(url).not.toMatch(/\.gguf|\/Users\/|%2F(Users|Volumes)/i);
    expect(requests[0]).toMatch(/search=Tiny(\+|%20)Llama(\+|%20)1B/);
  });

  it("makes no lookup when research is not allowed, and says so", async () => {
    const r = await matchOnHub(
      { name: "Tiny Llama 1B", metadata: {} },
      { fetch, hub: base, research: false },
    );
    expect(r.lookedUp).toBe(false);
    expect(r.note).toMatch(/No lookup was made/);
    expect(requests).toEqual([]);
  });
});

describe("the registry's source, hash and weights (registry.ts)", () => {
  it("records a source and repoints the weights only to a copy with the same hash, keeping the original", () => {
    const dir = tmp();
    const reg = new ModelRegistry(join(dir, "models.json"));
    reg.upsert("tiny", { family: "llama" });
    reg.recordSource("tiny", source());
    expect(reg.get("tiny")?.source?.sha256).toBe(SHA);
    expect(reg.get("tiny")?.sha256).toBe(SHA);
    reg.recordWeights("tiny", { path: "/Volumes/USB/tiny.gguf", volume: "external", sha256: SHA });
    expect(() =>
      reg.recordWeights("tiny", {
        path: "/Users/me/tiny.gguf",
        volume: "internal",
        sha256: "1".repeat(64),
      }),
    ).toThrow(/hash/);
    reg.recordWeights("tiny", { path: "/Users/me/tiny.gguf", volume: "internal", sha256: SHA });
    expect(reg.preferredWeights("tiny")).toBe("/Users/me/tiny.gguf");
    expect(reg.get("tiny")?.copies?.map((c) => c.path)).toEqual([
      "/Volumes/USB/tiny.gguf",
      "/Users/me/tiny.gguf",
    ]);
    const again = new ModelRegistry(join(dir, "models.json"));
    expect(again.preferredWeights("tiny")).toBe("/Users/me/tiny.gguf");
    expect(existsSync(join(dir, "models.json"))).toBe(true);
  });
});
