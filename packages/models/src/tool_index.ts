import { plannerCopy } from "./planner_copy.js";
import type { ToolDefinition } from "./types.js";

/**
 * Many tools without their prefill cost (worker-loop rule 11a, NEW-worker-loop-8).
 *
 * A role other than the Worker offered more than ten tools — the Planner or
 * Seshat with a project's MCP servers — sees them as a one-line index in its
 * prompt and one tool in its tools array, `tool_search`. A schema it loads
 * is appended to the conversation as a message; it is never inserted into
 * the tools array, so the array and every earlier message stay byte-identical
 * and the cached prefix survives, and an unused tool costs no prefill.
 */

/** More tools than this are indexed rather than sent (rule 11a). */
export const TOOL_INDEX_THRESHOLD = 10;

export const TOOL_SEARCH_TOOL: ToolDefinition = {
  name: "tool_search",
  description: plannerCopy.toolSearch.description,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: plannerCopy.toolSearch.query,
      },
    },
    required: ["query"],
  },
};

/** At most this many tools are loaded by one keyword search. */
const SEARCH_LIMIT = 3;

function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return (m?.[1] ?? t).slice(0, 140);
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 0);
}

export class ToolIndex {
  private readonly loaded = new Set<string>();
  /** The tools array for the whole conversation: fixed at construction. */
  public readonly tools: readonly ToolDefinition[];

  constructor(
    private readonly all: readonly ToolDefinition[],
    threshold = TOOL_INDEX_THRESHOLD,
  ) {
    this.indexed = all.length > threshold;
    this.tools = this.indexed ? [TOOL_SEARCH_TOOL] : [...all];
  }

  /** Whether the tools are offered as an index (more than the threshold). */
  public readonly indexed: boolean;

  /** One line per tool, for the prompt; empty when the tools are sent as they are. */
  public indexText(): string {
    if (!this.indexed) return "";
    return [
      plannerCopy.indexHeader(this.all.length),
      ...this.all.map((t) => `- ${t.name}: ${firstSentence(t.description ?? "")}`),
    ].join("\n");
  }

  /** Whether a call to this tool may be executed: sent in the array, or loaded. */
  public callable(name: string): boolean {
    return this.indexed ? this.loaded.has(name) : this.all.some((t) => t.name === name);
  }

  /**
   * Answer a `tool_search` call: the named tools, or the best keyword
   * matches, as the content of the tool-result message that carries their
   * schemas. The loaded tools become callable.
   */
  public search(query: string): { names: string[]; content: string } {
    const tokens = query.split(/[\s,]+/).filter(Boolean);
    let found = this.all.filter((t) => tokens.includes(t.name));
    if (found.length === 0) {
      const want = new Set(words(query));
      const scored = this.all
        .map((t) => ({
          t,
          score: new Set(words(`${t.name} ${t.description ?? ""}`).filter((w) => want.has(w))).size,
        }))
        .filter((x) => x.score > 0);
      const best = Math.max(0, ...scored.map((x) => x.score));
      found = scored
        .filter((x) => x.score === best)
        .slice(0, SEARCH_LIMIT)
        .map((x) => x.t);
    }
    if (found.length === 0) {
      return {
        names: [],
        content: plannerCopy.noMatch(query),
      };
    }
    for (const t of found) this.loaded.add(t.name);
    return {
      names: found.map((t) => t.name),
      content: `${plannerCopy.loaded(found.length)}\n${found
        .map((t) =>
          JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }),
        )
        .join("\n")}`,
    };
  }
}
