import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRegistry } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * A model download as a person runs it (C2d, FINDINGS_C1 TST-01; models.md
 * rule 4e, NEW-models-18): the built command `sekhemet dev models fetch
 * <model>` spawned with a throwaway home, its source a real HTTP server on
 * this machine that the test controls — cut mid-body, answering a Range
 * request with 206, or ignoring it with 200. No request leaves the machine.
 */

const BIN = resolve(import.meta.dirname, "../dist/index.js");
const WEIGHTS = Buffer.alloc(3 * 1024 * 1024);
for (let i = 0; i < WEIGHTS.length; i++) WEIGHTS[i] = (i * 31 + 7) % 251;
const SHA = createHash("sha256").update(WEIGHTS).digest("hex");

type Mode = "cut" | "range" | "ignore-range";
let dir: string;
let server: Server;
let base: string;
let mode: Mode;
let requests: { range?: string }[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sek-download-"));
  for (const d of ["cwd", "home", "models"]) mkdirSync(join(dir, d), { recursive: true });
  // Offline: only this machine may be reached, as a person's air-gapped setup.
  writeFileSync(join(dir, "user.toml"), '[network]\nmode = "offline"\n');
  requests = [];
  mode = "range";
  server = createServer((req, res) => {
    const range = req.headers.range;
    requests.push(range ? { range } : {});
    const from = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    if (mode === "cut") {
      // Half the body, then the connection drops.
      res.writeHead(200, { "content-length": WEIGHTS.length });
      res.write(WEIGHTS.subarray(0, WEIGHTS.length / 2), () => res.socket?.destroy());
      return;
    }
    if (mode === "range" && range) {
      res.writeHead(206, {
        "content-length": WEIGHTS.length - from,
        "content-range": `bytes ${from}-${WEIGHTS.length - 1}/${WEIGHTS.length}`,
      });
      res.end(WEIGHTS.subarray(from));
      return;
    }
    res.writeHead(200, { "content-length": WEIGHTS.length });
    res.end(WEIGHTS);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const registryPath = () => join(dir, "home", ".sekhemet", "models.json");

/** The model's source as a registry entry records it (what `models fetch` reads). */
function source(sizeBytes = WEIGHTS.length): void {
  new ModelRegistry(registryPath()).recordSource("tiny", {
    url: `${base}/o/r/resolve/main/tiny.gguf`,
    host: "127.0.0.1",
    sha256: SHA,
    sizeBytes,
  });
}

/** `sekhemet dev models fetch <args>` spawned with the throwaway home. */
function fetchModel(args: string[]): Promise<{ status: number | null; out: string }> {
  const home = join(dir, "home");
  return new Promise((done) => {
    const child = spawn(process.execPath, [BIN, "dev", "models", "fetch", ...args], {
      cwd: join(dir, "cwd"),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        SEKHEMET_CONFIG_DIR: join(home, ".sekhemet"),
        SEKHEMET_MODEL_REGISTRY: registryPath(),
        SEKHEMET_USER_CONFIG: join(dir, "user.toml"),
        SEKHEMET_MODELS_DIR: join(dir, "models"),
        SEKHEMET_MODEL_LOADS: "off",
        SEKHEMET_KEYCHAIN: "off",
        BROWSER: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => {
      out += String(b);
    });
    child.stderr.on("data", (b) => {
      out += String(b);
    });
    child.on("close", (status) => done({ status, out }));
  });
}

const part = () => join(dir, "models", "tiny.gguf.part");
const whole = () => join(dir, "models", "tiny.gguf");

describe("an interrupted download is resumed (MD-N18-1, MD-N18-4)", () => {
  it("MD-N18-1, MD-N18-4: a cut download keeps its .part; the next fetch asks for the rest with a Range from the kept length, appends the 206 and verifies the whole", async () => {
    source();
    mode = "cut";
    const cut = await fetchModel(["tiny"]);
    expect(cut.status).not.toBe(0);
    expect(existsSync(whole())).toBe(false);
    expect(existsSync(part())).toBe(true);
    const kept = statSync(part()).size;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(WEIGHTS.length);
    expect(readFileSync(part()).equals(WEIGHTS.subarray(0, kept))).toBe(true);
    mode = "range";
    const resumed = await fetchModel(["tiny"]);
    expect(resumed.status).toBe(0);
    expect(resumed.out).toMatch(/Verified\. tiny is ready to assign/);
    expect(requests.at(-1)).toEqual({ range: `bytes=${kept}-` });
    expect(readFileSync(whole()).equals(WEIGHTS)).toBe(true);
    expect(existsSync(part())).toBe(false);
  }, 120_000);

  it("MD-N18-4: a server that ignores the Range and answers 200 is taken from nothing, never appended to the kept bytes", async () => {
    source();
    // A kept .part whose bytes are wrong for the file: appending would corrupt it.
    writeFileSync(part(), Buffer.alloc(1024 * 1024, 0xee));
    mode = "ignore-range";
    const done = await fetchModel(["tiny"]);
    expect(done.status).toBe(0);
    expect(requests[0]?.range).toBe(`bytes=${1024 * 1024}-`);
    expect(readFileSync(whole()).equals(WEIGHTS)).toBe(true);
  }, 120_000);
});

describe("a download larger than the volume's free space (MD-N18-2)", () => {
  it("MD-N18-2: is refused before any request, naming both sizes", async () => {
    // A source declaring more bytes than any disk here has free.
    source(512 * 1024 ** 4);
    const refused = await fetchModel(["tiny"]);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toMatch(/needs [\d.]+ [TGM]B.*has [\d.]+ [TGMk]?B free/);
    expect(requests).toEqual([]);
    expect(existsSync(part())).toBe(false);
  }, 60_000);
});
