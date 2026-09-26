import type { CardStore } from "@sekhemet/kernel";
import type { ModelHold } from "@sekhemet/models";
import { answerQueued, runnerLease } from "./pm/service.js";
import type { PmStore } from "./pm/store.js";
import type { PmMessage } from "./pm/types.js";

/**
 * `sekhemet ask "<question>"` (surface item 16a, NEW-surface-6; owner
 * decision O23, approved by the lead under DEC-42): Seshat from the terminal,
 * for non-developers and people on SSH. It is Seshat's conversation, not a
 * second one: the question is the person's message in the thread the
 * dashboard and ACP show, answered through the PM's queued-answer path, and
 * the reply is printed. Proposals the reply creates are listed with where to
 * apply them; `ask` applies none. When a queue runner holds the lease, Seshat
 * answers between the Worker's steps and `ask` says it is waiting.
 *
 * Exit codes (surface item 18): 0 answered; 1 no model could answer (the
 * reason is printed); 2 no question.
 */
export interface AskDeps {
  repoPath: string;
  cardStore: CardStore;
  pmStore: PmStore;
  pmModel: string;
  acquire: () => Promise<ModelHold>;
  researcher?: Parameters<typeof answerQueued>[0]["researcher"];
  say?: (line: string) => void;
  /** How long to wait for a running queue's answer; default 30 minutes. */
  waitMs?: number;
  pollMs?: number;
}

function print(say: (l: string) => void, replies: readonly PmMessage[]): 0 | 1 {
  let failed = false;
  for (const r of replies) {
    say(r.text);
    if (r.state === "error") failed = true;
    const proposals = (r.proposals ?? []).filter((p) => p.state === "open");
    if (proposals.length > 0) {
      say("");
      say(
        `${proposals.length} proposed change${proposals.length === 1 ? "" : "s"} — ask applies none; apply or discard them in the dashboard's Seshat panel:`,
      );
      for (const p of proposals) say(`  - ${p.summary}${p.cardId ? ` (${p.cardId})` : ""}`);
    }
  }
  return failed ? 1 : 0;
}

export async function runAsk(question: string, deps: AskDeps): Promise<0 | 1 | 2> {
  const say = deps.say ?? ((l: string) => console.log(l));
  const text = question.trim();
  if (!text) {
    say('Usage: sekhemet ask "<question>"');
    return 2;
  }
  const asked = await deps.pmStore.appendUserMessage(text.slice(0, 8000), { view: "terminal" });
  const repliesSince = async () =>
    (await deps.pmStore.thread()).filter((m) => m.role === "pm" && m.seq > asked.seq);

  const lease = runnerLease(deps.repoPath);
  if (lease) {
    // A queue is running: it answers queued messages between the Worker's
    // steps (runtime item 4). Wait for that answer rather than load a model.
    say("Seshat answers between the Worker's steps; waiting…");
    const deadline = Date.now() + (deps.waitMs ?? 30 * 60_000);
    while (Date.now() < deadline) {
      const replies = await repliesSince();
      const answered = (await deps.pmStore.thread()).some(
        (m) => m.id === asked.id && m.state === "done",
      );
      if (answered && replies.length > 0) return print(say, replies);
      await new Promise((r) => setTimeout(r, deps.pollMs ?? 2_000));
    }
    say("No answer yet; your question is kept in Seshat's thread and answered on the next step.");
    return 1;
  }

  try {
    await answerQueued({
      repoPath: deps.repoPath,
      cardStore: deps.cardStore,
      pmStore: deps.pmStore,
      pmModel: deps.pmModel,
      acquire: deps.acquire,
      ...(deps.researcher ? { researcher: deps.researcher } : {}),
    });
  } catch (err) {
    say(`Seshat could not answer: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const replies = await repliesSince();
  if (replies.length === 0) {
    say("Seshat did not answer; your question is kept in the thread.");
    return 1;
  }
  return print(say, replies);
}
