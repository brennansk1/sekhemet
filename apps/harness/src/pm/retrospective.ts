import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CardStore,
  ERASED_MARKER,
  type EventLog,
  type EventRecord,
  firstModelAttempts,
  parseToml,
} from "@sekhemet/kernel";
import { processProfileFromConfig } from "@sekhemet/planner";
import { type Audience, nameFor, soloAudience } from "./audience.js";
import { SPRINT_REPORT_TYPES, sprintReport } from "./sprints.js";
import { allEvents, plainTitle } from "./standup.js";
import type { PmStore } from "./store.js";
import { voiceGuard } from "./voice.js";

/**
 * The retrospective, a report for people (planner-pm §2.7 item 4,
 * NEW-planner-pm-11; DEC-05: ceremonies are reports, never meetings between
 * agents; FINDINGS_C1 PRC-03). When a sprint completes, or when
 * `retro_every_cards` issues have been accepted in a Kanban project (one
 * that runs no sprints), Seshat drafts one from the ledger: what went well
 * (issues accepted, first-try passes, cycle time against the service level),
 * what slowed the team (review wait, the reasons given when changes were
 * requested, time on hold, scope added during the sprint) and proposed
 * actions. Every figure is computed here, by code, with its basis; the
 * draft's words are this module's, as the standup's are. An action is a
 * proposal a person applies where it lives — a Playbook rule on the
 * Playbook, review capacity on Configuration, a new issue in Triage —
 * so drafting changes nothing (DEC-36). A person edits and posts it:
 * `retrospective/posted`, its text private, listed on Status.
 */

export const RETRO_POSTED = "retrospective/posted";

export interface RetroDeps {
  cardStore: CardStore;
  log: EventLog;
  pmStore: PmStore;
  /** The project's repository, for its `[process]` profile. */
  repoPath?: string;
}

/** Every figure the draft states, computed from the ledger before any words. */
export interface RetroFacts {
  project: string;
  /** "Sprint 3", or "the last 10 accepted issues". */
  title: string;
  /** "this sprint", or "since the last retrospective". */
  sprintWords: string;
  from: string;
  to: string;
  accepted: { id: string; title: string }[];
  firstTime: { passed: number; total: number };
  /** Cycle times of the issues finished in the window, and the project's 85th percentile. */
  cycle: { hours: number[]; serviceLevelHours?: number };
  /** Each wait in Review that ended in the window, and the longest. */
  reviewWait: { hours: number[]; longest?: { title: string; hours: number } };
  /** The reasons a person gave when requesting changes, with the issue. */
  changesRequested: { reason: string; title: string }[];
  /** Issues on hold in the window: how long, and why. */
  onHold: { title: string; hours: number; reason: string }[];
  /** Issues added to the sprint after it started (none for Kanban). */
  scopeAdded: string[];
  reviewMinutesPerDay: number;
  /** "Based on: Activity log #a–#b · N issues accepted." */
  basedOn: string;
}

export interface RetroAction {
  kind: "playbook" | "review_capacity" | "issue";
  text: string;
  why: string;
  /** Where a person applies it. */
  href?: string;
  /** A new issue's title, filed in Triage by a person's press. */
  title?: string;
}

export interface RetroDraft {
  wentWell: string[];
  slowed: string[];
  actions: RetroAction[];
  text: string;
  basedOn: string;
}

export interface RetroDue {
  sprint?: { id: string; name: string };
  from: string;
  to: string;
  reason: string;
}

const HOUR = 3_600_000;
const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
const hours = (h: number) =>
  h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : `${Math.round(h * 10) / 10}h`;
const median = (xs: readonly number[]) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};
const percentile = (xs: readonly number[], q: number) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
};
const once = (k: number) => (k === 1 ? "once" : k === 2 ? "twice" : `${k} times`);

/** The project's `[process]` profile: Kanban, with `retro_every_cards`, unless it says otherwise. */
function profileOf(repoPath: string | undefined) {
  const p = repoPath ? join(repoPath, ".sekhemet", "config.toml") : undefined;
  let table: Parameters<typeof processProfileFromConfig>[0];
  if (p && existsSync(p)) {
    try {
      table = parseToml(readFileSync(p, "utf8"));
    } catch {
      table = undefined;
    }
  }
  return processProfileFromConfig(table);
}

/** The project's posted retrospectives, oldest first, the text as the person posted it. */
export async function postedRetrospectives(
  log: EventLog,
  project: string,
  audience: Audience = soloAudience(),
  me?: string,
): Promise<
  { id: string; sprint?: string; from: string; to: string; text: string; by: string; at: string }[]
