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

/** `/api/machine`'s memory, as the Memory card reads it. */
export interface MachineMemoryFacts {
  /** The used-ratio level (models rule 19's marks). */
  level?: string;
  /** The level the run guard acts on. */
  guardLevel?: string;
  /** `kernel` where the system reports a pressure level, else `ratio`. */
  guardSource?: string;
  usedRatio: number;
  thresholds?: { warning: number; throttle: number; critical: number };
}

const RATIO_LEVEL: Record<string, { label: string; tone: string; text: string }> = {
  normal: {
    label: "Normal",
    tone: "pass",
    text: "Issues run normally. Sekhemet stops adding worktrees at 90% and pauses the Agent at 94%.",
  },
  warning: {
    label: "Warning",
    tone: "parked",
    text: "Above 85%: multi-token prediction is off, and above 90% no new worktree is created. Running issues continue.",
  },
  critical: {
    label: "Critical",
    tone: "fail",
    text: "Above 94%: the Agent is paused safely before the system would swap. Work resumes below 85%.",
  },
};

const KERNEL_TEXT: Record<string, string> = {
  normal: "The system reports normal pressure. Issues run normally.",
  warning:
    "The system reports warning pressure. Running issues continue; the Agent is paused if pressure reaches critical.",
  critical:
    "The system reports critical pressure. The Agent is paused safely before the system would swap, until pressure falls.",
};

/**
 * The Memory card's level, words and gauge legend (dashboard §2.4 Machine;
 * wave 2 A7): they follow the guard that runs. Where the system reports a
 * pressure level the run guard acts on it and on swap, not on the used-memory
 * marks, so the legend and text never say a percentage pauses the Agent.
 */
export function memoryGuardView(m: MachineMemoryFacts): {
  label: string;
  tone: string;
  text: string;
  legend: string;
} {
  const guard = m.guardLevel ?? m.level ?? "normal";
  const lv =
    RATIO_LEVEL[guard] ?? (RATIO_LEVEL.normal as { label: string; tone: string; text: string });
  const t = m.thresholds ?? { warning: 0.85, throttle: 0.9, critical: 0.94 };
  const p = (r: number) => `${Math.round(r * 100)}%`;
  if (m.guardSource === "kernel") {
    return {
      label: lv.label,
      tone: lv.tone,
      text: KERNEL_TEXT[guard] ?? (KERNEL_TEXT.normal as string),
      legend: `${p(t.warning)} · ${p(t.throttle)} · ${p(t.critical)}: used-memory marks. On this machine the run guard follows the system's pressure level and swap instead, and pauses the Agent only at critical pressure.`,
    };
  }
  return {
    ...lv,
    legend: `${p(t.warning)} warning · ${p(t.throttle)} no new worktrees · ${p(t.critical)} pause the Agent`,
  };
}
