import { execFileSync } from "node:child_process";
import { moduleApiSummary } from "@sekhemet/loop";
import type { LocalInferenceAdapter, ToolCall, ToolDefinition } from "@sekhemet/models";
import { formatHits, searchLibraries } from "../pm/libraries.js";

/**
 * The Researcher: the fourth model in the roster (worker, manager,
 * adversarial reviewer, researcher). The user chose Apodex-1.1-mini
 * (arXiv 2608.23283, Apache-2.0, a Qwen3.5-35B-A3B research fine-tune).
 *
 * It answers questions the others should not guess at, from evidence it
 * fetched: package registries (with licences), package READMEs, the real
 * API of a module from its type declarations, and the project's own git
 * history. Every answer carries its sources; an answer without one is
 * reported as unknown rather than asserted (ARIS: "plausible unsupported
 * success" is the failure to design against).
 */
export interface ResearchAnswer {
  answer: string;
  sources: string[];
  /** False when the evidence did not settle the question. */
  grounded: boolean;
}

export interface ResearchDeps {
  repoPath: string;
  /** Injectable for tests. */
  fetchJson?: (url: string) => Promise<unknown>;
  libraries?: typeof searchLibraries;
}

const RESEARCH_TOOLS: ToolDefinition[] = [
  {
    name: "find_library",
    description: "Search npm or PyPI; results carry licence and whether it is safe to use.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        ecosystem: { type: "string", enum: ["npm", "pypi"] },
      },
      required: ["query"],
    },
  },
  {
    name: "package_readme",
    description: "Read an npm package's README (first part) to learn its API and usage.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "module_api",
    description:
      "The real classes and members of a module from the project's installed type declarations, e.g. node:sqlite.",
    parameters: {
      type: "object",
      properties: { module: { type: "string" } },
      required: ["module"],
    },
  },
  {
    name: "git_history",
    description: "Search this repository's commit messages and code changes for a term.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];

const defaultFetch = async (url: string): Promise<unknown> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
};

async function runTool(
  call: ToolCall,
  deps: ResearchDeps,
): Promise<{ text: string; source?: string }> {
  const a = call.arguments ?? {};
  try {
    if (call.name === "find_library") {
      const q = String(a.query ?? "").slice(0, 120);
      const eco = a.ecosystem === "pypi" ? "pypi" : "npm";
      const hits = await (deps.libraries ?? searchLibraries)(q, eco);
      return { text: formatHits(hits), source: `${eco} registry search "${q}"` };
    }
    if (call.name === "package_readme") {
      const name = String(a.name ?? "");
      if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(name)) return { text: "Invalid package name." };
      const body = (await (deps.fetchJson ?? defaultFetch)(
        `https://registry.npmjs.org/${encodeURIComponent(name).replace("%40", "@")}`,
      )) as { readme?: string; license?: string };
      return {
        text: `${name} (licence ${body.license ?? "unknown"}):\n${(body.readme ?? "(no README)").slice(0, 3500)}`,
        source: `npm README of ${name}`,
      };
    }
    if (call.name === "module_api") {
      const mod = String(a.module ?? "");
      const api = moduleApiSummary(deps.repoPath, mod);
      return api
        ? { text: `${mod}: ${api}`, source: `type declarations of ${mod}` }
        : { text: `No declarations found for ${mod} in this project.` };
    }
    if (call.name === "git_history") {
      const q = String(a.query ?? "").slice(0, 80);
      const out = execFileSync("git", ["log", "--oneline", "-n", "10", "-i", `--grep=${q}`], {
        cwd: deps.repoPath,
        encoding: "utf8",
        timeout: 10_000,
      }).trim();
      return { text: out || "(no commits mention it)", source: `git history for "${q}"` };
    }
  } catch (err) {
    return { text: `Tool failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { text: `Unknown tool ${call.name}` };
}

/** Investigate one question with evidence, in at most three tool rounds. */
export async function research(
  model: LocalInferenceAdapter,
  question: string,
  deps: ResearchDeps,
): Promise<ResearchAnswer> {
  const system =
    "You are the Researcher on a software team. Answer only from evidence you fetch with your tools; cite what you used. If the evidence does not settle it, say so plainly. Be concise: the answer is read by a coding model and a project manager.";
  let context = `QUESTION\n${question}\n\nUse the tools to gather evidence, then answer.`;
  const sources: string[] = [];
  for (let round = 0; round < 3; round++) {
    const res = await model.generate({
      systemPrompt: system,
      prompt: context,
      tools: RESEARCH_TOOLS,
      toolArm: "arm_a_flat",
      temperature: 0.2,
      maxTokens: 900,
    });
    if (res.toolCalls.length === 0) {
      const answer = res.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      return { answer: answer || "No answer.", sources, grounded: sources.length > 0 };
    }
    const results: string[] = [];
    for (const call of res.toolCalls.slice(0, 4)) {
      const r = await runTool(call, deps);
      if (r.source) sources.push(r.source);
      results.push(`${call.name}(${JSON.stringify(call.arguments)}):\n${r.text}`);
    }
    context = `${context}\n\nEVIDENCE\n${results.join("\n\n")}\n\n${round === 1 ? "Answer now." : "Gather more if needed, or answer."}`;
  }
  const final = await model.generate({
    systemPrompt: system,
    prompt: `${context}\n\nAnswer now from the evidence above.`,
    toolArm: "arm_a_flat",
    temperature: 0.2,
    maxTokens: 700,
  });
  return {
    answer: final.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || "No answer.",
    sources,
    grounded: sources.length > 0,
  };
}
