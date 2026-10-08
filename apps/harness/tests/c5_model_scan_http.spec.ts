import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BIN, type G6Repo, g6Repo } from "./support/g6_review.js";
import { guardedImports, trackChild } from "./support/hygiene.js";

/**
 * The model scan's header limit, at its door (security SEC-N10-2; C2d G6
 * finding 8 routed to C5): `sekhemet serve` spawned as the built binary
 * (`apps/harness/dist/index.js`) over a folder of hand-made GGUF files, asked
 * `/api/config/models` over HTTP. No file is loaded as a model.
 */

const str = (v: string) => {
  const b = Buffer.from(v, "utf8");
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(b.length));
  return Buffer.concat([len, b]);
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

/** A GGUF v3 header from key/values (each a string, or an array of `count` short strings). */
function gguf(kvs: Buffer[]): Buffer {
  const header = Buffer.concat([Buffer.from("GGUF"), u32(3), u64(0), u64(kvs.length), ...kvs]);
  return Buffer.concat([header, Buffer.alloc((32 - (header.length % 32)) % 32)]);
}
const stringKv = (key: string, value: string) => Buffer.concat([str(key), u32(8), str(value)]);
function arrayKv(key: string, count: number): Buffer {
  const one = str("t");
  const body = Buffer.alloc(one.length * count);
  for (let i = 0; i < count; i++) one.copy(body, one.length * i);
  return Buffer.concat([str(key), u32(9), u32(8), u64(count), body]);
}

async function scanned(r: G6Repo, folder: string) {
  const child = trackChild(
    spawn(process.execPath, [...guardedImports(), BIN, "serve", "--port", "0"], {
      cwd: r.repo,
      env: r.env({ env: { SEKHEMET_MODELS_DIR: folder } }),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    }),
  );
  let out = "";
  child.stderr?.on("data", (d) => {
    out += String(d);
  });
  const address = await new Promise<string>((ok, bad) => {
    const timer = setTimeout(() => bad(new Error(`no address: ${out}`)), 30_000);
    child.stdout?.on("data", (d) => {
      out += String(d);
      const m = /running at:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        ok(m[1] as string);
      }
    });
  });
  const res = await fetch(`${address}/api/config/models`);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    models: { file: string }[];
    skipped: { path: string; reason: string }[];
  };
}

describe("SEC-N10-2: an oversized header is header_too_large however it is oversized", () => {
  it("SEC-N10-2: a header oversized by one 17 MB string, or by an array of more than a million entries, is skipped as header_too_large, not unreadable", async () => {
    const r = g6Repo("sek-c5-scan-");
    const folder = join(r.root, "models");
    mkdirSync(folder);
    writeFileSync(join(folder, "fine.gguf"), gguf([stringKv("general.name", "tiny")]));
    writeFileSync(
      join(folder, "long-string.gguf"),
      gguf([
        stringKv("general.name", "x"),
        stringKv("general.description", "a".repeat(17_000_000)),
      ]),
    );
    writeFileSync(
      join(folder, "many-entries.gguf"),
      gguf([stringKv("general.name", "y"), arrayKv("tokenizer.ggml.tokens", 1_000_001)]),
    );
    const m = await scanned(r, folder);
    expect(m.models.map((x) => x.file)).toEqual(["fine.gguf"]);
    const reasonOf = (f: string) => m.skipped.find((s) => s.path === join(folder, f))?.reason;
    expect(reasonOf("long-string.gguf")).toBe("header_too_large");
    expect(reasonOf("many-entries.gguf")).toBe("header_too_large");
  }, 90_000);
});
