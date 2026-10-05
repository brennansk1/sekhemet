import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ENGINE_FLOOR,
  ENGINE_PIN,
  type EnginePin,
  EngineRefused,
  detectEnginePlatform,
  engineAssetUrl,
  engineFixes,
  getEngine,
  llamaBuildNumber,
  parseTar,
  pinnedAsset,
  readLlamaBuild,
  resolveLlamaServer,
} from "../src/inference_engine.js";
import * as viaLlamaServer from "../src/llama_server.js";
import { DownloadHashMismatch } from "../src/model_download.js";
import { SHIPPED_ENGINE_FLOOR, SHIPPED_MODELS } from "../src/shipped_models.js";

// NEW-models-16 and NEW-models-19 (models rules 6a, 6b; DEC-53 c7): the engine
// is found, its build read and checked against the floor, and fetched only on
// a person's yes from the one pinned release, hash-checked before unpacking,
// unpacked safely into the user directory.

// ── a tar writer for the archives the tests serve ─────────────────────────
interface Entry {
  name: string;
  type?: "0" | "2" | "5" | "1";
  body?: string;
  link?: string;
  mode?: number;
}
function header(e: Entry, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(e.name, 0, 100, "utf8");
  h.write(`${(e.mode ?? (e.type === "5" ? 0o755 : 0o644)).toString(8).padStart(7, "0")}\0`, 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(e.type ?? "0", 156);
  if (e.link) h.write(e.link, 157, 100, "utf8");
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}
function tarGz(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? "");
    const size = e.type === "0" || e.type === undefined ? body.length : 0;
    parts.push(header(e, size));
    if (size) {
      parts.push(body);
      const pad = (512 - (size % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}
const fakeServer = (build: number) =>
  `#!/bin/sh\necho "version: 0.4.0 (build ${build}, commit 5266f24da)" 1>&2\necho "built with test for test" 1>&2\n`;
const goodArchive = (build = 10809) =>
  tarGz([
    { name: `llama-b${build}/`, type: "5" },
    { name: `llama-b${build}/llama-server`, body: fakeServer(build), mode: 0o755 },
    { name: `llama-b${build}/libggml.dylib`, body: "lib" },
    { name: `llama-b${build}/libllama.dylib`, type: "2", link: "libggml.dylib" },
  ]);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("the pin and the floor (MD-N16-1, rule 6b)", () => {
  it("pins one release at or above every shipped model's floor, each asset with its hash", () => {
    expect(ENGINE_FLOOR).toBe(SHIPPED_ENGINE_FLOOR);
    expect(ENGINE_PIN.build).toBeGreaterThanOrEqual(ENGINE_FLOOR);
    for (const m of SHIPPED_MODELS)
      if (m.minLlamaBuild) expect(ENGINE_PIN.build).toBeGreaterThanOrEqual(m.minLlamaBuild);
    expect(ENGINE_PIN.release).toBe(`b${ENGINE_PIN.build}`);
    expect(ENGINE_PIN.license).toBe("MIT");
    expect(ENGINE_PIN.assets.map((a) => `${a.os}-${a.arch}-${a.backend}`).sort()).toEqual([
      "darwin-arm64-metal",
      "linux-x64-cpu",
      "linux-x64-vulkan",
    ]);
    for (const a of ENGINE_PIN.assets) {
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.file).toMatch(new RegExp(`^llama-${ENGINE_PIN.release}-bin-.*\\.tar\\.gz$`));
      expect(engineAssetUrl(ENGINE_PIN, a)).toBe(
        `https://github.com/ggml-org/llama.cpp/releases/download/${ENGINE_PIN.release}/${a.file}`,
      );
    }
  });

  it("is recorded in PROVENANCE: every asset's file, hash, size and licence", () => {
    const provenance = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "docs", "reference", "PROVENANCE.md"),
      "utf8",
    );
    for (const a of ENGINE_PIN.assets) {
      const row = provenance.split("\n").find((l) => l.includes(`\`${a.file}\``));
      expect(row, a.file).toBeDefined();
      expect(row).toContain(`\`${a.sha256}\``);
      expect(row).toContain(a.sizeBytes.toLocaleString("en-US"));
      expect(row).toMatch(/\| MIT \|$/);
    }
  });

  it("offers an asset only for a pinned platform and backend (MD-N19-3)", () => {
    expect(pinnedAsset(ENGINE_PIN, { os: "darwin", arch: "arm64", backend: "metal" })?.file).toBe(
      "llama-b10809-bin-macos-arm64.tar.gz",
    );
    expect(pinnedAsset(ENGINE_PIN, { os: "linux", arch: "x64", backend: "vulkan" })?.file).toBe(
      "llama-b10809-bin-ubuntu-vulkan-x64.tar.gz",
    );
    expect(pinnedAsset(ENGINE_PIN, { os: "linux", arch: "x64", backend: "cuda" })).toBeUndefined();
    expect(pinnedAsset(ENGINE_PIN, { os: "win32", arch: "x64", backend: "cpu" })).toBeUndefined();
  });

  it("detects the backend from what the machine has", () => {
    expect(detectEnginePlatform({ platform: "darwin", arch: "arm64" }).backend).toBe("metal");
    const none = { exists: () => false };
    expect(detectEnginePlatform({ platform: "linux", arch: "x64", probe: none }).backend).toBe(
      "cpu",
    );
    const nvidia = { exists: (p: string) => p === "/proc/driver/nvidia" };
    expect(detectEnginePlatform({ platform: "linux", arch: "x64", probe: nvidia }).backend).toBe(
      "cuda",
    );
    const vk = { exists: (p: string) => p === "/usr/share/vulkan/icd.d" };
    expect(detectEnginePlatform({ platform: "linux", arch: "x64", probe: vk }).backend).toBe(
      "vulkan",
    );
  });

  it("is re-exported from llama_server, and reads build numbers", () => {
    expect(viaLlamaServer.resolveLlamaServer).toBe(resolveLlamaServer);
    expect(viaLlamaServer.llamaBuildNumber).toBe(llamaBuildNumber);
    expect(llamaBuildNumber("version: 0.4.0 (build 10809, commit 5266f24da)")).toBe(10809);
    expect(llamaBuildNumber("b10828-abc")).toBe(10828);
  });
});

