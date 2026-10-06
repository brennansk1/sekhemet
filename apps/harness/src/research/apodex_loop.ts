import {
  type ChatTurn,
  type LocalInferenceAdapter,
  type ToolCall,
  type ToolDefinition,
  stripReasoning,
} from "@sekhemet/models";
import {
  coordinatorPrompt,
  extractInfo,
  formatFetchResults,
  formatSearchResults,
  recencyFromTbs,
  researchAgentPrompt,
  splitSiteOperators,
  subagentPrompt,
  truncateMiddle,
} from "./apodex.js";
import { researchCopy } from "./research_copy.js";
import type { ResearchDeps } from "./researcher.js";
import { runResearchTool } from "./researcher.js";
import {
  SUB_QUESTION_MIN_HOSTS,
  type Source,
  groundingConfidence,
  independentHosts,
  kindOfUrl,
} from "./sources.js";
import { type Hit, fetchPage, isFetchRefusal, webSearch } from "./web.js";

/**
 * The Researcher's loop when Apodex drives it, built to Apodex's training
 * harness (see apodex.ts): its tool names, argument shapes and result
 * formats; finalize_answer / submit_report as the only clean exits; the
 * coordinator and sub-agent roles of its Agent Team; and the harness guards
 * that keep a long research loop honest (duplicate queries, repeated turns,
 * compaction, a verified References section).
 */

const str = { type: "string" } as const;
const strOrList = { anyOf: [str, { type: "array", items: str }] };

