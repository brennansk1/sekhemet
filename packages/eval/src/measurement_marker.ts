import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The mark a measured run leaves on the repository it prepared — the suite
 * runner's fixture copies and M0's workspaces (`.sekhemet/measurement.json`).
 * What a person's repository never allows is allowed only there: the queue's
 * `--auto-accept`, and independent mode's measurement setup, which marks
 * earlier cards done as the harness, never as a person (kernel rule 28).
 *
 * The purpose names which measurement prepared it: `frozen suite` (the
 * suite runner's copies, the only ones SUITE_RUNS counts), `m0`, or
 * `benchmark` (the combination benchmark's card repositories,
 * NEW-measurement-5), so a benchmark's card is never read as a suite card.
 */
export interface MeasurementMarker {
  purpose: MeasurementPurpose;
  by: string;
  createdAt: string;
}

export const MEASUREMENT_PURPOSES = ["frozen suite", "m0", "benchmark"] as const;
export type MeasurementPurpose = (typeof MEASUREMENT_PURPOSES)[number];

export const MEASUREMENT_MARKER_PATH = [".sekhemet", "measurement.json"] as const;

export function writeMeasurementMarker(
  repoPath: string,
  purpose: MeasurementMarker["purpose"],
  by: string,
): MeasurementMarker {
  const marker: MeasurementMarker = { purpose, by, createdAt: new Date().toISOString() };
  mkdirSync(join(repoPath, MEASUREMENT_MARKER_PATH[0]), { recursive: true });
  writeFileSync(join(repoPath, ...MEASUREMENT_MARKER_PATH), `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

export function readMeasurementMarker(repoPath: string): MeasurementMarker | undefined {
  try {
    const m = JSON.parse(
      readFileSync(join(repoPath, ...MEASUREMENT_MARKER_PATH), "utf8"),
    ) as Partial<MeasurementMarker>;
    return (MEASUREMENT_PURPOSES as readonly string[]).includes(m.purpose ?? "")
      ? (m as MeasurementMarker)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Who holds the runner in a marked repository, as the calibration night
 * names it: `suite` only for the frozen suite's copies; any other
 * measurement (m0, a benchmark) is `measurement`; none when unmarked.
 */
export function measurementHolder(
  marker: Pick<MeasurementMarker, "purpose"> | undefined,
): "suite" | "measurement" | undefined {
  if (!marker) return undefined;
  return marker.purpose === "frozen suite" ? "suite" : "measurement";
}
