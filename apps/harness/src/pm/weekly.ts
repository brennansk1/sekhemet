import type { CardRecord, CardStore, EventLog } from "@sekhemet/kernel";
import { parseTitle, stopReasonLabel } from "@sekhemet/ui";
import { type Audience, soloAudience } from "./audience.js";
import { namedDecisions } from "./decisions.js";
import type { PmStore } from "./store.js";
import { voiceGuard } from "./voice.js";

/**
 * The weekly project update (planner-pm §2.18.5, PM-N9-7; teams item 29):
 * Seshat drafts it from the ledger in five parts — status, done, next,
 * risks, asks — and proposes no health word, which is the lead's. A draft
 * writes nothing: the update exists once a person posts it
 * (`project/update_posted`, its text private).
 */

/** The words of a project's health (teams item 28): never in Seshat's draft. */
export const HEALTH_WORDS = ["on track", "at risk", "off track"] as const;

export const UPDATE_POSTED = "project/update_posted";

export interface WeeklyDraft {
  project?: string;
  parts: { status: string; done: string; next: string; risks: string; asks: string };
  /** The five parts as one text, for the editor; a person edits and posts it. */
  text: string;
}

const WEEK_MS = 7 * 24 * 3_600_000;
/**
 * An issue as the update's reader knows it: its title, never its id or a
 * stop-reason code (DEC-31; the draft is edited on Status, dashboard DB-P5-2).
 */
const name = (c: CardRecord) => parseTitle(c.title).title;
const issues = (n: number) => `${n} ${n === 1 ? "issue" : "issues"}`;
const list = (cards: CardRecord[], none: string) =>
  cards.length ? cards.map((c) => `- ${name(c)}`).join("\n") : none;

/** A health word, if the text carries one, is taken out: health is the lead's to set. */
function withoutHealth(text: string): string {
  return text.replace(/\b(?:on|off) track\b|\bat risk\b/gi, "exposed");
}

export async function draftWeeklyUpdate(deps: {
  repoPath: string;
  cardStore: CardStore;
  pmStore: PmStore;
  /** One project's update; the whole workspace's when omitted. */
  project?: string;
  audience?: Audience;
  /** Who the draft is for: only what they can see (PM-N9-8). */
  asker?: string;
  now?: Date;
}): Promise<WeeklyDraft> {
  const audience = deps.audience ?? soloAudience();
  const now = (deps.now ?? new Date()).getTime();
  const cards = (await deps.cardStore.listCards()).filter(
    (c) =>
      c.tier !== "epic" &&
      (deps.project === undefined || c.projectId === deps.project) &&
      (!deps.asker || audience.canSee(deps.asker, c.projectId)),
  );
  const by = (s: string) => cards.filter((c) => c.status === s);
  const done = by("done").filter((c) => now - Date.parse(c.updatedAt) <= WEEK_MS);
  const flight = [...by("in_progress"), ...by("verify")];
  const review = by("review");
  const next = by("ready")
    .sort((a, b) => (a.priority || 9) - (b.priority || 9))
    .slice(0, 3);
  const stopped = cards.filter(
    (c) => c.stopReason && c.stopReason !== "gate_passed" && c.status !== "done",
  );
  const parked = by("parked").filter((c) => !stopped.includes(c));
  const decisions = await namedDecisions(
    { cardStore: deps.cardStore, log: deps.pmStore.log as EventLog },
    audience,
    deps.asker,
  );
  const status = `${issues(done.length)} done in the last 7 days, ${flight.length} in progress, ${review.length} waiting for review, ${by("ready").length} ready.`;
  // PM-N9-4: a parked reason may carry a model's own words (a suggestion's
  // "why", a planner's hold); guarded here, where the draft reads it.
  // DEC-31: a parked issue is *On hold*; an issue its reason names is named by its
  // title, one the reader cannot see only as "an issue" (DB-P5-2, PM-N9-8).
  const titles = new Map(cards.map((c) => [c.id, name(c)]));
  const withTitles = (text: string) =>
    text.replace(/\bcard_[A-Za-z0-9_.:-]*[A-Za-z0-9]/g, (id) => titles.get(id) ?? "an issue");
  const risks = [
    ...stopped.map((c) => `- ${name(c)}: ${stopReasonLabel(c.stopReason).sentence}`),
    ...parked.map(
      (c) =>
        `- ${name(c)} is on hold: ${withTitles(voiceGuard(c.blockedReason ?? "no reason recorded"))}`,
    ),
  ];
  const asks = [
    // A decision's line names its issue by id for Seshat; the reader has the question.
    ...decisions.map((d) => `- ${d.replace(/\s*\(card_[A-Za-z0-9_-]+\)/g, "")}`),
    ...(review.length ? [`- Review: ${review.map(name).join(", ")}`] : []),
  ];
  const parts = {
    status: withoutHealth(status),
    done: withoutHealth(list(done, "Nothing finished this week.")),
    next: withoutHealth(list(next, "Nothing is ready yet.")),
    risks: withoutHealth(risks.length ? risks.join("\n") : "None seen this week."),
    asks: withoutHealth(asks.length ? asks.join("\n") : "Nothing waits on a person."),
  };
  const text = [
    `Status\n${parts.status}`,
    `Done\n${parts.done}`,
    `Next\n${parts.next}`,
    `Risks\n${parts.risks}`,
    `Asks\n${parts.asks}`,
  ].join("\n\n");
  return { ...(deps.project ? { project: deps.project } : {}), parts, text };
}

/** A person posts the update (teams item 29): the only write, with the person as principal. */
export async function postWeeklyUpdate(
  log: EventLog,
  input: { project: string; text: string; principal: string },
): Promise<void> {
  if (!input.principal) throw new Error("An update is posted by a person; no one was named");
  if (!input.text.trim()) throw new Error("An update needs its text");
  await log.append({
    actor: "human",
    type: UPDATE_POSTED,
    payload: { project: input.project },
    private: { text: input.text },
    principal: input.principal,
  });
}
