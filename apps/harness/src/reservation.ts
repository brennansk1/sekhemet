import type { CardRecord, CardStore, EventLog } from "@sekhemet/kernel";
import type { MemoryWatchdog } from "@sekhemet/models";

/**
 * Reserving the machine, and whether a card may start now (runtime.md items
 * 17, 17a and 22; NEW-runtime-5 RUN-58 and RUN-18, NEW-runtime-10 RUN-48).
 *
 * A reservation and a release are ledger events — `machine/reserved
 * {principal, until?}` and `machine/released {principal}` — appended by the
 * one implementation the CLI (`sekhemet dev reserve`) and the dashboard share.
 * Whether the machine is reserved now is read from the latest of them, never
 * from process memory, so a restart, a second process and the daemon agree.
 */

export const MACHINE_EVENTS = {
  reserved: "machine/reserved",
  released: "machine/released",
} as const;

export interface Reservation {
  reserved: boolean;
  principal?: string;
  /** When the reservation ends by itself (ISO), if it was given one. */
  until?: string;
  /** The seq of the event the answer was read from. */
  seq?: number;
}

/** The machine's reservation now, from the latest reserve or release event (RUN-58). */
export async function reservationNow(log: EventLog, now = new Date()): Promise<Reservation> {
  const events = await log.getEventsByTypes([MACHINE_EVENTS.reserved, MACHINE_EVENTS.released]);
  const latest = events.at(-1);
  if (!latest || latest.type === MACHINE_EVENTS.released) {
    return latest ? { reserved: false, seq: latest.seq } : { reserved: false };
  }
  const p = latest.payload as { principal: string; until?: string };
  const expired = p.until !== undefined && Date.parse(p.until) <= now.getTime();
  return {
    reserved: !expired,
    principal: p.principal,
    ...(p.until ? { until: p.until } : {}),
    seq: latest.seq,
  };
}

/** Reserve the machine; false (nothing appended) when it is already reserved. */
export async function reserveMachine(
  log: EventLog,
  input: { principal: string; until?: Date },
  now = new Date(),
): Promise<boolean> {
  if ((await reservationNow(log, now)).reserved) return false;
  await log.append({
    actor: "human",
    type: MACHINE_EVENTS.reserved,
    payload: {
      principal: input.principal,
      ...(input.until ? { until: input.until.toISOString() } : {}),
    },
    principal: input.principal,
  });
  return true;
}

/** Release the machine; false (nothing appended) when it is not reserved. */
export async function releaseMachine(
  log: EventLog,
  input: { principal: string },
  now = new Date(),
): Promise<boolean> {
  if (!(await reservationNow(log, now)).reserved) return false;
  await log.append({
    actor: "human",
    type: MACHINE_EVENTS.released,
    payload: { principal: input.principal },
    principal: input.principal,
  });
  return true;
}

/** `HH:MM` today (or tomorrow when already past), or an ISO time. */
export function parseUntil(spec: string, from = new Date()): Date | undefined {
  const hm = /^(\d{1,2}):(\d{2})$/.exec(spec);
  if (hm) {
    const t = new Date(from);
    t.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (t.getTime() <= from.getTime()) t.setDate(t.getDate() + 1);
    return t;
  }
  const iso = Date.parse(spec);
  return Number.isNaN(iso) ? undefined : new Date(iso);
}

/**
 * Why a card may not start now, or undefined when it may (RUN-18, RUN-48):
 * the memory watchdog asks to stop new worktrees, or the card's project is
 * paused. A card already running is never interrupted by either.
 */
export async function mayStartCard(
  ctx: { cardStore: CardStore; watchdog?: Pick<MemoryWatchdog, "isActive" | "state"> },
  card: Pick<CardRecord, "id" | "projectId">,
): Promise<string | undefined> {
  if (ctx.watchdog?.isActive("stopNewWorktrees")) {
    return `the memory watchdog asks to stop new worktrees (${ctx.watchdog.state.level}: ${ctx.watchdog.state.reason})`;
  }
  const projectId = card.projectId ?? (await ctx.cardStore.getCard(card.id))?.projectId;
  const project = projectId ? ctx.cardStore.getProject(projectId) : undefined;
  if (project && project.status === "paused") {
    return `its project ${project.name} is paused; resume it to run its issues`;
  }
  return undefined;
}

/**
 * Why a card may not start unattended now (models rule 20, MD-N3-1): while
 * the machine is reserved — a person's reserve-now, or inside `[machine]
 * reserved_hours` — an unattended run (an overnight round, the daemon)
 * starts only a card marked urgent (priority 1). A person starting a card
 * themselves is never refused here.
 */
export function unattendedStartRefusal(
  card: Pick<CardRecord, "id" | "priority">,
  ctx: { unattended: boolean; reservedNow: boolean; inReservedHours: boolean },
): string | undefined {
  if (!ctx.unattended || card.priority === 1) return undefined;
  if (ctx.reservedNow) return "the machine is reserved and the issue is not urgent";
  if (ctx.inReservedHours) return "it is inside the reserved hours and the issue is not urgent";
  return undefined;
}
