import type { BoardService } from "@sekhemet/board";
import type { CardRecord, CardStore } from "@sekhemet/kernel";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import type { ResearchAnswer } from "../research/researcher.js";
import { forecastSentence, openIssues } from "../status_api.js";
import type { Audience } from "./audience.js";
import { capabilityReport, capabilitySummary } from "./capability.js";
import { PipelineRefusal, planThroughPipeline } from "./pipeline.js";
import type { PmStore } from "./store.js";
import { draftWeeklyUpdate } from "./weekly.js";

/**
 * Slash commands in Seshat's chat (H16).
 *
 * A command the human typed is an instruction, not a conversation, so it is
 * answered by code, from the ledger, without loading the manager model
 * (a 40-120 s swap on this hardware). /plan runs the one planner (PM-P1-1),
 * with the Planner's model when one is given; /compact stays with the
 * summariser.
 * Status moves (/ready, /park, /backlog) are applied as the human's own
 * action and recorded as theirs on the ledger.
 */

export interface SlashCommand {
  name: string;
  args: string;
}

export const SLASH_HELP: { cmd: string; does: string }[] = [
  { cmd: "/help", does: "This list." },
  { cmd: "/status", does: "Standup from the Activity log: done, in flight, needs you." },
  {
    cmd: "/forecast",
    does: "When the open work is likely done (Monte Carlo over throughput, 50th and 85th percentile).",
  },
  {
    cmd: "/capability",
    does: "How often the Coding model finishes each issue type, and the largest change it handles reliably.",
  },
  { cmd: "/research <question>", does: "Ask the Research model; the answer comes with sources." },
  {
    cmd: "/deep <question>",
    does: "Deep research: several searches at once, then a check of every source.",
  },
  {
    cmd: "/plan <feature>",
    does: "The Planning model splits a feature into small issues, each with testable acceptance criteria.",
  },
  { cmd: "/update", does: "A draft of this week's project update, for you to edit and post." },
  { cmd: "/ready <issue>", does: "Move an issue to To do." },
  { cmd: "/park <issue> [reason]", does: "Put an issue on hold." },
  { cmd: "/backlog <issue>", does: "Move an issue back to Backlog." },
  { cmd: "/compact", does: "Fold the conversation into Seshat's summary." },
];

export function parseSlash(text: string): SlashCommand | undefined {
  const m = /^\s*\/([a-z]+)\b\s*([\s\S]*)$/i.exec(text);
  return m ? { name: (m[1] ?? "").toLowerCase(), args: (m[2] ?? "").trim() } : undefined;
}

/** The board a command's move goes through: the harness's own (kernel K-S4-3). */
export type SlashBoard = Pick<BoardService, "transitionCard">;

export interface SlashDeps {
  cardStore: CardStore;
  /**
   * The harness's board, which every move goes through (kernel K-S4-3): its
   * Review limit, evidence reader and entry conditions, never one a command
   * builds for itself (fix round F3).
   */
  board: SlashBoard;
  pmStore: PmStore;
  repoPath: string;
  researcher?: ((q: string, o?: { deep?: boolean }) => Promise<ResearchAnswer>) | undefined;
  /** The Planner role's model for /plan (PM-P1-2); without it the heuristic plans and says so. */
  planner?: LocalInferenceAdapter | undefined;
  /** Who asked, and what they can see (PM-N9-8). */
  audience?: Audience | undefined;
  asker?: string | undefined;
}

/** What to do with a command: a reply now, or a rewritten message for Seshat. */
export type SlashOutcome = { reply: string } | { forward: string } | { passthrough: true };

/**
 * PM-N9-8: only the cards the asker can see; a hidden card reads exactly as
 * a missing one. Everything is visible with no audience or asker (the CLI,
 * a Solo install).
 */
export function visibleCards(
  cards: CardRecord[],
  deps: Pick<SlashDeps, "audience" | "asker">,
): CardRecord[] {
  if (!deps.audience || !deps.asker) return cards;
  const { audience, asker } = deps;
  return cards.filter((c) => audience.canSee(asker, c.projectId));
}

