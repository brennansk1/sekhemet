import { createHash } from "node:crypto";
import type { GateFailure } from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import type { ToolDefinition } from "@sekhemet/models";
import {
  type AllocationEvent,
  type ContextSection,
  type SectionKind,
  allocateContext,
  estimatePromptTokens,
} from "./allocator.js";
import { compactHistory, maskOlderObservations } from "./condenser.js";
import type { EvidenceStore } from "./evidence.js";
import { type Exemplar, renderExemplars } from "./exemplars.js";
import { factKeysOf } from "./facts.js";
import { type PlaybookRule, ruleFactKeys } from "./playbook.js";
import type { PrefixStabilityGuard } from "./prefix_guard.js";
import {
  DEFAULT_PRESSURE_THRESHOLDS,
  type PressureAssessment,
  type PressureThresholds,
  type PressureTier,
  applyContextPressure,
  assessContextPressure,
} from "./pressure.js";
import { PROMPT_ZONE_1_SYSTEM, type SkillDisclosure, type TurnHistoryItem } from "./prompts.js";
import { linesNamedFor, pruneLines } from "./pruner.js";
import type { SkillManifest } from "./skills.js";
import { type ToolInterfaceSpec, renderToolInterface } from "./tool_interface.js";
import { renderToolSearchIndex } from "./tool_search.js";
import { computeContextVersion } from "./versioning.js";
import { computePrefixHash } from "./zones.js";

/**
 * The Worker's prompt, built by the one allocator (Integration review items
 * 4 and 7; re-audit C4 and C7). This replaces the loop's reduction levels.
 *
 * Order, for the prefix cache (static first, volatile last):
 *   system    laws, the tools (as text only when they are NOT sent natively),
 *             card-scoped rules, skills. Stable for the whole card: nothing
 *             that depends on a gate result or a rung is here.
 *   static    repo map, acceptance tests, other pinned files, team note,
 *             repair plan, dossier, card contract (without the step count).
 *   volatile  lessons, scope files, rung directive, error-scoped rules,
 *             history, the standing failure and its remedies, what was cut,
 *             and the goal with the step count, last.
 *
 * Under pressure (C7) the 70/80/85/90% tiers of `pressure.ts` condense and
 * mask history, trim then drop the repo map and collapse skills; then the
 * allocator cuts by priority: repo map, old history, non-scope pinned
 * files, tests, and only then team, rules, lessons, the plan. The Worker's
 * scope files and the standing failure are cut last. If even the required
 * sections exceed 95% of the budget, the step stops with `budget_exhausted`.
 */
export interface PinnedFile {
  path: string;
  content: string;
}

