/**
 * Configuration's settings sections (dashboard NEW-dashboard-4, §2.16):
 * Preferences' density, Review capacity and Project configuration with each
 * value's source. Pure: the page (`configuration.js`) renders what these
 * return; the browser loads this module as `/app/lib/settings.js`.
 */
import { humanize, plural } from "./vocabulary.js";

// ---------------------------------------------------------------------------
// Preferences: density (this browser's, like the theme)
// ---------------------------------------------------------------------------

export type Density = "compact" | "comfortable";

/** Compact: 88 px tiles. Comfortable: 112 px, with the spec line and the token and time bars. */
export const DENSITY_CHOICES: readonly { value: Density; label: string }[] = [
  { value: "compact", label: "Compact" },
  { value: "comfortable", label: "Comfortable" },
];

/** The key `boot.js` and the palette's density toggle use. */
export const DENSITY_KEY = "sekhemet-density";

/** This browser's density; compact when none is saved or storage is blocked. */
export function readDensity(storage: { getItem(key: string): string | null } | null): Density {
  try {
    return storage?.getItem(DENSITY_KEY) === "comfortable" ? "comfortable" : "compact";
  } catch {
    return "compact";
  }
}

// ---------------------------------------------------------------------------
// Review capacity (DB-N4-2, DB-N4-3; review-git §2.2.3)
// ---------------------------------------------------------------------------

/** What a refused value reads beside the field; the server says the same. */
export const REVIEW_MINUTES_REFUSED = "Review minutes per day must be more than 0.";

/** `GET /api/config?project=`'s `reviewCapacity`. */
export interface ReviewCapacity {
  project: string;
  minutesPerDay: number;
  /** The In review limit these minutes give now. */
  reviewWip?: number;
  allowed: boolean;
  reason?: string;
}

export function reviewCapacityView(cap: ReviewCapacity): {
  value: string;
  limitText: string;
  disabled: boolean;
  reason: string;
} {
  const limitText =
    cap.reviewWip !== undefined
      ? `In review holds at most ${plural(cap.reviewWip, "issue")} at ${cap.minutesPerDay} minutes a day.`
      : "";
  return {
    value: String(cap.minutesPerDay),
    limitText,
    disabled: !cap.allowed,
    reason: cap.allowed ? "" : (cap.reason ?? "You can't change this project's review capacity."),
  };
}

/** A typed value: a number above 0, or refused with the previous value kept. */
export function reviewMinutesInput(
  raw: string,
  previous: number,
): { ok: true; value: number } | { ok: false; value: number; error: string } {
  const text = String(raw ?? "").trim();
  const value = text === "" ? Number.NaN : Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, value: previous, error: REVIEW_MINUTES_REFUSED };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Project configuration: the effective values and where each came from
// ---------------------------------------------------------------------------

/** The configuration layers (`resolveConfig`), in words. */
export const CONFIG_SOURCE_LABELS: Record<string, string> = {
  defaults: "Default",
  user: "Your configuration (~/.sekhemet/config.toml)",
  project: "This project (.sekhemet/config.toml)",
  card: "This issue",
  cli: "The command line",
};

export interface ConfigLike {
  machine?: { tier?: string; reservedHours?: string; overnightHours?: string };
  network?: { mode?: string };
  team?: { mode?: string };
  review?: { reviewMinutesPerDay?: number };
}

const NETWORK_WORDS: Record<string, string> = {
  offline: "Offline",
  allowlist: "Only the listed hosts",
  open: "Open",
};

/** One row per setting a person reads here: its name, value and source. */
export function configRows(
  config: ConfigLike,
  sources: Record<string, string> = {},
): { key: string; label: string; value: string; source: string }[] {
  const source = (key: string) => {
    const layer = sources[key] ?? "defaults";
    return CONFIG_SOURCE_LABELS[layer] ?? humanize(layer);
  };
  // `[machine] tier` is parsed but nothing applies it yet: Machine shows the
  // tier in force (DB-N2-9), so it is not listed here as if it decided one.
  const rows: [string, string, string][] = [
    ["machine.reserved_hours", "Reserved hours", config.machine?.reservedHours || "None"],
    [
      "machine.overnight_hours",
      "Overnight hours",
      config.machine?.overnightHours ?? "The hours outside the reserved hours",
    ],
    [
      "network.mode",
      "Network",
      NETWORK_WORDS[config.network?.mode ?? ""] ?? humanize(config.network?.mode ?? "offline"),
    ],
    ["team.mode", "Setup", config.team?.mode === "team" ? "Team" : "Solo"],
    [
      "review.review_minutes_per_day",
      "Review minutes per day (new projects)",
      String(config.review?.reviewMinutesPerDay ?? 60),
    ],
  ];
  return rows.map(([key, label, value]) => ({ key, label, value, source: source(key) }));
}
