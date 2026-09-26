import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedLlamaServerAdapter, type SlotKey, SlotStore, slotKeyId } from "../src/index.js";
import { fakeServer } from "./support/fake_server.js";

const MiB = 1024 ** 2;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

const KEY: SlotKey = {
  weightsHash: "a".repeat(64),
  engineBuild: "b10809",
  contextTokens: 16384,
  kvType: "q8_0",
  template: "t".repeat(64),
};

/** A fake llama-server: slot save writes the named file into the slot directory, restore reads it. */
async function fakeLlama(dir: string, savedBytes = 32 * MiB) {
  const srv = await fakeServer((req, body) => {
    const filename = (body as { filename?: string } | undefined)?.filename ?? "";
    if (req.url?.includes("action=save")) {
      writeFileSync(join(dir, filename), Buffer.alloc(16));
      return { json: { id_slot: 0, filename, n_saved: 4000, n_written: savedBytes } };
    }
    if (req.url?.includes("action=restore")) {
      if (!existsSync(join(dir, filename))) return { status: 400, json: { error: "no file" } };
      return { json: { id_slot: 0, filename, n_restored: 4000, n_read: savedBytes } };
    }
    if (req.url === "/props")
      return {
        json: {
          model_path: "/w.gguf",
          build_info: "b10809",
          chat_template: "{{ messages }}",
          default_generation_settings: { n_ctx: 8192 },
        },
      };
    return { json: {} };
  });
  closers.push(srv.close);
  return srv;
}

function store(dir: string, url: string, now = () => 0) {
  return new SlotStore({ dir, serverUrl: url, now, readBytesPerSecond: 100 * MiB });
}

describe("MD-N14-36: slots saved and restored as keyed caches", () => {
  it("keys a slot by weights hash, engine build, context, KV type and template", () => {
    expect(slotKeyId(KEY)).toMatch(/^[0-9a-f]{16}$/);
    expect(slotKeyId({ ...KEY, template: "u".repeat(64) })).not.toBe(slotKeyId(KEY));
    expect(slotKeyId({ ...KEY, contextTokens: 8192 })).not.toBe(slotKeyId(KEY));
  });

  it("saves on the server and restores a file whose key matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slots-"));
    const srv = await fakeLlama(dir);
    const s = store(dir, srv.url);
    const saved = await s.save({
      slot: 1,
      kind: "thread",
      owner: "thread-7",
      key: KEY,
      sources: ["e1"],
    });
    expect(saved?.bytes).toBe(32 * MiB);
    const back = await s.restore({
      slot: 1,
      kind: "thread",
      owner: "thread-7",
      key: KEY,
      reprefillMs: 30_000,
    });
    expect(back.action).toBe("restored");
    const posts = srv.seen.filter((x) => x.method === "POST").map((x) => x.url);
    expect(posts).toEqual(["/slots/1?action=save", "/slots/1?action=restore"]);
    // The manifest holds ids only, never prompt text.
    const manifest = readdirSync(dir).find((f) => f.endsWith(".json")) as string;
    expect(JSON.parse(readFileSync(join(dir, manifest), "utf8")).sources).toEqual(["e1"]);
  });

  it("re-prefills, not restores, when the template changed between save and return", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slots-"));
    const srv = await fakeLlama(dir);
    const s = store(dir, srv.url);
    await s.save({ slot: 0, kind: "prefix", owner: "planner", key: KEY, sources: [] });
    const back = await s.restore({
      slot: 0,
      kind: "prefix",
      owner: "planner",
      key: { ...KEY, template: "u".repeat(64) },
      reprefillMs: 30_000,
    });
    expect(back).toMatchObject({ action: "reprefill", reason: "key_mismatch" });
    expect(srv.seen.some((x) => x.url.includes("action=restore"))).toBe(false);
  });

  it("re-prefills a card's live slot mid-attempt until the equivalence check has passed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slots-"));
    const srv = await fakeLlama(dir);
    const s = store(dir, srv.url);
    await s.save({ slot: 0, kind: "live_card", owner: "card-1", key: KEY, sources: [] });
    const before = await s.restore({
      slot: 0,
      kind: "live_card",
      owner: "card-1",
      key: KEY,
      reprefillMs: 60_000,
    });
    expect(before).toMatchObject({ action: "reprefill", reason: "live_card_unverified" });
    const after = await s.restore({
      slot: 0,
      kind: "live_card",
      owner: "card-1",
      key: KEY,
      reprefillMs: 60_000,
      equivalencePassed: true,
    });
    expect(after.action).toBe("restored");
  });

  it("saves only when K < R, K before the first save being the slot's size at the volume's read rate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slots-"));
    const srv = await fakeLlama(dir);
    const s = store(dir, srv.url);
    // 500 MiB at 100 MiB/s: K = 5 s.
    expect(s.estimateRestoreMs({ owner: "t", kind: "thread", estimatedBytes: 500 * MiB })).toBe(
      5000,
    );
    const skipped = await s.saveIfWorth({
      slot: 0,
      kind: "thread",
      owner: "t",
      key: KEY,
      sources: [],
      estimatedBytes: 500 * MiB,
      reprefillMs: 4000,
    });
    expect(skipped).toBeUndefined();
    expect(srv.seen.some((x) => x.url.includes("action=save"))).toBe(false);
    const saved = await s.saveIfWorth({
      slot: 0,
      kind: "thread",
      owner: "t",
      key: KEY,
      sources: [],
      estimatedBytes: 500 * MiB,
      reprefillMs: 9000,
    });
    expect(saved).toBeDefined();
  });

  it("re-prefills when the recorded restore is slower than the re-prefill", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slots-"));
    const srv = await fakeLlama(dir);
    let t = 0;
    const s = store(dir, srv.url, () => t);
    await s.save({ slot: 0, kind: "thread", owner: "t", key: KEY, sources: [] });
    // A restore that takes 8 s on the clock.
    const slow = new SlotStore({
      dir,
      serverUrl: srv.url,
      now: () => {
        t += 4000;
        return t;
      },
      readBytesPerSecond: 100 * MiB,
    });
    expect(
      (await slow.restore({ slot: 0, kind: "thread", owner: "t", key: KEY, reprefillMs: 60_000 }))
        .action,
    ).toBe("restored");
    expect(slow.estimateRestoreMs({ owner: "t", kind: "thread" })).toBe(4000);
    expect(
      await slow.restore({ slot: 0, kind: "thread", owner: "t", key: KEY, reprefillMs: 3000 }),
    ).toMatchObject({ action: "reprefill", reason: "slower_than_prefill" });
  });
});

