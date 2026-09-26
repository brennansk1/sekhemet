import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lookupPublishedFile, matchOnHub } from "../src/hf_lookup.js";
import { DownloadHashMismatch, DownloadRefused, downloadModel } from "../src/model_download.js";
import { ModelRegistry } from "../src/registry.js";

// MD-N12-6, MD-N12-7, SEC-53, DB-N6-6/7: one explicit download, from the
// registered source only, through the network policy, verified by SHA-256
// before the file is used. MD-N13-2, SEC-N10-3: a lookup sends a name only.

const WEIGHTS = Buffer.alloc(300_000, 7);
const SHA = createHash("sha256").update(WEIGHTS).digest("hex");

let server: Server;
let base = "";
let requests: string[] = [];
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sek-dl-"));
  dirs.push(d);
  return d;
};

beforeEach(async () => {
  requests = [];
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    const url = new URL(req.url ?? "/", "http://x");
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

  it("cancels, deleting the partial file", async () => {
    const dest = tmp();
    const ac = new AbortController();
    ac.abort();
    await expect(
      downloadModel({ model: "tiny", source: source(), destDir: dest, fetch, signal: ac.signal }),
    ).rejects.toThrow(/cancel/i);
    expect(readdirSync(dest)).toEqual([]);
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
