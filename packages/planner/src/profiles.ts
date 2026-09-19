import type { TomlTable } from "@sekhemet/kernel";

/**
 * Process profiles (P16, design "Process profiles"). Execution is always
 * Kanban flow; a profile changes only planning cadence and ceremony. Each
 * profile answers the same questions for the scheduler and the sessions:
 * when to plan, when to retro, whether work is time-boxed, and how much
 * may be in flight.
 */
export type ProcessProfileName = "kanban" | "scrum" | "shape_up";

export interface ProcessProfile {
  name: ProcessProfileName;
  /** Plan continuously (on intake) or at the start of each cycle. */
  planning: "continuous" | "per_cycle";
  /** Cycle length in days; undefined for continuous flow. */
  cycleDays?: number;
  /** Cooldown days after a cycle (Shape Up). */
  cooldownDays?: number;
  /** A retrospective every N closed cards (Kanban) or at each cycle end. */
  retroEveryCards?: number;
  retroAtCycleEnd: boolean;
  /** Sprint goal / appetite: the cycle commits to a bounded budget. */
  commitment: "none" | "sprint_goal" | "fixed_appetite";
  /** Shape Up betting table: pitches are bet on at the cycle boundary. */
  bettingTable: boolean;
  /** In-progress WIP (cards). */
  wipLimit: number;
}

export const PROCESS_PROFILES: Record<ProcessProfileName, ProcessProfile> = {
  kanban: {
    name: "kanban",
    planning: "continuous",
    retroEveryCards: 10,
    retroAtCycleEnd: false,
    commitment: "none",
    bettingTable: false,
    wipLimit: 1,
  },
  scrum: {
    name: "scrum",
    planning: "per_cycle",
    cycleDays: 14,
    retroAtCycleEnd: true,
    commitment: "sprint_goal",
    bettingTable: false,
    wipLimit: 1,
  },
  shape_up: {
    name: "shape_up",
    planning: "per_cycle",
    cycleDays: 42,
    cooldownDays: 14,
    retroAtCycleEnd: true,
    commitment: "fixed_appetite",
    bettingTable: true,
    wipLimit: 1,
  },
};

/** `[process] profile = "scrum"`, with optional overrides of any field. */
export function processProfileFromConfig(table: TomlTable | undefined): ProcessProfile {
  const t = table?.process;
  if (!t || typeof t !== "object" || Array.isArray(t)) return PROCESS_PROFILES.kanban;
  const name = (
    typeof t.profile === "string" && t.profile.replace("-", "_") in PROCESS_PROFILES
      ? t.profile.replace("-", "_")
      : "kanban"
  ) as ProcessProfileName;
  const base = PROCESS_PROFILES[name];
  const out: ProcessProfile = { ...base };
  const num = (k: string): number | undefined =>
    typeof t[k] === "number" ? (t[k] as number) : undefined;
  const cycle = num("cycle_days");
  if (cycle !== undefined) out.cycleDays = cycle;
  const cooldown = num("cooldown_days");
  if (cooldown !== undefined) out.cooldownDays = cooldown;
  const retro = num("retro_every_cards");
  if (retro !== undefined) out.retroEveryCards = retro;
  const wip = num("wip_limit");
  if (wip !== undefined) out.wipLimit = wip;
  return out;
}

export type CeremonyKind = "planning" | "retrospective" | "betting" | "review";

export interface CeremonyDue {
  kind: CeremonyKind;
  reason: string;
}

/**
 * Which ceremonies are due now: the scheduler asks this before each pass.
 * `cycleStart` is when the current cycle began (per-cycle profiles);
 * `closedSinceRetro` counts cards closed since the last retrospective.
 */
export function ceremoniesDue(
  profile: ProcessProfile,
  state: { now: Date; cycleStart?: Date; closedSinceRetro: number; intakePending: boolean },
): CeremonyDue[] {
  const due: CeremonyDue[] = [];
  if (profile.planning === "continuous") {
    if (state.intakePending) due.push({ kind: "planning", reason: "new work arrived (continuous flow)" });
  } else if (profile.cycleDays !== undefined) {
    const start = state.cycleStart?.getTime();
    const len = (profile.cycleDays + (profile.cooldownDays ?? 0)) * 86_400_000;
    if (start === undefined || state.now.getTime() - start >= len) {
      due.push({ kind: "planning", reason: `a new ${profile.cycleDays}-day cycle starts` });
      if (profile.bettingTable) due.push({ kind: "betting", reason: "pitches are bet on at the cycle boundary" });
      if (profile.retroAtCycleEnd && start !== undefined) {
        due.push({ kind: "retrospective", reason: "the cycle ended" });
      }
    }
  }
  if (
    profile.retroEveryCards !== undefined &&
    state.closedSinceRetro >= profile.retroEveryCards
  ) {
    due.push({ kind: "retrospective", reason: `${state.closedSinceRetro} cards closed since the last retro` });
  }
  return due;
}