export const APODEX_WEB_TOOLS: ToolDefinition[] = [
  {
    name: "web_search",
    description:
      "Perform web searches and retrieve rich results. Returns a numbered plain-text list of search results, each with Title, Snippet, and URL.",
    parameters: {
      type: "object",
      properties: {
        q: {
          ...strOrList,
          description: "Search query string, or a list of query strings to execute in parallel",
        },
        tbs: {
          type: "string",
          description:
            "Time-based search filter ('qdr:h' for past hour, 'qdr:d' for past day, 'qdr:w' for past week, 'qdr:m' for past month, 'qdr:y' for past year)",
        },
        num: { type: "integer", description: "Number of results to return (default: 10)" },
      },
      required: ["q"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch content from a URL and extract specific types of information. Returns extracted information as plain text. For multiple URLs, results are numbered.",
    parameters: {
      type: "object",
      properties: {
        url: {
          ...strOrList,
          description: "The URL to fetch, or a list of URLs to fetch in parallel",
        },
        info_to_extract: {
          ...strOrList,
          description:
            "The specific types of information to extract (usually a question), or a list of extraction prompts (one per URL). Omit to get the raw page back",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "scholar_search",
    description:
      "Search scholarly literature (Hugging Face Papers, arXiv, OpenAlex): titles, arXiv ids, years, citation counts, abstracts. Prefer it for methods, algorithms and benchmarks.",
    parameters: { type: "object", properties: { query: str }, required: ["query"] },
  },
  {
    name: "read_paper",
    description:
      "Read an arXiv paper. Without a section it returns the section list and the opening; then ask for a section by its heading.",
    parameters: {
      type: "object",
      properties: { arxiv_id: str, section: str },
      required: ["arxiv_id"],
    },
  },
  {
    name: "paper_citations",
    description:
      "The works a paper cites (references) or the works citing it (cited_by, most cited first). Takes an arXiv id or DOI.",
    parameters: {
      type: "object",
      properties: { id: str, direction: { type: "string", enum: ["references", "cited_by"] } },
      required: ["id", "direction"],
    },
  },
  {
    name: "read_docs",
    description:
      "Find and read the pages of a library's official documentation most relevant to a question. `library` is a name (node, typescript, vitest, sqlite, react, ...) or the docs URL.",
    parameters: {
      type: "object",
      properties: { library: str, question: str },
      required: ["library", "question"],
    },
  },
  {
    name: "github_search",
    description: "Search GitHub repositories (with licence and stars) or code.",
    parameters: {
      type: "object",
      properties: { query: str, kind: { type: "string", enum: ["repos", "code"] } },
      required: ["query"],
    },
  },
  {
    name: "repo_tree",
    description:
      "List the files of a GitHub repository at a ref, optionally under a path prefix. Use it to find where something lives before reading it.",
    parameters: {
      type: "object",
      properties: { repo: str, ref: str, path: str },
      required: ["repo"],
    },
  },
  {
    name: "repo_file",
    description:
      "Read one file from a GitHub repository at a ref. The source is the primary source: prefer it over a blog post describing it.",
    parameters: {
      type: "object",
      properties: { repo: str, path: str, ref: str },
      required: ["repo", "path"],
    },
  },
  {
    name: "code_search",
    description:
      "Search code on GitHub, inside one repository when `repo` is given. Finds real call sites and usage patterns.",
    parameters: {
      type: "object",
      properties: { query: str, repo: str },
      required: ["query"],
    },
  },
  {
    name: "issue_search",
    description:
      "Search issues and pull requests, including closed ones, where behaviour that is not in the documentation is usually explained.",
    parameters: {
      type: "object",
      properties: { query: str, repo: str },
      required: ["query"],
    },
  },
  {
    name: "releases_between",
    description:
      "Every release note between two versions of a repository — the question an upgrade actually asks. Give `from` (installed) and `to` (proposed).",
    parameters: {
      type: "object",
      properties: { repo: str, from: str, to: str },
      required: ["repo", "from", "to"],
    },
  },
];

export const APODEX_LOCAL_TOOLS: ToolDefinition[] = [
  {
    name: "find_library",
    description: "Search npm or PyPI; results carry licence and whether it is safe to use.",
    parameters: {
      type: "object",
      properties: { query: str, ecosystem: { type: "string", enum: ["npm", "pypi"] } },
      required: ["query"],
    },
  },
  {
    name: "package_readme",
    description: "Read an npm package's README (first part) to learn its API and usage.",
    parameters: { type: "object", properties: { name: str }, required: ["name"] },
  },
  {
    name: "module_api",
    description:
      "The real classes and members of a module from the project's installed type declarations, e.g. node:sqlite.",
    parameters: { type: "object", properties: { module: str }, required: ["module"] },
  },
  {
    name: "git_history",
    description: "Search this repository's commit messages for a term.",
    parameters: { type: "object", properties: { query: str }, required: ["query"] },
  },
  {
    name: "deps_source",
    description:
      "Read the real source of a package installed in this project, at the version actually resolved. Better than any web page for an API question. Omit `path` for an outline of the package's entry points and type declarations.",
    parameters: {
      type: "object",
      properties: { name: str, path: str },
      required: ["name"],
    },
  },
  {
    name: "deps_grep",
    description:
      "Search inside an installed package's own source for a pattern, to find how something is implemented or whether it exists.",
    parameters: {
      type: "object",
      properties: { name: str, pattern: str },
      required: ["name", "pattern"],
    },
  },
  {
    // Design-stage DS-N9-13; the words are the Researcher's copy module's.
    name: "probe",
    description: researchCopy.probeTool.description,
    parameters: {
      type: "object",
      properties: {
        package: { type: "string", description: researchCopy.probeTool.package },
        language: {
          type: "string",
          enum: ["node", "python"],
          description: researchCopy.probeTool.language,
        },
        code: { type: "string", description: researchCopy.probeTool.code },
        statement: { type: "string", description: researchCopy.probeTool.statement },
      },
      required: ["package", "language", "code", "statement"],
    },
  },
];

export const FINALIZE_ANSWER: ToolDefinition = {
  name: "finalize_answer",
  description:
    "Submit the final answer and end the research loop. Call this when you have gathered enough evidence and are ready to deliver the answer.",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "The complete answer in Markdown. Include inline [N] citations and a References section.",
      },
      confidence: {
        type: "number",
        description:
          "Self-assessed confidence in [0, 1] that the answer is correct and well-grounded.",
      },
    },
    required: ["content"],
  },
};

export const SUBMIT_REPORT: ToolDefinition = {
  name: "submit_report",
  description:
    "Submit your final research report and end this task. Call this once when you have gathered enough evidence and are ready to return to the main agent.",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "The complete report in the mandatory Scope/Findings/Evidence/Confidence format.",
      },
      confidence: {
        type: "number",
        description: "Self-assessed confidence in [0, 1]. Default 0.7.",
      },
    },
    required: ["content"],
  },
};

export const TEAM_TOOLS: ToolDefinition[] = [
  {
    name: "create_subagent",
    description:
      "Create persistent sub-agents. Each agent remembers prior tasks across calls. Pass them all in a single call.",
    parameters: {
      type: "object",
      properties: {
        agents: {
          type: "array",
          items: {
            type: "object",
            properties: { name: str, system_prompt: str },
            required: ["name"],
          },
        },
      },
      required: ["agents"],
    },
  },
  {
    name: "assign_task",
    description: "Assign tasks to existing sub-agents. Tasks start immediately in the background.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: { agent: str, prompt: str },
            required: ["agent", "prompt"],
          },
        },
      },
      required: ["tasks"],
    },
  },
  {
    name: "collect_reports",
    description:
      "Collect reports from any sub-agents that have finished their tasks. Waits for running agents.",
    parameters: { type: "object", properties: {} },
  },
];

