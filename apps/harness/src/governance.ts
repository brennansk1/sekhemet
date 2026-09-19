import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { arch, cpus, platform, totalmem } from "node:os";
import type { EventLog } from "@sekhemet/kernel";

/**
 * Compute governance (H23): the machine is the user's, so unattended work is
 * bounded by three circuit breakers, each on the ledger when it trips:
 *
 * - Energy: a daily kWh budget (`[machine] power_budget_kwh_day`, 0 = none).
 *   Energy is estimated as the machine's inference draw times the time spent
 *   running cards, from the ledger's own run events, so it survives restarts.
 * - Failures: N cards in a row that end without passing trips the breaker.
 *   A run that fails every card is burning power to learn nothing; a person
 *   should look first.
 * - Heat: macOS reports thermal throttling (`pmset -g therm`), Linux the
 *   hottest thermal zone. A throttled machine runs slowly and hot; wait.
 */

export const GOVERNANCE_EVENTS = {
  usage: "compute/usage",
  tripped: "compute/breaker_tripped",
} as const;

/** Sustained draw while a local model runs, when the user has not measured it. */
export function estimatedWatts(): number {
  const env = Number(process.env.SEKHEMET_MACHINE_WATTS);
  if (env > 0) return env;
  const gb = totalmem() / 1024 ** 3;
  if (platform() === "darwin" && arch() === "arm64") return gb > 64 ? 90 : 40; // Apple silicon SoC under GPU load
  if (gb >= 96) return 140; // Strix Halo class APU (Ryzen AI Max+ 395), ~120 W package plus board
  return Math.max(65, cpus().length * 6);
}

export interface EnergyToday {
  kwh: number;
  runMs: number;
  since: string;
}

/** Energy spent today, from compute/usage events on the ledger. */
export async function energyToday(log: EventLog, now = new Date()): Promise<EnergyToday> {
  const since = new Date(now);
  since.setHours(0, 0, 0, 0);
  const events = await log.getEventsByTypes([GOVERNANCE_EVENTS.usage]);
  let kwh = 0;
  let runMs = 0;
  for (const e of events) {
    if (Date.parse(e.createdAt) < since.getTime()) continue;
    const p = e.payload as { kwh?: number; durationMs?: number };
    kwh += p.kwh ?? 0;
    runMs += p.durationMs ?? 0;
  }
  return { kwh: Math.round(kwh * 1000) / 1000, runMs, since: since.toISOString() };
}

/** Record one stretch of unattended compute on the ledger. */
export async function recordUsage(
  log: EventLog,
  durationMs: number,
  detail: Record<string, unknown> = {},
  watts = estimatedWatts(),
): Promise<number> {
  const kwh = (watts * durationMs) / 3_600_000 / 1000;
  await log.append({
    actor: "harness",
    type: GOVERNANCE_EVENTS.usage,
    payload: { durationMs, watts, kwh, ...detail },
  });
  return kwh;
}

export type Thermal = "nominal" | "warm" | "throttled" | "unknown";

/** The machine's thermal state, where the OS reports one. */
export function thermalState(read: (cmd: string, args: string[]) => string = defaultRead): Thermal {
  try {
    if (platform() === "darwin") {
      const out = read("pmset", ["-g", "therm"]);
      const limit = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(out)?.[1];
      if (/thermal warning level set to [1-9]|performance warning level set to [1-9]/i.test(out))
        return "throttled";
      if (limit !== undefined) return Number(limit) < 100 ? "throttled" : "nominal";
      return /No thermal warning level has been recorded/i.test(out) ? "nominal" : "unknown";
    }
    if (platform() === "linux") {
      let max = 0;
      for (let i = 0; i < 16; i++) {
        try {
          max = Math.max(
            max,
            Number(readFileSync(`/sys/class/thermal/thermal_zone${i}/temp`, "utf8")) / 1000,
          );
        } catch {
          break;
        }
      }
      if (max === 0) return "unknown";
      return max >= 95 ? "throttled" : max >= 85 ? "warm" : "nominal";
    }
  } catch {
    // Unknown is not a reason to stop.
  }
  return "unknown";
}

function defaultRead(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000 });
}

export interface GovernanceLimits {
  /** 0 = no energy budget. */
  kwhPerDay: number;
  /** Consecutive non-passing cards before the failure breaker trips. */
  maxConsecutiveFailures: number;
}

export interface Verdict {
  ok: boolean;
  breaker?: "energy" | "failures" | "thermal";
  reason?: string;
}

/**
 * Whether unattended work may start (or continue). Trips are written to the
 * ledger once per breaker per call site, so the dashboard and Seshat can say
 * why the queue stopped.
 */
export async function mayRun(
  log: EventLog,
  limits: GovernanceLimits,
  state: { consecutiveFailures: number },
  opts: { thermal?: () => Thermal; now?: Date } = {},
): Promise<Verdict> {
  let verdict: Verdict = { ok: true };
  if (limits.kwhPerDay > 0) {
    const used = await energyToday(log, opts.now);
    if (used.kwh >= limits.kwhPerDay) {
      verdict = {
        ok: false,
        breaker: "energy",
        reason: `today's energy budget is spent (${used.kwh.toFixed(2)} of ${limits.kwhPerDay} kWh)`,
      };
    }
  }
  if (verdict.ok && state.consecutiveFailures >= limits.maxConsecutiveFailures) {
    verdict = {
      ok: false,
      breaker: "failures",
      reason: `${state.consecutiveFailures} cards in a row ended without passing; a person should look before more run`,
    };
  }
  if (verdict.ok && (opts.thermal ?? (() => thermalState()))() === "throttled") {
    verdict = { ok: false, breaker: "thermal", reason: "the machine is thermally throttled" };
  }
  if (!verdict.ok) {
    await log
      .append({ actor: "harness", type: GOVERNANCE_EVENTS.tripped, payload: { ...verdict } })
      .catch(() => undefined);
  }
  return verdict;
}
