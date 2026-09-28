import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type RuleCredit, ruleCredit } from "@sekhemet/eval";
import type { AttemptOutcome, EventLog, LifecycleHookEngine } from "@sekhemet/kernel";
import { userPaths } from "../user_dir.js";
import {
  ROTATION_EVENT,
  type RotationRecord,
  type ScopedCard,
  creditRecords,
  keyHolder,
  matchesCard,
  rankRules,
  remedyCovers,
  ruleKeys,
  scopeRefusal,
} from "./scoping.js";

/**
 * What Sekhemet has learned: playbook rules for the Worker and Seshat, and a
 * profile of the user. Docs: PM_CONTRACT §6.
 *
 * Two scopes, because the user asked the Worker to learn "both for the project
 * itself and across projects":
 * - project: ledger events in this repo, so they travel with its history and
 *   the hash chain covers them;
 * - global: a JSON file in the user's config directory, consulted by every
 *   project. A rule is promoted to global only when a human says so.
 */

export type RuleRole = "worker" | "manager";
export type RuleStatus = "candidate" | "active" | "retired";
export type RuleSource = "struggle" | "send_back" | "reflection" | "seed" | "research";

/**
 * Where a rule applies (context rule 24b): every declared field must match,
 * AND, never OR. `kind` is a `CardKind` (a SPIDR word on an older rule is
 * read as one); `triggerGate` is the failing gate's rung as the loop names it.
 */
export interface RuleScope {
  kind?: string;
  pathPattern?: string;
  errorPattern?: string;
  triggerGate?: string;
}

/** At most this many rules reach one prompt (context rule 24). */
export const RULES_PER_PROMPT = 8;

export interface LearnedRule {
  id: string;
  role: RuleRole;
  text: string;
  scope: RuleScope;
  reach: "project" | "global";
  status: RuleStatus;
  helpful: number;
  harmful: number;
  /** Erev-Roth recency-weighted value: v <- (1 - 0.1) v + reward. */
  value: number;
  source: RuleSource;
  evidence: RuleEvidence[];
  createdAt: string;
  /** Similar existing rules at the time it was added, for consolidation. */
  related?: string[];
}

/**
 * One signal behind a rule, tagged with where it came from and how it was
 * verified (measurement MS-T8-9): `execution` (a gate failed and later
 * passed), `person` (someone wrote it), `none` (a model's synthesis). An
 * untagged item predates the tags.
 */
export interface RuleEvidence {
  cardId?: string;
  note: string;
  source?: string;
  verified?: "execution" | "person" | "none";
  /** When the signal was recorded (the tie-break's "most recent evidence", CX-N4-3). */
  at?: string;
}

export type ProfileCategory = "code_style" | "planning" | "communication" | "priorities";

/**
 * Where a profile statement applies, and how fast it fades (planner-pm
 * §2.13.3, PM-P6-15): its reach — this project or all projects — narrowed to
 * a repository or a card kind, and the Erev–Roth forgetting rate it records,
 * the share of its strength lost per week without new evidence.
 */
export interface ProfileScope {
  reach: "project" | "all";
  repository?: string;
  kind?: string;
  decayPerWeek: number;
}

/**
 * A statement's scope when it records none: this project, fading by the
 * forgetting rate of PM_CONTRACT §6's rule value (0.1), applied per week.
 */
export const DEFAULT_PROFILE_SCOPE: ProfileScope = { reach: "project", decayPerWeek: 0.1 };

/** Below this strength a statement is not used until new evidence raises it (PM-P6-15). */
export const PROFILE_IN_FORCE = 0.2;

