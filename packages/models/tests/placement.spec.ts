import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CopyHashMismatch,
  KEEP_FREE_BYTES,
  type PlacementCandidate,
  advisePlacement,
  copyToInternal,
} from "../src/placement.js";

// MD-N14-41, DB-NM14-7, DB-NM14-8: copies ranked by swaps per day × load time
// saved ÷ GB, chosen as a knapsack keeping 20 GB free; copied only on a
// person's click, verified by hash, the original kept.

const GB = 1e9;
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sek-place-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const cand = (
  model: string,
  sizeGb: number,
  swapsPerDay: number,
  extra: Partial<PlacementCandidate> = {},
): PlacementCandidate => ({
  model,
  name: model,
  sizeBytes: sizeGb * GB,
  path: `/Volumes/USB/${model}.gguf`,
  volume: "external",
  swapsPerDay: { value: swapsPerDay, grade: "estimated" },
  loadExternalMs: { value: 300_000, grade: "measured" },
  loadInternalMs: { value: 20_000, grade: "estimated" },
  ...extra,
});

describe("advisePlacement (MD-N14-41, DB-NM14-7)", () => {
  it("chooses copies as a knapsack that keeps 20 GB of internal space free", () => {
    const advice = advisePlacement({
      candidates: [cand("worker", 13.6, 6), cand("planner", 12, 4), cand("researcher", 4, 1)],
      internalFreeBytes: { value: 40 * GB, grade: "measured" },
    });
    // 20 GB to spend: worker (13.6) + researcher (4) = 17.6 fits; worker + planner does not.
    expect(advice.suggested.sort()).toEqual(["researcher", "worker"]);
    const worker = advice.rows.find((r) => r.model === "worker");
    // 6 swaps × (300 − 20) s = 28 minutes a day.
    expect(worker?.savedPerDayMs.value).toBe(6 * 280_000);
    expect(worker?.savedPerDayMs.grade).toBe("estimated");
    expect(worker?.reason).toMatch(/saves about 6 swaps' worth of loading, 28 minutes a day/);
    const planner = advice.rows.find((r) => r.model === "planner");
    expect(planner?.suggested).toBe(false);
    expect(planner?.reason).toMatch(/20 GB/);
    expect(advice.freeAfterBytes).toBeGreaterThanOrEqual(KEEP_FREE_BYTES);
  });

  it("does not suggest a copy that would leave less than 20 GB free, and says why", () => {
    const advice = advisePlacement({
      candidates: [cand("worker", 13.6, 6)],
      internalFreeBytes: { value: 30 * GB, grade: "measured" },
    });
    expect(advice.suggested).toEqual([]);
    expect(advice.rows[0]?.reason).toMatch(/less than 20 GB free/);
  });

  it("prefers an internal copy with the same hash that already exists", () => {
    const advice = advisePlacement({
      candidates: [
        cand("worker", 13.6, 6, {
          sha256: "a".repeat(64),
          internalCopy: "/Users/me/AI-Models/llm/w.gguf",
        }),
      ],
      internalFreeBytes: { value: 200 * GB, grade: "measured" },
    });
    expect(advice.suggested).toEqual([]);
    expect(advice.rows[0]).toMatchObject({
      suggested: false,
      internalCopy: "/Users/me/AI-Models/llm/w.gguf",
    });
    expect(advice.rows[0]?.reason).toMatch(/internal copy with the same hash/);
  });

  it("grades the saving measured only when every input is measured (MS-NM14-4)", () => {
    const advice = advisePlacement({
      candidates: [
        cand("w", 1, 2, {
          swapsPerDay: { value: 2, grade: "measured" },
          loadInternalMs: { value: 10_000, grade: "measured" },
        }),
      ],
      internalFreeBytes: { value: 100 * GB, grade: "measured" },
    });
    expect(advice.rows[0]?.savedPerDayMs.grade).toBe("measured");
  });
});

describe("copyToInternal (DB-NM14-8)", () => {
  it("copies, verifies the hash, and keeps the original", async () => {
    const src = join(tmp(), "w.gguf");
    const bytes = Buffer.alloc(100_000, 3);
    writeFileSync(src, bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const dest = tmp();
    const states: string[] = [];
    const r = await copyToInternal({
      source: src,
      destDir: dest,
      sha256: sha,
      freeBytes: () => 100 * GB,
      onProgress: (p) => states.push(p.state),
    });
    expect(r).toMatchObject({ sha256: sha, bytes: 100_000, path: join(dest, "w.gguf") });
    expect(readFileSync(r.path).equals(bytes)).toBe(true);
    expect(existsSync(src)).toBe(true);
    expect(states).toContain("verifying");
    expect(states.at(-1)).toBe("done");
  });

  it("deletes a copy whose hash differs, keeping the original", async () => {
    const src = join(tmp(), "w.gguf");
    writeFileSync(src, Buffer.alloc(1000, 1));
    const dest = tmp();
    await expect(
      copyToInternal({
        source: src,
        destDir: dest,
        sha256: "0".repeat(64),
        freeBytes: () => 100 * GB,
      }),
    ).rejects.toBeInstanceOf(CopyHashMismatch);
    expect(readdirSync(dest)).toEqual([]);
    expect(existsSync(src)).toBe(true);
  });

  it("refuses a copy that would leave less than 20 GB free", async () => {
    const src = join(tmp(), "w.gguf");
    writeFileSync(src, Buffer.alloc(1000, 1));
    await expect(
      copyToInternal({
        source: src,
        destDir: tmp(),
        sha256: "0".repeat(64),
        freeBytes: () => 20 * GB,
      }),
    ).rejects.toThrow(/20 GB/);
  });

  it("recognises an existing copy with the same hash instead of copying again", async () => {
    const bytes = Buffer.alloc(5000, 9);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const src = join(tmp(), "w.gguf");
    writeFileSync(src, bytes);
    const dest = tmp();
    writeFileSync(join(dest, "w.gguf"), bytes);
    const r = await copyToInternal({
      source: src,
      destDir: dest,
      sha256: sha,
      freeBytes: () => 21 * GB,
    });
    expect(r.existing).toBe(true);
    expect(r.path).toBe(join(dest, "w.gguf"));
  });
});
