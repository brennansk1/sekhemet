import { execFileSync } from "node:child_process";
import { moduleApiSummary } from "@sekhemet/loop";
import type { ChatTurn, LocalInferenceAdapter, ToolCall, ToolDefinition } from "@sekhemet/models";
import { formatHits, searchLibraries } from "../pm/libraries.js";
import { researchAgentPrompt, stripThinking } from "./apodex.js";
import {
  APODEX_LOCAL_TOOLS,
  EvidenceLedger,
  apodexLoop,
  apodexTeam,
  verifyReferences,
} from "./apodex_loop.js";
import { depsFile, depsGrep, depsOutline, installed } from "./deps.js";
import { readDocs } from "./docs.js";
import { type LoopFinding, type LoopResult, runResearchLoop } from "./loop.js";
import { codeSearch, issueSearch, parseSlug, releasesBetween, repoFile, repoTree } from "./repo.js";
import { type Source, groundingConfidence, kindOfUrl } from "./sources.js";
import {
  type WebConfig,
  fetchPage,
  formatWebHits,
  githubSearch,
  paperCitations,
  readPaper,
  searchPapers,
  webSearch,
} from "./web.js";

/**
 * The Researcher: the fourth model in the roster (worker, manager,
 * adversarial reviewer, researcher). The user chose Apodex-1.1-mini
 * (arXiv 2608.23283, Apache-2.0, a Qwen3.5-35B-A3B research fine-tune).
 *
 * Apodex drives the research: it chooses the queries, the papers, the pages
 * and when it has enough to answer a sub-question. The code keeps what a
 * model should not decide alone (Helga's research loop, ported in loop.ts):
 * whether the checklist is covered, when to stop, whether a citation points
 * at something that was actually read, and how confident the answer may be.
 *
 * Built to the model card: tool schemas go through the native tool channel,
 * the system prompt is the vendor's evaluation prompt, several tool calls per
 * turn are allowed and run in parallel, and the budget is long enough for
 * research (the card's example loop allows 20 turns). Deep questions use the
 * card's "Agent Team" shape: decompose, research the parts, merge.
 *
 * Every answer carries its sources; an answer without one is reported as not
 * grounded rather than asserted (ARIS: "plausible unsupported success").
 */
export interface ResearchAnswer {
  answer: string;
  /** Human-readable source list, as before (kept for callers and the ledger). */
  sources: string[];
  /** False when the evidence did not settle the question. */
  grounded: boolean;
  /** Typed sources, with what was read from each. */
  evidence: Source[];
  /** Grounding confidence in [0, 1] from the kinds of source read (sources.ts). */
  confidence: number;
  /** Citation markers [n] in the answer that point at no source read. */
  badCitations: number[];
  /** Deep mode only: the coverage record of the research loop. */
  coverage?: Omit<LoopResult, "findings">;
}

export interface ResearchDeps {
  repoPath: string;
  /** Injectable for tests. */
  fetchJson?: (url: string) => Promise<unknown>;
  libraries?: typeof searchLibraries;
  /** Web, papers and GitHub access; undefined keeps the Researcher offline. */
  web?: WebConfig | undefined;
  /** Model turns before it must answer. Defaults: 3, or 12 for Apodex. */
  maxRounds?: number;
  /** Today's date for the vendor prompt (injectable for tests). */
  today?: string;
  /** Progress: one line per turn and tool call (the CLI prints it). */
  onEvent?: (line: string) => void;
  /** Tools from the user's MCP servers (H11), namespaced mcp__<server>__<tool>. */
  mcp?: import("../mcp_client.js").McpHub | undefined;
}

const str = { type: "string" } as const;