export interface ProfileEntry {
  id: string;
  statement: string;
  category: ProfileCategory;
  /**
   * 0..1. As `profile()` returns it, the strength now: the strength recorded
   * at the last evidence, decayed by the scope's rate for each week since.
   */
  strength: number;
  /** The strength as recorded at the last evidence, before decay (read-only view). */
  recordedStrength?: number;
  evidence: { note: string; at: string }[];
  status: "active" | "dismissed";
  source: "send_back" | "proposal_choices" | "edits" | "reflection";
  /** Where it applies and how fast it fades; `DEFAULT_PROFILE_SCOPE` when absent. */
  scope?: ProfileScope;
}

const DECAY = 0.1;

const STOP = new Set(
  "a an the and or of to in on for with is are be it this that use do not never always when your you its by as at from".split(
    " ",
  ),
);
const words = (t: string) =>
  new Set(
    t
      .toLowerCase()
      .replace(/[^a-z0-9_:.]+/g, " ")
      .split(" ")
      .map((w) => w.replace(/^[.:]+|[.:]+$/g, ""))
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );

/**
 * Lexical similarity (Jaccard over content words). Mem0 compares a new
 * memory with its top-k most similar existing ones before deciding what to
 * do; embeddings would need a model call per memory, and at this scale word
 * overlap separates near-duplicates from new facts well enough.
 */
export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}
const EVENTS = {
  rule: "learn/rule",
  /** Read from older ledgers only: credit now comes from the attempt record (rule 24e). */
  ruleOutcome: "learn/rule_outcome",
  refused: "learn/rule_refused",
  profile: "learn/profile",
  signal: "learning/signal",
} as const;

function globalPath(): string {
  return userPaths().learning;
}

function readGlobal(): LearnedRule[] {
  try {
    return JSON.parse(readFileSync(globalPath(), "utf8")) as LearnedRule[];
  } catch {
    return [];
  }
}

function writeGlobal(rules: LearnedRule[]): void {
  mkdirSync(dirname(globalPath()), { recursive: true });
  writeFileSync(globalPath(), `${JSON.stringify(rules, null, 2)}\n`, { mode: 0o600 });
}

export class LearningStore {
  /**
   * `hooks` is optional so a store built for a read — a report, a test — does
   * not have to load the project's hooks.toml to list rules. Production passes
   * the project's engine, which is what makes `playbook/propose` reachable.
   */
  constructor(
    private log: EventLog,
    private hooks?: LifecycleHookEngine,
    private options: {
      /** The project's files, so a path pattern matching all of them is refused (CX-N4-1). */
      projectFiles?: () => readonly string[];
    } = {},
  ) {}

  // --- Rules -------------------------------------------------------------------

  /** Every rule: project rules folded from the ledger, then global rules. */
  public async rules(): Promise<LearnedRule[]> {
    const byId = new Map<string, LearnedRule>();
    for (const e of await this.log.getEventsByTypes([EVENTS.rule, EVENTS.ruleOutcome])) {
      if (e.type === EVENTS.rule) {
        const p = e.payload as Partial<LearnedRule> & { id: string };
        byId.set(p.id, { ...(byId.get(p.id) ?? ({} as LearnedRule)), ...p } as LearnedRule);
      } else {
        const p = e.payload as { ruleId: string; helpful: boolean };
        const r = byId.get(p.ruleId);
        if (!r) continue;
        if (p.helpful) r.helpful++;
        else r.harmful++;
        r.value = round((1 - DECAY) * r.value + (p.helpful ? 1 : -1));
      }
    }
    const project = [...byId.values()];
    const ids = new Set(project.map((r) => r.id));
    return [...project, ...readGlobal().filter((r) => !ids.has(r.id))];
  }

