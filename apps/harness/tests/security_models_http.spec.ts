import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedModel } from "./support/g2_model.js";
import { webStub } from "./support/g2_web.js";
import { BIN, type G6Repo, g6Repo } from "./support/g6_review.js";

/**
 * security item 41a (NEW-security-10, the model folder scan) at the door
 * (C2d, FINDINGS_C1 TST-01): `sekhemet serve` spawned with a model folder
 * (`SEKHEMET_MODELS_DIR`), and Configuration › Models read over HTTP
 * (`GET /api/config/models`, which scans the folder) as the page reads it.
 * A model's look-up on Hugging Face (`GET /api/config/models/<id>?lookup=1`)
 * goes to a local stub: the spawned server's `node:https` is routed there
 * by `g2_model.ts`'s preload, after the network policy decided, so nothing
 * leaves this machine and the stub records exactly what was sent.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned through
 * `support/g6_review.ts` (`BIN`).
 */

const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
});

/**
 * A minimal GGUF v3 file: no tensors, string metadata keys, and optionally a
 * `tokenizer.ggml.tokens` array of `tokens` twelve-character strings (how a
 * real header grows large: a vocabulary, not one long value).
 */
function gguf(entries: Record<string, string>, tokens = 0): Buffer {
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
  const kvs = Object.entries(entries).map(([k, v]) => Buffer.concat([str(k), u32(8), str(v)]));
  if (tokens > 0) {
    const one = str("tok_00000000");
    const body = Buffer.alloc(one.length * tokens);
    for (let i = 0; i < tokens; i++) one.copy(body, one.length * i);
    kvs.push(Buffer.concat([str("tokenizer.ggml.tokens"), u32(9), u32(8), u64(tokens), body]));
  }
  const header = Buffer.concat([Buffer.from("GGUF"), u32(3), u64(0), u64(kvs.length), ...kvs]);
  // The tensor data starts at the next 32-byte boundary (GGUF's default
  // alignment): a file that stops before it is a truncated one.
  return Buffer.concat([header, Buffer.alloc((32 - (header.length % 32)) % 32)]);
}

const small = () => gguf({ "general.name": "tiny" });

interface Models {
  models: { id: string; file: string; path: string }[];
  skipped: { path: string; reason: string }[];
}

/**
 * `sekhemet serve` with the model folder `folder` (and `nodeArgs` before the
 * binary, `env` added); `use` gets its address, then the server stops.
 */
async function served<T>(
  r: G6Repo,
  folder: string,
  use: (address: string) => Promise<T>,
  opts: { nodeArgs?: string[]; env?: Record<string, string> } = {},
): Promise<T> {
  const child = spawn(process.execPath, [...(opts.nodeArgs ?? []), BIN, "serve", "--port", "0"], {
    cwd: r.repo,
    env: r.env({ env: { SEKHEMET_MODELS_DIR: folder, ...opts.env } }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
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
    child.once("exit", (code) => bad(new Error(`serve exited ${code}: ${out}`)));
  });
  try {
    return await use(address);
  } finally {
    child.kill("SIGTERM");
  }
}

async function scanned(r: G6Repo, folder: string): Promise<Models> {
  return served(r, folder, async (address) => {
    const res = await fetch(`${address}/api/config/models`);
    expect(res.status).toBe(200);
    return (await res.json()) as Models;
  });
}

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("SEC-N10-1, SEC-N10-2: what the model scan opens", () => {
  it("SEC-N10-1: a symbolic link whose target lies outside the chosen folder is not followed and is reported as skipped", async () => {
    const r = g6Repo();
    const outside = join(r.root, "outside");
    const folder = join(r.root, "models");
    mkdirSync(outside);
    mkdirSync(folder);
    writeFileSync(join(outside, "secret.gguf"), small());
    writeFileSync(join(folder, "inside.gguf"), small());
    symlinkSync(join(outside, "secret.gguf"), join(folder, "escape.gguf"));
    symlinkSync(join(folder, "inside.gguf"), join(folder, "alias.gguf"));
    const m = await scanned(r, folder);
    expect(m.models.map((x) => x.file).sort()).toEqual(["alias.gguf", "inside.gguf"]);
    expect(m.models.some((x) => x.path.startsWith(outside))).toBe(false);
    expect(m.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: join(folder, "escape.gguf"), reason: "symlink_outside" }),
      ]),
    );
  }, 90_000);

  it("SEC-N10-2: a header over the 16 MB limit, a malformed header and an unknown extension are skipped without loading, and no file is changed", async () => {
    const r = g6Repo();
    const folder = join(r.root, "models");
    mkdirSync(folder);
    writeFileSync(join(folder, "fine.gguf"), small());
    writeFileSync(join(folder, "huge.gguf"), gguf({ "general.name": "huge" }, 900_000));
    writeFileSync(
      join(folder, "broken.gguf"),
      Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(7, 0xff)]),
    );
    writeFileSync(join(folder, "weights.bin"), Buffer.alloc(100));
    const files = ["fine.gguf", "huge.gguf", "broken.gguf", "weights.bin"].map((f) =>
      join(folder, f),
    );
    const before = files.map((f) => [digest(f), statSync(f).mtimeMs]);
    const m = await scanned(r, folder);
    expect(m.models.map((x) => x.file)).toEqual(["fine.gguf"]);
    const reasonOf = (f: string) => m.skipped.find((s) => s.path === join(folder, f))?.reason;
    expect(reasonOf("huge.gguf")).toBe("header_too_large");
    expect(reasonOf("broken.gguf")).toMatch(/\w/);
    expect(reasonOf("broken.gguf")).not.toBe("header_too_large");
    expect(reasonOf("weights.bin")).toBe("not_a_model");
    expect(files.map((f) => [digest(f), statSync(f).mtimeMs])).toEqual(before);
  }, 90_000);
});