const WEB_TOOLS: ToolDefinition[] = [
  {
    name: "scholar_search",
    description:
      "Search research papers (Hugging Face Papers, arXiv, OpenAlex). Returns titles, arXiv ids, years, citation counts and abstracts.",
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
      "Snowball from a paper: the works it cites (references) or the works citing it (cited_by, most cited first). Takes an arXiv id or DOI.",
    parameters: {
      type: "object",
      properties: { id: str, direction: { type: "string", enum: ["references", "cited_by"] } },
      required: ["id", "direction"],
    },
  },
  {
    name: "web_search",
    description:
      "Search the web. Returns titles, URLs and snippets, official docs ranked first. Optional: `site` (only these domains), `exclude` (never these), `recency` (day, week, month, year).",
    parameters: {
      type: "object",
      properties: {
        query: str,
        site: { type: "array", items: str },
        exclude: { type: "array", items: str },
        recency: { type: "string", enum: ["day", "week", "month", "year"] },
      },
      required: ["query"],
    },
  },
  {
    name: "search_and_read",
    description:
      "Search the web and read the top results in one step: returns the parts of the best 3 pages about the query, each numbered as a source. The fastest way to settle a factual question; follow up with web_fetch for depth.",
    parameters: {
      type: "object",
      properties: {
        query: str,
        site: { type: "array", items: str },
        recency: { type: "string", enum: ["day", "week", "month", "year"] },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Read a public web page (rendered in a browser) as markdown: docs, changelogs, issues, posts. `focus` says what you need from it, so long pages return that part.",
    parameters: { type: "object", properties: { url: str, focus: str }, required: ["url"] },
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
];

/**
 * The model-free tools: the repository, its installed dependencies, the
 * registries, and GitHub through `gh`. One list, shared with the Apodex loop
 * — two lists of the same tools drift, and a tool the dispatcher knows but
 * no model was told about is a tool that is never called.
 */
const LOCAL_TOOLS: ToolDefinition[] = APODEX_LOCAL_TOOLS;

/** The only clean exit, as in Apodex's own harness (FrontierAgent). */
export const FINALIZE_TOOL: ToolDefinition = {
  name: "finalize_answer",
  description:
    "Finish: give the complete answer in Markdown, citing sources as [N]. Call this when you have enough evidence; it is the only way to end.",
  parameters: { type: "object", properties: { content: str }, required: ["content"] },
};

export function researchTools(web: boolean): ToolDefinition[] {
  return [...(web ? [...LOCAL_TOOLS, ...WEB_TOOLS] : LOCAL_TOOLS), FINALIZE_TOOL];
}

const defaultFetch = async (url: string): Promise<unknown> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
};

interface ToolResult {
  text: string;
  source?: Source;
  /** Several sources from one call (search_and_read); the text marks each as {{n}}. */
  sources?: Source[];
}

const src = (kind: Source["kind"], ref: string, text: string, title?: string): Source => ({
  kind,
  ref,
  excerpt: text.slice(0, 1500),
  ...(title ? { title } : {}),
});

export async function runResearchTool(call: ToolCall, deps: ResearchDeps): Promise<ToolResult> {
  const a = call.arguments ?? {};
  if (deps.mcp?.handles(call.name)) {
    const text = await deps.mcp.call(call.name, a);
    return text.startsWith("[ERROR]")
      ? { text }
      : { text, source: src("web", `${call.name}(${JSON.stringify(a).slice(0, 120)})`, text) };
  }
  const s = (k: string, max = 200) => String(a[k] ?? "").slice(0, max);
  try {
    if (call.name === "find_library") {
      const q = s("query", 120);
      const eco = a.ecosystem === "pypi" ? "pypi" : "npm";
      const text = formatHits(await (deps.libraries ?? searchLibraries)(q, eco));
      return { text, source: src("registry", `${eco} registry search "${q}"`, text) };
    }
    if (call.name === "package_readme") {
      const name = s("name");
      if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(name)) return { text: "Invalid package name." };
      const body = (await (deps.fetchJson ?? defaultFetch)(
        `https://registry.npmjs.org/${encodeURIComponent(name).replace("%40", "@")}`,
      )) as { readme?: string; license?: string };
      const text = `${name} (licence ${body.license ?? "unknown"}):\n${(body.readme ?? "(no README)").slice(0, 3500)}`;
      return { text, source: src("documentation", `npm README of ${name}`, text) };
    }
    if (call.name === "module_api") {
      const mod = s("module");
      const api = moduleApiSummary(deps.repoPath, mod);
      return api
        ? { text: `${mod}: ${api}`, source: src("api", `type declarations of ${mod}`, api) }
        : { text: `No declarations found for ${mod} in this project.` };
    }
    if (call.name === "git_history") {
      const q = s("query", 80);
      const out = execFileSync("git", ["log", "--oneline", "-n", "10", "-i", `--grep=${q}`], {
        cwd: deps.repoPath,
        encoding: "utf8",
        timeout: 10_000,
      }).trim();
      return out
        ? { text: out, source: src("source", `git history for "${q}"`, out) }
        : { text: "(no commits mention it)" };
    }
    // Tier 1: the installed dependency's own source. No model, no network,
    // and at the version that will actually run.
    if (call.name === "deps_source") {
      const name = s("name");
      const path = s("path", 300);
      const text = path ? depsFile(deps.repoPath, name, path) : depsOutline(deps.repoPath, name);
      const v = installed(deps.repoPath, name);
      return v
        ? { text, source: src("source", `${name}@${v.version}${path ? ` ${path}` : ""}`, text) }
        : { text };
    }
    if (call.name === "deps_grep") {
      const name = s("name");
      const text = depsGrep(deps.repoPath, name, s("pattern"));
      const v = installed(deps.repoPath, name);
      return v
        ? { text, source: src("source", `${name}@${v.version} source search`, text) }
        : { text };
    }

    // Repository intelligence: git and gh, cached by commit SHA.
    if (
      call.name === "repo_tree" ||
      call.name === "repo_file" ||
      call.name === "releases_between" ||
      call.name === "code_search" ||
      call.name === "issue_search"
    ) {
      const slugArg = s("repo", 140);
      const slug = slugArg ? parseSlug(slugArg) : undefined;
      if (slugArg && !slug) return { text: `"${slugArg}" is not an owner/repo.` };
      if (call.name === "code_search") {
        const q = s("query");
        const text = codeSearch(q, slug);
        return {
          text,
          source: src("source", `code search "${q}"${slug ? ` in ${slugArg}` : ""}`, text),
        };
      }
      if (call.name === "issue_search") {
        const q = s("query");
        const text = issueSearch(q, slug);
        return { text, source: src("forum", `issues "${q}"${slug ? ` in ${slugArg}` : ""}`, text) };
      }
      if (!slug) return { text: "This tool needs a repository as owner/repo." };
      if (call.name === "repo_tree") {
        const text = repoTree(slug, s("ref", 120) || "HEAD", s("path", 200));
        return { text, source: src("repository", `${slugArg} tree`, text) };
      }
      if (call.name === "repo_file") {
        const path = s("path", 300);
        const text = repoFile(slug, path, s("ref", 120) || "HEAD");
        return { text, source: src("source", `${slugArg}/${path}`, text) };
      }
      const from = s("from", 60);
      const to = s("to", 60);
      const text = releasesBetween(slug, from, to);
      return { text, source: src("documentation", `${slugArg} releases ${from}..${to}`, text) };
    }

    const web = deps.web;
    if (!web) return { text: `Tool ${call.name} needs web access, which is off for this project.` };
    if (call.name === "scholar_search" || call.name === "search_papers") {
      const q = s("query");
      const text = formatWebHits(await searchPapers(q, web));
      return { text, source: src("paper", `paper search "${q}"`, text) };
    }
    if (call.name === "read_paper") {
      const id = s("arxiv_id", 20);
      const text = await readPaper(id, typeof a.section === "string" ? a.section : undefined, web);
      return text.length > 300 ? { text, source: src("paper", `arXiv ${id}`, text) } : { text };
    }
    if (call.name === "paper_citations") {
      const id = s("id", 80);
      const dir = a.direction === "cited_by" ? "cited_by" : "references";
      const r = await paperCitations(id, dir, web);
      if (typeof r === "string") return { text: r };
      const text = formatWebHits(r);
      return {
        text,
        source: src(
          "paper",
          `${dir === "cited_by" ? "citations of" : "references of"} ${id}`,
          text,
        ),
      };
    }
    const searchOpts = () => ({
      ...(Array.isArray(a.site) ? { site: (a.site as unknown[]).map(String).slice(0, 5) } : {}),
      ...(Array.isArray(a.exclude)
        ? { exclude: (a.exclude as unknown[]).map(String).slice(0, 10) }
        : {}),
      ...(["day", "week", "month", "year"].includes(String(a.recency))
        ? { recency: a.recency as "day" | "week" | "month" | "year" }
        : {}),
    });
    if (call.name === "web_search") {
      const q = s("query");
      const r = await webSearch(q, web, searchOpts());
      if (typeof r === "string") return { text: r };
      const text = formatWebHits(r);
      return { text, source: src("web", `web search "${q}"`, text) };
    }
    if (call.name === "search_and_read") {
      const q = s("query");
      const r = await webSearch(q, web, searchOpts());
      if (typeof r === "string") return { text: r };
      const top = r.slice(0, 3);
      const pages = await Promise.all(
        top.map((h) => fetchPage(h.url, web, 4000, q).catch(() => "")),
      );
      const sources: Source[] = [];
      const parts: string[] = [];
      top.forEach((h, i) => {
        const body = pages[i] ?? "";
        const read =
          body.length > 200 && !/^(The page answered|Refusing|The site's robots)/.test(body);
        if (read) sources.push(src(kindOfUrl(h.url), h.url, body, h.title));
        parts.push(
          `${read ? `{{${sources.length}}} ` : ""}${h.title}\n${h.url}\n${read ? body : `(not read: ${body.slice(0, 80) || "empty"}) ${h.snippet}`}`,
        );
      });
      const rest = r.slice(3, 8).map((h) => `- ${h.title}: ${h.url}`);
      return {
        text: `${parts.join("\n\n---\n\n")}${rest.length ? `\n\nOther results:\n${rest.join("\n")}` : ""}`,
        sources,
      };
    }
    if (call.name === "web_fetch" || call.name === "fetch_page") {
      const url = s("url", 2000);
      const focus = typeof a.focus === "string" ? a.focus.slice(0, 200) : undefined;
      const text = await fetchPage(url, web, 12_000, focus);
      return text.length > 200 ? { text, source: src(kindOfUrl(url), url, text) } : { text };
    }
    if (call.name === "read_docs") {
      const fetchText = async (u: string) => {
        const t = await fetchPageRaw(u, web);
        return t;
      };
      const r = await readDocs(s("library", 300), s("question", 400), fetchText);
      if (typeof r === "string") return { text: r };
      if (r.pages.length === 0) return { text: `No readable pages under ${r.root}.` };
      const text = r.pages.map((p) => `## ${p.title}\n${p.url}\n${p.text}`).join("\n\n");
      return {
        text: `${r.available ? `(${r.available} pages in the set; the ${r.pages.length} most relevant)\n` : ""}${text}`,
        source: src("documentation", r.pages[0]?.url ?? r.root, text, r.pages[0]?.title),
      };
    }
    if (call.name === "github_search") {
      const q = s("query");
      const r = await githubSearch(q, a.kind === "code" ? "code" : "repos", web);
      if (typeof r === "string") return { text: r };
      const text = formatWebHits(r);
      return { text, source: src("repository", `GitHub search "${q}"`, text) };
    }
  } catch (err) {
    return { text: `Tool failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { text: `Unknown tool ${call.name}.` };
}

/** Raw HTML for the docs reader, through the same polite fetcher. */
async function fetchPageRaw(url: string, web: WebConfig): Promise<string | undefined> {
  const res = web.polite
    ? await web.polite.fetch(url, {}, true)
    : await (web.fetch ?? fetch)(url, { signal: AbortSignal.timeout(12_000) });
  return res.ok ? res.text() : undefined;
}

/** The vendor's evaluation prompt (model card §3.3), used when Apodex drives. */
export function apodexSystemPrompt(today: string): string {
  return `You are Apodex, an AI assistant developed by Apodex AI.

Apodex is the flagship agent of Apodex AI. Rather than a conventional conversational LLM, it is a general-purpose solver designed for mission-critical tasks.

Current time: ${today}. In this environment you have access to a set of tools you can use to answer the user's question.

You only have access to the tools provided. You can use multiple tools per message, and will receive the results of those tools in the user's next response. You use tools step-by-step to accomplish a given task.

# General Objective

You accomplish a given task iteratively, breaking it down into clear steps and working through them methodically.`;
}

/**
 * Research methodology for the system prompt, adapted from Apodex's own
 * agent harness (ApodexAI/FrontierAgent, apodex/prompts_base.py, Apache-2.0):
 * the workflow and citation rules the model was trained against, with the
 * tool names mapped to this harness's tools. Static, so the prefix caches.
 */
export const RESEARCH_METHOD = `## Research workflow
1. **Search**: use web_search with specific, varied keywords; never repeat a query. Use site and recency filters when they help. For methods, algorithms, benchmarks or anything needing peer-reviewed sources, prefer scholar_search. For a library's API, prefer read_docs, module_api and package_readme over posts.
2. **Deep read**: use web_fetch (with a focus) on promising URLs, or search_and_read to search and read in one step. One search round is never enough. If a page fails, pick a different source rather than retrying the same link.
3. **Cross-check**: verify claims across independent sources before accepting them. Official documentation and source code outrank posts.
4. **Parallelize**: several independent tool calls in one turn run at once.
5. **Finalize**: when you have enough evidence, call finalize_answer with the complete answer. That is the only clean exit.

## Output rules
- Cite sources with [N] notation, N being the source number shown with each tool result. Every factual claim needs at least one citation.
- Present specific, concrete findings (versions, API names, commands, numbers), not vague summaries.
- If the evidence does not settle it, begin with "Not settled:" and say what is missing.

## Context discipline
- Read selectively: search or focus within long pages rather than reading them whole.
- Do not re-search or re-read sources already gathered; older results may be shortened, and their sources stay numbered.
- A turn that states an intention to act must include that tool call.`;

const GENERIC_SYSTEM =
  "You are the Researcher on a software team. Answer only from evidence you fetch with your tools. If the evidence does not settle it, say so plainly.";

const ROLE_BRIEF = `ROLE
You are the Researcher on a local software team (a coding Worker, a project manager called Seshat, an adversarial reviewer). They act on your answer, so it must be right and it must be sourced.
- Prefer official documentation, type declarations and source over posts. Papers for methods; check what cites them for newer results.
- Before recommending a library, check its licence (find_library) and that it is maintained.
- Cite with [n], where n is the number of an entry in SOURCES below. Cite only what you read.
- If the evidence does not settle the question, say "Not settled:" and what is missing. Do not guess.
- Final answer: at most 250 words, concrete (versions, API names, commands), no preamble.`;

const isApodex = (m: LocalInferenceAdapter) => /apodex/i.test(m.modelId);

const strip = stripThinking;

/** Citation markers that point outside the numbered source list. */
export function checkCitations(answer: string, sourceCount: number): number[] {
  const bad = new Set<number>();
  for (const m of answer.matchAll(/\[(\d{1,3})\]/g)) {
    const n = Number(m[1]);
    if (n < 1 || n > sourceCount) bad.add(n);
  }
  return [...bad];
}

/**
 * Observation masking (The Complexity Trap, 2508.21433): once the transcript
 * passes the budget, older tool results shrink to their head; the latest
 * round stays whole. Masked text stays recoverable through the source list.
 */
export function maskOldEvidence(rounds: string[], budgetChars: number): string[] {
  let total = rounds.reduce((n, r) => n + r.length, 0);
  const out = [...rounds];
  for (let i = 0; i < out.length - 1 && total > budgetChars; i++) {
    const r = out[i] as string;
    if (r.length <= 600) continue;
    const short = `${r.slice(0, 500)}\n… (older evidence masked; the source stays listed)`;
    total -= r.length - short.length;
    out[i] = short;
  }
  return out;
}

function sourceList(evidence: Source[]): string {
  return evidence.map((s, i) => `[${i + 1}] ${s.title ? `${s.title}: ` : ""}${s.ref}`).join("\n");
}

/** Investigate one question with evidence, the model choosing the tools. */
export async function research(
  model: LocalInferenceAdapter,
  question: string,
  deps: ResearchDeps,
): Promise<ResearchAnswer> {
  const apodex = isApodex(model);
  if (apodex && model.nativeTools) return apodexResearch(model, question, deps);
  const system = `${
    apodex
      ? apodexSystemPrompt(deps.today ?? new Date().toISOString().slice(0, 10))
      : GENERIC_SYSTEM
  }\n\n${RESEARCH_METHOD}`;
  const tools = [...researchTools(Boolean(deps.web)), ...(deps.mcp?.toolDefinitions() ?? [])];
  const maxRounds = deps.maxRounds ?? (apodex ? 12 : 3);
  // Characters of evidence the window holds, leaving room for the answer and thinking.
  const budget = Math.max(12_000, ((model.contextWindow?.contextTokens ?? 16_384) - 5000) * 3);
  const evidence: Source[] = [];
  const head = `${ROLE_BRIEF}\n\nQUESTION\n${question}`;
  // Reasoning on for a reasoning-first model, bounded so the window survives.
  const think = apodex ? { reasoning: "low" as const, reasoningBudgetTokens: 1024 } : {};
  const sampling = apodex ? {} : { temperature: 0.2 };

  const finish = (text: string): ResearchAnswer => {
    const answer = strip(text) || "No answer.";
    const unsettled = /^not settled/i.test(answer) || answer === "No answer.";
    return {
      answer,
      sources: evidence.map((e) => e.ref),
      evidence,
      grounded: evidence.length > 0 && !unsettled,
      confidence: unsettled ? 0 : groundingConfidence(evidence),
      badCitations: checkCitations(answer, evidence.length),
    };
  };

  /** Run one turn's calls in parallel and number their sources. */
  const execute = async (calls: ToolCall[]) => {
    const results = await Promise.all(calls.map((c) => runResearchTool(c, deps)));
    const number = (source: Source) => {
      const at = evidence.findIndex((e) => e.ref === source.ref);
      if (at !== -1) return at + 1;
      evidence.push(source);
      return evidence.length;
    };
    return results.map((r) => {
      let text = r.text.slice(0, 12_000);
      let tag = "";
      if (r.source) tag = `Source [${number(r.source)}]: ${r.source.ref}\n`;
      if (r.sources) {
        const nums = r.sources.map(number);
        text = text.replace(/\{\{(\d+)\}\}/g, (m, k) => {
          const n = nums[Number(k) - 1];
          return n ? `Source [${n}]:` : m;
        });
      }
      return `${tag}${text}`;
    });
  };

  if (model.nativeTools) {
    // Native multi-turn, as the model card's agent loop does: assistant turns
    // carry their tool calls, each result answers its call by id.
    const turns: ChatTurn[] = [
      {
        role: "user",
        content: `${head}\n\nUse the tools to gather evidence (several calls at once is fine), then answer.`,
      },
    ];
    const masked = () => {
      const toolIdx = turns.flatMap((t, i) => (t.role === "tool" ? [i] : []));
      const bodies = maskOldEvidence(
        toolIdx.map((i) => (turns[i] as ChatTurn).content),
        budget,
      );
      return turns.map((t, i) => {
        const k = toolIdx.indexOf(i);
        return k === -1 ? t : { ...t, content: bodies[k] as string };
      });
    };
    for (let round = 0; round < maxRounds; round++) {
      const last = round === maxRounds - 1;
      const messages = masked();
      if (last) {
        messages.push({
          role: "user",
          content: `Answer now from the evidence above.${evidence.length ? `\n\nSOURCES\n${sourceList(evidence)}` : ""}`,
        });
      }
      const res = await model.generate({
        systemPrompt: system,
        prompt: "",
        messages,
        ...(last ? {} : { tools }),
        toolArm: "arm_a_flat",
        ...sampling,
        ...think,
        maxTokens: 1500,
        purpose: "planning",
      });
      if (res.toolCalls.length === 0 || last) {
        const text = strip(res.text);
        // An answer that cites nothing although sources exist gets one chance
        // to attach them; a cited answer is what the team can check.
        if (!last && evidence.length > 0 && !/\[\d+\]/.test(text) && !/^not settled/i.test(text)) {
          turns.push({ role: "assistant", content: res.text });
          turns.push({
            role: "user",
            content: `Rewrite the answer citing the sources as [n].\n\nSOURCES\n${sourceList(evidence)}`,
          });
          continue;
        }
        return finish(res.text);
      }
      const calls = res.toolCalls
        .slice(0, 6)
        .map((c, i) => ({ ...c, id: c.id || `call_${round}_${i}` }));
      turns.push({ role: "assistant", content: res.text, toolCalls: calls });
      const outputs = await execute(calls);
      calls.forEach((c, i) =>
        turns.push({ role: "tool", toolCallId: c.id, content: outputs[i] ?? "" }),
      );
    }
    return finish("");
  }

  // Flat transcript for models without native tools (Ollama tags).
  const rounds: string[] = [];
  for (let round = 0; round < maxRounds; round++) {
    const last = round === maxRounds - 1;
    const res = await model.generate({
      systemPrompt: system,
      prompt: `${head}\n\n${maskOldEvidence(rounds, budget).join("\n\n")}${
        evidence.length ? `\n\nSOURCES\n${sourceList(evidence)}` : ""
      }\n\n${
        last
          ? "Answer now from the evidence above."
          : rounds.length === 0
            ? "Use the tools to gather evidence, then answer."
            : "Gather more if something is still unsettled, or answer."
      }`,
      ...(last ? {} : { tools }),
      toolArm: "arm_a_flat",
      ...sampling,
      maxTokens: last ? 900 : 1200,
      purpose: "planning",
    });
    if (res.toolCalls.length === 0 || last) return finish(res.text);
    const calls = res.toolCalls.slice(0, 6);
    const outputs = await execute(calls);
    rounds.push(
      `EVIDENCE (round ${round + 1})\n${calls.map((c, i) => `${c.name}(${JSON.stringify(c.arguments)}):\n${outputs[i]}`).join("\n\n")}`,
    );
  }
  return finish("");
}

function parseList(text: string): string[] {
  const t = strip(text);
  const json = /\[[\s\S]*\]/.exec(t)?.[0];
  if (json) {
    try {
      const arr = JSON.parse(json) as unknown[];
      return arr.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    } catch {
      // Fall through to lines.
    }
  }
  return t
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length > 8);
}

export interface InvestigateOptions {
  /** Sub-questions at most (the card's Agent Team decomposes; this bounds it). */
  maxItems?: number;
  /** Loop rounds over the checklist. */
  maxRounds?: number;
  /** Model turns per sub-question. */
  subRounds?: number;
  /** Sub-questions researched at once. 1 unless the server has parallel slots. */
  concurrency?: number;
}

/**
 * Deep research, in the model card's Agent Team shape, governed by Helga's loop:
 * 1. the model decomposes the question into a checklist of sub-questions;
 * 2. each sub-question is researched by a sub-run (its own tool loop);
 * 3. the code measures coverage and stops on covered, dry or budget; the
 *    model rewrites queries only for what is still uncovered;
 * 4. the model merges the findings into one answer, citing the merged sources,
 *    and the citations are checked.
 */
export async function investigate(
  model: LocalInferenceAdapter,
  question: string,
  deps: ResearchDeps,
  opts: InvestigateOptions = {},
): Promise<ResearchAnswer> {
  if (isApodex(model) && model.nativeTools) return apodexInvestigate(model, question, deps, opts);
  const system = GENERIC_SYSTEM;
  const maxItems = opts.maxItems ?? 5;
  const plan = await model.generate({
    systemPrompt: system,
    prompt: `${ROLE_BRIEF}\n\nQUESTION\n${question}\n\nBreak this into at most ${maxItems} sub-questions that together settle it. Each must be answerable from documentation, code or papers. Reply with a JSON array of strings only.`,
    toolArm: "arm_a_flat",
    maxTokens: 700,
    purpose: "planning",
  });
  const checklist = parseList(plan.text).slice(0, maxItems);
  if (checklist.length === 0) checklist.push(question);

  const sub = (q: string) =>
    research(model, `${q}\n\n(Part of: ${question})`, { ...deps, maxRounds: opts.subRounds ?? 5 });
  const loop = await runResearchLoop(
    checklist,
    async (q): Promise<LoopFinding | undefined> => {
      const r = await sub(q);
      return { query: q, text: r.grounded ? r.answer : "", sources: r.grounded ? r.evidence : [] };
    },
    {
      maxRounds: opts.maxRounds ?? 3,
      concurrency: opts.concurrency ?? 1,
      proposeQueries: async (outstanding, findings) => {
        if (findings.length === 0) return outstanding;
        const res = await model.generate({
          systemPrompt: system,
          prompt: `QUESTION\n${question}\n\nThese parts are not yet covered by any source:\n${outstanding.map((o) => `- ${o}`).join("\n")}\n\nAlready tried:\n${findings.map((f) => `- ${f.query}`).join("\n")}\n\nWrite one better-targeted research question for each part (different wording, the specific library, API or paper). Reply with a JSON array of strings only.`,
          toolArm: "arm_a_flat",
          maxTokens: 500,
          purpose: "planning",
        });
        const qs = parseList(res.text);
        return qs.length > 0 ? qs : outstanding;
      },
    },
  );

  // Merge sources, renumbering each finding's citations into the merged list.
  const evidence: Source[] = [];
  const parts: string[] = [];
  for (const f of loop.findings) {
    if (!f.text) continue;
    const map = new Map<number, number>();
    f.sources.forEach((s, i) => {
      let at = evidence.findIndex((e) => e.ref === s.ref);
      if (at === -1) {
        evidence.push(s);
        at = evidence.length - 1;
      }
      map.set(i + 1, at + 1);
    });
    parts.push(
      `FINDING for "${f.query}"\n${f.text.replace(/\[(\d{1,3})\]/g, (m, n) => (map.has(Number(n)) ? `[${map.get(Number(n))}]` : m))}`,
    );
  }
  const { findings: _f, ...coverage } = loop;
  if (parts.length === 0) {
    return {
      answer: `Not settled: no sub-question found evidence (${loop.stoppedBecause}).`,
      sources: [],
      evidence: [],
      grounded: false,
      confidence: 0,
      badCitations: [],
      coverage,
    };
  }
  const merged = await model.generate({
    systemPrompt: system,
    prompt: `${ROLE_BRIEF}\n\nQUESTION\n${question}\n\n${parts.join("\n\n")}\n\nSOURCES\n${sourceList(evidence)}\n\nNOT COVERED: ${coverage.outstanding.join("; ") || "none"}\n\nMerge the findings into one answer. Keep their citations. Name anything not covered as not settled.`,
    toolArm: "arm_a_flat",
    maxTokens: 1000,
    purpose: "planning",
  });
  const answer = strip(merged.text) || parts.join("\n\n");
  return {
    answer,
    sources: evidence.map((e) => e.ref),
    evidence,
    grounded: evidence.length > 0 && coverage.coveragePct > 0,
    // Confidence is scaled by coverage: sources for half the question is half an answer.
    confidence:
      Math.round(groundingConfidence(evidence) * (coverage.coveragePct / 100) * 100) / 100,
    badCitations: checkCitations(answer, evidence.length),
    coverage,
  };
}

/** What the team is and how the answer is used; the user turn, so the system prompt stays static. */
export const APODEX_TEAM_BRIEF =
  "You research for a local software team: a coding Worker, a project manager (Seshat) and an adversarial reviewer act on your answer, so it must be right, specific and sourced. Prefer official documentation, type declarations and source code over posts; check licences before recommending a library. Keep the final answer under 300 words plus References.";

const todayOf = (deps: ResearchDeps) => deps.today ?? new Date().toISOString().slice(0, 10);

/** Characters of tool output the window holds before older results compact. */
const budgetFor = (model: LocalInferenceAdapter) =>
  Math.max(16_000, ((model.contextWindow?.contextTokens ?? 16_384) - 7000) * 3);

function toAnswer(
  text: string,
  ledger: EvidenceLedger,
  extra: Partial<ResearchAnswer> = {},
): ResearchAnswer {
  const answer = strip(text) || "No answer.";
  const v = verifyReferences(answer, ledger);
  const unsettled = /^not settled/i.test(answer) || answer === "No answer.";
  const readRefs = v.references.filter((r) => r.read).length;
  return {
    answer,
    sources: v.evidence.map((e) => e.ref),
    evidence: v.evidence,
    // Grounded: it cites something a tool actually returned and was read.
    grounded: !unsettled && readRefs > 0,
    confidence: unsettled ? 0 : v.confidence,
    badCitations: v.badCitations,
    ...extra,
  };
}

/** One question, Apodex solo (its ReAct mode), on its trained tools. */
export async function apodexResearch(
  model: LocalInferenceAdapter,
  question: string,
  deps: ResearchDeps,
): Promise<ResearchAnswer> {
  const ledger = new EvidenceLedger();
  const run = await apodexLoop(model, `${APODEX_TEAM_BRIEF}\n\nQUESTION\n${question}`, deps, {
    role: "solo",
    system: researchAgentPrompt(todayOf(deps), "See the task for who uses your answer."),
    maxTurns: deps.maxRounds ?? 14,
    extractor: model,
    budgetChars: budgetFor(model),
    ledger,
  });
  return toAnswer(run.text, ledger);
}

/** A deep question, Apodex's Agent Team. */
export async function apodexInvestigate(
  model: LocalInferenceAdapter,
  question: string,
  deps: ResearchDeps,
  opts: InvestigateOptions = {},
): Promise<ResearchAnswer> {
  const team = await apodexTeam(model, question, deps, {
    today: todayOf(deps),
    maxAgents: Math.min(4, opts.maxItems ?? 4),
    maxTasks: (opts.maxItems ?? 4) * 2,
    subTurns: opts.subRounds ?? 8,
    budgetChars: budgetFor(model),
    brief: APODEX_TEAM_BRIEF,
  });
  return toAnswer(team.answer, team.ledger, {
    coverage: {
      ran: true,
      rounds: team.coordinatorTurns,
      items: team.tasks,
      covered: team.reports.map((r) => r.agent),
      outstanding: [],
      coveragePct: team.tasks > 0 ? 100 : 0,
      sources: team.ledger.read.size,
      stoppedBecause: team.answer ? "covered" : "budget",
      exitRule: "measured coverage of the checklist (no model judgement)",
    },
  });
}