export interface WorkerPromptInput {
  card: CardRecord;
  /** Tool specs for the text interface. */
  tools: ToolInterfaceSpec[];
  /**
   * The JSON schemas when the adapter sends tools natively
   * (`adapter.nativeTools`). Present: the text interface is omitted, so the
   * tools are described once, and the schemas' size counts against the
   * budget. Absent: the text interface is rendered into the system prompt.
   */
  nativeToolSchemas?: ToolDefinition[];
  /** Request budget in tokens (window - max output - margin). Absent: no cuts. */
  budgetTokens?: number;
  repoMap?: string;
  acceptanceTests?: PinnedFile[];
  /** The Worker's own declared scope files, current content. */
  scopeFiles?: PinnedFile[];
  /** Other pinned files (read-only context outside the scope). */
  otherFiles?: PinnedFile[];
  teamNote?: string;
  /** The planning model's repair plan for this attempt. */
  repairPlan?: string;
  /** Per-card directives from the team: answers, a send-back note. */
  dossier?: { label: string; text: string }[];
  /** Working-memory lessons and lessons from earlier attempts. */
  lessons?: string[];
  /**
   * Rules in force (from `PlaybookRegistry.matchRules` with `failureText`).
   * Rules without `errorPattern` go to the system prompt; error-scoped ones
   * to the volatile tail.
   */
  rules?: PlaybookRule[];
  /** The active repair rung's directive, when past direct repair. */
  rungDirective?: string;
  skills?: SkillManifest[];
  /** Pin skill disclosure for the card (keeps the system prompt stable). */
  skillDisclosure?: SkillDisclosure;
  turns?: TurnHistoryItem[];
  gateFailures?: GateFailure[];
  /** Source lines at the failure locations. */
  failureCode?: string;
  goal?: string;
  acceptanceCriteria?: string[];
  openTodos?: string[];
  /** Files written and read this card ("wrote src/a.ts"). */
  completedWork?: string[];
  readyToVerify?: boolean;
  /** Where masked history goes. Default `defaultEvidenceStore`. */
  evidenceStore?: EvidenceStore;
  thresholds?: PressureThresholds;
  /** Most card-scoped rules in the system prompt. Default 8. */
  maxRules?: number;
  /** Most error-scoped rules in the tail. Default 5. */
  maxErrorRules?: number;
  /**
   * Pins the system prompt for the card on its first build and reuses it
   * verbatim afterwards (C4). Rules that enter later go to the tail.
   */
  prefixGuard?: PrefixStabilityGuard;
  /**
   * Project conventions from AGENTS.md / CLAUDE.md (`loadProjectConventions`,
   * C22), folded into the system prompt.
   */
  conventions?: string;
  /** Successful trajectories of this card's class (`ExemplarStore.topFor`, C13). */
  exemplars?: Exemplar[];
  /**
   * Dynamic tool loading (C19): every tool in the catalog, shown as a
   * one-line index in the system prompt. `tools` is then the set loaded
   * from the start; `loadedTools` the specs `tool_search` loaded since,
   * which go to the volatile tail so the prefix stays stable.
   */
  toolIndex?: ToolInterfaceSpec[];
  loadedTools?: ToolInterfaceSpec[];
}

/**
 * The context pack for a step (C14): an id and the per-zone token counts,
 * with the prefix hashes and the joint version, for persistence with the
 * attempt and the evidence bundle.
 */
export interface ContextPackRecord {
  id: string;
  cardId: string;
  step: number;
  zoneTokens: { system: number; static: number; volatile: number; toolSchemas: number };
  prefixHash: string;
  staticPrefixHash: string;
  /** Joint prompt/playbook/tool version (C21). */
  version: string;
  tier: PressureTier;
  cut: SectionKind[];
}

/** Per-step context metrics (C20). */
export interface ContextStepMetrics {
  step: number;
  usedTokens: number;
  budgetTokens: number | undefined;
  utilization: number | undefined;
  tier: PressureTier;
  maskedObservations: number;
  compactedTurns: number;
  sectionsCut: number;
  rulesInPrompt: number;
  /** The system prompt matched the card's pin (C4); undefined without a guard. */
  prefixStable: boolean | undefined;
}

export interface WorkerPromptResult {
  systemPrompt: string;
  prompt: string;
  /** sha256 of the system prompt. Must not change within a card. */
  prefixHash: string;
  /** sha256 of the system prompt plus the static user prefix. */
  staticPrefixHash: string;
  tier: PressureTier;
  pressure: PressureAssessment;
  events: AllocationEvent[];
  usedTokens: number;
  budgetTokens: number | undefined;
  stop: boolean;
  stopReason?: "budget_exhausted";
  /** Ids of the rules that reached the prompt, for outcome counting. */
  rulesUsed: string[];
  /** Kinds of sections that were cut, for the log. */
  cut: SectionKind[];
  /** The context pack record (C14). */
  pack: ContextPackRecord;
  /** Joint prompt/playbook/tool version hash (C21). */
  versionHash: string;
  metrics: ContextStepMetrics;
  /**
   * Identical inputs have produced identical bytes every time this process
   * has seen them (C15). False means a nondeterministic input slipped in.
   */
  deterministic: boolean;
}

const NATIVE_TOOLS_NOTE =
  "TOOLS: your tools are provided through the function-calling interface. Call them by name with JSON arguments; call only those tools.";

const HEADERS: Partial<Record<SectionKind, string>> = {
  rules: "=== PROJECT PLAYBOOK RULES ===",
  skills: "=== ACTIVE LOADED SKILLS ===",
  error_rules: "=== RULES FOR THE CURRENT ERROR ===",
  lessons: "=== LESSONS SO FAR ===",
};