/** A list argument that may arrive as a list, a JSON-encoded list, or one string. */
export function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter((s) => s.trim());
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("[")) {
      try {
        const parsed = JSON.parse(t) as unknown;
        if (Array.isArray(parsed)) return parsed.map(String).filter((s) => s.trim());
      } catch {
        // A plain string that starts with a bracket.
      }
    }
    return t ? [t] : [];
  }
  return [];
}

/** What one research run read and saw, shared by a team's agents. */
export class EvidenceLedger {
  /** URLs a tool returned (search results), with their titles. */
  readonly seen = new Map<string, string>();
  /** Sources whose content reached the model (fetched pages, docs, papers). */
  readonly read = new Map<string, Source>();
  readonly queries = new Set<string>();
  /** A source's date as its search result gave it, for recency in a disagreement (DS-N2-8). */
  readonly dates = new Map<string, string>();

  noteHits(hits: Hit[]): void {
    for (const h of hits) {
      if (h.url && !this.seen.has(h.url)) this.seen.set(h.url, h.title);
      const date = /\b(19|20)\d{2}(-\d{2}(-\d{2})?)?\b(?!\.\d)/.exec(h.meta ?? "")?.[0];
      if (h.url && date && !this.dates.has(h.url)) this.dates.set(h.url, date);
    }
  }

  noteRead(s: Source): void {
    if (!this.read.has(s.ref)) this.read.set(s.ref, s);
  }
}

export interface VerifiedAnswer {
  answer: string;
  /** Referenced sources, in the answer's own numbering. */
  references: { n: number; ref: string; read: boolean; known: boolean }[];
  /** [n] markers with no reference, or references to nothing whose text was read. */
  badCitations: number[];
  /** The sources read that the answer cites. */
  evidence: Source[];
  confidence: number;
}

const normTitle = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** The source read that a reference names: by URL or ref, else by its normalised title. */
function readSourceFor(raw: string, ledger: EvidenceLedger): Source | undefined {
  const url = /(https?:\/\/[^\s>)\]]+)/.exec(raw)?.[1];
  const ref = url ?? raw;
  const direct = ledger.read.get(ref) ?? [...ledger.read.values()].find((s) => raw.includes(s.ref));
  if (direct) return direct;
  const nraw = normTitle(raw);
  return [...ledger.read.values()].find(
    (s) => s.title && normTitle(s.title).length >= 20 && nraw.includes(normTitle(s.title)),
  );
}

/**
 * The one reference checker (design-stage DS-N2-4), for every research
 * pipeline: each citation is checked against text actually fetched and
 * recorded in the ledger, matched by URL (or ref) or by normalised title.
 * The answer's References section names its sources; without one, `[n]`
 * is the n-th of the `numbered` sources the pipeline showed the model. A
 * citation to nothing read — a made-up URL, a page only seen as a search
 * hit, a number with no reference — is flagged in `badCitations`.
 * Confidence counts only what was read and cited.
 */
export function verifyReferences(
  answer: string,
  ledger: EvidenceLedger,
  numbered?: readonly Source[],
): VerifiedAnswer {
  const refs: VerifiedAnswer["references"] = [];
  const found = new Map<number, Source>();
  const at = answer.search(/\n#*\s*\**References:?\**\s*\n/i);
  const body = at === -1 ? answer : answer.slice(0, at);
  if (at !== -1) {
    for (const line of answer.slice(at).split("\n")) {
      const m = /^\s*[-*]?\s*\[(\d{1,3})\]\s*(.+?)\s*$/.exec(line);
      if (!m) continue;
      const raw = (m[2] ?? "").replace(/^<|>$/g, "");
      const url = /(https?:\/\/[^\s>)\]]+)/.exec(raw)?.[1];
      const n = Number(m[1]);
      const source = readSourceFor(raw, ledger);
      if (source) found.set(n, source);
      const nraw = normTitle(raw);
      const known =
        Boolean(source) ||
        ledger.seen.has(url ?? raw) ||
        [...ledger.seen.values()].some(
          (t) => normTitle(t).length >= 20 && nraw.includes(normTitle(t)),
        );
      refs.push({ n, ref: url ?? raw, read: Boolean(source), known });
    }
  } else if (numbered) {
    const cited = new Set([...body.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1])));
    for (const n of [...cited].sort((a, b) => a - b)) {
      const s = numbered[n - 1];
      if (!s) continue;
      const source =
        readSourceFor(s.ref, ledger) ?? (s.title ? readSourceFor(s.title, ledger) : undefined);
      if (source) found.set(n, source);
      refs.push({ n, ref: s.ref, read: Boolean(source), known: Boolean(source) });
    }
  }
  const bad = new Set<number>();
  for (const r of refs) if (!r.read) bad.add(r.n);
  for (const m of body.matchAll(/\[(\d{1,3})\]/g)) {
    const n = Number(m[1]);
    if (!refs.some((r) => r.n === n)) bad.add(n);
  }
  const evidence = [
    ...new Set(refs.flatMap((r) => (found.has(r.n) ? [found.get(r.n) as Source] : []))),
  ];
  return {
    answer,
    references: refs,
    badCitations: [...bad].sort((a, b) => a - b),
    evidence,
    confidence: groundingConfidence(evidence),
  };
}