  public async propose(
    rule: Omit<
      LearnedRule,
      "id" | "status" | "helpful" | "harmful" | "value" | "createdAt" | "reach"
    > & {
      reach?: "project" | "global";
    },
  ): Promise<LearnedRule | undefined> {
    // MS-T8-9: an inlet never proposes from signals that are all unverified
    // model syntheses; one executed or person-written signal is required.
    if (rule.evidence.length > 0 && rule.evidence.every((e) => e.verified === "none")) {
      return undefined;
    }
    // CX-N4-1: a rule that would reach every prompt is refused, naming the pattern.
    const refusal = scopeRefusal(rule.scope, this.options.projectFiles?.());
    if (refusal) {
      await this.log.append({
        actor: "harness",
        type: EVENTS.refused,
        payload: { role: rule.role, source: rule.source, ...refusal },
      });
      return undefined;
    }
    const at = new Date().toISOString();
    const evidence = rule.evidence.map((e) => ({ ...e, at: e.at ?? at }));
    const existing = (await this.rules()).filter(
      (r) => r.role === rule.role && r.status !== "retired",
    );
    // CX-N4-4: one curator, one fact per key. A fact a gate remedy states is
    // already in the failure block; one another rule holds gains evidence.
    const keys = ruleKeys(rule);
    if (remedyCovers(keys)) return undefined;
    const holder = keyHolder(keys, existing);
    if (holder) {
      if (holder.reach === "project") {
        await this.writeRule(
          { ...holder, evidence: [...holder.evidence, ...evidence].slice(-8) },
          "harness",
        );
      }
      return undefined;
    }
    // Mem0's update step: compare with the most similar existing rules.
    const ranked = existing
      .map((r) => ({ r, sim: similarity(r.text, rule.text) }))
      .sort((a, b) => b.sim - a.sim);
    // NOOP: a near-duplicate strengthens the existing rule's evidence instead of adding bloat.
    const dup = ranked[0] && ranked[0].sim >= 0.8 ? ranked[0].r : undefined;
    const related = ranked
      .filter((x) => x.sim >= 0.3 && x.sim < 0.8)
      .slice(0, 3)
      .map((x) => x.r.id);
    if (dup) {
      if (dup.reach === "project") {
        await this.writeRule(
          { ...dup, evidence: [...dup.evidence, ...evidence].slice(-8) },
          "harness",
        );
      }
      return undefined;
    }
    const full: LearnedRule = {
      ...rule,
      evidence,
      id: `rule_${randomUUID().slice(0, 8)}`,
      reach: rule.reach ?? "project",
      ...(related.length > 0 ? { related } : {}),
      status: "candidate",
      helpful: 0,
      harmful: 0,
      value: 0,
      createdAt: new Date().toISOString(),
    };

    // K12: the project sees a rule before it is written, and may refuse it.
    // A playbook rule is injected into every later prompt, so it is the one
    // piece of learned state a repository has a standing interest in vetting
    // — a house rule that contradicts its conventions is worse than none.
    // The candidate is complete here (id, reach, related), so a hook judges
    // what would actually be stored rather than a request to store something.
    const verdict = await this.hooks?.emit("playbook/propose", {
      cardId: rule.evidence.find((e) => e.cardId)?.cardId ?? "",
      data: { rule: full },
    });
    if (verdict?.blocked) return undefined;

    await this.writeRule(full, "planner");
    return full;
  }

  private async writeRule(rule: LearnedRule, actor: string): Promise<void> {
    if (rule.reach === "global") {
      const all = readGlobal().filter((r) => r.id !== rule.id);
      writeGlobal([...all, rule]);
      return;
    }
    await this.log.append({ actor, type: EVENTS.rule, payload: rule });
  }

  /** Human decisions: approve (optionally to every project), retire, or edit. */
  public async update(
    id: string,
    change: {
      status?: RuleStatus;
      text?: string;
      reach?: "project" | "global";
      evidence?: LearnedRule["evidence"];
    },
  ): Promise<LearnedRule | undefined> {
    const rule = (await this.rules()).find((r) => r.id === id);
    if (!rule) return undefined;
    const next: LearnedRule = { ...rule, ...change };
    if (rule.reach === "project" && next.reach === "global") {
      // Promotion to every project: the project copy retires, the global copy lives.
      await this.writeRule({ ...rule, status: "retired" }, "human");
    }
    await this.writeRule(next, "human");
    return next;
  }