function renderList(items: string[]): string {
  return items.map((item, i) => `${i + 1}. ${item}`).join("\n");
}

function scopeLine(files: string[]): string {
  return files.length > 0 ? files.join(", ") : "unrestricted (max 3 files)";
}

function renderTurns(turns: TurnHistoryItem[]): string {
  return turns.map((t) => `Turn ${t.turn}: ${t.action} -> ${t.result}`).join("\n");
}

/** Keep the head and the tail of a file: signatures up top, exports at the bottom. */
function shrinkFile(text: string, maxTokens: number): string | undefined {
  if (estimatePromptTokens(text) <= maxTokens) return text;
  const marker =
    "\n… (middle cut to fit the context window; read_file with a line range for it) …\n";
  const room = (maxTokens - estimatePromptTokens(marker)) * 3.2;
  if (room < 200) return undefined;
  const head = Math.floor(room * 0.7);
  const tail = Math.floor(room * 0.3) - 4;
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`;
}

/**
 * Shrink a file section by relevance first (C3): keep the lines that matter
 * to the goal and the failure, the lines the failure names, and their
 * enclosing declarations. Head-and-tail cutting is the fallback.
 */
function pruningShrink(path: string, query: string, failure: string) {
  const pinned = linesNamedFor(path, failure);
  return (text: string, maxTokens: number): string | undefined => {
    const nl = text.indexOf("\n");
    const header = nl >= 0 ? text.slice(0, nl) : "";
    const body = nl >= 0 ? text.slice(nl + 1) : text;
    const room = maxTokens - estimatePromptTokens(header) - 1;
    if (room > 40 && query.trim()) {
      const pruned = pruneLines(body, query, { maxTokens: room, pinnedLines: pinned });
      if (pruned.fits) return `${header}\n${pruned.text}`;
    }
    return shrinkFile(text, maxTokens);
  };
}

function failureText(failures: GateFailure[], code: string | undefined): string {
  const [first, ...rest] = failures;
  if (!first) return "";
  const lines = [
    "=== LAST GATE FAILURE ===",
    `Gate Rung: ${first.rung} (Exit code: ${first.exitCode})`,
    `Suggested Fix Files: ${scopeLine(first.suggestedFixFiles)}`,
    "Error Excerpt:",
    first.errorExcerpt,
  ];
  if (rest.length > 0) {
    lines.push(
      "",
      "Also failing — fix these in the same pass:",
      ...rest.map((f, i) => `${i + 2}. ${f.errorExcerpt.split("\n")[0]}`),
    );
  }
  if (code) lines.push("", "The code at the failing lines (> marks the line):", code);
  lines.push(
    "",
    "INSTRUCTION: Address the error above in declared scope files and call finish_card when tests pass.",
  );
  return lines.join("\n");
}

function goalText(input: WorkerPromptInput, stepsUsed: number): string {
  const { card } = input;
  const parts = [
    "=== GOAL (RE-INJECTED) ===",
    `Card ${card.id}: ${input.goal ?? card.title}`,
    `Scope files: ${scopeLine(card.scopeFiles)}`,
    `Step: ${stepsUsed}/${card.stepBudget}`,
  ];
  if (input.acceptanceCriteria?.length) {
    parts.push(`Acceptance criteria:\n${renderList(input.acceptanceCriteria)}`);
  }
  if (input.completedWork?.length) {
    parts.push(`Already done this card:\n${renderList(input.completedWork)}`);
  }
  if (input.openTodos?.length) parts.push(`Still to write:\n${renderList(input.openTodos)}`);
  parts.push(
    input.readyToVerify
      ? "Next action: every declared scope file has been written. Do NOT write it again. If the content satisfies the criteria above, call finish_card now; otherwise read the file and correct it."
      : "Next action: emit exactly one tool call now. Call finish_card only once every criterion above holds.",
  );
  return parts.join("\n");
}

interface Built {
  sections: ContextSection[];
  rules: PlaybookRule[];
}

function failureBlob(input: WorkerPromptInput): string {
  return (input.gateFailures ?? []).map((f) => f.errorExcerpt).join("\n");
}

/** What pruning scores lines against: the goal, the criteria and the failure. */
function pruneQuery(input: WorkerPromptInput): string {
  return [
    input.goal ?? input.card.title,
    ...(input.acceptanceCriteria ?? []),
    failureBlob(input),
    input.failureCode ?? "",
  ].join("\n");
}

function buildSections(
  input: WorkerPromptInput,
  turns: TurnHistoryItem[],
  repoMap: string,
  disclosure: SkillDisclosure,
  pinned?: { systemPrompt: string; ruleIds: string[] },
): Built {
  const s: ContextSection[] = [];
  const add = (section: ContextSection): void => {
    if (section.text.trim()) s.push(section);
  };

  // --- system: stable for the whole card ---
  const native = input.nativeToolSchemas !== undefined;
  add({
    id: "laws",
    kind: "laws",
    placement: "system",
    order: 0,
    priority: 100,
    required: true,
    text: native ? `${PROMPT_ZONE_1_SYSTEM}\n\n${NATIVE_TOOLS_NOTE}` : PROMPT_ZONE_1_SYSTEM,
  });
  if (!native) {
    add({
      id: "tools",
      kind: "tools",
      placement: "system",
      order: 1,
      priority: 100,
      required: true,
      text: renderToolInterface(input.tools),
    });
  }
  const all = input.rules ?? [];
  // Which rules make the cut follows their rank; the order they render in
  // does not (by id), so a re-ranking alone never reorders the prefix (C4).
  const cardRules = all
    .filter((r) => !r.errorPattern)
    .slice(0, input.maxRules ?? 8)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const errorRules = all.filter((r) => r.errorPattern).slice(0, input.maxErrorRules ?? 5);
  if (input.conventions?.trim()) {
    add({
      id: "conventions",
      kind: "conventions",
      placement: "system",
      order: 5,
      priority: 50,
      capTokens: 350,
      text: `=== PROJECT CONVENTIONS ===\n${input.conventions.trim()}`,
    });
  }
  if (input.toolIndex?.length) {
    add({
      id: "tool_index",
      kind: "tool_index",
      placement: "system",
      order: 2,
      priority: 100,
      required: true,
      text: renderToolSearchIndex(input.toolIndex),
    });
  }
  const lateRules: PlaybookRule[] = [];
  cardRules.forEach((r, i) => {
    if (pinned && !pinned.ruleIds.includes(r.id)) {
      lateRules.push(r);
      return;
    }
    add({
      id: `rule:${r.id}`,
      kind: "rules",
      placement: "system",
      order: 10 + i,
      priority: 55,
      capTokens: 160,
      factKeys: ruleFactKeys(r),
      text: `- ${r.instruction}`,
    });
  });
  [...(input.skills ?? [])]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .forEach((skill, i) => {
      const mode = skill.disclosure ?? disclosure;
      add({
        id: `skill:${skill.name}`,
        kind: "skills",
        placement: "system",
        order: 40 + i,
        priority: mode === "manifest" ? 52 : 48,
        capTokens: 600,
        text:
          mode === "manifest"
            ? `- ${skill.name}: ${skill.description}`
            : `### Skill: ${skill.name}\n${skill.content}`,
      });
    });
  if (pinned) {
    // The card's pinned system prompt replaces the freshly built one (C4).
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i]?.placement === "system") s.splice(i, 1);
    }
    add({
      id: "pinned_system",
      kind: "pinned_system",
      placement: "system",
      order: 0,
      priority: 100,
      required: true,
      text: pinned.systemPrompt,
    });
  }
  lateRules.forEach((r, i) =>
    add({
      id: `rule:${r.id}`,
      kind: "late_rules",
      placement: "volatile",
      order: 205 + i,
      priority: 55,
      capTokens: 160,
      factKeys: ruleFactKeys(r),
      text: `- ${r.instruction}`,
    }),
  );
  if (input.loadedTools?.length) {
    add({
      id: "loaded_tools",
      kind: "loaded_tools",
      placement: "volatile",
      order: 50,
      priority: 92,
      required: true,
      text: `=== TOOLS LOADED WITH tool_search ===\n${renderToolInterface(input.loadedTools)}`,
    });
  }

  // --- static: stable for the card, extends the cached prefix ---
  if (repoMap) {
    add({
      id: "repo_map",
      kind: "repo_map",
      placement: "static",
      order: 0,
      priority: 10,
      text: `=== ARCHITECTURAL REPO MAP ===\n${repoMap}`,
    });
  }
  if (input.exemplars?.length) {
    const rendered = renderExemplars(input.exemplars);
    if (rendered) {
      add({
        id: "exemplars",
        kind: "exemplars",
        placement: "static",
        order: 5,
        priority: 35,
        capTokens: 450,
        text: `=== WORKED EXAMPLES FROM THIS REPO (same kind of card, passed) ===\n${rendered}`,
      });
    }
  }
  (input.acceptanceTests ?? []).forEach((f, i) =>
    add({
      id: `test:${f.path}`,
      kind: "tests",
      placement: "static",
      order: 10 + i,
      priority: 40,
      minTokens: 300,
      shrink: shrinkFile,
      text: `=== ACCEPTANCE TEST: ${f.path} (shown in full; do not read_file it) ===\n${f.content || "(empty file)"}`,
    }),
  );
  (input.otherFiles ?? []).forEach((f, i) =>
    add({
      id: `file:${f.path}`,
      kind: "other_file",
      placement: "static",
      order: 20 + i,
      priority: 30,
      shrink: pruningShrink(f.path, pruneQuery(input), failureBlob(input)),
      minTokens: 200,
      text: `=== REFERENCE FILE: ${f.path} ===\n${f.content || "(empty file)"}`,
    }),
  );
  if (input.teamNote) {
    add({
      id: "team",
      kind: "team",
      placement: "static",
      order: 30,
      priority: 45,
      capTokens: 300,
      text: `=== YOUR TEAM ===\n${input.teamNote}`,
    });
  }
  if (input.repairPlan) {
    add({
      id: "plan",
      kind: "plan",
      placement: "static",
      order: 31,
      priority: 65,
      capTokens: 900,
      minTokens: 250,
      text: `=== REPAIR PLAN FROM THE PLANNING MODEL ===\nA previous attempt at this card failed. This plan diagnoses why. Follow it unless a rule above or the failure below says otherwise.\n${input.repairPlan}`,
    });
  }
  (input.dossier ?? []).forEach((d, i) =>
    add({
      id: `dossier:${i}`,
      kind: "dossier",
      placement: "static",
      order: 32 + i,
      priority: 62,
      capTokens: 300,
      inferKeys: true,
      text: `=== ${d.label.toUpperCase()} ===\n${d.text}`,
    }),
  );
  const { card } = input;
  add({
    id: "contract",
    kind: "contract",
    placement: "static",
    order: 40,
    priority: 100,
    required: true,
    // No step counter here: it changes every turn and lives in the goal tail.
    text: `=== ACTIVE CARD CONTRACT ===\nCard ID: ${card.id}\nTier: ${card.tier.toUpperCase()}\nTitle: ${card.title}\nDeclared Scope: ${scopeLine(card.scopeFiles)}`,
  });

  // --- volatile: the per-turn tail ---
  (input.lessons ?? []).forEach((lesson, i) =>
    add({
      id: `lesson:${i}`,
      kind: "lessons",
      placement: "volatile",
      order: i,
      priority: 60,
      capTokens: 120,
      inferKeys: true,
      text: `- ${lesson}`,
    }),
  );
  (input.scopeFiles ?? []).forEach((f, i) =>
    add({
      id: `scope:${f.path}`,
      kind: "scope_file",
      placement: "volatile",
      order: 100 + i,
      priority: 90,
      minTokens: 400,
      shrink: pruningShrink(f.path, pruneQuery(input), failureBlob(input)),
      text: `=== SCOPE FILE: ${f.path} (current content; edit it, do not read_file it) ===\n${f.content || "(empty file)"}`,
    }),
  );
  if (input.rungDirective) {
    add({
      id: "rung",
      kind: "rung",
      placement: "volatile",
      order: 200,
      priority: 80,
      capTokens: 200,
      text: `=== REPAIR MODE ===\n${input.rungDirective}`,
    });
  }
  errorRules.forEach((r, i) =>
    add({
      id: `rule:${r.id}`,
      kind: "error_rules",
      placement: "volatile",
      order: 210 + i,
      priority: 57,
      capTokens: 160,
      factKeys: ruleFactKeys(r),
      text: `- ${r.instruction}`,
    }),
  );
  if (turns.length > 0) {
    const older = turns.slice(0, -1);
    const recent = turns.slice(-1);
    if (older.length > 0) {
      add({
        id: "history_old",
        kind: "history_old",
        placement: "volatile",
        order: 300,
        priority: 20,
        minTokens: 60,
        shrink: (text, max) => {
          // Keep the newest lines: drop from the top.
          const lines = text.split("\n");
          while (lines.length > 2 && estimatePromptTokens(lines.join("\n")) > max)
            lines.splice(1, 1);
          const out = lines.join("\n");
          return estimatePromptTokens(out) <= max ? out : undefined;
        },
        text: `=== EARLIER TURNS ===\n${renderTurns(older)}`,
      });
    }
    add({
      id: "history_recent",
      kind: "history_recent",
      placement: "volatile",
      order: 301,
      priority: 70,
      minTokens: 80,
      text: `=== LAST TURN ===\n${renderTurns(recent)}`,
    });
  }
  const failures = input.gateFailures ?? [];
  if (failures.length > 0) {
    add({
      id: "failure",
      kind: "failure",
      placement: "volatile",
      order: 400,
      priority: 95,
      minTokens: 200,
      text: failureText(failures, input.failureCode),
    });
    const remedies = [
      ...new Set(failures.map((f) => f.suggestedAction).filter((a): a is string => !!a)),
    ];
    remedies.forEach((remedy, i) =>
      add({
        id: `remedy:${i}`,
        kind: "remedy",
        placement: "volatile",
        order: 401 + i,
        priority: 75,
        capTokens: 200,
        factKeys: factKeysOf(remedy),
        text: `How to fix${remedies.length > 1 ? ` (${i + 1})` : ""}: ${remedy}`,
      }),
    );
  } else {
    add({
      id: "instruction",
      kind: "failure",
      placement: "volatile",
      order: 400,
      priority: 95,
      required: true,
      text: "INSTRUCTION: Proceed with implementation using available tools. Call finish_card when complete.",
    });
  }
  add({
    id: "goal",
    kind: "goal",
    placement: "volatile",
    order: 1000,
    priority: 100,
    required: true,
    text: goalText(input, card.stepsUsed),
  });
  return { sections: s, rules: [...cardRules, ...errorRules] };
}