describe("MD-N14-37: erasure deletes the slot files that hold erased prompt text", () => {
  it("deletes a slot whose sources a ledger/erased event covers, and keeps the others", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slots-"));
    const srv = await fakeLlama(dir);
    const ldir = mkdtempSync(join(tmpdir(), "slot-ledger-"));
    const db = new DatabaseSync(join(ldir, "ledger.db"));
    initSchema(db);
    const log = new EventLog(db);
    const said = await log.append({
      actor: "human",
      type: "card/note",
      payload: {},
      private: { text: "my private question" },
    });
    const other = await log.append({
      actor: "human",
      type: "card/note",
      payload: {},
      private: { text: "kept" },
    });
    const s = store(dir, srv.url);
    const covered = await s.save({
      slot: 0,
      kind: "thread",
      owner: "a",
      key: KEY,
      sources: [said.id],
    });
    const kept = await s.save({
      slot: 1,
      kind: "thread",
      owner: "b",
      key: KEY,
      sources: [other.id],
    });
    await log.erase({ eventIds: [said.id], reason: "erasure", principal: log.localPrincipal() });
    const deleted = s.sweepErased(log.erasureIndex());
    expect(deleted).toEqual([covered?.file]);
    expect(existsSync(join(dir, covered?.file as string))).toBe(false);
    expect(existsSync(join(dir, kept?.file as string))).toBe(true);
  });

  it("a slot whose sources are unknown is deleted on any erasure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slots-"));
    const srv = await fakeLlama(dir);
    const s = store(dir, srv.url);
    const unknown = await s.save({ slot: 0, kind: "prefix", owner: "w", key: KEY });
    expect(s.sweepErased({ byEvent: new Map(), byBlob: new Map() })).toEqual([]);
    const index = { byEvent: new Map([["x", { erasedBySeq: 5, fields: [] }]]), byBlob: new Map() };
    expect(s.sweepErased(index)).toEqual([unknown?.file]);
    // A slot saved after that erasure is not deleted by it again.
    const later = await s.save({ slot: 0, kind: "prefix", owner: "w", key: KEY });
    expect(s.sweepErased(index)).toEqual([]);
    expect(existsSync(join(dir, later?.file as string))).toBe(true);
  });
});

describe("the managed adapter's slot saves go through the keyed store", () => {
  it("saves under a keyed name and restores it only for the same key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slots-"));
    const srv = await fakeLlama(dir);
    const adapter = new ManagedLlamaServerAdapter({
      modelId: "cyber-tiel/iq3",
      modelPath: "/nonexistent.gguf",
      port: srv.port,
      contextTokens: 8192,
      slotCacheDir: dir,
    });
    expect(await adapter.slotAction("save")).toBe(true);
    expect(await adapter.slotAction("restore")).toBe(true);
    const names = srv.seen
      .filter((x) => x.method === "POST")
      .map((x) => (x.body as { filename: string }).filename);
    expect(names[0]).toMatch(/^cyber-tiel_iq3\.prefix\.[0-9a-f]{16}\.bin$/);
    expect(names[1]).toBe(names[0]);
    // Another KV type is another key: nothing restores.
    const other = new ManagedLlamaServerAdapter({
      modelId: "cyber-tiel/iq3",
      modelPath: "/nonexistent.gguf",
      port: srv.port,
      contextTokens: 8192,
      kvType: "f16",
      slotCacheDir: dir,
    });
    expect(await other.slotAction("restore")).toBe(false);
  });
});

describe("MD-N14-37: no decision reads a slot file (a search test)", () => {
  it("only the adapter and the index import the slot store; decide() never does", () => {
    const src = join(import.meta.dirname, "..", "src");
    const importers = readdirSync(src)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /from "\.\/slot_state\.js"/.test(readFileSync(join(src, f), "utf8")));
    expect(importers.sort()).toEqual(["index.ts", "llama_server.ts"]);
    for (const f of readdirSync(src).filter((x) => x.endsWith(".ts"))) {
      const text = readFileSync(join(src, f), "utf8");
      if (/export function decide\(/.test(text)) {
        expect(text).not.toMatch(/slot_state|SlotStore|slot-save-path|\.bin"/);
      }
    }
  });
});
