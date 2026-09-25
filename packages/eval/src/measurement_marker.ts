import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The mark a measured run leaves on the repository it prepared — the suite
 * runner's fixture copies and M0's workspaces (`.sekhemet/measurement.json`).
 * What a person's repository never allows is allowed only there: the queue's
 * `--auto-accept`, and independent mode's measurement setup, which marks
 * earlier cards done as the harness, never as a person (kernel rule 28).
 */
export interface MeasurementMarker {
  purpose: "frozen suite" | "m0";
  by: string;
  createdAt: string;
}

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
    return m.purpose === "frozen suite" || m.purpose === "m0"
      ? (m as MeasurementMarker)
      : undefined;
  } catch {
    return undefined;
  }
}