> {
  return (await log.getEventsByTypes([RETRO_POSTED]))
    .filter((e) => (e.payload as { project?: string }).project === project)
    .map((e) => {
      const p = e.payload as { id: string; sprint?: string; from: string; to: string };
      const text = (e.private as { text?: unknown } | undefined)?.text;
      return {
        id: p.id,
        ...(p.sprint ? { sprint: p.sprint } : {}),
        from: p.from,
        to: p.to,
        text: typeof text === "string" && text !== ERASED_MARKER ? text : "",
        by: nameFor(audience, e.principal ?? undefined, me),
        at: e.createdAt,
      };
    });
}

/**
 * Whether a retrospective is due (PM-N11-1): the project's latest completed
 * sprint has none posted; or, in a project that runs no sprints, its
 * profile's `retro_every_cards` issues were accepted since the last one.
 */
export async function retrospectiveDue(
  deps: RetroDeps,
  project: string,
  now = new Date(),
): Promise<RetroDue | undefined> {
  const posted = await postedRetrospectives(deps.log, project);
  const sprints = (await deps.pmStore.cycles()).filter((c) => c.projectId === project);
  if (sprints.length > 0) {
    const ids = new Set(sprints.map((c) => c.id));
    const events = await deps.log.getEventsByTypes(["cycle/started", "cycle/completed"]);
    const completed = events
      .filter(
        (e) => e.type === "cycle/completed" && ids.has(String((e.payload as { id?: string }).id)),
      )
      .at(-1);
    if (!completed) return undefined;
    const id = String((completed.payload as { id: string }).id);
    if (posted.some((r) => r.sprint === id)) return undefined;
    const started = events.find(
      (e) => e.type === "cycle/started" && (e.payload as { id?: string }).id === id,
    );
    const sprint = sprints.find((c) => c.id === id);
    const name = sprint?.name ?? "the sprint";
    return {
      sprint: { id, name },
      from:
        started?.createdAt ??
        `${sprint?.startsOn ?? completed.createdAt.slice(0, 10)}T00:00:00.000Z`,
      to: completed.createdAt,
      reason: `${name} completed`,
    };
  }
  const every = profileOf(deps.repoPath).retroEveryCards;
  if (!every) return undefined;
  const from =
    posted.at(-1)?.to ?? deps.cardStore.getProject(project)?.createdAt ?? new Date(0).toISOString();
  const accepted = await acceptedIn(deps, project, from, now.toISOString());
  if (accepted.length < every) return undefined;
  return {
    from,
    to: now.toISOString(),
    reason: `${n(accepted.length, "issue")} accepted since the last retrospective`,
  };
}

/** The project's issues accepted in (from, to], each once, by its latest accept. */
async function acceptedIn(
  deps: RetroDeps,
  project: string,
  from: string,
  to: string,
): Promise<{ id: string; title: string; e: EventRecord }[]> {
  const latest = new Map<string, EventRecord>();
  for (const e of await deps.log.getEventsByTypes(["card/accepted"])) {
    if (e.createdAt <= from || e.createdAt > to) continue;
    const id = (e.payload as { id?: string }).id;
    if (id) latest.set(id, e);
  }
  const out: { id: string; title: string; e: EventRecord }[] = [];
  for (const [id, e] of latest) {
    const c = await deps.cardStore.getCard(id);
    if (c && c.projectId === project) out.push({ id, title: plainTitle(c), e });
  }
  return out.sort((a, b) => a.e.seq - b.e.seq);
}