  /**
   * The rules in force a card's prompt may carry (context rule 24b, 24f):
   * approved rules of the role whose kind and path match the card (AND; the
   * error pattern and trigger gate are applied per step by the playbook),
   * ranked by `rankRules`, at most eight. Probation is off (O15): a learned
   * candidate never applies before a person approves it, even when the run
   * lists it; a candidate a person seeded for the run (`source: "seed"`,
   * E5) does. A rule whose scope would match every card is never in force.
   */
  public async activeFor(
    role: RuleRole,
    card: ScopedCard,
    options: {
      runRules?: ReadonlySet<string>;
      /** The current error code, whose rules come first (CX-N4-3). */
      errorCode?: string;
      limit?: number;
      /** The owner allowed probation (O15); never in a measurement run. */
      probation?: boolean;
      measurement?: boolean;
    } = {},
  ): Promise<LearnedRule[]> {
    const onProbation = options.probation === true && options.measurement !== true;
    const inForce = (r: LearnedRule) =>
      r.status === "active" ||
      (r.status === "candidate" &&
        options.runRules?.has(r.id) === true &&
        (r.source === "seed" || onProbation));
    const matched = (await this.rules()).filter(
      (r) =>
        r.role === role &&
        inForce(r) &&
        scopeRefusal(r.scope) === undefined &&
        matchesCard(r.scope, card),
    );
    return rankRules(matched, {
      ...(options.errorCode ? { errorCode: options.errorCode } : {}),
    }).slice(0, options.limit ?? RULES_PER_PROMPT);
  }

  /**
   * The PM rules in force, for Seshat's snapshot (CX-N4-5): at most eight,
   * ranked like the Worker's. A PM rule never reaches a Worker prompt,
   * because `activeFor("worker", …)` reads only Worker rules.
   */
  public async seshatRules(): Promise<string[]> {
    const rules = (await this.rules()).filter((r) => r.role === "manager" && r.status === "active");
    return rankRules(rules, {})
      .slice(0, RULES_PER_PROMPT)
      .map((r) => r.text);
  }

  // --- Rotation and paired credit (CX-N4-6) --------------------------------------

  public async rotations(): Promise<RotationRecord[]> {
    return (await this.log.getEventsByTypes([ROTATION_EVENT])).map(
      (e) => e.payload as RotationRecord,
    );
  }

  /**
   * Rotate the rules in force across comparable cards (measurement §2,
   * *Admission*): on a card's first attempt, a rule goes into the prompt of
   * one comparable card — same project and card class — and is withheld
   * from the next, in start order, and the decision is recorded. A retry
   * carries every rule; a measurement run rotates nothing, so trials stay
   * independent. The same card's first attempt keeps its recorded decision.
   * Only the ranked rules the prompt's cap admits (`limit`, default
   * `RULES_PER_PROMPT`) are rotated: a rule the cap cuts is neither in the
   * prompt nor withheld, so it is never credited as either. The treatment
   * arm's credit reads the attempt record's rule ids (the rules a step
   * really carried, after per-step scoping), not this decision.
   */
  public async rotate(
    ranked: readonly LearnedRule[],
    card: { id: string; projectId: string; cardClass: string },
    attemptNumber: number,
    options: { measurement?: boolean; limit?: number } = {},
  ): Promise<{ inPrompt: LearnedRule[]; withheld: string[] }> {
    const rules = ranked.slice(0, options.limit ?? RULES_PER_PROMPT);
    if (attemptNumber !== 1 || options.measurement || rules.length === 0) {
      return { inPrompt: [...rules], withheld: [] };
    }
    const all = await this.rotations();
    const recorded = all.find((r) => r.cardId === card.id);
    if (recorded) {
      const out = new Set(recorded.withheld);
      return {
        inPrompt: rules.filter((r) => !out.has(r.id)),
        withheld: rules.filter((r) => out.has(r.id)).map((r) => r.id),
      };
    }
    const comparable = all.filter(
      (r) => r.projectId === card.projectId && r.cardClass === card.cardClass,
    );
    const inPrompt: LearnedRule[] = [];
    const withheld: string[] = [];
    for (const rule of rules) {
      const seen = comparable.filter(
        (r) => r.with.includes(rule.id) || r.withheld.includes(rule.id),
      ).length;
      if (seen % 2 === 0) inPrompt.push(rule);
      else withheld.push(rule.id);
    }
    const payload: RotationRecord = {
      cardId: card.id,
      projectId: card.projectId,
      cardClass: card.cardClass,
      with: inPrompt.map((r) => r.id),
      withheld,
    };
    await this.log.append({
      actor: "harness",
      type: ROTATION_EVENT,
      cardId: card.id,
      payload,
    });
    return { inPrompt, withheld };
  }

