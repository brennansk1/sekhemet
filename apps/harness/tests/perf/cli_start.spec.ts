import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// W9 (FINISH_LINE_PLAN §A, "CLI start"): the built CLI's warm start
// (`sekhemet --help`, the median of nine runs) is held to +20% of the figure
// recorded in evidence/cli_start_baseline.json. Timing is the machine's, so
// this runs in `pnpm release-gate` (`SEKHEMET_PERF=1`), not in `pnpm gate`.

const perf = process.env.SEKHEMET_PERF === "1";
const SCRIPT = resolve(import.meta.dirname, "../../../../scripts/measure_cli_start.mjs");

describe.runIf(perf)("the CLI's start (W9)", () => {
  it("is within 20% of the recorded figure", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--check"], {
      encoding: "utf8",
      timeout: 120_000,
    });
    const said = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}") as {
      ok: boolean;
      medianMs: number;
      limitMs: number;
      baselineMs: number;
    };
    console.log(
      `W9 CLI start: median ${said.medianMs} ms against the recorded ${said.baselineMs} ms (limit ${said.limitMs} ms)`,
    );
    expect(said.medianMs).toBeGreaterThan(0);
    expect(said.medianMs).toBeLessThanOrEqual(said.limitMs);
    expect(r.status).toBe(0);
  }, 180_000);
});
