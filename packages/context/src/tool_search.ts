import type { ToolDefinition } from "@sekhemet/models";
import { queryTerms } from "./pruner.js";
import type { ToolInterfaceSpec } from "./tool_interface.js";
import { workerCopy } from "./worker_copy.js";

/**
 * Dynamic tool loading (C19). Instead of every schema in every prompt, the
 * system prompt carries a one-line index of tool names; the full contract of
 * a tool is loaded on demand through `tool_search`, and from then on that
 * tool's schema travels with every request of the card. The core tools the
 * Worker uses on nearly every card stay loaded from the start.
 */
export const TOOL_SEARCH_NAME = "tool_search";

export const TOOL_SEARCH_SPEC: ToolInterfaceSpec = {
  name: TOOL_SEARCH_NAME,
  summary: "Load the full contract of tools by name or by what you need them for.",
  parameters: [
    {
      name: "query",
      type: "string",
      required: true,
      description: "Tool names (comma-separated) or a description of the task",
    },
  ],
  returns: "The matching tools' full parameter lists; they are callable from then on.",
};

/** The index line per tool, for the system prompt. Sorted, so byte-stable. */
export function renderToolSearchIndex(specs: readonly ToolInterfaceSpec[]): string {
  return [
    "=== TOOL INDEX (call tool_search to load a tool's parameters before its first use) ===",
    ...[...specs]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => `- ${t.name}: ${t.summary}`),
  ].join("\n");
}

