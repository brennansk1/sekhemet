import { factKeysOf } from "./facts.js";

/**
 * One context allocator (Integration review item 7, target architecture §4).
 *
 * A prompt is a list of typed sections. Each has a priority (higher is kept
 * longer), an optional token cap, fact keys for duplicate detection and a
 * placement that decides where it renders:
 *
 *   system  the card-stable system prompt (laws, tools, card rules, skills)
 *   static  the start of the user prompt: stable for the card (repo map,
 *           tests, team, plan, contract), so it extends the cached prefix
 *   volatile the per-turn tail (scope files, failure, history, goal)
 *
 * Allocation runs in four passes:
 *   1. caps: a section over its cap is shrunk to fit it;
 *   2. duplicates: identical text, or a section whose every fact key is
 *      already carried by a section that wins (earlier placement, then
 *      higher priority), is dropped;
 *   3. fit: while the total is over the budget, the lowest-priority section
 *      is shrunk (if it can be) and otherwise dropped; `required` sections
 *      are never dropped;
 *   4. render: system, then static, then volatile, each in `order`.
 *
 * Nothing is cut silently: every drop and shrink is reported.
 */
export type SectionPlacement = "system" | "static" | "volatile";

export type SectionKind =
  | "laws"
  | "tools"
  | "rules"
  | "skills"
  | "repo_map"
  | "tests"
  | "other_file"
  | "scope_file"
  | "team"
  | "plan"
  | "dossier"
  | "contract"
  | "lessons"
  | "rung"
  | "error_rules"
  | "history_old"
  | "history_recent"
  | "failure"
  | "remedy"
  | "notice"
  | "goal"
  | "conventions"
  | "exemplars"
  | "tool_index"
  | "loaded_tools"
  | "late_rules"
  | "pinned_system";

export interface ContextSection {
  id: string;
  kind: SectionKind;
  text: string;
  priority: number;
  placement: SectionPlacement;
  /** Render order within the placement (ascending). */
  order: number;
  /** Token ceiling; the section is shrunk to it. */
  capTokens?: number;
  /** Explicit fact keys; `inferKeys` derives them from the text instead. */
  factKeys?: string[];
  inferKeys?: boolean;
  /** Never dropped (may still be shrunk). */
  required?: boolean;
  /**
   * Produce a shorter version at most `maxTokens` long, or undefined when it
   * cannot. Default: keep the head, then a marker line.
   */
  shrink?: (text: string, maxTokens: number) => string | undefined;
  /** Smallest useful size when shrinking under pressure; below it, drop. */
  minTokens?: number;
}

export interface AllocationEvent {
  id: string;
  kind: SectionKind;
  action: "capped" | "deduplicated" | "shrunk" | "dropped";
  tokensBefore: number;
  tokensAfter: number;
  /** For deduplicated sections: the section that already carries the fact. */
  coveredBy?: string;
}

export interface AllocationResult {
  sections: ContextSection[];
  events: AllocationEvent[];
  usedTokens: number;
  budgetTokens: number;
  /** False when even the required sections exceed the budget. */
  fits: boolean;
}

export interface AllocateOptions {
  budgetTokens: number;
  /** Tokens already spent outside the sections (native tool schemas). */
  overheadTokens?: number;
  estimate?: (text: string) => number;
}

/**
 * The prompt-side token estimate. Code tokenizes denser than prose; 3.2
 * characters per token errs on the safe side (the Worker's request
 * estimate uses the same ratio).
 */
export function estimatePromptTokens(text: string): number {
  return Math.ceil(text.length / 3.2);
}

const PLACEMENT_RANK: Record<SectionPlacement, number> = { system: 0, static: 1, volatile: 2 };

/** Head-keeping shrink with an explicit marker. */
export function shrinkHead(
  text: string,
  maxTokens: number,
  estimate: (t: string) => number = estimatePromptTokens,
): string | undefined {
  const marker = "\n… (cut to fit the context window)";
  if (estimate(text) <= maxTokens) return text;
  const room = maxTokens - estimate(marker);
  if (room <= 0) return undefined;
  // Characters per token for this estimator, measured on the text itself.
  const ratio = text.length / Math.max(1, estimate(text));
  let cut = Math.floor(room * ratio);
  while (cut > 0 && estimate(text.slice(0, cut) + marker) > maxTokens) cut -= 16;
  if (cut <= 0) return undefined;
  const nl = text.lastIndexOf("\n", cut);
  return `${text.slice(0, nl > cut * 0.6 ? nl : cut)}${marker}`;
}

function keysOf(section: ContextSection): string[] {
  if (section.factKeys) return section.factKeys;
  return section.inferKeys ? factKeysOf(section.text) : [];
}

