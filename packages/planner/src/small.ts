import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALLOCATOR_WINDOW_MARGIN_TOKENS,
  PROMPT_ZONE_FRACTIONS,
  estimatePromptTokens,
} from "@sekhemet/context";
import type { CardRecord } from "@sekhemet/kernel";
import { REASONING_BUDGET_TOKENS } from "@sekhemet/models";
import { ASSUMED_FILE_TOKENS } from "./constants.js";
export { REFERENCE_WORKER_WINDOW } from "./constants.js";
import type { CodebaseMap } from "./types.js";

/**
 * INVEST's *Small* — the one card-size number (planner-pm §2.4, DEC-27;
 * PM-12, PM-13, PM-14): a card's Zone 3 content fits Zone 3's cap at the
 * resolved Worker's prompt budget W, 0.50 × (W − 2,400). The planner's
 * INVEST check and the board's `ready` entry condition (kernel rule 27,
 * K-N5-7, `BoardServiceOptions.zone3Fit`) both call {@link zone3Fit}: one
 * computation, so they cannot disagree about one card.
 */

/** Zone 1 in tokens, native tool schemas included (context rule 10, DEC-27). */
export const ZONE1_TOKENS = 2_400;

/** The Worker's answer cap, reserved out of its window (worker-loop rule 22). */
export const WORKER_ANSWER_TOKENS = 4_096;

/**
 * The Worker's prompt budget W from its registry window (worker-loop rule
 * 22): the window less the answer cap, the high thinking allowance and the
 * tokenizer margin — 9,984 on the reference Worker.
 */
export function workerPromptBudget(
  windowTokens: number,
  answerTokens: number = WORKER_ANSWER_TOKENS,
): number {
  return (
    windowTokens - answerTokens - REASONING_BUDGET_TOKENS.high - ALLOCATOR_WINDOW_MARGIN_TOKENS
  );
}

/**
 * Zone 3's cap at a prompt budget W: 0.50 × (W − 2,400) (context rule 10),
 * never below zero — a W under Zone 1 leaves no room for any issue's
 * content, which {@link windowTooSmall} says (N0, c6 #7).
 */
export function zone3Cap(promptBudgetTokens: number): number {
  return Math.max(
    0,
    Math.floor((PROMPT_ZONE_FRACTIONS[3] as number) * (promptBudgetTokens - ZONE1_TOKENS)),
  );
}

const tokens = (n: number) => n.toLocaleString("en-US");

/**
 * Why no issue fits a Coding model's window, when none can (Zone 3's cap is
 * zero), else undefined: what its prompt budget leaves against Zone 1 (N0).
 */
export function windowTooSmall(windowTokens: number): string | undefined {
  const w = workerPromptBudget(windowTokens);
  if (zone3Cap(w) > 0) return undefined;
  return `The Coding model's window of ${tokens(windowTokens)} tokens is too small for any issue: after its answer, thinking and margin, ${tokens(Math.max(0, w))} tokens are left for the prompt, and its fixed instructions take ${tokens(ZONE1_TOKENS)}. Assign a Coding model with a larger window.`;
}

/** The parts of a card that make up its Zone 3 content. */
export type Zone3Card = Pick<
  CardRecord,
  "id" | "title" | "spec" | "acceptanceCriteria" | "scopeFiles" | "acceptanceTests" | "interface"
>;

export interface Zone3Options {
  /** The resolved Worker's prompt budget W ({@link workerPromptBudget}). */
  promptBudgetTokens: number;
  /** Scope files and staged tests are read from here when present. */
  repoRoot?: string | undefined;
  /** Sizes of files not on disk (the planner's map, before a file is read). */
  codebaseMap?: CodebaseMap | undefined;
  /** Staged test sources not yet on disk, by path. */
  testSources?: Readonly<Record<string, string>> | undefined;
}

function testPathOf(path: string): string {
  return path.startsWith("tests/") || path.includes("/") ? path : `tests/${path}`;
}

function read(root: string | undefined, rel: string): string | undefined {
  if (!root) return undefined;
  const p = join(root, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : undefined;
}

/**
 * The tokens of each section of a card's Zone 3 content, as the allocator
 * counts them (its estimator, plus one separator per section): the spec and
 * criteria, the interface the test imports, the staged acceptance tests and
 * the scope files. The repo map slice is not counted: assembly shrinks it
 * first, so it never decides whether the card fits (context rule 10).
 */
export function zone3Sections(card: Zone3Card, options: Zone3Options): number[] {
  const sizes: number[] = [];
  const text = (t: string) => estimatePromptTokens(t) + 1;
  sizes.push(
    text(
      [
        card.title,
        card.spec ?? "",
        ...(card.acceptanceCriteria ?? []).map((c, i) => `${i + 1}. ${c}`),
      ].join("\n"),
    ),
  );
  if (card.interface && card.interface.length > 0) {
    sizes.push(
      text(card.interface.map((s) => `${s.symbol} in ${s.file}: ${s.signature}`).join("\n")),
    );
  }
  for (const t of card.acceptanceTests ?? []) {
    const source = options.testSources?.[t] ?? read(options.repoRoot, testPathOf(t));
    if (source !== undefined) sizes.push(text(source));
  }
  for (const f of card.scopeFiles) {
    const source = read(options.repoRoot, f);
    if (source !== undefined) {
      sizes.push(text(source));
      continue;
    }
    const map = options.codebaseMap;
    // A file the map lists but has not measured is charged a file's
    // assumed size; a file no one has written yet is empty.
    const known = map?.fileTokens?.[f] ?? (map?.files.includes(f) ? ASSUMED_FILE_TOKENS : 0);
    if (known > 0) sizes.push(known + 1);
  }
  return sizes;
}

/**
 * A card's Zone 3 content against Zone 3's cap at the Worker's W — the
 * planner's INVEST *Small* and the board's `ready` entry condition
 * (`BoardServiceOptions.zone3Fit`).
 */
export function zone3Fit(card: Zone3Card, options: Zone3Options): { tokens: number; cap: number } {
  return {
    tokens: zone3Sections(card, options).reduce((a, b) => a + b, 0),
    cap: zone3Cap(options.promptBudgetTokens),
  };
}