  /**
   * Each rule in force's paired credit, from the attempt record and the
   * rotation alone (rule 24e, MS-T8-14, `ruleCredit`): its helpful and
   * harmful counts and value are the credit's, and a rule a look finds
   * harmful is retired automatically with the pairs and the test as its
   * evidence — at no other time without a person (CX-N4-6).
   */
  public async settleCredit(outcomes: readonly AttemptOutcome[]): Promise<RuleCredit[]> {
    const records = creditRecords(outcomes, await this.rotations());
    const out: RuleCredit[] = [];
    for (const rule of await this.rules()) {
      if (rule.status !== "active" || rule.role !== "worker") continue;
      const c = ruleCredit(records, rule.id);
      out.push(c);
      if (c.pairs === 0) continue;
      const retire = c.status === "retired" && c.retiredAt !== undefined;
      if (
        !retire &&
        rule.helpful === c.helpful &&
        rule.harmful === c.harmful &&
        rule.value === c.credit
      ) {
        continue;
      }
      await this.writeRule(
        {
          ...rule,
          helpful: c.helpful,
          harmful: c.harmful,
          value: c.credit,
          ...(retire && c.retiredAt
            ? {
                status: "retired" as const,
                evidence: [
                  ...rule.evidence,
                  {
                    note: `retired automatically at the look after ${c.retiredAt.look} pairs: ${c.helpful} helpful, ${c.harmful} harmful, P = ${c.retiredAt.p.toPrecision(3)} (one-sided exact test, alpha 0.05/3)`,
                    source: "credit",
                    verified: "execution" as const,
                    at: new Date().toISOString(),
                  },
                ].slice(-8),
              }
            : {}),
        },
        "harness",
      );
    }
    return out;
  }

  /**
   * Record one inlet signal (measurement rule 20, MS-T8-4, MS-T8-9) and
   * return every occurrence of its key so far, this one included.
   */
  public async recordSignal(signal: {
    inlet: string;
    key: string;
    evidence: RuleEvidence;
  }): Promise<RuleEvidence[]> {
    await this.log.append({ actor: "harness", type: EVENTS.signal, payload: signal });
    return (await this.log.getEventsByTypes([EVENTS.signal]))
      .map((e) => e.payload as { inlet: string; key: string; evidence: RuleEvidence })
      .filter((p) => p.inlet === signal.inlet && p.key === signal.key)
      .map((p) => p.evidence);
  }

  // --- Profile -----------------------------------------------------------------

  /** Each statement as last recorded, its strength undecayed. */
  private async recordedProfile(): Promise<ProfileEntry[]> {
    const byId = new Map<string, ProfileEntry>();
    for (const e of await this.log.getEventsByTypes([EVENTS.profile])) {
      const p = e.payload as Partial<ProfileEntry> & { id: string };
      const { recordedStrength: _view, ...recorded } = p;
      byId.set(p.id, { ...(byId.get(p.id) ?? ({} as ProfileEntry)), ...recorded } as ProfileEntry);
    }
    return [...byId.values()];
  }