function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Which of two sections wins a duplicate: earlier placement, then priority, then order. */
function wins(a: ContextSection, b: ContextSection): boolean {
  const pa = PLACEMENT_RANK[a.placement];
  const pb = PLACEMENT_RANK[b.placement];
  if (pa !== pb) return pa < pb;
  if (a.priority !== b.priority) return a.priority > b.priority;
  return a.order < b.order;
}

export function allocateContext(
  input: ContextSection[],
  options: AllocateOptions,
): AllocationResult {
  const estimate = options.estimate ?? estimatePromptTokens;
  const events: AllocationEvent[] = [];
  const shrinkTo = (s: ContextSection, max: number): string | undefined =>
    s.shrink ? s.shrink(s.text, max) : shrinkHead(s.text, max, estimate);

  // 1. Caps.
  let sections = input
    .filter((s) => s.text.trim().length > 0)
    .map((s) => {
      if (s.capTokens === undefined) return s;
      const before = estimate(s.text);
      if (before <= s.capTokens) return s;
      const text = shrinkTo(s, s.capTokens);
      if (text === undefined) {
        events.push({
          id: s.id,
          kind: s.kind,
          action: "dropped",
          tokensBefore: before,
          tokensAfter: 0,
        });
        return undefined;
      }
      events.push({
        id: s.id,
        kind: s.kind,
        action: "capped",
        tokensBefore: before,
        tokensAfter: estimate(text),
      });
      return { ...s, text };
    })
    .filter((s): s is ContextSection => s !== undefined);

  // 2. Duplicates: winners first, so each fact is carried by its best holder.
  const ranked = [...sections].sort((a, b) => (wins(a, b) ? -1 : wins(b, a) ? 1 : 0));
  const seenText = new Map<string, string>();
  const keyHolder = new Map<string, string>();
  const dropped = new Set<string>();
  for (const s of ranked) {
    const norm = normalized(s.text);
    const keys = keysOf(s);
    const sameText = seenText.get(norm);
    const holder =
      keys.length > 0 && keys.every((k) => keyHolder.has(k))
        ? keyHolder.get(keys[0] as string)
        : undefined;
    const coveredBy = sameText ?? holder;
    if (coveredBy !== undefined && !s.required) {
      dropped.add(s.id);
      events.push({
        id: s.id,
        kind: s.kind,
        action: "deduplicated",
        tokensBefore: estimate(s.text),
        tokensAfter: 0,
        coveredBy,
      });
      continue;
    }
    seenText.set(norm, s.id);
    for (const k of keys) if (!keyHolder.has(k)) keyHolder.set(k, s.id);
  }
  sections = sections.filter((s) => !dropped.has(s.id));

  // 3. Fit by priority.
  const overhead = options.overheadTokens ?? 0;
  const total = (): number => overhead + sections.reduce((a, s) => a + estimate(s.text) + 1, 0);
  const byPriority = [...sections].sort((a, b) => a.priority - b.priority || b.order - a.order);
  for (const victim of byPriority) {
    const over = total() - options.budgetTokens;
    if (over <= 0) break;
    const current = sections.find((s) => s.id === victim.id);
    if (!current) continue;
    const before = estimate(current.text);
    const target = before - over;
    const shrunk =
      target >= (current.minTokens ?? Number.POSITIVE_INFINITY)
        ? shrinkTo(current, target)
        : undefined;
    if (shrunk !== undefined) {
      sections = sections.map((s) => (s.id === current.id ? { ...s, text: shrunk } : s));
      events.push({
        id: current.id,
        kind: current.kind,
        action: "shrunk",
        tokensBefore: before,
        tokensAfter: estimate(shrunk),
      });
      continue;
    }
    if (current.required) {
      // Last resort for a required section: its minimum, if it has one.
      const floor = current.minTokens;
      const min = floor !== undefined ? shrinkTo(current, Math.max(floor, target)) : undefined;
      if (min !== undefined && estimate(min) < before) {
        sections = sections.map((s) => (s.id === current.id ? { ...s, text: min } : s));
        events.push({
          id: current.id,
          kind: current.kind,
          action: "shrunk",
          tokensBefore: before,
          tokensAfter: estimate(min),
        });
      }
      continue;
    }
    sections = sections.filter((s) => s.id !== current.id);
    events.push({
      id: current.id,
      kind: current.kind,
      action: "dropped",
      tokensBefore: before,
      tokensAfter: 0,
    });
  }

  // 4. Render order.
  sections.sort(
    (a, b) => PLACEMENT_RANK[a.placement] - PLACEMENT_RANK[b.placement] || a.order - b.order,
  );
  const usedTokens = total();
  return {
    sections,
    events,
    usedTokens,
    budgetTokens: options.budgetTokens,
    fits: usedTokens <= options.budgetTokens,
  };
}

/** Join the sections of one placement, blank-line separated. */
export function renderPlacement(sections: ContextSection[], placement: SectionPlacement): string {
  return sections
    .filter((s) => s.placement === placement)
    .map((s) => s.text)
    .join("\n\n");
}
