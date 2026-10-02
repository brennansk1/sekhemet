import type { CardStore, EventLog, EventRecord, LifecycleHookEvent } from "@sekhemet/kernel";
import { PR_EVENT } from "./github_sync.js";
import {
  BOARD_EVENTS,
  type UserHook,
  hookHandler,
  hookName,
  loadPersonHooks,
  loadUserHooks,
} from "./user_hooks.js";

/**
 * Board-lifecycle hooks (extensibility rules 4 and 7, NEW-extensibility-1): a
 * team calls its own tracker or CI when a card moves, is accepted or has a
 * pull request opened. Each hook runs once per ledger event, after the event
 * committed; it observes and cannot block or reverse the transition. A hook
 * that exits 2 has its stderr recorded on the card's dossier (EXT-9); one
 * that fails is recorded the same way, never silently.
 */

/** Which ledger event each board-lifecycle hook event follows. */
const LEDGER_TYPES: Record<string, LifecycleHookEvent> = {
  "card/status_changed": "card/status_changed",
  "card/accepted": "card/accepted",
  [PR_EVENT]: "pr/opened",
};

export function watchBoardHooks(
  log: EventLog,
  cardStore: CardStore,
  repoPath: string,
): { stop: () => void; idle: () => Promise<void> } {
  const hooks: UserHook[] = [...loadPersonHooks().hooks, ...loadUserHooks(repoPath).hooks].filter(
    (h) => BOARD_EVENTS.includes(h.event),
  );
  const pending = new Set<Promise<void>>();
  if (hooks.length === 0) return { stop: () => undefined, idle: async () => undefined };

  const run = async (event: LifecycleHookEvent, record: EventRecord): Promise<void> => {
    const cardId = record.cardId ?? String((record.payload as { id?: string })?.id ?? "");
    const context = { cardId, data: { ...(record.payload as Record<string, unknown>) } };
    for (const hook of hooks.filter((h) => h.event === event)) {
      let objection: string | undefined;
      try {
        const outcome = await hookHandler(hook, repoPath)(context);
        if (outcome && "block" in outcome && outcome.block) objection = outcome.reason ?? "";
      } catch (err) {
        objection = err instanceof Error ? err.message : String(err);
      }
      if (objection === undefined || !cardId) continue;
      await cardStore
        .recordDossierEntry({
          cardId,
          kind: "note",
          actor: "harness",
          text: `Hook "${hookName(hook)}" on ${event} objected (the move stands): ${objection}`,
        })
        .catch(() => undefined);
    }
  };

  const unsubscribes = Object.entries(LEDGER_TYPES).map(([type, event]) =>
    log.subscribe({ type }, (record) => {
      const p = run(event, record).finally(() => pending.delete(p));
      pending.add(p);
    }),
  );
  return {
    stop: () => {
      for (const u of unsubscribes) u();
    },
    idle: async () => {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}