  /**
   * Every statement about the person, strongest first, each with its strength
   * now (PM-P6-15): the recorded strength times (1 − the scope's weekly rate)
   * for each week since its latest evidence — Erev–Roth forgetting, computed
   * from the ledger on each read, so nothing is written for time passing.
   */
  public async profile(now = Date.now()): Promise<ProfileEntry[]> {
    return (await this.recordedProfile())
      .map((p) => ({ ...p, recordedStrength: p.strength, strength: decayedStrength(p, now) }))
      .sort((a, b) => b.strength - a.strength);
  }

  /**
   * The statements Seshat uses (PM-P6-15, O24's default): active, and at a
   * strength of at least `PROFILE_IN_FORCE` now. A faded one returns when new
   * evidence raises it.
   */
  public async profileInForce(now = Date.now()): Promise<ProfileEntry[]> {
    return (await this.profile(now)).filter(
      (p) => p.status === "active" && p.strength >= PROFILE_IN_FORCE,
    );
  }

  /**
   * Add or reinforce a statement about the user. Reinforcement raises strength
   * toward 1 with diminishing returns; nothing is ever written as certain.
   */
  public async observe(
    entry: Omit<ProfileEntry, "id" | "status" | "strength" | "evidence" | "recordedStrength"> & {
      evidence: string;
      key?: string;
    },
    now = Date.now(),
  ): Promise<ProfileEntry> {
    // Reinforcement starts from the strength now, decayed since the last evidence.
    const all = await this.profile(now);
    const id = entry.key ? `pref_${entry.key}` : undefined;
    const existing = all.find((p) =>
      id ? p.id === id : p.status === "active" && similarity(p.statement, entry.statement) >= 0.7,
    );
    const at = new Date(now).toISOString();
    const { recordedStrength: _view, ...current } = existing ?? ({} as ProfileEntry);
    const next: ProfileEntry = existing
      ? {
          ...current,
          statement: entry.statement,
          strength: round(existing.strength + (1 - existing.strength) * 0.3),
          evidence: [...existing.evidence, { note: entry.evidence, at }].slice(-8),
          ...(entry.scope ? { scope: entry.scope } : {}),
        }
      : {
          id: id ?? `pref_${randomUUID().slice(0, 8)}`,
          statement: entry.statement,
          category: entry.category,
          source: entry.source,
          strength: 0.3,
          evidence: [{ note: entry.evidence, at }],
          status: "active",
          ...(entry.scope ? { scope: entry.scope } : {}),
        };
    await this.log.append({ actor: "planner", type: EVENTS.profile, payload: next });
    return next;
  }

  public async updateProfile(
    id: string,
    change: { status?: "active" | "dismissed"; statement?: string },
  ): Promise<ProfileEntry | undefined> {
    // The recorded entry, so a person's edit never writes a decayed strength as new evidence.
    const entry = (await this.recordedProfile()).find((p) => p.id === id);
    if (!entry) return undefined;
    const next = { ...entry, ...change };
    await this.log.append({ actor: "human", type: EVENTS.profile, payload: next });
    return next;
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

const WEEK_MS = 7 * 24 * 3_600_000;

/**
 * A statement's strength at `now` (PM-P6-15): its recorded strength times
 * (1 − φ) per week since its latest evidence, φ its scope's `decayPerWeek`.
 */
export function decayedStrength(
  p: Pick<ProfileEntry, "strength" | "evidence" | "scope">,
  now = Date.now(),
): number {
  const last = Math.max(...(p.evidence ?? []).map((e) => Date.parse(e.at)).filter(Number.isFinite));
  if (!Number.isFinite(last) || now <= last) return p.strength;
  const rate = Math.min(1, Math.max(0, (p.scope ?? DEFAULT_PROFILE_SCOPE).decayPerWeek));
  return round(p.strength * (1 - rate) ** ((now - last) / WEEK_MS));
}