export interface LoopRun {
  text: string;
  ended: "finalize" | "submit" | "text" | "budget";
  turns: number;
  selfConfidence?: number;
}

export interface ApodexLoopOptions {
  role: "solo" | "subagent";
  system: string;
  maxTurns: number;
  /** The model that runs web_fetch's extraction (usually the same one). */
  extractor?: LocalInferenceAdapter | undefined;
  /** Characters of tool output kept before older results are compacted. */
  budgetChars: number;
  ledger: EvidenceLedger;
}

function callSignature(calls: ToolCall[]): string {
  return calls
    .map((c) => `${c.name}:${JSON.stringify(c.arguments)}`)
    .sort()
    .join("|");
}

/** Run one Apodex-shaped tool call. */
async function runApodexTool(
  call: ToolCall,
  deps: ResearchDeps,
  opts: ApodexLoopOptions,
): Promise<string> {
  const a = call.arguments ?? {};
  const web = deps.web;
  const ledger = opts.ledger;
  if (call.name === "web_search") {
    if (!web) return "[ERROR]: Web access is off for this project.";
    const queries = asList(a.q ?? a.query).slice(0, 5);
    if (queries.length === 0) return "[ERROR]: Search query 'q' is required and cannot be empty.";
    const fresh = queries.filter((q) => !ledger.queries.has(q.trim().toLowerCase()));
    if (fresh.length === 0) {
      return "This exact search already ran and its results are above. Use different keywords, or web_fetch one of the results.";
    }
    const recency = recencyFromTbs(a.tbs);
    const num = Math.min(10, Math.max(1, Number(a.num) || 10));
    const lists = await Promise.all(
      fresh.map(async (q) => {
        const { query, site, exclude } = splitSiteOperators(q);
        const r = await webSearch(query, web, { site, exclude, ...(recency ? { recency } : {}) });
        return typeof r === "string"
          ? { q, error: r, hits: [] as Hit[] }
          : { q, hits: r.slice(0, num) };
      }),
    );
    const merged: Hit[] = [];
    const urls = new Set<string>();
    for (const l of lists) {
      if (l.hits.length > 0) ledger.queries.add(l.q.trim().toLowerCase());
      for (const h of l.hits) {
        if (h.url && urls.has(h.url)) continue;
        urls.add(h.url);
        merged.push(h);
      }
    }
    ledger.noteHits(merged);
    const errors = lists.flatMap((l) => ("error" in l && l.error ? [l.error] : []));
    if (merged.length === 0 && errors.length > 0) return `[ERROR]: ${errors[0]}`;
    return formatSearchResults(
      merged.map((h) => ({
        title: h.title,
        url: h.url,
        snippet: h.snippet,
        ...(h.meta && /\d{4}/.test(h.meta) ? { date: h.meta } : {}),
      })),
    );
  }
  if (call.name === "web_fetch") {
    if (!web) return "[ERROR]: Web access is off for this project.";
    let urls = asList(a.url).slice(0, 5);
    if (urls.length === 0) return "[ERROR]: url is required and cannot be empty.";
    // DS-N4-1: the effort's page reads per sub-question.
    const budget = deps.pageBudget;
    if (budget) {
      if (budget.used >= budget.max) return researchCopy.pagesSpent(budget.max);
      urls = urls.slice(0, budget.max - budget.used);
      budget.used += urls.length;
    }
    const infosRaw = asList(a.info_to_extract);
    const infos =
      infosRaw.length === urls.length
        ? infosRaw
        : infosRaw.length === 1
          ? urls.map(() => infosRaw[0] as string)
          : urls.map(() => infosRaw.join(" "));
    const results = await Promise.all(
      urls.map(async (u, i) => {
        // DS-N9-10: the question reaches the page reader's ranking too.
        const page = await fetchPage(u, web, 80_000, infos[i] || undefined);
        if (isFetchRefusal(page)) {
          return { url: u, info: `[ERROR]: Scraping failed: ${page}` };
        }
        const info = await extractInfo(opts.extractor, infos[i] ?? "", page);
        ledger.noteRead({ kind: kindOfUrl(u), ref: u, excerpt: info.slice(0, 1500) });
        return { url: u, info };
      }),
    );
    return formatFetchResults(results);
  }
  // The harness's own tools, with the Researcher's implementations.
  const r = await runResearchTool(call, deps);
  if (r.source) {
    // Register what was read under the URL a model would cite for it, so a
    // citation of the package page or the paper validates against the read.
    const name = String(a.name ?? "");
    const url =
      call.name === "read_paper"
        ? `https://arxiv.org/abs/${String(a.arxiv_id ?? "")}`
        : call.name === "package_readme" && name
          ? `https://www.npmjs.com/package/${name}`
          : r.source.ref;
    ledger.noteRead({ ...r.source, ref: url });
    if (call.name === "package_readme" && name) {
      ledger.noteRead({ ...r.source, ref: `https://registry.npmjs.org/${name}` });
      ledger.noteRead({ ...r.source, ref: `https://npmjs.com/package/${name}` });
    }
  }
  if (
    call.name === "scholar_search" ||
    call.name === "github_search" ||
    call.name === "paper_citations"
  ) {
    // Each hit is "N. Title (meta)\n   URL\n   abstract". A paper's abstract
    // reached the model, so a scholar hit counts as a read paper source, and
    // its title is registered so a reference by title validates too.
    for (const m of r.text.matchAll(
      /^\d+\. (.+?)(?: \(([^)]*)\))?\n\s+(https?:\/\/\S+)\n\s*(.*)$/gm,
    )) {
      const title = (m[1] ?? "").trim();
      const url = m[3] as string;
      ledger.seen.set(url, title);
      if (call.name !== "github_search" && (m[4] ?? "").length > 40) {
        ledger.noteRead({ kind: "paper", ref: url, title, excerpt: (m[4] ?? "").slice(0, 600) });
      }
    }
  }
  return r.text;
}