export async function resolveCard(
  cardStore: CardStore,
  ref: string,
  deps: Pick<SlashDeps, "audience" | "asker">,
): Promise<string | undefined> {
  const id = ref.split(/\s+/)[0] ?? "";
  if (!id) return undefined;
  const visible = async (candidateId: string) => {
    const card = await cardStore.getCard(candidateId);
    return card && visibleCards([card], deps).length > 0 ? candidateId : undefined;
  };
  if (await visible(id)) return id;
  if (await visible(`card_${id}`)) return `card_${id}`;
  // A short suffix, as the board shows it ("hasher" for card_chron_hasher).
  const all = visibleCards(await cardStore.listCards(), deps);
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
    case "plan": {
      if (!cmd.args) return { reply: "Say what to plan: `/plan <feature>`." };
      // PM-P1-1: the one planner, as `sekhemet plan` runs it; a person's
      // command, so the cards it makes are theirs (§2.8.7).
      try {
        const r = await planThroughPipeline(
          {
            repoPath: deps.repoPath,
            cardStore: deps.cardStore,
            log: deps.pmStore.log,
            boardService: deps.board,
            actor: "human",
            ...(deps.asker ? { principal: deps.asker } : {}),
          },
          cmd.args,
          deps.planner ? { adapter: deps.planner } : {},
        );
        return { reply: r.report || "The Planning model created no issue." };
      } catch (err) {
        if (err instanceof PipelineRefusal) return { reply: err.message };
        throw err;
      }
    }
    case "update": {
      const draft = await draftWeeklyUpdate({
        repoPath: deps.repoPath,
        cardStore: deps.cardStore,
        pmStore: deps.pmStore,
        ...(deps.audience ? { audience: deps.audience } : {}),
        ...(deps.asker ? { asker: deps.asker } : {}),
      });
      return {
        reply: `Draft of this week's update. Nothing is posted until a person posts it from the project's Status page.\n\n${draft.text}`,
      };
    }
    case "forecast": {
      // STA-01: Status's forecast, in Status's words, over the issues the person can see.
      const visible = visibleCards(await deps.cardStore.listCards(), deps);
      const open = openIssues(visible);
      const sentence = await forecastSentence(visible, deps.pmStore.log);
      return {
        reply: `${open} open ${open === 1 ? "issue" : "issues"}. Forecast: ${sentence} A range, not a promise.`,
      };
    }
    case "capability":
      return {
        reply: capabilitySummary(
          capabilityReport(deps.repoPath, visibleCards(await deps.cardStore.listCards(), deps)),
        ),
      };
    case "research":
    case "deep": {
      if (!cmd.args) return { reply: `Say what to research: \`/${cmd.name} <question>\`.` };
      if (!deps.researcher)
        return {
          reply:
            "No Research model is configured (start the queue or the dashboard with --researcher apodex).",
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
      const id = await resolveCard(deps.cardStore, cmd.args, deps);
      if (!id) return { reply: `No issue matches "${cmd.args.split(/\s+/)[0] ?? ""}".` };
      const reason = cmd.args.split(/\s+/).slice(1).join(" ") || `/${cmd.name} from the chat`;
      const card = await deps.cardStore.getCard(id);
      if (!card) return { reply: `No issue ${id}.` };
      await deps.board.transitionCard({
        cardId: id,
        fromStatus: card.status,
        toStatus: cmd.name === "park" ? "parked" : cmd.name === "ready" ? "ready" : "backlog",
        actor: "human",
        reason,
      });
      return {
        reply: `Moved ${id} to ${cmd.name === "park" ? "On hold" : cmd.name === "ready" ? "To do" : "Backlog"}.`,
      };
    }
    case "status":
    case "standup":
      return { passthrough: true };
    default:
      return { reply: `Unknown command /${cmd.name}. Type /help for the list.` };
  }
}
