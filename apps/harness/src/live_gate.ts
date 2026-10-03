import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GateRung, GateRunner, RunGatesOptions } from "@sekhemet/gates";
import { workspaceFolderOf } from "./workspace_locator.js";

/**
 * The running check, live (dashboard DB-N2-10, *Running Tests…*).
 *
 * A card's checks run in the card's own process; the dashboard server is
 * another. As the model's output reaches the page through the card's live
 * file (`.sekhemet/live/<card>.txt`, M2), the check runner's announce of each
 * check (`RunGatesOptions.onGateStart`) is written to
 * `.sekhemet/live/<card>.gate.json` with the process's pid, and removed when
 * the checks end. The server reads it into the card's badge and pushes a
 * `gate` frame when it changes. It is presence, not a fact: nothing about it
 * enters the event log, and a file whose process is gone is ignored.
 */

export interface LiveGate {
  gate: string;
  rung: string;
}

/** Where a card's running check is announced. */
export function liveGatePath(repoPath: string, cardId: string): string {
  // Runtime item 2: live files are the workspace's, beside its ledger.
  return join(workspaceFolderOf(repoPath), ".sekhemet", "live", `${cardId}.gate.json`);
}

function alive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists, owned by someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The check a card's live process is running now, or undefined (none, unreadable, or its process gone). */
export function readLiveGate(repoPath: string, cardId: string): LiveGate | undefined {
  const path = liveGatePath(repoPath, cardId);
  if (!existsSync(path)) return undefined;
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as Partial<LiveGate> & { pid?: unknown };
    if (typeof v.gate !== "string" || typeof v.rung !== "string" || !alive(v.pid)) return undefined;
    return { gate: v.gate, rung: v.rung };
  } catch {
    return undefined;
  }
}

function write(repoPath: string, cardId: string, gate: { gate: string; rung: GateRung }): void {
  try {
    mkdirSync(dirname(liveGatePath(repoPath, cardId)), { recursive: true });
    writeFileSync(
      liveGatePath(repoPath, cardId),
      JSON.stringify({ ...gate, pid: process.pid, startedAt: new Date().toISOString() }),
    );
  } catch {
    // The badge is best effort; the checks are not.
  }
}

function clear(repoPath: string, cardId: string): void {
  try {
    rmSync(liveGatePath(repoPath, cardId), { force: true });
  } catch {
    // Best effort: a stale file names a process that is gone, and is ignored.
  }
}

/**
 * The card's check runner, announcing each check to the card's live gate
 * file as it starts (and to the caller's own listener), and clearing it
 * when the run ends — passed, failed or thrown.
 */
export function withLiveGate(inner: GateRunner, repoPath: string, cardId: string): GateRunner {
  return {
    ...(inner.gateIds ? { gateIds: inner.gateIds } : {}),
    runGates: async (rungs, cwd, runOptions?: RunGatesOptions) => {
      const options: RunGatesOptions = {
        ...(runOptions ?? {}),
        onGateStart: (g) => {
          write(repoPath, cardId, g);
          runOptions?.onGateStart?.(g);
        },
      };
      try {
        return await inner.runGates(rungs, cwd, options);
      } finally {
        clear(repoPath, cardId);
      }
    },
  };
}
