import { type PlaybookRule, errorPatternMatches, factKeysOf, keysCovered } from "@sekhemet/context";
import type { AttemptFinished } from "@sekhemet/eval";
import { remedyFor } from "@sekhemet/gates";
import {
  type AttemptOutcome,
  CARD_KINDS,
  type CardClassInput,
  type CardKind,
  type RunLedger,
  cardKind,
} from "@sekhemet/kernel";
import type { LearnedRule, RuleScope } from "./store.js";

/**
 * Exact scoping, one curator and fair credit for learned rules (context rule
 * 24b-24e, NEW-context-4). Pure functions; `LearningStore` applies them.
 */

// --- CX-N4-1: nothing that would reach every prompt ---------------------------

/** Path patterns that match every path of any project (rule 24b's `src/`). */
const MATCH_ALL = new Set(["", "/", ".", "./", "*", "**", "**/*", "src", "src/", "./src/"]);

/** Why a scope would put a rule in every prompt (CX-N4-1). */
export type ScopeRefusalCode = "empty_scope" | "empty_field" | "match_all" | "every_project_file";

/** A refusal, naming the field and pattern that caused it. */
export interface ScopeRefusal {
  code: ScopeRefusalCode;
  field?: keyof RuleScope;
  pattern?: string;
}

/**
 * Why a rule's scope would put it in every prompt, naming the pattern; or
 * undefined when the scope is narrow enough to write. `projectFiles`, when
 * known, catches a pattern every file of this project contains. Structural,
 * so the refusal is a ledger fact, not prose.
 */
export function scopeRefusal(
  scope: RuleScope,
  projectFiles?: readonly string[],
): ScopeRefusal | undefined {
  const declared = Object.entries(scope).filter(([, v]) => v !== undefined) as [
    keyof RuleScope,
    string,
  ][];
  if (declared.length === 0) return { code: "empty_scope" };
  for (const [field, value] of declared) {
    if (value.trim() === "") return { code: "empty_field", field, pattern: value };
  }
  const pattern = scope.pathPattern;
  if (pattern === undefined) return undefined;
  if (MATCH_ALL.has(pattern.trim())) return { code: "match_all", field: "pathPattern", pattern };
  if (projectFiles && projectFiles.length > 0 && projectFiles.every((f) => f.includes(pattern))) {
    return { code: "every_project_file", field: "pathPattern", pattern };
  }
  return undefined;
}

// --- CX-N4-2: AND scoping, the kind from cardKind -----------------------------

const LEGACY_KIND: Record<string, CardKind> = {
  s: "spike",
  p: "implement",
  path: "implement",
  i: "interface",
  d: "data",
  r: "rule",
};

/** A rule's declared kind as a `CardKind`; a SPIDR word from an older rule is read too. */
export function normalizeKind(kind: string): string {
  const k = kind.trim().toLowerCase();
  if ((CARD_KINDS as readonly string[]).includes(k)) return k;
  return LEGACY_KIND[k] ?? k;
}

export interface ScopedCard extends CardClassInput {
  scopeFiles: string[];
}

/**
 * The card-boundary half of the AND: kind (from `cardKind`) and path. The
 * error pattern and trigger gate are the step-time half, applied by the
 * playbook while that error and gate stand (`playbookRuleOf`).
 */
export function matchesCard(scope: RuleScope, card: ScopedCard): boolean {
  if (scope.kind !== undefined && normalizeKind(scope.kind) !== cardKind(card)) return false;
  if (scope.pathPattern !== undefined) {
    const p = scope.pathPattern;
    if (!card.scopeFiles.some((f) => f.includes(p))) return false;
  }
  return true;
}

/**
 * The learned rule as the card's playbook carries it in memory (rule 24a):
 * its pattern is the card's own title (already matched at the boundary), and
 * its error pattern and trigger gate stay scopes, so it rides in the prompt
 * only while both stand.
 */
export function playbookRuleOf(
  rule: Pick<LearnedRule, "id" | "text" | "scope">,
  cardTitle: string,
): PlaybookRule {
  return {
    id: rule.id,
    pattern: cardTitle,
    instruction: rule.text,
    ...(rule.scope.errorPattern ? { errorPattern: rule.scope.errorPattern } : {}),
    ...(rule.scope.triggerGate ? { requiresGate: rule.scope.triggerGate } : {}),
  };
}

// --- CX-N4-3: a defined tie-break ---------------------------------------------