/** Render sections, emitting a group header once before each run of a grouped kind. */
function render(sections: ContextSection[]): string {
  const out: string[] = [];
  let previous: SectionKind | undefined;
  for (const section of sections) {
    const header = HEADERS[section.kind];
    if (header && section.kind !== previous) out.push(`${header}\n${section.text}`);
    else if (header) out[out.length - 1] = `${out[out.length - 1]}\n${section.text}`;
    else out.push(section.text);
    previous = section.kind;
  }
  return out.join("\n\n");
}

const CUT_LABELS: Partial<Record<SectionKind, string>> = {
  repo_map: "the repo map",
  history_old: "earlier turns (recall(ref) brings any back)",
  other_file: "reference files",
  tests: "acceptance tests (read_file them if needed)",
  team: "the team note",
  skills: "skills",
  rules: "some rules",
  error_rules: "some rules",
  lessons: "some lessons",
  dossier: "team notes",
  plan: "part of the repair plan",
  scope_file: "part of a scope file (read_file with a line range)",
};

/** Recent input-hash -> output-hash pairs, for the runtime determinism check (C15). */
const seenBuilds = new Map<string, string>();

function inputKey(input: WorkerPromptInput, pinnedHash: string | undefined): string {
  const { evidenceStore: _e, prefixGuard: _g, ...rest } = input;
  return createHash("sha256")
    .update(JSON.stringify(rest))
    .update(pinnedHash ?? "")
    .digest("hex");
}

