import type { GateFailure } from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import type { SkillManifest } from "./skills.js";
import { estimateTokens } from "./tokens.js";
import { type ToolInterfaceSpec, renderToolInterface } from "./tool_interface.js";
import {
  type ZoneBudgetReport,
  assertNoBannedPlaceholders,
  assertSystemZoneBudget,
  computePrefixHash,
} from "./zones.js";

export const PROMPT_ZONE_1_SYSTEM = `=== SEKHEMET LOCAL CODING EXECUTOR ===
You are the Sekhemet autonomous coding agent running locally on open-weights models.
You operate on single-task kanban cards with deterministic executable verification gates.

NON-NEGOTIABLE LAWS:
1. SCOPE DISCIPLINE: Touch ONLY declared scope files. Never exceed 200 diff lines across 1-3 files.
2. CONTRACT-FIRST TDD: Acceptance tests are written first and fail before code is written. NEVER modify test assertions to make tests pass.
3. DETERMINISTIC REPAIR: When a gate fails, read the typed GateFailure excerpt and apply targeted surgical fixes. Do not hallucinate or guess.
4. ACTIONS OVER CHAT: Output concrete tool calls immediately. Do not produce conversational fluff.
5. LITERAL OUTPUT: Emit real file paths, real symbol names and real code. Never echo a template marker back.`;

export interface TurnHistoryItem {
  turn: number;
  action: string;
  result: string;
}

/**
 * How much of a matched skill reaches Zone 2. `manifest` is the progressive
 * disclosure default under context pressure: one line per skill instead of the
 * full body (§1426-1436).
 */
export type SkillDisclosure = "full" | "manifest";

export interface PromptPackOptions {
  card: CardRecord;
  repoMap?: string;
  /**
   * Files shown in full: the card's acceptance tests and its scope files.
   *
   * Measured on Chronicle, the agent spent its first two to four turns on
   * read_file for exactly these. Supplying them up front removes those turns,
   * and turn count, not decode speed, is what dominates wall clock.
   */
  pinnedFiles?: { path: string; content: string; label: string }[];
  /** Repair plan from the manager model after an earlier failed attempt. */
  managerGuidance?: string;
  activeSkills?: SkillManifest[];
  playbookRules?: string[];
  recentTurns?: TurnHistoryItem[];
  gateFailure?: GateFailure;
  /** Further failures from the same verification, rendered after the first. */
  otherGateFailures?: GateFailure[];
  /** Tool interface rendered into Zone 1 so the model knows what it may call. */
  tools?: ToolInterfaceSpec[];
  /** Overrides the card title as the restated goal. */
  goal?: string;
  acceptanceCriteria?: string[];
  openTodos?: string[];
  /** Files already written during this card, so the agent knows what it has done. */
  completedWork?: string[];
  /**
   * Every declared scope file has been written.
   *
   * Without this the agent has no signal that it is finished and simply rewrites
   * the same file until the oscillation breaker trips — observed against a real
   * local model, which produced a correct file ten times in a row.
   */
  readyToVerify?: boolean;
  skillDisclosure?: SkillDisclosure;
  /** Number of verbatim turns rendered in Zone 4. */
  maxRecentTurns?: number;
}

export interface PromptZoneReport {
  system: ZoneBudgetReport;
  toolInterfaceTokens: number;
  conventionsTokens: number;
  repoMapTokens: number;
  volatileTokens: number;
  totalTokens: number;
}

export interface BuiltPromptPack {
  systemPrompt: string;
  prompt: string;
  /** sha256 of the byte-stable prefix (Zones 1 + 2). */
  prefixHash: string;
  /** The Zone 1 tool interface block, empty when no tools were supplied. */
  toolInterface: string;
  zones: PromptZoneReport;
}

const DEFAULT_RECENT_TURNS = 3;