describe("finding the engine (MD-N16-1, MD-N19-5)", () => {
  const bin = (dir: string, build: number) => {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "llama-server");
    writeFileSync(p, fakeServer(build));
    chmodSync(p, 0o755);
    return p;
  };

  it("reads the build from --version, and nothing from a missing program", () => {
    const d = tmp("eng-read-");
    expect(readLlamaBuild(bin(d, 10809))).toBe(10809);
    expect(readLlamaBuild(join(d, "absent"))).toBeUndefined();
  });

  it("uses SEKHEMET_LLAMA_SERVER when set, whatever else is there", () => {
    const d = tmp("eng-env-");
    const set = bin(join(d, "set"), 9000);
    const user = join(d, "user");
    bin(join(user, "engines", "llama.cpp-b10809", "llama-b10809"), 10809);
    const r = resolveLlamaServer({ env: { SEKHEMET_LLAMA_SERVER: set, PATH: "" }, userDir: user });
    expect(r.engine).toMatchObject({ path: set, origin: "setting", build: 9000 });
    expect(r.meetsFloor).toBe(false);
  });

  it("prefers the newer of the downloaded engine and PATH's that meets the floor", () => {
    const d = tmp("eng-pick-");
    const user = join(d, "user");
    const downloaded = bin(join(user, "engines", "llama.cpp-b10809", "llama-b10809"), 10809);
    const onPath = bin(join(d, "path"), 10900);
    const r = resolveLlamaServer({ env: { PATH: join(d, "path") }, userDir: user });
    expect(r.engine).toMatchObject({ path: onPath, origin: "path", build: 10900 });
    // PATH's is below the floor: the downloaded one is used.
    const old = bin(join(d, "old"), 8000);
    const r2 = resolveLlamaServer({ env: { PATH: join(d, "old") }, userDir: user });
    expect(r2.engine).toMatchObject({ path: downloaded, origin: "downloaded", build: 10809 });
    expect(r2.meetsFloor).toBe(true);
    expect(r2.candidates.map((c) => c.path)).toContain(old);
  });

  it("names a below-floor engine when it is the only one, and nothing when none", () => {
    const d = tmp("eng-low-");
    bin(join(d, "old"), 8000);
    const r = resolveLlamaServer({ env: { PATH: join(d, "old") }, userDir: join(d, "u") });
    expect(r.engine?.build).toBe(8000);
    expect(r.meetsFloor).toBe(false);
    const none = resolveLlamaServer({ env: { PATH: "" }, userDir: join(d, "u") });
    expect(none.engine).toBeUndefined();
  });

  it("names this platform's fixes, every named page existing (MD-N16-2)", () => {
    const mac = engineFixes({ os: "darwin", arch: "arm64", backend: "metal" });
    expect(mac.join(" ")).toMatch(/Get the inference engine/);
    expect(mac.join(" ")).toMatch(/brew install llama\.cpp/);
    const cuda = engineFixes({ os: "linux", arch: "x64", backend: "cuda" });
    expect(cuda.join(" ")).not.toMatch(/Get the inference engine/);
    expect(cuda.join(" ")).toMatch(/docs\/reference\/INSTALL\.md/);
    expect(cuda.join(" ")).not.toMatch(/HARNESS_DESIGN/);
  });
});