/** Every figure of the retrospective for `due`'s window (PM-N11-1), from the ledger alone. */
export async function retrospectiveFacts(
  deps: RetroDeps,
  project: string,
  due: RetroDue,
): Promise<RetroFacts> {
  const { from, to } = due;
  const inWindow = (at: string) => at > from && at <= to;
  const cards = (await deps.cardStore.listCards()).filter((c) => c.projectId === project);
  const title = new Map(cards.map((c) => [c.id, plainTitle(c)]));
  const accepted = await acceptedIn(deps, project, from, to);

  // Moves, per issue, for cycle time, review wait and time on hold.
  const moves = (await deps.log.getEventsByTypes(["card/status_changed"])).filter((e) =>
    title.has(String((e.payload as { id?: string }).id ?? e.cardId)),
  );
  const started = new Map<string, number>();
  const cycleAll: number[] = [];
  const cycleWindow: number[] = [];
  const enteredReview = new Map<string, number>();
  const waits: { id: string; hours: number }[] = [];
  const heldSince = new Map<string, { at: number; reason: string }>();
  const held = new Map<string, { hours: number; reason: string }>();
  const changes: { reason: string; title: string }[] = [];
  const addHeld = (id: string, endMs: number) => {
    const h = heldSince.get(id);
    if (!h) return;
    const startMs = Math.max(h.at, Date.parse(from));
    const span = Math.max(0, Math.min(endMs, Date.parse(to)) - startMs) / HOUR;
    if (span > 0) {
      const was = held.get(id);
      held.set(id, { hours: (was?.hours ?? 0) + span, reason: h.reason });
    }
    heldSince.delete(id);
  };
  for (const e of moves) {
    const p = e.payload as { id?: string; fromStatus?: string; toStatus?: string; reason?: string };
    const id = String(p.id ?? e.cardId);
    const at = Date.parse(e.createdAt);
    if (p.toStatus === "in_progress" && !started.has(id)) started.set(id, at);
    if (p.fromStatus === "review" && enteredReview.has(id)) {
      if (inWindow(e.createdAt)) {
        waits.push({ id, hours: (at - (enteredReview.get(id) as number)) / HOUR });
      }
      enteredReview.delete(id);
    }
    if (p.toStatus === "review") enteredReview.set(id, at);
    if (p.fromStatus === "parked") addHeld(id, at);
    if (p.toStatus === "parked") {
      const why = String(p.reason ?? "").replace(/^parked:?\s*/, "");
      heldSince.set(id, { at, reason: why || "no reason was given" });
    }
    if (p.toStatus === "done") {
      const s = started.get(id);
      if (s !== undefined) {
        const h = (at - s) / HOUR;
        if (e.createdAt <= to) cycleAll.push(h);
        if (inWindow(e.createdAt)) cycleWindow.push(h);
      }
    }
    const back = /^returned:\s*(.*)$/s.exec(String(p.reason ?? ""));
    if (back && inWindow(e.createdAt)) {
      changes.push({
        reason: voiceGuard((back[1] ?? "").trim()),
        title: title.get(id) ?? "an issue",
      });
    }
  }
  for (const id of heldSince.keys()) addHeld(id, Date.parse(to));

  const ids = new Set(cards.map((c) => c.id));
  const first = firstModelAttempts(deps.cardStore.runs.readAttemptOutcomes()).filter(
    (o) => ids.has(o.cardId) && inWindow(o.completedAt),
  );
  let scopeAdded: string[] = [];
  if (due.sprint) {
    const report = sprintReport(await allEvents(deps.log, [...SPRINT_REPORT_TYPES]), due.sprint.id);
    scopeAdded = (report?.added.issues ?? []).map((id) => title.get(id) ?? "an issue");
  }
  const longest = [...waits].sort((a, b) => b.hours - a.hours)[0];
  const seqs = [
    ...accepted.map((a) => a.e.seq),
    ...moves.filter((e) => inWindow(e.createdAt)).map((e) => e.seq),
  ];
  const lo = seqs.length ? Math.min(...seqs) : 0;
  const hi = seqs.length ? Math.max(...seqs) : 0;
  const serviceLevelHours = percentile(cycleAll, 0.85);
  return {
    project,
    title: due.sprint ? due.sprint.name : `the last ${n(accepted.length, "accepted issue")}`,
    sprintWords: due.sprint ? "this sprint" : "since the last retrospective",
    from,
    to,
    accepted: accepted.map(({ id, title: t }) => ({ id, title: t })),
    firstTime: { passed: first.filter((o) => o.passed).length, total: first.length },
    cycle: {
      hours: cycleWindow,
      ...(serviceLevelHours !== undefined ? { serviceLevelHours } : {}),
    },
    reviewWait: {
      hours: waits.map((w) => w.hours),
      ...(longest
        ? { longest: { title: title.get(longest.id) ?? "an issue", hours: longest.hours } }
        : {}),
    },
    changesRequested: changes,
    onHold: [...held.entries()]
      .map(([id, h]) => ({
        title: title.get(id) ?? "an issue",
        hours: h.hours,
        reason: voiceGuard(h.reason),
      }))
      .sort((a, b) => b.hours - a.hours),
    scopeAdded,
    reviewMinutesPerDay: deps.cardStore.getProject(project)?.reviewMinutesPerDay ?? 60,
    basedOn: `Based on: Activity log #${lo}–#${hi} · ${n(accepted.length, "issue")} accepted.`,
  };
}

/** A review waits longer than a working day at the median: more review capacity is proposed. */
const SLOW_REVIEW_HOURS = 24;