describe("SEC-N10-3: a Hugging Face look-up sends a name, through the research policy", () => {
  const HUB_ID = "acme/tiny-test-model-GGUF";

  async function lookUp(r: G6Repo, userConfig: string) {
    // A folder and a file whose names say where they live on this machine.
    const folder = join(r.root, "jane-private-models");
    mkdirSync(folder);
    writeFileSync(
      join(folder, "secret-client-build.gguf"),
      gguf({ "general.name": "tiny-test-model" }),
    );
    r.userConfig(userConfig);
    const stub = await webStub({
      "huggingface.co/api/models": () => ({
        type: "application/json",
        body: JSON.stringify([{ id: HUB_ID }]),
      }),
      [`huggingface.co/api/models/${HUB_ID}`]: {
        type: "application/json",
        body: JSON.stringify({
          id: HUB_ID,
          gguf: { total: 1_000_000, context_length: 4096 },
          cardData: { license: "mit" },
        }),
      },
    });
    const { preload } = scriptedModel(r.home);
    const detail = await served(
      r,
      folder,
      async (address) => {
        const list = (await (await fetch(`${address}/api/config/models`)).json()) as Models;
        const id = list.models[0]?.id ?? "";
        const res = await fetch(`${address}/api/config/models/${encodeURIComponent(id)}?lookup=1`);
        expect(res.status).toBe(200);
        return (await res.json()) as {
          lookup: { lookedUp: boolean; repo?: string; note?: string };
          metadata?: { license?: string; sources?: Record<string, string> };
        };
      },
      { nodeArgs: ["--import", preload], env: { G2_STUB_PORT: String(stub.port) } },
    );
    const egress = await r.ledger(({ log }) => log.getEventsByTypes(["harness/egress"]));
    return {
      detail,
      sent: stub.requests,
      egress: egress.map((e) => e.payload as { host: string; allowed: boolean; purpose: string }),
    };
  }

  it('SEC-N10-3: with research = "yes", the look-up sends the model\'s name only, never the folder or the file name, and each request is recorded', async () => {
    const r = g6Repo();
    const { detail, sent, egress } = await lookUp(
      r,
      '[network]\nmode = "offline"\nresearch = "yes"\n',
    );
    expect(detail.lookup).toMatchObject({ lookedUp: true, repo: HUB_ID });
    expect(detail.metadata?.license).toBe("mit");
    expect(sent[0]).toBe("huggingface.co/api/models?search=tiny-test-model&limit=5");
    expect(sent.length).toBe(2);
    for (const s of sent) {
      expect(s).not.toMatch(/jane-private-models|secret-client-build|\.gguf/);
      expect(s).not.toContain(r.root);
    }
    expect(egress).toEqual([
      expect.objectContaining({ host: "huggingface.co", allowed: true, purpose: "model lookup" }),
      expect.objectContaining({ host: "huggingface.co", allowed: true, purpose: "model lookup" }),
    ]);
  }, 90_000);

  it("SEC-N10-3: with research off, or the hub in fetch_deny, nothing is sent", async () => {
    const off = await lookUp(g6Repo(), '[network]\nmode = "open"\n');
    expect(off.detail.lookup.lookedUp).toBe(false);
    expect(off.sent).toEqual([]);

    const denied = await lookUp(
      g6Repo(),
      '[network]\nresearch = "yes"\nfetch_deny = ["huggingface.co"]\n',
    );
    expect(denied.sent).toEqual([]);
    expect(denied.egress).toEqual([
      expect.objectContaining({ host: "huggingface.co", allowed: false, purpose: "model lookup" }),
    ]);
  }, 120_000);
});