function renderList(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

function renderScope(scopeFiles: string[]): string {
  return scopeFiles.length > 0 ? scopeFiles.join(", ") : "unrestricted (max 3 files)";
}

function renderSkill(skill: SkillManifest, disclosure: SkillDisclosure): string {
  if (disclosure === "manifest") {
    return `- ${skill.name}: ${skill.description}`;
  }
  return `### Skill: ${skill.name}\n${skill.content}`;
}

/**
 * Goal re-injection (Design §420, §466).
 *
 * "The card goal, acceptance criteria, and open TODOs are restated at the tail
 * of every step, where attention is strongest (countering 'lost in the
 * middle')." Placement is the mechanism: this block is always last, after the
 * observations and after the gate failure.
 */
function buildGoalTail(options: PromptPackOptions): string {
  const { card } = options;
  const goal = options.goal ?? card.title;
  const parts: string[] = [
    "=== GOAL (RE-INJECTED) ===",
    `Card ${card.id}: ${goal}`,
    `Scope files: ${renderScope(card.scopeFiles)}`,
  ];

  const criteria = options.acceptanceCriteria ?? [];
  if (criteria.length > 0) {
    parts.push(`Acceptance criteria:\n${renderList(criteria)}`);
  }

  const completed = options.completedWork ?? [];
  if (completed.length > 0) {
    parts.push(`Already written this card:\n${renderList(completed)}`);
  }

  const todos = options.openTodos ?? [];
  if (todos.length > 0) {
    parts.push(`Still to write:\n${renderList(todos)}`);
  }

  parts.push(
    options.readyToVerify
      ? "Next action: every declared scope file has been written. Do NOT write it again. If the content satisfies the criteria above, call finish_card now; otherwise read the file and correct it."
      : "Next action: emit exactly one tool call now. Call finish_card only once every criterion above holds.",
  );

  return parts.join("\n");
}

/**
 * Assembles the four-zone prompt.
 *
 *   Zone 1 (prefix) — system laws plus the tool interface. Byte-stable for the
 *                     life of a prompt version; budgeted under 1,000 / 2,000
 *                     tokens and asserted here.
 *   Zone 2 (prefix) — playbook rules and skills, sorted for determinism, so the
 *                     cache prefix survives a whole card.
 *   Zone 3          — repo map slice.
 *   Zone 4          — card contract, observations, gate failure, and the
 *                     re-injected goal at the very tail.
 */
export function buildFullPromptPack(options: PromptPackOptions): BuiltPromptPack {
  const {
    card,
    repoMap = "",
    activeSkills = [],
    playbookRules = [],
    recentTurns = [],
    gateFailure,
    otherGateFailures,
    tools = [],
    skillDisclosure = "full",
    maxRecentTurns = DEFAULT_RECENT_TURNS,
  } = options;

  // --- ZONE 1: SYSTEM LAWS + TOOL INTERFACE (byte-stable within a version) ---
  const toolInterface = renderToolInterface(tools);
  const zone1 = toolInterface
    ? `${PROMPT_ZONE_1_SYSTEM}\n\n${toolInterface}`
    : PROMPT_ZONE_1_SYSTEM;
  assertNoBannedPlaceholders(PROMPT_ZONE_1_SYSTEM, "Zone 1 system prompt");
  const systemReport = assertSystemZoneBudget(PROMPT_ZONE_1_SYSTEM);

  // --- ZONE 2: CONVENTIONS (changes at card boundaries only) ---
  const zone2Parts: string[] = [];

  if (playbookRules.length > 0) {
    zone2Parts.push("=== PROJECT PLAYBOOK RULES ===");
    for (const rule of [...playbookRules].sort()) {
      zone2Parts.push(`- ${rule}`);
    }
  }

  if (activeSkills.length > 0) {
    // Sorted by name: skill order must never depend on readdirSync order,
    // or the cache prefix differs between machines (C15).
    const sortedSkills = [...activeSkills].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    zone2Parts.push("=== ACTIVE LOADED SKILLS ===");
    for (const skill of sortedSkills) {
      zone2Parts.push(renderSkill(skill, skillDisclosure));
    }
  }

  const zone2 = zone2Parts.join("\n\n");
  const systemPrompt = `${zone1}\n\n${zone2}`.trim();

  // --- ZONE 3 & 4: VOLATILE USER PROMPT ---
  const userParts: string[] = [];

  // Zone 3: Architectural Repo Map
  if (repoMap) {
    userParts.push(`=== ARCHITECTURAL REPO MAP ===\n${repoMap}`);
  }

  // Zone 3b: pinned files. Acceptance tests are immutable, so placing them
  // ahead of the per-turn content keeps them inside the cacheable prefix.
  for (const file of options.pinnedFiles ?? []) {
    userParts.push(
      `=== ${file.label.toUpperCase()}: ${file.path} (shown in full; do not read_file it) ===\n${file.content || "(empty file)"}`,
    );
  }

  if (options.managerGuidance) {
    userParts.push(
      `=== REPAIR PLAN FROM THE PLANNING MODEL ===\nA previous attempt at this card failed. This plan diagnoses why. Follow it exactly.\n${options.managerGuidance}`,
    );
  }

  // Zone 4: Card Contract & Scope
  const cardContract = `=== ACTIVE CARD CONTRACT ===
Card ID: ${card.id}
Tier: ${card.tier.toUpperCase()}
Title: ${card.title}
Declared Scope: ${renderScope(card.scopeFiles)}
Step: ${card.stepsUsed}/${card.stepBudget}`;
  userParts.push(cardContract);

  // Zone 4: Recent Turns & Gate Failures
  if (recentTurns.length > 0) {
    const turnsText = recentTurns
      .slice(-maxRecentTurns)
      .map((t) => `Turn ${t.turn}: ${t.action} -> ${t.result}`)
      .join("\n");
    userParts.push(`=== RECENT EXECUTION TURNS ===\n${turnsText}`);
  }

  if (gateFailure) {
    const failureText = `=== LAST GATE FAILURE ===
Gate Rung: ${gateFailure.rung} (Exit code: ${gateFailure.exitCode})
Suggested Fix Files: ${renderScope(gateFailure.suggestedFixFiles)}
Error Excerpt:
${gateFailure.errorExcerpt}${gateFailure.suggestedAction ? `\nHow to fix: ${gateFailure.suggestedAction}` : ""}${
  otherGateFailures && otherGateFailures.length > 0
    ? `\n\nAlso failing — fix these in the same pass:\n${otherGateFailures
        .map(
          (f, i) =>
            `${i + 2}. ${f.errorExcerpt.split("\n")[0]}${f.suggestedAction ? `\n   How to fix: ${f.suggestedAction}` : ""}`,
        )
        .join("\n")}`
    : ""
}

INSTRUCTION: Address the error above in declared scope files and call finish_card when tests pass.`;
    userParts.push(failureText);
  } else {
    userParts.push(
      "INSTRUCTION: Proceed with implementation using available tools. Call finish_card when complete.",
    );
  }

  // Tail placement is the mechanism, not decoration: the goal goes last.
  userParts.push(buildGoalTail(options));

  const prompt = userParts.join("\n\n");

  const zones: PromptZoneReport = {
    system: systemReport,
    toolInterfaceTokens: estimateTokens(toolInterface),
    conventionsTokens: estimateTokens(zone2),
    repoMapTokens: estimateTokens(repoMap),
    volatileTokens: estimateTokens(prompt) - estimateTokens(repoMap),
    totalTokens: estimateTokens(systemPrompt) + estimateTokens(prompt),
  };

  return {
    systemPrompt,
    prompt,
    prefixHash: computePrefixHash(systemPrompt),
    toolInterface,
    zones,
  };
}