/** Score tools against a query: exact names first, then term overlap. */
export function searchTools(
  query: string,
  specs: readonly ToolInterfaceSpec[],
  limit = 3,
): ToolInterfaceSpec[] {
  const names = new Set(
    query
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const exact = specs.filter((s) => names.has(s.name));
  if (exact.length > 0) return exact;
  const terms = queryTerms(query);
  return [...specs]
    .map((s) => {
      const hay = queryTerms(
        `${s.name} ${s.summary} ${s.returns ?? ""} ${s.parameters.map((p) => `${p.name} ${p.description}`).join(" ")}`,
      );
      let score = 0;
      for (const t of terms) if (hay.has(t)) score++;
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
    .slice(0, limit)
    .map((x) => x.s);
}

/** Terms in a query that name files rather than tools: `crypto.js`, `src/db.ts`. */
function fileLikeTerms(query: string): string[] {
  return query
    .split(/[,\s]+/)
    .map((s) => s.trim().replace(/^["'`]|["'`]$/g, ""))
    .filter((s) => /\/|\.[cm]?[jt]sx?$|\.json$/.test(s));
}

/**
 * A Worker that asks tool_search for files wants to read them. Telling it "no
 * tool matches" is a dead end it repeats until the stall detector stops it —
 * suite run 3 lost card_onyx_4_vault exactly that way — so the reply names the
 * call that does what it asked, ready to make. A `.js` import names the `.ts`
 * source beside it, and a bare name is looked for under `src/`.
 */
function filesReply(files: readonly string[]): string {
  const calls = files.map((f) => {
    const ts = f.replace(/\.[cm]?js(x?)$/, ".ts$1").replace(/^\.\//, "");
    const path = ts.includes("/") ? ts : `src/${ts}`;
    return `read_file(path: "${path}")`;
  });
  return [
    "tool_search finds tools, not files. read_file is already loaded; to read these, call:",
    ...calls,
    "If a path is wrong, find_files locates it.",
  ].join("\n");
}

/**
 * Terms that name code rather than tools: `ChronicleEvent`, `openDatabase`,
 * `GENESIS_HASH`. Tool names are snake_case, so camel and constant case
 * cannot be one.
 */
function symbolLikeTerms(query: string): string[] {
  return (
    query
      .split(/[,\s]+/)
      .map((s) => s.trim())
      // camelCase, PascalCase with two capitals, or CONSTANT_CASE.
      .filter((s) =>
        /^(?:[a-z]+[A-Z]\w*|[A-Z][a-z0-9]*[A-Z]\w*|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)$/.test(s),
      )
  );
}

/**
 * Suite run 4 lost two turns of card_chron_ledger to "No tool matches" for
 * symbols. Each call is read_symbol's own signature, with the file that
 * declares the symbol (WL-M2-7), so it can be made as written.
 */
function symbolsReply(
  symbols: readonly string[],
  declaringFile: (symbol: string) => string | undefined,
): string {
  return workerCopy.toolSearchSymbols(
    symbols
      .map((s) => {
        const path = declaringFile(s);
        return path ? workerCopy.readSymbolCall(path, s) : workerCopy.symbolNotDeclared(s);
      })
      .join("\n"),
  );
}

/**
 * Tracks which tools are loaded for a card. `handle` is the `tool_search`
 * tool's implementation; `visibleSpecs` / `visibleSchemas` are what the next
 * request carries.
 */
export class ToolLoader {
  private loaded: Set<string>;

  constructor(
    private readonly all: readonly ToolInterfaceSpec[],
    alwaysLoaded: readonly string[] = [],
  ) {
    this.loaded = new Set([TOOL_SEARCH_NAME, ...alwaysLoaded]);
  }

  public isLoaded(name: string): boolean {
    return this.loaded.has(name);
  }

  /**
   * `declaringFile` finds the file that declares a code symbol, for the
   * read_symbol calls a query naming symbols is answered with (WL-M2-7).
   */
  public handle(
    query: string,
    declaringFile: (symbol: string) => string | undefined = () => undefined,
  ): { loaded: string[]; text: string } {
    const found = searchTools(query, this.all);
    for (const t of found) this.loaded.add(t.name);
    const symbols = symbolLikeTerms(query);
    const reader = symbols.length > 0 ? this.all.find((t) => t.name === "read_symbol") : undefined;
    if (found.length === 0) {
      const files = fileLikeTerms(query);
      if (files.length > 0) return { loaded: [], text: filesReply(files) };
      if (reader) {
        this.loaded.add(reader.name);
        return { loaded: [reader.name], text: symbolsReply(symbols, declaringFile) };
      }
      return { loaded: [], text: `No tool matches "${query}". The index lists every tool.` };
    }
    // A query that names tools and symbols keeps its symbols (WL-M2-7).
    if (reader && !found.some((t) => t.name === reader.name)) {
      this.loaded.add(reader.name);
      found.push(reader);
    }
    const text = found
      .map(
        (t) =>
          `${t.name}(${t.parameters
            .map((p) => `${p.name}${p.required ? "*" : ""}: ${p.enumValues?.join("|") ?? p.type}`)
            .join(", ")}): ${t.summary}${t.returns ? ` Returns: ${t.returns}` : ""}`,
      )
      .join("\n");
    return {
      loaded: found.map((t) => t.name),
      text: reader ? `${text}\n${symbolsReply(symbols, declaringFile)}` : text,
    };
  }

  /** Specs whose full contract the prompt should carry now. */
  public visibleSpecs(): ToolInterfaceSpec[] {
    const seen = new Set<string>();
    return [TOOL_SEARCH_SPEC, ...this.all.filter((t) => this.loaded.has(t.name))].filter((t) => {
      if (seen.has(t.name)) return false;
      seen.add(t.name);
      return true;
    });
  }

  /** Native schemas for the loaded tools only, plus tool_search itself. */
  public visibleSchemas(all: readonly ToolDefinition[]): ToolDefinition[] {
    const search: ToolDefinition = {
      name: TOOL_SEARCH_NAME,
      description: TOOL_SEARCH_SPEC.summary,
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Tool names or a task" } },
        required: ["query"],
      },
    };
    return [search, ...all.filter((d) => d.name !== TOOL_SEARCH_NAME && this.loaded.has(d.name))];
  }

  public loadedNames(): string[] {
    return [...this.loaded].sort();
  }
}
