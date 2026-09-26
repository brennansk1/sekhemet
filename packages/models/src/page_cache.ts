import { open } from "node:fs/promises";
import { type HeadroomProbe, measureHeadroom } from "./headroom.js";
import { DEFAULT_SWAP_POLICY } from "./swap_policy.js";
import type { WatchdogLevel } from "./watchdog.js";

/**
 * C10's page-cache warmer (models rule 20e, MD-N14-26): the successor's
 * weights file read once, sequentially, so the OS keeps it in the page cache
 * and its load reads memory, not the drive.
 *
 * - It warms only while the headroom probe (rule 20g) shows free memory
 *   beyond the margin (2 GB, D) that also holds the whole file, read at the
 *   moment it starts; never while the watchdog is above `normal`.
 * - The cache it fills is file-backed and reclaimable: it is never counted
 *   as used memory. The headroom's system measure counts wired, anonymous
 *   and compressor-occupied pages only, the watchdog's levels read kernel
 *   pressure and swap, and a DEC-42 host reading adds the warmed bytes back
 *   to free memory (`warmedBytes`): only weights warmed and not resident,
 *   each counted once — a re-warm replaces its count, and a load or unload
 *   of the weights forgets it (`forget`), so stale warm bytes never inflate
 *   free memory.
 */
export interface PageCacheWarmer {
  warm(weights: string): Promise<void>;
  /** Bytes warmed into the page cache and not yet loaded or unloaded, each weights once. */
  warmedBytes(): number;
  /** The weights were loaded or unloaded: their warmed bytes no longer count. */
  forget(weights: string): void;
}

export function pageCacheWarmer(opts: {
  probe: HeadroomProbe;
  watchdogLevel: () => WatchdogLevel;
  /** The weights' file and bytes; undefined: nothing to warm. */
  source: (weights: string) => Promise<{ path: string; bytes: number } | undefined>;
  /** Free memory kept beyond the file (D). Default the policy's 2 GiB. */
  marginBytes?: number;
  /** Bytes per sequential read. Default 8 MiB. */
  chunkBytes?: number;
}): PageCacheWarmer {
  const margin = opts.marginBytes ?? DEFAULT_SWAP_POLICY.prefetchMarginBytes;
  const chunk = opts.chunkBytes ?? 8 * 1024 ** 2;
  const warmed = new Map<string, number>();
  return {
    warmedBytes: () => [...warmed.values()].reduce((n, b) => n + b, 0),
    forget: (weights) => {
      warmed.delete(weights);
    },
    async warm(weights) {
      const level = opts.watchdogLevel();
      if (level !== "normal")
        throw new Error(`not warming ${weights}: the watchdog is at ${level}, not normal`);
      const source = await opts.source(weights);
      if (!source) throw new Error(`not warming ${weights}: its weights file is unknown`);
      const free = measureHeadroom(await opts.probe.read()).bytes;
      if (free - margin <= source.bytes)
        throw new Error(
          `not warming ${weights}: free memory (${gb(free)}) less the ${gb(margin)} margin does not hold its ${gb(source.bytes)}`,
        );
      const file = await open(source.path, "r");
      try {
        const buf = Buffer.allocUnsafe(chunk);
        let at = 0;
        for (;;) {
          const { bytesRead } = await file.read(buf, 0, chunk, at);
          if (bytesRead === 0) break;
          at += bytesRead;
          // Stop at once if pressure rises mid-read.
          if (opts.watchdogLevel() !== "normal") break;
        }
        warmed.set(weights, at);
      } finally {
        await file.close();
      }
    },
  };
}

const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;
