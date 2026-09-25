import { type BoardService, BoardServiceImpl } from "@sekhemet/board";
import type { CardStore } from "@sekhemet/kernel";
import type { ResearchAnswer } from "../research/researcher.js";
import { capabilityReport, capabilitySummary } from "./capability.js";
import { pmQuality } from "./metrics.js";
import type { PmStore } from "./store.js";

/**
 * Slash commands in Seshat's chat (H16).
 *
 * A command the human typed is an instruction, not a conversation, so it is
 * answered by code, from the ledger, without loading the manager model
 * (a 40-120 s swap on this hardware). Only /plan goes to Seshat, rewritten
 * into the request it stands for; /compact stays with the summariser.
 * Status moves (/ready, /park, /backlog) are applied as the human's own
 * action and recorded as theirs on the ledger.
 */

export interface SlashCommand {
  name: string;
  args: string;
}

export const SLASH_HELP: { cmd: string; does: string }[] = [
  { cmd: "/help", does: "This list." },
  { cmd: "/status", does: "Standup from the ledger: done, in flight, needs you." },
  {
    cmd: "/forecast",
    does: "When the open work is likely done (Monte Carlo over throughput, 50th and 85th percentile).",
  },
  {
    cmd: "/capability",
    does: "The Worker's measured pass rate by card kind, and its size horizon.",
  },
  { cmd: "/research <question>", does: "Ask the Researcher; the answer comes with sources." },
  { cmd: "/deep <question>", does: "Deep research: a team of sub-researchers and a verifier." },
  { cmd: "/plan <feature>", does: "Seshat splits a feature into cards (as proposals you apply)." },
  { cmd: "/ready <card>", does: "Move a card to Ready." },
  { cmd: "/park <card> [reason]", does: "Park a card." },
  { cmd: "/backlog <card>", does: "Move a card back to Backlog." },
  { cmd: "/compact", does: "Fold the conversation into Seshat's summary." },
];

export function parseSlash(text: string): SlashCommand | undefined {
  const m = /^\s*\/([a-z]+)\b\s*([\s\S]*)$/i.exec(text);
  return m ? { name: (m[1] ?? "").toLowerCase(), args: (m[2] ?? "").trim() } : undefined;
}

export interface SlashDeps {
  cardStore: CardStore;
  /** The board every move goes through (kernel K-S4-3); the harness passes its own. */
  board?: Pick<BoardService, "transitionCard">;
  pmStore: PmStore;
  repoPath: string;
  researcher?: ((q: string, o?: { deep?: boolean }) => Promise<ResearchAnswer>) | undefined;
}

/** What to do with a command: a reply now, or a rewritten message for Seshat. */
export type SlashOutcome = { reply: string } | { forward: string } | { passthrough: true };

async function resolveCard(cardStore: CardStore, ref: string): Promise<string | undefined> {
  const id = ref.split(/\s+/)[0] ?? "";
  if (!id) return undefined;
  if (await cardStore.getCard(id)) return id;
  if (await cardStore.getCard(`card_${id}`)) return `card_${id}`;
  // A short suffix, as the board shows it ("hasher" for card_chron_hasher).
  const all = await cardStore.listCards();
  const hits = all.filter((c) => c.id.endsWith(`_${id}`) || c.id.endsWith(id));
  return hits.length === 1 ? hits[0]?.id : undefined;
}

export async function runSlash(cmd: SlashCommand, deps: SlashDeps): Promise<SlashOutcome> {
  switch (cmd.name) {
    case "help":
      return {
        reply: `Commands:\n\n${SLASH_HELP.map((h) => `- \`${h.cmd}\` ${h.does}`).join("\n")}`,
      };
    case "compact":
      return { passthrough: true };
    case "plan":
      if (!cmd.args) return { reply: "Say what to plan: `/plan <feature>`." };
      return {
        forward: `Plan this feature into cards, each at most 3 files and 200 changed lines, ordered, with acceptance criteria; propose them as cards I can apply: ${cmd.args}`,
      };
    case "forecast": {
      const open = (await deps.cardStore.listCards()).filter(
        (c) => !["done", "rejected", "parked"].includes(c.status),
      );
      const q = await pmQuality(deps.pmStore.log, open.length, () => undefined);
      return {
        reply: q.forecast
          ? `${open.length} open card(s). At the recent throughput, 50% likely done in ${q.forecast.p50Days} day(s), 85% likely in ${q.forecast.p85Days} (Monte Carlo over ${q.forecast.samples} days of history). A range, not a promise.`
          : `${open.length} open card(s). Not enough history for a forecast yet: it needs at least five days of completed work.`,
      };
    }
    case "capability":
      return {
        reply: capabilitySummary(capabilityReport(deps.repoPath, await deps.cardStore.listCards())),
      };
    case "research":
    case "deep": {
      if (!cmd.args) return { reply: `Say what to research: \`/${cmd.name} <question>\`.` };
      if (!deps.researcher)
        return {
          reply:
            "No Researcher is configured (start the queue or the dashboard with --researcher apodex).",
        };
      const r = await deps.researcher(cmd.args, { deep: cmd.name === "deep" });
      const verdict = r.grounded
        ? `Grounded, confidence ${r.confidence.toFixed(2)}.`
        : "Not grounded: treat it as unverified.";
      return {
        reply: `${r.answer}\n\n${verdict}${r.sources.length ? `\n\nSources:\n${r.sources.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : ""}`,
      };
    }
    case "ready":
    case "park":
    case "backlog": {
      const id = await resolveCard(deps.cardStore, cmd.args);
      if (!id) return { reply: `No card matches "${cmd.args.split(/\s+/)[0] ?? ""}".` };
      const reason = cmd.args.split(/\s+/).slice(1).join(" ") || `/${cmd.name} from the chat`;
      const card = await deps.cardStore.getCard(id);
      if (!card) return { reply: `No card ${id}.` };
      const board = deps.board ?? new BoardServiceImpl(deps.cardStore, { entryConditions: true });
      await board.transitionCard({
        cardId: id,
        fromStatus: card.status,
        toStatus: cmd.name === "park" ? "parked" : cmd.name === "ready" ? "ready" : "backlog",
        actor: "human",
        reason,
      });
      return {
        reply: `Moved ${id} to ${cmd.name === "park" ? "Parked" : cmd.name === "ready" ? "Ready" : "Backlog"}.`,
      };
    }
    case "status":
    case "standup":
      return { passthrough: true };
    default:
      return { reply: `Unknown command /${cmd.name}. Type /help for the list.` };
  }
}
