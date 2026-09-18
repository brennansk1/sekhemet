import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { estimatePromptTokens } from "./allocator.js";

/**
 * AGENTS.md / CLAUDE.md conventions folded into Zone 2 (C22). The project's
 * own agent instructions are bounded, extracted deterministically and put
 * in the cached system prefix, instead of being reachable only through the
 * `docs` tool. Only conventions a Worker can act on are kept: bullet and
 * numbered rules under headings about code, style, testing, commits,
 * structure and commands. Prose, diagrams and code blocks are dropped. The
 * result is byte-stable for a given file.
 */
export const CONVENTION_FILES = ["AGENTS.md", "CLAUDE.md", ".sekhemet/CONVENTIONS.md"] as const;

const USEFUL_HEADING =
  /(convention|standard|style|code|test|commit|lint|format|structure|rule|invariant|guideline|naming|architecture|command|tooling)/i;

export function extractConventions(markdown: string, maxTokens = 300): string {
  const out: string[] = [];
  let inFence = false;
  let usefulSection = true;
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      usefulSection = USEFUL_HEADING.test(heading[1] ?? "");
      continue;
    }
    if (!usefulSection) continue;
    const item = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (!item) continue;
    const text = (item[1] ?? "")
      .replace(/\*\*|__|`/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\$[^$]*\$/g, "")
      .trim();
    if (text.length < 12 || text.length > 220) continue;
    const next = `- ${text}`;
    if (out.includes(next)) continue;
    if (estimatePromptTokens([...out, next].join("\n")) > maxTokens) break;
    out.push(next);
  }
  return out.join("\n");
}

/** Read and extract every convention file present under `root`, in a fixed order. */
export function loadProjectConventions(root: string, maxTokens = 300): string {
  const parts: string[] = [];
  for (const name of CONVENTION_FILES) {
    const path = join(root, name);
    const remaining = maxTokens - estimatePromptTokens(parts.join("\n"));
    if (!existsSync(path) || remaining <= 20) continue;
    const text = extractConventions(readFileSync(path, "utf8"), remaining - 8);
    if (text) parts.push(`From ${name}:\n${text}`);
  }
  return parts.join("\n");
}
