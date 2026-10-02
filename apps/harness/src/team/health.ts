import type { EventLog, EventRecord } from "@sekhemet/kernel";

/**
 * A project's health and a release's target date (teams §2.6 items 28–29,
 * NEW-teams-11, TEAM-28, -29, -45; dashboard DB-N9-2, -3; DEC-37): each is a
 * person's call, recorded with them as principal, and every answer here is a
 * fold of the event log — no second store. A model never sets either: the
 * only writers take a person's principal, and Seshat's weekly draft carries
 * no health word (`pm/weekly.ts`).
 */

export const HEALTH_SET = "project/health_set";
export const TARGET_SET = "release/target_set";
export const RELEASE_LEAD_SET = "release/lead_set";
export const HEALTH_VALUES = ["on_track", "at_risk", "off_track"] as const;
export type Health = (typeof HEALTH_VALUES)[number];

export const isHealth = (x: unknown): x is Health =>
  typeof x === "string" && (HEALTH_VALUES as readonly string[]).includes(x);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A calendar day, YYYY-MM-DD, that exists (2026-02-30 does not). */
export function isDay(x: unknown): x is string {
  if (typeof x !== "string" || !DAY_RE.test(x)) return false;
  const d = new Date(`${x}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === x;
}

/** A person sets the project's health (TEAM-28): the only write, never a model's. */
export async function setProjectHealth(
  log: EventLog,
  input: { project: string; health: Health; principal: string },
): Promise<void> {
  if (!input.principal) throw new Error("Health is set by a person; no one was named");
  if (!isHealth(input.health)) throw new Error("Health is On track, At risk or Off track");
  await log.append({
    actor: "human",
    type: HEALTH_SET,
    payload: { project: input.project, health: input.health },
    principal: input.principal,
  });
}

/** The project's health as last set, with who set it and when; null when no one has. */
export async function healthOf(
  log: EventLog,
  project: string,
): Promise<{ value: Health; principal: string; at: string } | null> {
  const last = (await log.getEventsByTypes([HEALTH_SET]))
    .filter((e) => e.actor === "human" && e.principal)
    .filter((e) => (e.payload as { project?: string }).project === project)
    .at(-1);
  const value = (last?.payload as { health?: unknown } | undefined)?.health;
  return last && isHealth(value)
    ? { value, principal: last.principal as string, at: last.createdAt }
    : null;
}

/** A person sets a release's target date, or clears it with none (DB-N9-3). */
export async function setReleaseTarget(
  log: EventLog,
  input: { sliceId: string; projectId: string; target: string | null; principal: string },
): Promise<void> {
  if (!input.principal) throw new Error("A target date is set by a person; no one was named");
  if (input.target !== null && !isDay(input.target)) {
    throw new Error("A target date is a day, YYYY-MM-DD");
  }
  await log.append({
    actor: "human",
    type: TARGET_SET,
    payload: {
      sliceId: input.sliceId,
      projectId: input.projectId,
      ...(input.target ? { target: input.target } : {}),
    },
    principal: input.principal,
  });
}

/**
 * A person names a release's lead, or clears it with none (teams item 28,
 * DB-N9-2): the only writer, with the person who named them as principal.
 */
export async function setReleaseLead(
  log: EventLog,
  input: { sliceId: string; projectId: string; lead: string | null; principal: string },
): Promise<void> {
  if (!input.principal) throw new Error("A release's lead is named by a person; no one was named");
  await log.append({
    actor: "human",
    type: RELEASE_LEAD_SET,
    payload: {
      sliceId: input.sliceId,
      projectId: input.projectId,
      ...(input.lead ? { lead: input.lead } : {}),
    },
    principal: input.principal,
  });
}

/** Each release's target date as last set (a cleared one is absent), with who set it. */
export async function releaseTargets(
  log: EventLog,
  project: string,
): Promise<Map<string, { date: string; principal: string; at: string }>> {
  const out = new Map<string, { date: string; principal: string; at: string }>();
  for (const e of await log.getEventsByTypes([TARGET_SET])) {
    if (e.actor !== "human" || !e.principal) continue;
    const p = e.payload as { sliceId?: string; projectId?: string; target?: string };
    if (p.projectId !== project || !p.sliceId) continue;
    if (p.target) out.set(p.sliceId, { date: p.target, principal: e.principal, at: e.createdAt });
    else out.delete(p.sliceId);
  }
  return out;
}

/** The events the update clock folds (TEAM-29). */
export const UPDATE_CLOCK_EVENTS = [
  "project/created",
  "project/update_posted",
  "slice/created",
  "slice/accepted",
] as const;

/**
 * When a project's update clock started (teams item 29, TEAM-29): its last
 * posted update; else when its current release started — the previous
 * release's acceptance, or the first release's creation; else the project's
 * creation. In ms, or undefined for a project the ledger never named.
 */
export function updateClockStart(
  events: readonly EventRecord[],
  project: string,
): number | undefined {
  return updateClock(events, project)?.at;
}

/**
 * The update clock with what started it — the last update, the current
 * release's start, or the project's creation — so a reminder says why.
 */
export function updateClock(
  events: readonly EventRecord[],
  project: string,
): { at: number; since: "update" | "release" | "project"; name?: string } | undefined {
  let created: number | undefined;
  let name: string | undefined;
  let firstRelease: number | undefined;
  let lastAccepted: number | undefined;
  let lastUpdate: number | undefined;
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const at = Date.parse(e.createdAt);
    if (e.type === "project/created" && (p.id ?? p.project) === project) {
      created ??= at;
      if (typeof p.name === "string") name ??= p.name;
    } else if (e.type === "project/update_posted" && p.project === project) lastUpdate = at;
    else if (e.type === "slice/created" && p.projectId === project) firstRelease ??= at;
    // A release a person accepted ends; the next one starts then (kernel K-N5-5).
    else if (e.type === "slice/accepted" && p.projectId === project && e.actor === "human")
      lastAccepted = at;
  }
  const named = name ? { name } : {};
  if (lastUpdate !== undefined) return { at: lastUpdate, since: "update", ...named };
  const release = lastAccepted ?? firstRelease;
  if (release !== undefined) return { at: release, since: "release", ...named };
  return created !== undefined ? { at: created, since: "project", ...named } : undefined;
}