const WEB_TOOLS = new Set([
  "web_search",
  "web_fetch",
  "read_docs",
  "read_paper",
  "github_search",
  "scholar_search",
  "paper_citations",
]);

/**
 * Research safety (X8): content from the web is data, never instructions. A
 * page can say "ignore your task and ..."; wrapping it marks it for the model
 * (the system prompt says to treat such text as untrusted), and the markers
 * inside the content are neutralised so a page cannot close the wrapper.
 */
export function untrusted(tool: string, text: string): string {
  if (!WEB_TOOLS.has(tool) && !tool.startsWith("mcp__")) return text;
  const safe = text.replace(/<\/?untrusted[^>]*>/gi, "[tag removed]");
  return `<untrusted source="${tool}">\n${safe}\n</untrusted>`;
}

/** One agent's loop: tools until a terminal call, with Apodex's harness guards. */
export async function apodexLoop(
  model: LocalInferenceAdapter,
  task: string,
  deps: ResearchDeps,
  opts: ApodexLoopOptions,
): Promise<LoopRun> {
  const terminal = opts.role === "solo" ? FINALIZE_ANSWER : SUBMIT_REPORT;
  const tools = [
    ...(deps.web ? APODEX_WEB_TOOLS : []),
    ...APODEX_LOCAL_TOOLS,
    ...(deps.mcp?.toolDefinitions() ?? []),
    terminal,
  ];
  const turns: ChatTurn[] = [{ role: "user", content: task }];
  let lastSig = "";
  let repeats = 0;
  let nudged = false;
  let repaired = false;

  const compacted = (): ChatTurn[] => {
    let total = turns.reduce((n, t) => n + t.content.length, 0);
    const lastTool = turns.map((t) => t.role).lastIndexOf("assistant");
    return turns.map((t, i) => {
      if (t.role !== "tool" || i > lastTool || total <= opts.budgetChars || t.content.length <= 700)
        return t;
      total -= t.content.length - 620;
      return { ...t, content: `[context compacted]\n${t.content.slice(0, 600)}` };
    });
  };

  for (let turn = 1; turn <= opts.maxTurns; turn++) {
    const last = turn === opts.maxTurns;
    // The turn before the last asks for the answer, so a rejected finalize
    // (unverified citations) still has one turn to be repaired.
    const penultimate = turn === opts.maxTurns - 1 && opts.maxTurns > 3;
    const messages = compacted();
    if (penultimate && !repaired) {
      messages.push({
        role: "user",
        content: `Two turns left. Call ${terminal.name} now with your complete ${opts.role === "solo" ? "answer (citations and References included)" : "report"}.`,
      });
    }
    if (last) {
      messages.push({
        role: "user",
        content: `Turn budget reached. Call ${terminal.name} now with your complete ${opts.role === "solo" ? "answer (citations and References included)" : "report"}.`,
      });
    }
    const res = await model.generate({
      role: "researcher",
      systemPrompt: opts.system,
      prompt: "",
      messages,
      tools: last ? [terminal] : tools,
      toolArm: "arm_a_flat",
      reasoning: "low",
      reasoningBudgetTokens: 1536,
      maxTokens: 3000,
      purpose: "planning",
      slot: 0,
    });
    const text = stripReasoning(res.text);
    const end = res.toolCalls.find((c) => c.name === terminal.name);
    if (end) {
      const content = String(end.arguments?.content ?? "").trim();
      if (content) {
        const conf = Number(end.arguments?.confidence);
        // The References contract, enforced before the answer is accepted: a
        // cited URL no tool returned is how a plausible answer goes wrong.
        // One chance to repair, the way the trained harness rejects a bad
        // finalize (the rejection is the tool result).
        const check = opts.role === "solo" ? verifyReferences(content, opts.ledger) : undefined;
        if (check && check.badCitations.length > 0 && !repaired && !last) {
          repaired = true;
          const callId = end.id || `fin_${turn}`;
          turns.push({ role: "assistant", content: res.text, toolCalls: [{ ...end, id: callId }] });
          turns.push({
            role: "tool",
            toolCallId: callId,
            content: `finalize_answer rejected: citation(s) [${check.badCitations.join(", ")}] do not match any URL a tool returned in this session (or have no References line). Every cited URL must be copied character-for-character from a web_search or web_fetch result. Verify those claims with web_fetch, or remove them, then call finalize_answer again. If sources disagree about a fact (for example whether a package is maintained), check the package registry or the project's own repository before deciding.`,
          });
          deps.onEvent?.(
            `turn ${turn}: finalize rejected, citations [${check.badCitations.join(", ")}] unverified`,
          );
          continue;
        }
        return {
          text: content,
          ended: opts.role === "solo" ? "finalize" : "submit",
          turns: turn,
          ...(Number.isFinite(conf) ? { selfConfidence: Math.max(0, Math.min(1, conf)) } : {}),
        };
      }
    }
    if (res.toolCalls.length === 0) {
      // A text-only turn: in the trained harness that is "forgot to call a
      // tool". One reminder, then the text is taken as the answer.
      if (!nudged && text && !last) {
        nudged = true;
        turns.push({ role: "assistant", content: res.text });
        turns.push({
          role: "user",
          content: `If you are done, call ${terminal.name} with the complete ${opts.role === "solo" ? "answer" : "report"}; otherwise continue with a tool call.`,
        });
        continue;
      }
      return { text, ended: last ? "budget" : "text", turns: turn };
    }
    deps.onEvent?.(
      `${opts.role === "subagent" ? "  · " : ""}turn ${turn}: ${
        res.toolCalls.length
          ? res.toolCalls
              .map((c) => `${c.name}(${JSON.stringify(c.arguments).slice(0, 140)})`)
              .join(", ")
          : "text"
      } [${res.usage.completionTokens} tok, ${(res.usage.durationMs / 1000).toFixed(0)}s]`,
    );
    const calls = res.toolCalls
      .filter((c) => c.name !== terminal.name)
      .slice(0, 6)
      .map((c, i) => ({ ...c, id: c.id || `call_${turn}_${i}` }));
    const sig = callSignature(calls);
    repeats = sig === lastSig ? repeats + 1 : 0;
    lastSig = sig;
    turns.push({ role: "assistant", content: res.text, toolCalls: calls });
    const outputs = await Promise.all(
      calls.map((c) =>
        runApodexTool(c, deps, opts).catch(
          (e) => `[ERROR]: Unexpected error: ${e instanceof Error ? e.message : String(e)}`,
        ),
      ),
    );
    calls.forEach((c, i) =>
      turns.push({
        role: "tool",
        toolCallId: c.id,
        content: untrusted(c.name, truncateMiddle(outputs[i] ?? "", 10_000)),
      }),
    );
    // RepetitionGuard: identical tool turns in a row get a hint, then an exit.
    if (repeats === 2) {
      turns.push({
        role: "user",
        content:
          "You have made the same tool calls three turns in a row. Change approach: different keywords, a different source, or finish.",
      });
    }
    if (repeats >= 4) return { text, ended: "budget", turns: turn };
  }
  return { text: "", ended: "budget", turns: opts.maxTurns };
}