describe("parsing an archive safely (zip-slip)", () => {
  it("reads files, folders and links inside the archive", () => {
    const entries = parseTar(goodArchive());
    expect(entries.map((e) => `${e.type} ${e.name}`)).toEqual([
      "dir llama-b10809",
      "file llama-b10809/llama-server",
      "file llama-b10809/libggml.dylib",
      "symlink llama-b10809/libllama.dylib",
    ]);
  });

  it.each([
    ["a parent path", [{ name: "../evil", body: "x" }]],
    ["an absolute path", [{ name: "/tmp/evil", body: "x" }]],
    ["a link out of the archive", [{ name: "a/out", type: "2" as const, link: "../../etc" }]],
    ["an absolute link", [{ name: "a/out", type: "2" as const, link: "/etc/passwd" }]],
    ["a hard link out", [{ name: "a/h", type: "1" as const, link: "../x" }]],
  ])("refuses %s", (_what, entries) => {
    expect(() => parseTar(tarGz(entries))).toThrow(EngineRefused);
  });
});

describe("Get the inference engine (MD-N19-1..4)", () => {
  let server: Server;
  let base: string;
  let requests: string[];
  let archive: Buffer;
  beforeEach(async () => {
    requests = [];
    archive = goodArchive();
    server = createServer((req, res) => {
      requests.push(`${req.headers.host} ${req.url}`);
      if (req.url === "/release/asset.tar.gz") {
        res.writeHead(302, { location: `${base}/cdn/asset.tar.gz?sig=abc` });
        return res.end();
      }
      if (req.url === "/release/elsewhere.tar.gz") {
        res.writeHead(302, { location: `${base.replace("127.0.0.1", "localhost")}/x.tar.gz` });
        return res.end();
      }
      if (req.url?.startsWith("/cdn/asset.tar.gz")) {
        res.writeHead(200, { "content-length": archive.length });
        return res.end(archive);
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    base = `http://127.0.0.1:${port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const pinFor = (file = "asset.tar.gz", digest = sha(archive)): EnginePin => ({
    ...ENGINE_PIN,
    baseUrl: `${base}/release`,
    hosts: ["127.0.0.1"],
    assets: [
      {
        os: "darwin",
        arch: "arm64",
        backend: "metal",
        file,
        sha256: digest,
        sizeBytes: archive.length,
      },
    ],
  });
  const platform = { os: "darwin", arch: "arm64", backend: "metal" } as const;

  it("downloads the pinned asset, follows checked hops, unpacks it under engines/", async () => {
    const user = tmp("eng-user-");
    const hops: string[] = [];
    const done = await getEngine({
      pin: pinFor(),
      platform,
      userDir: user,
      fetch: (url, init) => {
        hops.push(new URL(url).hostname);
        return fetch(url, init);
      },
    });
    expect(hops).toEqual(["127.0.0.1", "127.0.0.1"]);
    expect(done).toMatchObject({
      release: "b10809",
      asset: "asset.tar.gz",
      sha256: sha(archive),
      bytes: archive.length,
      build: 10809,
    });
    expect(done.dir).toBe(join(user, "engines", "llama.cpp-b10809"));
    expect(done.binary).toBe(join(done.dir, "llama-b10809", "llama-server"));
    expect(existsSync(done.binary)).toBe(true);
    // Nothing outside the user directory; no archive left behind.
    expect(readdirSync(join(user, "engines")).sort()).toEqual(["llama.cpp-b10809"]);
    const found = resolveLlamaServer({ env: { PATH: "" }, userDir: user });
    expect(found.engine).toMatchObject({ origin: "downloaded", build: 10809 });
  });

  it("refuses a hop to a host the pin does not name, before asking it", async () => {
    const user = tmp("eng-hop-");
    await expect(
      getEngine({ pin: pinFor("elsewhere.tar.gz"), platform, userDir: user, fetch }),
    ).rejects.toThrow(/localhost/);
    expect(requests.some((r) => r.startsWith("localhost"))).toBe(false);
    expect(existsSync(join(user, "engines", "llama.cpp-b10809"))).toBe(false);
  });

  it("refuses under the network policy before any request, naming the setting", async () => {
    const user = tmp("eng-off-");
    await expect(
      getEngine({
        pin: pinFor(),
        platform,
        userDir: user,
        fetch,
        refusal: () => "offline ([network] mode)",
      }),
    ).rejects.toThrow(/\[network\] mode/);
    expect(requests).toEqual([]);
  });

  it("refuses a policy refusal on a redirect hop", async () => {
    const user = tmp("eng-hop2-");
    await expect(
      getEngine({
        pin: pinFor(),
        platform,
        userDir: user,
        fetch,
        refusal: (_host, hop) => (hop > 0 ? "not allowed ([network] mode)" : undefined),
      }),
    ).rejects.toThrow(/not allowed/);
    expect(requests).toHaveLength(1);
  });

  it("deletes a file whose hash differs and unpacks nothing", async () => {
    const user = tmp("eng-hash-");
    await expect(
      getEngine({ pin: pinFor("asset.tar.gz", "0".repeat(64)), platform, userDir: user, fetch }),
    ).rejects.toThrow(DownloadHashMismatch);
    expect(existsSync(join(user, "engines", "llama.cpp-b10809"))).toBe(false);
    expect(readdirSync(join(user, "engines", ".downloads"))).toEqual([]);
  });

  it("refuses an archive that would write outside its folder, leaving nothing", async () => {
    archive = tarGz([{ name: "../../escaped", body: "x" }]);
    const user = tmp("eng-slip-");
    await expect(getEngine({ pin: pinFor(), platform, userDir: user, fetch })).rejects.toThrow(
      EngineRefused,
    );
    expect(existsSync(join(user, "escaped"))).toBe(false);
    expect(readdirSync(join(user, "engines")).filter((n) => !n.startsWith("."))).toEqual([]);
  });

  it("says so and offers nothing where no asset is pinned (MD-N19-3)", async () => {
    const user = tmp("eng-none-");
    await expect(
      getEngine({
        pin: pinFor(),
        platform: { os: "linux", arch: "x64", backend: "cuda" },
        userDir: user,
        fetch,
      }),
    ).rejects.toThrow(/INSTALL\.md/);
    expect(requests).toEqual([]);
  });
});
