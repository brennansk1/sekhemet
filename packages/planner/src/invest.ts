import { DEFAULT_TIER_BUDGET, DIFFICULTY_SPLIT_THRESHOLD, INVEST_MAX_STEPS } from "./constants.js";
import { workerPromptBudget, zone3Cap } from "./small.js";
import { tokenize } from "./text.js";
import type {
  InvestCheckResult,
  InvestValidationReport,
  PlannedStory,
  TierBudget,
} from "./types.js";

/**
 * Markers of a card that dictates syntax instead of stating an outcome.
 *
 * A card that says "on line 42 change `const x` to `let x`" is not negotiable:
 * it has already made every decision the executor exists to make, and it goes
 * stale the moment the file moves.
 */
const DICTATION_MARKERS = ["line", "lines", "linenumber", "verbatim", "exactly as written"];

const DICTATION_PATTERNS: RegExp[] = [
  /```/,
  /\bline\s+\d+\b/i,
  /\bat line\b/i,
  /\breplace\s+`[^`]+`\s+with\s+`[^`]+`/i,
  /=>\s*\{/,
];

/** Every file a story touches, implementation and acceptance tests alike. */
export function storyFiles(story: PlannedStory): string[] {
  return [...story.card.scopeFiles, ...story.acceptanceTests.map((t) => t.filePath)];
}

export function containsLineByLineDictation(text: string): boolean {
  if (DICTATION_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  const tokens = new Set(tokenize(text).map((t) => t.text));
  return DICTATION_MARKERS.some((marker) => tokens.has(marker)) && /\d/.test(text);
}

/** Transitive dependency closure, used by both the overlap and the cycle check. */
function reachable(stories: readonly PlannedStory[]): Map<string, Set<string>> {
  const direct = new Map<string, string[]>();
  for (const story of stories) {
    direct.set(story.card.id, story.dependsOn);
  }

  const closure = new Map<string, Set<string>>();
  for (const story of stories) {
    const seen = new Set<string>();
    const stack = [...story.dependsOn];
    while (stack.length > 0) {
      const next = stack.pop();
      if (next === undefined || seen.has(next)) {
        continue;
      }
      seen.add(next);
      for (const parent of direct.get(next) ?? []) {
        stack.push(parent);
      }
    }
    closure.set(story.card.id, seen);
  }
  return closure;
}

function hasCycle(stories: readonly PlannedStory[]): string[] {
  const closure = reachable(stories);
  const offenders: string[] = [];
  for (const story of stories) {
    if (closure.get(story.card.id)?.has(story.card.id) === true) {
      offenders.push(story.card.id);
    }
  }
  return offenders;
}

export interface InvestOptions {
  tierBudget?: TierBudget;
  /** Cards already running; their scope is unavailable to these stories. */
  activeCardScopes?: { cardId: string; filesTouched: string[] }[];
  /** The spec text, checked for line-by-line dictation alongside the stories. */
  specText?: string;
}

/**
 * INVEST-S pre-flight (design §702-713).
 *
 * Six checks, run before a card can be handed to an executor. Two of them are
 * hard gates rather than warnings — difficulty above 7 and the conjunct sizing
 * check — because both describe a card that will exhaust its budget rather
 * than fail fast, and a warning nobody reads is how that card ships anyway.
 */
export function validateInvest(
  stories: readonly PlannedStory[],
  options: InvestOptions = {},
): InvestValidationReport {
  // MD-N4-10: with no budget given, the window is the resolved Coding model's (read now).
  const budget = options.tierBudget ?? DEFAULT_TIER_BUDGET;
  const checks: InvestCheckResult[] = [];
  const mustResplit = new Set<string>();
  const rejected = new Set<string>();

  checks.push(independentCheck(stories, options));
  checks.push(negotiableCheck(stories, options, rejected));
  checks.push(valuableCheck(stories, rejected));
  checks.push(estimableCheck(stories, mustResplit));
  checks.push(smallCheck(stories, budget, mustResplit));
  checks.push(testableCheck(stories, rejected));

  return {
    passed: checks.every((c) => c.passed),
    checks,
    mustResplit: [...mustResplit],
    rejected: [...rejected],
  };
}

/**
 * I — zero scope overlap between concurrent siblings, and zero cycles.
 *
 * Overlap is not fatal on its own: the design's remedy is to serialize the
 * pair as a dependency. So overlap between stories that are already ordered
 * passes, and overlap between stories that could run at the same time does
 * not.
 */
function independentCheck(
  stories: readonly PlannedStory[],
  options: InvestOptions,
): InvestCheckResult {
  const cycles = hasCycle(stories);
  if (cycles.length > 0) {
    return {
      check: "independent",
      passed: false,
      offendingStoryIds: cycles,
      detail: `Dependency cycle through ${cycles.join(", ")}: no execution order exists.`,
      action: "resplit",
    };
  }

  const closure = reachable(stories);
  const offenders = new Set<string>();
  const collisions: string[] = [];

  for (let i = 0; i < stories.length; i += 1) {
    for (let j = i + 1; j < stories.length; j += 1) {
      const a = stories[i];
      const b = stories[j];
      if (a === undefined || b === undefined) {
        continue;
      }
      const ordered =
        closure.get(a.card.id)?.has(b.card.id) === true ||
        closure.get(b.card.id)?.has(a.card.id) === true;
      if (ordered) {
        continue;
      }
      const shared = storyFiles(a).filter((f) => storyFiles(b).includes(f));
      if (shared.length > 0) {
        offenders.add(a.card.id);
        offenders.add(b.card.id);
        collisions.push(`${a.card.id} ∩ ${b.card.id} on ${shared.join(", ")}`);
      }
    }
  }

  for (const story of stories) {
    for (const active of options.activeCardScopes ?? []) {
      const shared = storyFiles(story).filter((f) => active.filesTouched.includes(f));
      if (shared.length > 0) {
        offenders.add(story.card.id);
        collisions.push(`${story.card.id} ∩ active ${active.cardId} on ${shared.join(", ")}`);
      }
    }
  }

  return {
    check: "independent",
    passed: collisions.length === 0,
    offendingStoryIds: [...offenders],
    detail:
      collisions.length === 0
        ? "No scope overlap between concurrent stories; dependency graph is acyclic."
        : `Concurrent scope overlap: ${collisions.join("; ")}.`,
    action: collisions.length === 0 ? "none" : "serialize_dependency",
  };
}

/** N — a card states an outcome; it does not dictate syntax. */
function negotiableCheck(
  stories: readonly PlannedStory[],
  options: InvestOptions,
  rejected: Set<string>,
): InvestCheckResult {
  const offenders: string[] = [];
  for (const story of stories) {
    const text = `${story.card.title}\n${story.rationale}\n${story.acceptanceTests.map((t) => t.assertion).join("\n")}`;
    if (containsLineByLineDictation(text)) {
      offenders.push(story.card.id);
      rejected.add(story.card.id);
    }
  }

  const specDictates =
    options.specText !== undefined && containsLineByLineDictation(options.specText);

  return {
    check: "negotiable",
    passed: offenders.length === 0 && !specDictates,
    offendingStoryIds: offenders,
    detail:
      offenders.length === 0 && !specDictates
        ? "No card dictates line-by-line syntax."
        : specDictates
          ? "The spec dictates line-by-line edits; restate it as an outcome before planning."
          : `Cards dictate syntax rather than outcome: ${offenders.join(", ")}.`,
    action: offenders.length === 0 && !specDictates ? "none" : "reject",
  };
}

/** V — a card that advances no gate and no goal criterion is an orphan. */
function valuableCheck(stories: readonly PlannedStory[], rejected: Set<string>): InvestCheckResult {
  const offenders: string[] = [];
  for (const story of stories) {
    if (story.advances.length === 0) {
      offenders.push(story.card.id);
      rejected.add(story.card.id);
    }
  }
  return {
    check: "valuable",
    passed: offenders.length === 0,
    offendingStoryIds: offenders,
    detail:
      offenders.length === 0
        ? "Every story advances at least one gate or goal criterion."
        : `Orphan stories advancing nothing: ${offenders.join(", ")}.`,
    action: offenders.length === 0 ? "none" : "reject",
  };
}

/** E — difficulty is on the 1..10 scale, and above 7 is a hard re-split. */
function estimableCheck(
  stories: readonly PlannedStory[],
  mustResplit: Set<string>,
): InvestCheckResult {
  const offenders: string[] = [];
  const details: string[] = [];
  for (const story of stories) {
    const value = story.difficulty.value;
    if (!Number.isFinite(value) || value < 1 || value > 10) {
      offenders.push(story.card.id);
      details.push(`${story.card.id} difficulty ${value} is off the 1..10 scale`);
      mustResplit.add(story.card.id);
      continue;
    }
    if (value > DIFFICULTY_SPLIT_THRESHOLD) {
      offenders.push(story.card.id);
      details.push(`${story.card.id} difficulty ${value} > ${DIFFICULTY_SPLIT_THRESHOLD}`);
      mustResplit.add(story.card.id);
    }
  }
  return {
    check: "estimable",
    passed: offenders.length === 0,
    offendingStoryIds: offenders,
    detail:
      offenders.length === 0
        ? `Every story is estimable and at or below difficulty ${DIFFICULTY_SPLIT_THRESHOLD}.`
        : `${details.join("; ")}. Difficulty above ${DIFFICULTY_SPLIT_THRESHOLD} forces a re-split.`,
    action: offenders.length === 0 ? "none" : "resplit",
  };
}

/**
 * S — two conjunct conditions, not one (planner-pm §2.4, PM-12, PM-13).
 *
 * The card's Zone 3 content must fit Zone 3's cap at the resolved Worker's
 * prompt budget, 0.50 × (W − 2,400) (`small.ts`, the same computation as
 * the `ready` entry condition) **and** the step budget must be at most
 * {@link INVEST_MAX_STEPS}. Either alone lets through a real failure: a tiny
 * pack with 90 steps thrashes, and an 8-step card that needs the whole
 * window has no room left to repair itself.
 */
function smallCheck(
  stories: readonly PlannedStory[],
  budget: TierBudget,
  mustResplit: Set<string>,
): InvestCheckResult {
  const packCap = zone3Cap(workerPromptBudget(budget.workerWindowTokens));
  const stepCap = Math.min(budget.maxSteps, INVEST_MAX_STEPS);
  const offenders: string[] = [];
  const details: string[] = [];

  for (const story of stories) {
    const packFits = story.estimatedPackTokens <= packCap;
    const stepsFit = story.card.stepBudget <= stepCap;
    if (packFits && stepsFit) {
      continue;
    }
    offenders.push(story.card.id);
    mustResplit.add(story.card.id);
    const reasons: string[] = [];
    if (!packFits) {
      reasons.push(`Zone 3 content ${story.estimatedPackTokens} > ${packCap} tokens`);
    }
    if (!stepsFit) {
      reasons.push(`steps ${story.card.stepBudget} > ${stepCap}`);
    }
    details.push(`${story.card.id}: ${reasons.join(" and ")}`);
  }

  return {
    check: "small",
    passed: offenders.length === 0,
    offendingStoryIds: offenders,
    detail:
      offenders.length === 0
        ? `Every story fits both conditions: Zone 3 content ≤ ${packCap} tokens and steps ≤ ${stepCap}.`
        : `${details.join("; ")}. Both conditions must hold; SPIDR split required.`,
    action: offenders.length === 0 ? "none" : "resplit",
  };
}

/** T — acceptance tests exist, are authorable, and are confirmed failing. */
function testableCheck(stories: readonly PlannedStory[], rejected: Set<string>): InvestCheckResult {
  const offenders: string[] = [];
  const details: string[] = [];
  for (const story of stories) {
    if (story.acceptanceTests.length === 0) {
      offenders.push(story.card.id);
      rejected.add(story.card.id);
      details.push(`${story.card.id} has no acceptance test`);
      continue;
    }
    const unauthorable = story.acceptanceTests.filter((t) => t.filePath.trim().length === 0);
    const passing = story.acceptanceTests.filter((t) => !t.initiallyFailing);
    if (unauthorable.length > 0) {
      offenders.push(story.card.id);
      rejected.add(story.card.id);
      details.push(`${story.card.id} has an acceptance test with no file to live in`);
    }
    if (passing.length > 0) {
      offenders.push(story.card.id);
      rejected.add(story.card.id);
      details.push(
        `${story.card.id} has ${passing.length} acceptance test(s) not confirmed failing`,
      );
    }
  }
  return {
    check: "testable",
    passed: offenders.length === 0,
    offendingStoryIds: [...new Set(offenders)],
    detail:
      offenders.length === 0
        ? "Every story has authorable acceptance tests, all confirmed failing."
        : `${details.join("; ")}.`,
    action: offenders.length === 0 ? "none" : "reject",
  };
}
