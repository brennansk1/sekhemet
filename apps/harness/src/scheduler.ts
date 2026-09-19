import { execFileSync } from "node:child_process";
import { platform } from "node:os";

/**
 * The idle and overnight scheduler (H21): unattended work runs when the
 * machine is the harness's, not the user's.
 *
 * `[machine] hours` in config.toml names the hours reserved for the user
 * ("08:00-18:00 Mon-Fri"). Outside them the queue may run. Inside them it may
 * run only when the user has been away from the keyboard for `idleMinutes`
 * (macOS: IOHIDSystem's HIDIdleTime; Linux: xprintidle when present), and it
 * yields as soon as they come back, at a card boundary.
 */

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface Window {
  start: number; // minutes after midnight
  end: number;
  days: Set<number>; // 0 = Sunday
}

/**
 * Parse "08:00-18:00 Mon-Fri", "09:00-17:30 Mon,Wed,Fri", "22:00-06:00" (every
 * day, crossing midnight), several windows separated by ";", or "none".
 */
export function parseHours(spec: string): Window[] {
  const out: Window[] = [];
  for (const part of spec
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)) {
    if (/^(none|off)$/i.test(part)) continue;
    const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})(?:\s+(.+))?$/.exec(part);
    if (!m) throw new Error(`Cannot read hours "${part}": use e.g. 08:00-18:00 Mon-Fri`);
    const start = Number(m[1]) * 60 + Number(m[2]);
    const end = Number(m[3]) * 60 + Number(m[4]);
    const days = new Set<number>();
    const dayText = (m[5] ?? "").trim().toLowerCase();
    if (!dayText) for (let d = 0; d < 7; d++) days.add(d);
    for (const token of dayText
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)) {
      const range = /^([a-z]{3})\w*(?:\s*-\s*([a-z]{3})\w*)?$/.exec(token);
      const a = DAYS.indexOf(range?.[1] ?? "");
      const b = range?.[2] ? DAYS.indexOf(range[2]) : a;
      if (a < 0 || b < 0) throw new Error(`Unknown day "${token}"`);
      for (let d = a; ; d = (d + 1) % 7) {
        days.add(d);
        if (d === b) break;
      }
    }
    out.push({ start, end, days });
  }
  return out;
}

/** Whether `at` falls inside the user's reserved hours. */
export function isReserved(windows: Window[], at: Date): boolean {
  const minute = at.getHours() * 60 + at.getMinutes();
  const day = at.getDay();
  for (const w of windows) {
    if (w.start <= w.end) {
      if (w.days.has(day) && minute >= w.start && minute < w.end) return true;
    } else {
      // Crosses midnight: the late part belongs to `day`, the early part to the day before.
      if (w.days.has(day) && minute >= w.start) return true;
      if (w.days.has((day + 6) % 7) && minute < w.end) return true;
    }
  }
  return false;
}

/** Minutes until the reserved hours end (0 when not reserved now). Bounded at a week. */
export function minutesUntilFree(windows: Window[], at: Date): number {
  for (let m = 0; m < 7 * 24 * 60; m++) {
    if (!isReserved(windows, new Date(at.getTime() + m * 60_000))) return m;
  }
  return 7 * 24 * 60;
}

/** Seconds since the last keyboard or mouse input, where the OS says; undefined otherwise. */
export function idleSeconds(
  read: (cmd: string, args: string[]) => string = defaultRead,
): number | undefined {
  try {
    if (platform() === "darwin") {
      const out = read("ioreg", ["-c", "IOHIDSystem", "-d", "4"]);
      const ns = /"HIDIdleTime"\s*=\s*(\d+)/.exec(out)?.[1];
      return ns ? Number(BigInt(ns) / 1_000_000_000n) : undefined;
    }
    if (platform() === "linux") {
      const ms = Number(read("xprintidle", []).trim());
      return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
    }
  } catch {
    // No idle source: treat as present (never run inside reserved hours).
  }
  return undefined;
}

function defaultRead(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export interface SlotDecision {
  run: boolean;
  why: string;
  /** When not running: suggested wait before asking again. */
  waitMinutes: number;
}

/** May unattended work run now? */
export function mayUseMachine(
  windows: Window[],
  opts: { now?: Date; idleMinutes?: number; idle?: () => number | undefined } = {},
): SlotDecision {
  const now = opts.now ?? new Date();
  if (!isReserved(windows, now))
    return { run: true, why: "outside the reserved hours", waitMinutes: 0 };
  const idle = (opts.idle ?? (() => idleSeconds()))();
  const needed = (opts.idleMinutes ?? 20) * 60;
  if (idle !== undefined && idle >= needed) {
    return {
      run: true,
      why: `reserved hours, but the user has been away ${Math.floor(idle / 60)} min`,
      waitMinutes: 0,
    };
  }
  return {
    run: false,
    why:
      idle === undefined
        ? "reserved hours, and idle time cannot be read"
        : `reserved hours; the user was active ${Math.floor(idle / 60)} min ago`,
    waitMinutes: Math.min(minutesUntilFree(windows, now), 10),
  };
}
