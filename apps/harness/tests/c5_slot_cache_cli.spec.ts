import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratch } from "./support/g2_cli.js";
import { startEngine } from "./support/g4_engine.js";
import { queueProject, runQueueOn } from "./support/g4_queue.js";

/**
 * The slot directory's cap (models rule 20i, MD-N14-37a; F31, C5): saved KV
 * slots no longer pile up without limit. `sekhemet queue` is spawned as the
 * built binary (`apps/harness/dist/index.js`, `support/g4_queue.ts`) over a
 * real slot directory (`SEKHEMET_SLOT_CACHE`); its start-up pass prunes it.
 * The Worker is a scripted engine (`support/g4_engine.ts`); no model is loaded.
 */

const MB = 1024 * 1024;
const MIN = 60_000;

function slot(
  dir: string,
  name: string,
  opts: { mb: number; ageMs: number; manifest: boolean; heldBy?: number },
): string {
  const file = `${name}.live_card.0123456789abcdef.bin`;
  writeFileSync(join(dir, file), Buffer.alloc(Math.round(opts.mb * MB)));
  const at = Date.now() - opts.ageMs;
  utimesSync(join(dir, file), at / 1000, at / 1000);
  if (opts.manifest)
    writeFileSync(
      join(dir, `${file}.json`),
      JSON.stringify({
        file,
        keyId: "0123456789abcdef",
        key: {
          weightsHash: "w",
          engineBuild: "b",
          contextTokens: 1,
          kvType: "q8_0",
          template: "t",
        },
        kind: "live_card",
        owner: name,
        slot: 0,
        savedAt: at,
        bytes: Math.round(opts.mb * MB),
        saveMs: 1,
        ...(opts.heldBy !== undefined ? { heldBy: opts.heldBy } : {}),
      }),
    );
  return file;
}

/** `sekhemet queue` over one Ready card, with the slot directory and its cap in MiB. */
async function queueWithSlots(dir: string, capMiB: number) {
  const p = await queueProject({
    files: { "src/a.ts": "" },
    cards: [{ id: "c1", tier: "story", title: "Write a", scopeFiles: ["src/a.ts"], stepBudget: 3 }],
  });
  const engine = await startEngine(p.home, [
    {
      calls: [
        { name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 1;\n" } },
        { name: "finish_card" },
      ],
    },
  ]);
  const r = await runQueueOn(p, engine, {
    SEKHEMET_SLOT_CACHE: dir,
    SEKHEMET_SLOT_CACHE_MAX_GB: String(capMiB / 1024),
  });
  return r.stdout + r.stderr;
}

describe("MD-N14-37a: the slot directory is capped, oldest first, never a held slot", () => {
  it("MD-N14-37a: `queue`'s start-up pass deletes slot files over SEKHEMET_SLOT_CACHE_MAX_GB oldest-saved first, keeping a slot a live process holds and a save still being written", async () => {
    const dir = join(scratch("sek-slots-"), "slots");
    mkdirSync(dir, { recursive: true });
    // A slot the test process (alive) saved for its return: the oldest manifest.
    const held = slot(dir, "held", {
      mb: 1.5,
      ageMs: 50 * MIN,
      manifest: true,
      heldBy: process.pid,
    });
    // A save that crashed an hour ago left a file with no manifest.
    const stale = slot(dir, "stale", { mb: 1.5, ageMs: 60 * MIN, manifest: false });
    const older = slot(dir, "older", { mb: 1.5, ageMs: 40 * MIN, manifest: true });
    const newer = slot(dir, "newer", { mb: 1.5, ageMs: 5 * MIN, manifest: true });
    // A save being written now: no manifest yet.
    const writing = slot(dir, "writing", { mb: 0.1, ageMs: 0, manifest: false });
    // Cap 3.2 MiB: 6.1 MiB on disk, so the stale file and then `older` go.
    const out = await queueWithSlots(dir, 3.2);
    expect(out).toMatch(/Slots: 2 saved model slots over the cache cap deleted/);
    expect(existsSync(join(dir, stale))).toBe(false);
    expect(existsSync(join(dir, older))).toBe(false);
    expect(existsSync(join(dir, `${older}.json`))).toBe(false);
    expect(existsSync(join(dir, held)), out).toBe(true);
    expect(existsSync(join(dir, newer))).toBe(true);
    expect(existsSync(join(dir, writing))).toBe(true);
  }, 180_000);

  it("MD-N14-37a: under the cap nothing is deleted, and a slot held by a process that has ended is no longer held", async () => {
    const dir = join(scratch("sek-slots-"), "slots");
    mkdirSync(dir, { recursive: true });
    // pid 2^22 + 7 is above every pid macOS and Linux hand out by default.
    const orphaned = slot(dir, "gone", {
      mb: 1.5,
      ageMs: 50 * MIN,
      manifest: true,
      heldBy: 4194311,
    });
    const kept = slot(dir, "kept", { mb: 1.5, ageMs: 5 * MIN, manifest: true });
    const under = await queueWithSlots(dir, 4);
    expect(under).not.toMatch(/over the cache cap/);
    expect(existsSync(join(dir, orphaned))).toBe(true);
    // Over a 2 MiB cap the ended process's slot, the oldest, goes.
    const over = await queueWithSlots(dir, 2);
    expect(over).toMatch(/Slots: 1 saved model slot over the cache cap deleted/);
    expect(existsSync(join(dir, orphaned))).toBe(false);
    expect(existsSync(join(dir, kept))).toBe(true);
  }, 180_000);

  it("MD-N14-37a: slots a live process holds past the cap — one long-lived process that saved many cards' slots and restored none — go oldest first until the directory fits, the newest held kept", async () => {
    const dir = join(scratch("sek-slots-"), "slots");
    mkdirSync(dir, { recursive: true });
    // The test process stands for a `serve`, `queue` or overnight process
    // that swapped five cards out and never returned to them: every slot
    // held by a live pid, 7.5 MiB against a 3.2 MiB cap.
    const held = [50, 40, 30, 20, 10].map((min, i) =>
      slot(dir, `card${i + 1}`, { mb: 1.5, ageMs: min * MIN, manifest: true, heldBy: process.pid }),
    );
    const out = await queueWithSlots(dir, 3.2);
    expect(out).toMatch(/Slots: 3 saved model slots over the cache cap deleted/);
    for (const f of held.slice(0, 3)) expect(existsSync(join(dir, f)), f).toBe(false);
    for (const f of held.slice(3)) expect(existsSync(join(dir, f)), f).toBe(true);
  }, 180_000);
});