export interface TeamResult {
  answer: string;
  ledger: EvidenceLedger;
  tasks: number;
  coordinatorTurns: number;
  reports: { agent: string; prompt: string; report: string; confidence?: number }[];
  /**
   * Each assigned task is a sub-question: the independent primary or
   * secondary hosts its runs read, whether that closed it, and how many
   * times it was dispatched (DS-N4-2: once more while open, then reported).
   */
  subQuestions: {
    agent: string;
    prompt: string;
    hosts: string[];
    closed: boolean;
    dispatches: number;
  }[];
}

/**
 * Apodex's Agent Team: a coordinator that frames the question, creates
 * specialist sub-agents, assigns them tasks, collects their reports, has a
 * verifier check the draft, and writes the merged, cited answer. Sub-agents
 * run on the same model one after another (one server slot); each remembers
 * its earlier reports. The code bounds agents, tasks and turns.
 */
export async function apodexTeam(
  model: LocalInferenceAdapter,
  question: string,
  deps: ResearchDeps,
  opts: {
    today: string;
    maxAgents?: number;
    maxTasks?: number;
    coordinatorTurns?: number;
    subTurns?: number;
    budgetChars: number;
    brief: string;
  },
): Promise<TeamResult> {
  const ledger = new EvidenceLedger();
  const maxAgents = opts.maxAgents ?? 4;
  const maxTasks = opts.maxTasks ?? 8;
  const agents = new Map<string, { brief: string; reports: string[] }>();
  const pending: { agent: string; prompt: string }[] = [];
  const reports: TeamResult["reports"] = [];
  const subQuestions: TeamResult["subQuestions"] = [];
  let tasksRun = 0;
  const turns: ChatTurn[] = [{ role: "user", content: `${opts.brief}\n\nQUESTION\n${question}` }];
  const system = coordinatorPrompt(opts.today, maxAgents);
  const maxTurns = opts.coordinatorTurns ?? 12;

  const runPending = async (): Promise<string> => {
    if (pending.length === 0)
      return "[status] No sub-agents are running and no reports are waiting.";
    const out: string[] = [];
    for (const t of pending.splice(0, pending.length)) {
      if (tasksRun >= maxTasks) {
        out.push(
          `<report agent="${t.agent}">Not run: the team's task budget (${maxTasks}) is spent. Synthesize from the reports you have.</report>`,
        );
        continue;
      }
      tasksRun++;
      const a = agents.get(t.agent) ?? { brief: "", reports: [] };
      const dispatch = async (prompt: string) => {
        const memory = a.reports.length
          ? `\n\nYour earlier reports (you remember these; build on them and spend this run on what they left open):\n${a.reports.map((r) => truncateMiddle(r, 1500)).join("\n---\n")}`
          : "";
        const readBefore = new Set(ledger.read.keys());
        const queriesBefore = new Set(ledger.queries);
        const run = await apodexLoop(
          model,
          `${prompt}${memory}`,
          // One page budget per dispatch of a sub-question (DS-N4-1).
          deps.maxPages ? { ...deps, pageBudget: { max: deps.maxPages, used: 0 } } : deps,
          {
            role: "subagent",
            system: `${subagentPrompt(opts.today, /verif/i.test(t.agent))}${a.brief ? `\n\n# Your role\n${a.brief}` : ""}`,
            maxTurns: opts.subTurns ?? 8,
            extractor: model,
            budgetChars: opts.budgetChars,
            ledger,
          },
        );
        const report =
          run.text ||
          "Scope: the task\nFindings: none — the agent ended without a report.\nConfidence: low";
        a.reports.push(report);
        agents.set(t.agent, a);
        reports.push({
          agent: t.agent,
          prompt,
          report,
          ...(run.selfConfidence !== undefined ? { confidence: run.selfConfidence } : {}),
        });
        return {
          report,
          read: [...ledger.read.entries()].filter(([k]) => !readBefore.has(k)).map(([, v]) => v),
          queries: [...ledger.queries].filter((q) => !queriesBefore.has(q)),
        };
      };
      // The closing rule, in code (DS-N4-2): a sub-question closes on sources
      // from two independent primary or secondary hosts; one still open is
      // dispatched once more with different queries (the ledger refuses a
      // search that already ran), then reported as it stands.
      const first = await dispatch(t.prompt);
      let read = first.read;
      let hosts = independentHosts(read);
      let dispatches = 1;
      let report = first.report;
      if (hosts.length < SUB_QUESTION_MIN_HOSTS) {
        deps.onEvent?.(`  · ${t.agent}: open (${hosts.join(", ") || "no host"}), re-dispatched`);
        const again = await dispatch(researchCopy.redispatch(t.prompt, first.queries, hosts));
        dispatches = 2;
        read = [...read, ...again.read];
        hosts = independentHosts(read);
        report = `${first.report}\n---\n${again.report}`;
      }
      subQuestions.push({
        agent: t.agent,
        prompt: t.prompt,
        hosts,
        closed: hosts.length >= SUB_QUESTION_MIN_HOSTS,
        dispatches,
      });
      out.push(`<report agent="${t.agent}">\n${truncateMiddle(report, 4000)}\n</report>`);
    }
    return out.join("\n\n");
  };

  for (let turn = 1; turn <= maxTurns; turn++) {
    const last = turn === maxTurns;
    let total = turns.reduce((n, t) => n + t.content.length, 0);
    const messages = turns.map((t, i) => {
      if (
        t.role !== "tool" ||
        i >= turns.length - 3 ||
        total <= opts.budgetChars ||
        t.content.length <= 900
      )
        return t;
      total -= t.content.length - 820;
      return { ...t, content: `[context compacted]\n${t.content.slice(0, 800)}` };
    });
    if (last)
      messages.push({
        role: "user",
        content:
          "Turn budget reached. Write the complete final answer now as plain text, with [N] citations and the References section.",
      });
    const res = await model.generate({
      role: "researcher",
      systemPrompt: system,
      prompt: "",
      messages,
      ...(last ? {} : { tools: TEAM_TOOLS }),
      toolArm: "arm_a_flat",
      reasoning: "low",
      reasoningBudgetTokens: 2048,
      maxTokens: 3500,
      purpose: "planning",
      slot: 0,
    });
    if (res.toolCalls.length === 0) {
      const text = stripReasoning(res.text);
      if (pending.length > 0 && !last) {
        turns.push({ role: "assistant", content: res.text });
        turns.push({
          role: "user",
          content: "Tasks are still assigned. Call collect_reports before answering.",
        });
        continue;
      }
      return {
        answer: text,
        ledger,
        tasks: tasksRun,
        coordinatorTurns: turn,
        reports,
        subQuestions,
      };
    }
    deps.onEvent?.(
      `coordinator ${turn}: ${res.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.arguments).slice(0, 160)})`).join(", ")}`,
    );
    const calls = res.toolCalls
      .slice(0, 4)
      .map((c, i) => ({ ...c, id: c.id || `co_${turn}_${i}` }));
    turns.push({ role: "assistant", content: res.text, toolCalls: calls });
    for (const c of calls) {
      const a = c.arguments ?? {};
      let out: string;
      if (c.name === "create_subagent") {
        const list = Array.isArray(a.agents)
          ? (a.agents as { name?: unknown; system_prompt?: unknown }[])
          : [];
        const made: string[] = [];
        for (const g of list) {
          const name = String(g.name ?? "")
            .trim()
            .slice(0, 40);
          if (!name || agents.has(name)) continue;
          if (agents.size >= maxAgents) break;
          agents.set(name, { brief: String(g.system_prompt ?? "").slice(0, 1200), reports: [] });
          made.push(name);
        }
        out = made.length
          ? `Created: ${made.join(", ")}. Team: ${[...agents.keys()].join(", ")}.`
          : `No new agents created (limit ${maxAgents}; team: ${[...agents.keys()].join(", ") || "none"}).`;
      } else if (c.name === "assign_task") {
        const tasks = Array.isArray(a.tasks)
          ? (a.tasks as { agent?: unknown; prompt?: unknown }[])
          : [];
        const queued: string[] = [];
        for (const t of tasks) {
          const agent = String(t.agent ?? "")
            .trim()
            .slice(0, 40);
          const prompt = String(t.prompt ?? "").trim();
          if (!agent || !prompt) continue;
          if (!agents.has(agent)) {
            if (agents.size >= maxAgents) continue;
            agents.set(agent, { brief: "", reports: [] });
          }
          pending.push({ agent, prompt });
          queued.push(agent);
        }
        out = queued.length
          ? `Assigned ${queued.length} task(s): ${queued.join(", ")}. They are running; call collect_reports for their results.`
          : "No tasks assigned: each task needs an agent and a prompt.";
      } else if (c.name === "collect_reports") {
        out = await runPending();
      } else {
        out = `Unknown tool ${c.name}. Coordinator tools: create_subagent, assign_task, collect_reports.`;
      }
      turns.push({ role: "tool", toolCallId: c.id, content: out });
    }
  }
  return {
    answer: "",
    ledger,
    tasks: tasksRun,
    coordinatorTurns: maxTurns,
    reports,
    subQuestions,
  };
}

export function researchPromptFor(today: string, brief: string): string {
  return researchAgentPrompt(today, brief);
}
