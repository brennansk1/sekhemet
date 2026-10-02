/**
 * Machine's hardware tier (dashboard §2.11, DB-N2-9): the tier this machine
 * runs at and what it decides, in words. The server's `/api/machine` gives
 * `tier` (`activeHardwareTier`); the browser loads this module as
 * `/app/lib/machine_tier.js`.
 */

/** `/api/machine`'s `tier`. */
export interface HardwareTierFacts {
  tier?: string;
  /** `calibrated`: this machine's measured profile; `installed`: its installed memory. */
  source: "calibrated" | "installed";
  /** The tier's memory range in GB; the upper bound is null for the top tier. */
  budgetGb?: [number, number | null];
  installedBytes: number;
  workingContextTokens?: number;
  parallelCards?: number;
  coLoadRoles?: boolean;
  /** Set when the machine is below the minimum; there is then no tier. */
  unsupported?: string;
}

const GB = 1024 ** 3;
const gb = (bytes: number) => `${(bytes / GB).toFixed(bytes % GB === 0 ? 0 : 1)} GB`;

export function hardwareTierView(
  t: HardwareTierFacts | undefined,
): { heading: string; range: string; lines: string[] } | undefined {
  if (!t) return undefined;
  if (!t.tier) {
    return {
      heading: "Below the minimum",
      range: "",
      lines: [
        `${(t.installedBytes / GB).toFixed(1)} GB of installed memory is below the 16 GB minimum; Sekhemet does not run issues here.`,
      ],
    };
  }
  const [lo, hi] = t.budgetGb ?? [undefined, undefined];
  const range =
    lo === undefined
      ? ""
      : hi === null || hi === undefined
        ? `${lo} GB of memory or more`
        : `${lo} to ${hi} GB of memory`;
  if (t.source === "installed") {
    return {
      heading: `Tier ${t.tier}`,
      range,
      lines: [
        `From this machine's ${gb(t.installedBytes)} of installed memory; not measured on it yet.`,
      ],
    };
  }
  const lines = ["Measured on this machine."];
  if (t.workingContextTokens !== undefined && t.parallelCards !== undefined) {
    lines.push(
      `Up to ${t.workingContextTokens.toLocaleString("en-US")} tokens of working context, and ${t.parallelCards} ${t.parallelCards === 1 ? "issue" : "issues"} at a time.`,
    );
  }
  if (t.coLoadRoles !== undefined) {
    lines.push(
      t.coLoadRoles
        ? "The models can stay loaded together."
        : "The models take turns in memory: one is loaded at a time.",
    );
  }
  return { heading: `Tier ${t.tier}`, range, lines };
}

/** `/api/machine`'s `host`: the machine in plain words (dashboard §2.16, DB-N19-5). */
export interface MachineHostFacts {
  /** "This Mac" or "This machine". */
  name: string;
  chip?: string;
  memoryBytes: number;
  /** Apple silicon: the memory is shared by the chip and the models. */
  unified: boolean;
  /** Measured memory bandwidth, GB/s; absent until calibration measures it. */
  bandwidthGBs?: number;
}

/**
 * Configuration's machine line under the title (DB-N19-5; the approved
 * mockup): *This Mac · Apple M4 · 24 GB unified memory · about 120 GB/s
 * memory bandwidth*. The bandwidth is named only once measured.
 */
export function machineLine(h: MachineHostFacts | undefined): string {
  if (!h) return "";
  const memory = `${Math.round(h.memoryBytes / GB)} GB ${h.unified ? "unified memory" : "memory"}`;
  const bandwidth =
    h.bandwidthGBs !== undefined && Number.isFinite(h.bandwidthGBs)
      ? `about ${Math.round(h.bandwidthGBs)} GB/s memory bandwidth`
      : "memory bandwidth not measured yet";
  return [h.name, ...(h.chip?.trim() ? [h.chip.trim()] : []), memory, bandwidth].join(" · ");
}
