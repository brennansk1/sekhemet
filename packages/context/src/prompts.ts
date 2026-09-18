import type { GateFailure } from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import type { SkillManifest } from "./skills.js";

export const PROMPT_ZONE_1_SYSTEM = `=== SEKHEMET LOCAL CODING EXECUTOR ===
You are the Sekhemet autonomous coding agent running locally on open-weights models.
You operate on single-task kanban cards with deterministic executable verification gates.

NON-NEGOTIABLE LAWS:
1. SCOPE DISCIPLINE: Touch ONLY declared scope files. Never exceed 200 diff lines across 1-3 files.
2. CONTRACT-FIRST TDD: Acceptance tests are written first and fail before code is written. NEVER modify test assertions to make tests pass.
3. DETERMINISTIC REPAIR: When a gate fails, read the typed GateFailure excerpt and apply targeted surgical fixes. Do not hallucinate or guess.
4. ACTIONS OVER CHAT: Output concrete tool calls immediately. Do not produce conversational fluff.`;

export interface TurnHistoryItem {
  turn: number;
  action: string;
  result: string;
}

export interface PromptPackOptions {
  card: CardRecord;
  repoMap?: string;
  activeSkills?: SkillManifest[];
  playbookRules?: string[];
  recentTurns?: TurnHistoryItem[];
  gateFailure?: GateFailure;
}

export interface BuiltPromptPack {
  systemPrompt: string;
  prompt: string;
}

export function buildFullPromptPack(options: PromptPackOptions): BuiltPromptPack {
  const {
    card,
    repoMap = "",
    activeSkills = [],
    playbookRules = [],
    recentTurns = [],
    gateFailure,
  } = options;

  // --- ZONE 1 & 2: SYSTEM PROMPT (Byte-stable cache prefix) ---
  const zone2Parts: string[] = [];

  if (playbookRules.length > 0) {
    zone2Parts.push("=== PROJECT PLAYBOOK RULES ===");
    for (const rule of playbookRules) {
      zone2Parts.push(`- ${rule}`);
    }
  }

  if (activeSkills.length > 0) {
    zone2Parts.push("=== ACTIVE LOADED SKILLS ===");
    for (const skill of activeSkills) {
      zone2Parts.push(`### Skill: ${skill.name}\n${skill.content}`);
    }
  }

  const systemPrompt = `${PROMPT_ZONE_1_SYSTEM}\n\n${zone2Parts.join("\n\n")}`.trim();

  // --- ZONE 3, 4, 5: USER PROMPT ---
  const userParts: string[] = [];

  // Zone 3: Architectural Repo Map
  if (repoMap) {
    userParts.push(`=== ARCHITECTURAL REPO MAP ===\n${repoMap}`);
  }

  // Zone 4: Card Contract & Scope
  const cardContract = `=== ACTIVE CARD CONTRACT ===
Card ID: ${card.id}
Tier: ${card.tier.toUpperCase()}
Title: ${card.title}
Declared Scope: [${card.scopeFiles.join(", ") || "unrestricted (max 3 files)"}]
Step: ${card.stepsUsed}/${card.stepBudget}`;
  userParts.push(cardContract);

  // Zone 5: Recent Turns & Gate Failures
  if (recentTurns.length > 0) {
    const turnsText = recentTurns
      .slice(-3)
      .map((t) => `Turn ${t.turn}: ${t.action} -> ${t.result}`)
      .join("\n");
    userParts.push(`=== RECENT EXECUTION TURNS ===\n${turnsText}`);
  }

  if (gateFailure) {
    const failureText = `=== LAST GATE FAILURE ===
Gate Rung: ${gateFailure.rung} (Exit code: ${gateFailure.exitCode})
Suggested Fix Files: [${gateFailure.suggestedFixFiles.join(", ")}]
Error Excerpt:
${gateFailure.errorExcerpt}

INSTRUCTION: Address the error above in declared scope files and call finish_card when tests pass.`;
    userParts.push(failureText);
  } else {
    userParts.push(
      "INSTRUCTION: Proceed with implementation using available tools. Call finish_card when complete.",
    );
  }

  const prompt = userParts.join("\n\n");

  return {
    systemPrompt,
    prompt,
  };
}