/** The most recent evidence of a rule: its latest dated item, else its creation. */
export function evidenceAt(rule: LearnedRule): string {
  return rule.evidence.reduce((a, e) => (e.at && e.at > a ? e.at : a), rule.createdAt ?? "");
}

/**
 * Rules in the order a prompt takes them: those matching the current error
 * code first, then by value, then by most recent evidence, then by id —
 * never by ledger order, so the same inputs give the same eight.
 */
export function rankRules(
  rules: readonly LearnedRule[],
  context: { errorCode?: string },
): LearnedRule[] {
  const code = context.errorCode;
  const onError = (r: LearnedRule) =>
    code !== undefined &&
    r.scope.errorPattern !== undefined &&
    errorPatternMatches(r.scope.errorPattern, code)
      ? 1
      : 0;
  return [...rules].sort((a, b) => {
    const e = onError(b) - onError(a);
    if (e !== 0) return e;
    if (a.value !== b.value) return b.value - a.value;
    const at = evidenceAt(b).localeCompare(evidenceAt(a));
    if (at !== 0) return at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * The error code standing on the card at its boundary: the first code in the
 * failing gates of its last attempt, none when that attempt's last gate
 * result passed or it never ran. Rules matching it are taken first (CX-N4-3).
 */
export function standingErrorCode(
  runs: Pick<RunLedger, "listAttempts" | "listGateResults">,
  cardId: string,
): string | undefined {
  const last = runs.listAttempts(cardId).at(-1);
  if (!last) return undefined;
  const results = runs.listGateResults(last.id);
  if (results.length === 0 || results.at(-1)?.passed) return undefined;
  for (const r of results.filter((g) => !g.passed)) {
    for (const f of r.failures as { errorExcerpt?: unknown; code?: unknown }[]) {
      const text = `${typeof f.code === "string" ? f.code : ""} ${typeof f.errorExcerpt === "string" ? f.errorExcerpt : ""}`;
      const code = /\b(TS\d{4,5}|lint\/[\w/]+)\b/.exec(text)?.[1];
      if (code) return code;
    }
  }
  return undefined;
}

// --- CX-N4-4: one key per fact ------------------------------------------------

/** What a rule is about: the fact keys of its text and of its error pattern. */
export function ruleKeys(rule: { text: string; scope: RuleScope }): string[] {
  return factKeysOf(`${rule.text} ${rule.scope.errorPattern ?? ""}`);
}

/** Constraint keys whose every code has a gate remedy (`remedyFor`). */
const REMEDIED_CONSTRAINTS = new Set(["exactOptionalPropertyTypes", "noUncheckedIndexedAccess"]);

/** True when a gate's remedy already states every fact the keys name. */
export function remedyCovers(keys: readonly string[]): boolean {
  return (
    keys.length > 0 &&
    keys.every((k) => REMEDIED_CONSTRAINTS.has(k) || remedyFor(k, "") !== undefined)
  );
}

/** The existing rule already holding every key, if any. */
export function keyHolder(
  keys: readonly string[],
  rules: readonly LearnedRule[],
): LearnedRule | undefined {
  if (keys.length === 0) return undefined;
  return rules.find((r) => keysCovered(keys, new Set(ruleKeys(r))));
}

// --- CX-N4-6: rotation and credit ---------------------------------------------

/** The ledger event recording, on a card's first attempt, which rules were in or withheld. */
export const ROTATION_EVENT = "learn/rotation";

export interface RotationRecord {
  cardId: string;
  projectId: string;
  cardClass: string;
  with: string[];
  withheld: string[];
}

/**
 * The records rule credit reads (MS-T8-14): each first attempt's outcome from
 * the attempt record, with the rules its rotation withheld. The rules "with"
 * are those that reached the attempt's prompt.
 */
export function creditRecords(
  outcomes: readonly AttemptOutcome[],
  rotations: readonly RotationRecord[],
): AttemptFinished[] {
  const byCard = new Map<string, RotationRecord>();
  for (const r of rotations) if (!byCard.has(r.cardId)) byCard.set(r.cardId, r);
  return outcomes
    .filter((o) => o.attemptNumber === 1)
    .map((o) => {
      const rot = byCard.get(o.cardId);
      return {
        cardId: o.cardId,
        projectId: o.projectId ?? rot?.projectId ?? "",
        cardClass: o.cardClass ?? rot?.cardClass ?? "",
        attemptNumber: o.attemptNumber,
        builtBy: o.builtBy.kind,
        stopReason: o.stopReason,
        rules: o.ruleIds,
        withheldRules: rot?.withheld ?? [],
      };
    });
}
