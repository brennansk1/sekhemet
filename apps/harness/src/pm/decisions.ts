import type { CardStore, EventLog } from "@sekhemet/kernel";
import { DecisionStore } from "@sekhemet/planner";
import { type Audience, nameFor } from "./audience.js";
import { voiceGuard } from "./voice.js";

/**
 * The decisions waiting, as Seshat names them (planner-pm §2.18.3, PM-N9-5):
 * the person who decides — the issue's owner, else the project's lead,
 * else, in Solo, you — then the question, then the default and its deadline
 * where one applies: "Needs a decision from Priya: keep the old API? Default
 * if no answer by 2026-10-02 17:00 UTC: Keep it." Only the decisions on
 * issues the asker can see (PM-N9-8). `plain` names the issue by its title,
 * never its id, as a standup does (PM-P6-3).
 */
export async function namedDecisions(
  ledger: { cardStore: CardStore; log: EventLog },
  audience: Audience,
  asker?: string,
  opts: { plain?: boolean } = {},
): Promise<string[]> {
  const planned = new Map(
    (await new DecisionStore({ store: ledger.cardStore, log: ledger.log }).waiting()).map((d) => [
      d.id,
      d.request,
    ]),
  );
  const lines: string[] = [];
  for (const d of ledger.cardStore.runs.listDecisions("pending")) {
    const card = d.cardId ? await ledger.cardStore.getCard(d.cardId) : null;
    if (asker && !audience.canSee(asker, card?.projectId)) continue;
    const person = card?.owner ?? audience.leadOf(card?.projectId);
    const who = person
      ? nameFor(audience, person, asker)
      : audience.setup === "solo"
        ? "you"
        : "the project lead";
    // PM-N9-4: the question and the option's label are the executor's own
    // words, read by a person here, so they are guarded like any other.
    const question = voiceGuard(d.question.trim().replace(/\s+/g, " "));
    const where = d.cardId ? ` (${opts.plain ? (card?.title ?? "an issue") : d.cardId})` : "";
    const request = planned.get(d.id);
    let tail = "";
    if (request) {
      const option =
        request.policy === "safe_default" && request.defaultIfNoAnswer.optionIndex !== undefined
          ? request.options[request.defaultIfNoAnswer.optionIndex]
          : undefined;
      tail = option
        ? ` Default if no answer by ${when(request.defaultIfNoAnswer.deadline)}: ${voiceGuard(option.label)}.`
        : " No default: the work waits for the answer.";
    }
    // A standup says how long each decision has waited (§2.7.8).
    const waited = opts.plain ? waitedFor(d.createdAt) : "";
    lines.push(`Needs a decision from ${who}: ${question}${where}${tail}${waited}`);
  }
  return lines;
}

/** " Waiting 3h." from when a decision was asked; nothing when that is not recorded. */
function waitedFor(createdAt: string | undefined, now = Date.now()): string {
  const t = createdAt ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(t)) return "";
  const h = Math.max(0, (now - t) / 3_600_000);
  return ` Waiting ${h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : `${Math.round(h * 10) / 10}h`}.`;
}

/** "2026-10-02 17:00 UTC": a deadline as a person reads it, the same everywhere. */
function when(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t)
    ? `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`
    : iso;
}