/** The draft's words and proposals from its figures (PM-N11-1, -2): code, never a model. */
export function retrospectiveDraft(f: RetroFacts): RetroDraft {
  const wentWell: string[] = [
    f.accepted.length
      ? `${n(f.accepted.length, "issue")} accepted: ${f.accepted.map((a) => a.title).join("; ")}.`
      : "No issue was accepted.",
  ];
  if (f.firstTime.total) {
    wentWell.push(
      `${f.firstTime.passed} of ${n(f.firstTime.total, "issue")} passed ${f.firstTime.total === 1 ? "its" : "their"} checks on the Agent's first try.`,
    );
  }
  if (f.cycle.hours.length && f.cycle.serviceLevelHours !== undefined) {
    const sl = f.cycle.serviceLevelHours;
    const within = f.cycle.hours.filter((h) => h <= sl).length;
    wentWell.push(
      `${within} of ${n(f.cycle.hours.length, "issue")} finished within the service level of ${hours(sl)} (85% of this project's issues finish within it).`,
    );
  }
  const slowed: string[] = [];
  const wait = median(f.reviewWait.hours);
  if (wait !== undefined) {
    slowed.push(
      `Review wait: ${hours(wait)} at the median${f.reviewWait.longest ? `; the longest was ${f.reviewWait.longest.title} (${hours(f.reviewWait.longest.hours)})` : ""}.`,
    );
  }
  if (f.changesRequested.length) {
    slowed.push(
      `Changes were requested ${once(f.changesRequested.length)}: ${f.changesRequested
        .map((c) => `“${c.reason}” (${c.title})`)
        .join("; ")}.`,
    );
  }
  if (f.onHold.length) {
    slowed.push(
      `On hold: ${f.onHold.map((h) => `${h.title} (${hours(h.hours)}: ${h.reason})`).join("; ")}.`,
    );
  }
  if (f.scopeAdded.length) {
    slowed.push(`Scope added during the sprint: ${f.scopeAdded.join("; ")}.`);
  }
  if (!slowed.length) slowed.push("Nothing held the work up.");

  // DEC-36: each action is a proposal a person applies where it lives.
  const actions: RetroAction[] = [];
  if (f.changesRequested.length) {
    actions.push({
      kind: "playbook",
      text: "Make the note you gave when requesting changes a Playbook rule, so the Agent is told it before its first try.",
      why: `Changes were requested ${once(f.changesRequested.length)} ${f.sprintWords} for a reason the Agent could have been told up front.`,
      href: "#/playbook",
    });
  }
  if (wait !== undefined && wait > SLOW_REVIEW_HOURS) {
    const to = Math.ceil((f.reviewMinutesPerDay * 1.5) / 15) * 15;
    actions.push({
      kind: "review_capacity",
      text: `Raise review capacity from ${f.reviewMinutesPerDay} to ${to} minutes a day.`,
      why: `Issues waited ${hours(wait)} for review at the median, longer than a working day.`,
      href: "#/configuration/review",
    });
  }
  const blocked = f.onHold[0];
  if (blocked) {
    actions.push({
      kind: "issue",
      text: `Create an issue to remove what holds “${blocked.title}”.`,
      why: `It was on hold: ${blocked.reason}.`,
      title: `Remove the blocker on “${blocked.title}”`,
    });
  }
  const bullets = (xs: readonly string[]) => xs.map((x) => `- ${x}`).join("\n");
  const text = [
    `Retrospective: ${f.title}`,
    `What went well\n${bullets(wentWell)}`,
    `What slowed the team\n${bullets(slowed)}`,
    `Proposed actions\n${
      actions.length
        ? bullets(actions.map((a) => `${a.text} Why: ${a.why}`))
        : "- None: nothing slowed the team enough to change how it works."
    }`,
    f.basedOn,
  ].join("\n\n");
  return { wentWell, slowed, actions, text, basedOn: f.basedOn };
}

/** The due retrospective's draft, or none (a GET: it records nothing). */
export async function retrospectiveState(
  deps: RetroDeps,
  project: string,
  audience?: Audience,
  me?: string,
): Promise<{
  due: RetroDue | null;
  draft: RetroDraft | null;
  posted: Awaited<ReturnType<typeof postedRetrospectives>>;
}> {
  const due = await retrospectiveDue(deps, project);
  const draft = due ? retrospectiveDraft(await retrospectiveFacts(deps, project, due)) : null;
  return {
    due: due ?? null,
    draft,
    posted: await postedRetrospectives(deps.log, project, audience, me),
  };
}

/** A person posts the retrospective (PM-N11-3): the only write, with the person as principal. */
export async function postRetrospective(
  log: EventLog,
  input: {
    project: string;
    sprint?: string;
    from: string;
    to: string;
    text: string;
    principal: string;
  },
): Promise<string> {
  if (!input.principal) throw new Error("A retrospective is posted by a person; no one was named");
  if (!input.text.trim()) throw new Error("A retrospective needs its text");
  const id = `retro_${randomUUID().slice(0, 8)}`;
  await log.append({
    actor: "human",
    type: RETRO_POSTED,
    principal: input.principal,
    payload: {
      id,
      project: input.project,
      ...(input.sprint ? { sprint: input.sprint } : {}),
      from: input.from,
      to: input.to,
    },
    private: { text: input.text },
  });
  return id;
}

/** Seshat's line in the chat when a sprint's draft is ready (PM-N11-1). */
export function retrospectiveReadyText(sprint: string): string {
  return `I drafted the retrospective for ${sprint} from the Activity log. Edit it and post it on Status; nothing changes until a person applies an action.`;
}