export function buildWorkerPrompt(input: WorkerPromptInput): WorkerPromptResult {
  const thresholds = input.thresholds ?? DEFAULT_PRESSURE_THRESHOLDS;
  const overhead =
    input.nativeToolSchemas !== undefined
      ? estimatePromptTokens(JSON.stringify(input.nativeToolSchemas))
      : 0;
  const budget = input.budgetTokens;
  const store = input.evidenceStore ? { evidenceStore: input.evidenceStore } : {};
  const cardId = { cardId: input.card.id };
  const guard = input.prefixGuard;
  const pin = guard?.pinned(input.card.id);
  const version = computeContextVersion({
    tools: [...(input.toolIndex ?? []), ...input.tools],
    rules: input.rules ?? [],
    ...(input.conventions ? { templates: [input.conventions] } : {}),
  });

  // Nominal history: compact long histories, mask all but the last two.
  const raw = input.turns ?? [];
  const compacted = raw.length > 8 ? compactHistory(raw, 6, { ...store, ...cardId }).turns : raw;
  const nominalTurns = maskOlderObservations(compacted, 2, { ...store, ...cardId });
  const repoMapIn = input.repoMap ?? "";
  // With a pin, the disclosure in force when the card started stays (C4).
  const pinnedDisclosure = pin?.disclosure ?? input.skillDisclosure;
  const pinned = pin ? { systemPrompt: pin.systemPrompt, ruleIds: pin.ruleIds } : undefined;

  const measure = (b: Built): number =>
    overhead + b.sections.reduce((a, s) => a + estimatePromptTokens(s.text) + 1, 0);

  let disclosureUsed: SkillDisclosure = pinnedDisclosure ?? "full";
  let turnsUsed = nominalTurns;
  let built = buildSections(input, nominalTurns, repoMapIn, disclosureUsed, pinned);
  const pressure = assessContextPressure(
    measure(built),
    budget ?? Number.POSITIVE_INFINITY,
    thresholds,
  );

  // Tiered strategies (C7) before any section is cut.
  if (budget !== undefined && pressure.tier !== "nominal") {
    const applied = applyContextPressure(
      { turns: compacted, repoMap: repoMapIn, ...store, ...cardId },
      pressure,
    );
    disclosureUsed = pinnedDisclosure ?? (applied.skillBodiesDropped ? "manifest" : "full");
    turnsUsed = applied.turns;
    built = buildSections(input, applied.turns, applied.repoMap, disclosureUsed, pinned);
  }

  // Leave room for the line that names what was cut.
  const notice = 60;
  const allocation =
    budget === undefined
      ? allocateContext(built.sections, {
          budgetTokens: Number.POSITIVE_INFINITY,
          overheadTokens: overhead,
        })
      : allocateContext(built.sections, {
          budgetTokens: Math.floor(budget * thresholds.hardStop) - notice,
          overheadTokens: overhead,
        });

  const cutKinds = [
    ...new Set(
      allocation.events
        .filter((e) => e.action === "dropped" || e.action === "shrunk")
        .map((e) => e.kind),
    ),
  ];
  const sections = [...allocation.sections];
  const labels = [...new Set(cutKinds.map((k) => CUT_LABELS[k]).filter((l): l is string => !!l))];
  if (labels.length > 0) {
    const goalAt = sections.findIndex((x) => x.id === "goal");
    sections.splice(goalAt < 0 ? sections.length : goalAt, 0, {
      id: "notice",
      kind: "notice",
      placement: "volatile",
      order: 999,
      priority: 100,
      text: `(Context was cut to fit the window: ${labels.join("; ")}.)`,
    });
  }

  const systemPrompt = render(sections.filter((x) => x.placement === "system"));
  const staticPart = render(sections.filter((x) => x.placement === "static"));
  const volatilePart = render(sections.filter((x) => x.placement === "volatile"));
  const prompt = [staticPart, volatilePart].filter(Boolean).join("\n\n");
  const kept = new Set(sections.map((x) => x.id));
  const stop = budget !== undefined && !allocation.fits;
  const prefixHash = computePrefixHash(systemPrompt);
  const staticPrefixHash = computePrefixHash(`${systemPrompt}\n\n${staticPart}`);

  // Pin on the first build; observe every build (C4).
  let prefixStable: boolean | undefined;
  if (guard) {
    if (!pin) {
      guard.pin({
        cardId: input.card.id,
        systemPrompt,
        prefixHash,
        ruleIds: built.rules
          .filter((r) => kept.has(`rule:${r.id}`) && !r.errorPattern)
          .map((r) => r.id),
        disclosure: disclosureUsed,
        versionHash: version.version,
      });
    }
    prefixStable = guard.observe(input.card.id, prefixHash);
  }

  // Runtime determinism (C15): the same inputs must give the same bytes.
  const key = inputKey(input, pin?.prefixHash);
  const outHash = createHash("sha256")
    .update(systemPrompt)
    .update("\u0000")
    .update(prompt)
    .digest("hex");
  const previous = seenBuilds.get(key);
  const deterministic = previous === undefined || previous === outHash;
  if (!deterministic) {
    process.stderr.write(
      `[context] nondeterministic prompt for card ${input.card.id}: identical inputs produced different bytes\n`,
    );
  }
  seenBuilds.set(key, outHash);
  if (seenBuilds.size > 512) seenBuilds.delete(seenBuilds.keys().next().value as string);

  const zoneTokens = {
    system: estimatePromptTokens(systemPrompt),
    static: estimatePromptTokens(staticPart),
    volatile: estimatePromptTokens(volatilePart),
    toolSchemas: overhead,
  };
  const step = input.card.stepsUsed;
  const pack: ContextPackRecord = {
    id: `ctx_${createHash("sha256").update(`${input.card.id}:${step}:${outHash}`).digest("hex").slice(0, 16)}`,
    cardId: input.card.id,
    step,
    zoneTokens,
    prefixHash,
    staticPrefixHash,
    version: version.version,
    tier: pressure.tier,
    cut: cutKinds,
  };
  const rulesUsed = built.rules.filter((r) => kept.has(`rule:${r.id}`)).map((r) => r.id);
  const pinnedRules = pin?.ruleIds ?? [];
  const allRulesUsed = [
    ...new Set([
      ...rulesUsed,
      ...pinnedRules.filter((id) => (input.rules ?? []).some((r) => r.id === id)),
    ]),
  ];
  const metrics: ContextStepMetrics = {
    step,
    usedTokens: allocation.usedTokens,
    budgetTokens: budget,
    utilization:
      budget !== undefined && budget > 0
        ? Math.round((allocation.usedTokens / budget) * 1000) / 1000
        : undefined,
    tier: pressure.tier,
    maskedObservations: turnsUsed.filter((t) => t.result.includes("EvidenceRef:")).length,
    compactedTurns: raw.length > 8 ? raw.length - 6 : 0,
    sectionsCut: allocation.events.filter((e) => e.action === "dropped").length,
    rulesInPrompt: allRulesUsed.length,
    prefixStable,
  };

  return {
    systemPrompt,
    prompt,
    prefixHash,
    staticPrefixHash,
    tier: pressure.tier,
    pressure,
    events: allocation.events,
    usedTokens: allocation.usedTokens,
    budgetTokens: budget,
    stop,
    ...(stop ? { stopReason: "budget_exhausted" as const } : {}),
    rulesUsed: allRulesUsed,
    cut: cutKinds,
    pack,
    versionHash: version.version,
    metrics,
    deterministic,
  };
}

/**
 * Build twice and compare (C15): the explicit determinism assertion for
 * tests and `sekhemet doctor`. Throws when the bytes differ.
 */
export function assertPromptDeterminism(input: WorkerPromptInput): WorkerPromptResult {
  const { prefixGuard: _g, ...rest } = input;
  const a = buildWorkerPrompt(rest);
  const b = buildWorkerPrompt(rest);
  if (a.systemPrompt !== b.systemPrompt || a.prompt !== b.prompt) {
    throw new Error(`Prompt assembly is nondeterministic for card ${input.card.id}`);
  }
  return a;
}

/** Split matched rules the way `buildWorkerPrompt` places them. */
export function splitRulesByScope(rules: PlaybookRule[]): {
  card: PlaybookRule[];
  error: PlaybookRule[];
} {
  return { card: rules.filter((r) => !r.errorPattern), error: rules.filter((r) => r.errorPattern) };
}
