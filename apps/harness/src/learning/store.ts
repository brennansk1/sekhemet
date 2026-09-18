import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { EventLog } from "@sekhemet/kernel";

/**
 * What Sekhemet has learned: playbook rules for the Worker and Merit, and a
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
export type RuleSource = "struggle" | "send_back" | "reflection" | "seed";

export interface LearnedRule {
  id: string;
  role: RuleRole;
  text: string;
  scope: { kind?: string; pathPattern?: string; errorPattern?: string };
  reach: "project" | "global";
  status: RuleStatus;
  helpful: number;
  harmful: number;
  /** Erev-Roth recency-weighted value: v <- (1 - 0.1) v + reward. */
  value: number;
  source: RuleSource;
  evidence: { cardId?: string; note: string }[];
  createdAt: string;
}

export type ProfileCategory = "code_style" | "planning" | "communication" | "priorities";

export interface ProfileEntry {
  id: string;
  statement: string;
  category: ProfileCategory;
  strength: number;
  evidence: { note: string; at: string }[];
  status: "active" | "dismissed";
  source: "send_back" | "proposal_choices" | "edits" | "reflection";
}

const DECAY = 0.1;
const EVENTS = {
  rule: "learn/rule",
  ruleOutcome: "learn/rule_outcome",
  profile: "learn/profile",
} as const;

function globalPath(): string {
  const base = process.env.SEKHEMET_CONFIG_DIR ?? join(homedir(), ".config", "sekhemet");
  return join(base, "global_playbook.json");
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
  constructor(private log: EventLog) {}

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
    const existing = await this.rules();
    const norm = (t: string) => t.toLowerCase().replace(/\W+/g, " ").trim();
    // A duplicate strengthens the existing rule's evidence instead of adding bloat.
    const dup = existing.find((r) => r.role === rule.role && norm(r.text) === norm(rule.text));
    if (dup) {
      if (dup.reach === "project") {
        await this.writeRule(
          { ...dup, evidence: [...dup.evidence, ...rule.evidence].slice(-8) },
          "harness",
        );
      }
      return undefined;
    }
    const full: LearnedRule = {
      ...rule,
      id: `rule_${randomUUID().slice(0, 8)}`,
      reach: rule.reach ?? "project",
      status: "candidate",
      helpful: 0,
      harmful: 0,
      value: 0,
      createdAt: new Date().toISOString(),
    };
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
    change: { status?: RuleStatus; text?: string; reach?: "project" | "global" },
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

  /** Active rules a card's prompt should carry, most valuable first. */
  public async activeFor(
    role: RuleRole,
    card: { title: string; scopeFiles: string[] },
  ): Promise<LearnedRule[]> {
    const kind = /\(SPIDR:\s*([A-Za-z]+)/.exec(card.title)?.[1];
    return (await this.rules())
      .filter((r) => r.role === role && r.status === "active")
      .filter(
        (r) =>
          (!r.scope.kind || r.scope.kind === kind) &&
          (!r.scope.pathPattern ||
            card.scopeFiles.some((f) => f.includes(r.scope.pathPattern ?? ""))),
      )
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }

  /** Helpful/harmful accounting after a first attempt that carried these rules. */
  public async recordOutcome(ruleIds: string[], cardId: string, passed: boolean): Promise<void> {
    const rules = await this.rules();
    for (const id of ruleIds) {
      const rule = rules.find((r) => r.id === id);
      if (!rule) continue;
      if (rule.reach === "global") {
        const updated = {
          ...rule,
          helpful: rule.helpful + (passed ? 1 : 0),
          harmful: rule.harmful + (passed ? 0 : 1),
          value: round((1 - DECAY) * rule.value + (passed ? 1 : -1)),
        };
        await this.writeRule(updated, "harness");
      } else {
        await this.log.append({
          actor: "harness",
          type: EVENTS.ruleOutcome,
          cardId,
          payload: { ruleId: id, cardId, helpful: passed },
        });
      }
    }
  }

  /** Active rules that have clearly stopped helping: candidates for retirement. */
  public async retirementCandidates(): Promise<LearnedRule[]> {
    return (await this.rules()).filter((r) => r.status === "active" && r.harmful - r.helpful >= 3);
  }

  // --- Profile -----------------------------------------------------------------

  public async profile(): Promise<ProfileEntry[]> {
    const byId = new Map<string, ProfileEntry>();
    for (const e of await this.log.getEventsByTypes([EVENTS.profile])) {
      const p = e.payload as Partial<ProfileEntry> & { id: string };
      byId.set(p.id, { ...(byId.get(p.id) ?? ({} as ProfileEntry)), ...p } as ProfileEntry);
    }
    return [...byId.values()].sort((a, b) => b.strength - a.strength);
  }

  /**
   * Add or reinforce a statement about the user. Reinforcement raises strength
   * toward 1 with diminishing returns; nothing is ever written as certain.
   */
  public async observe(
    entry: Omit<ProfileEntry, "id" | "status" | "strength" | "evidence"> & {
      evidence: string;
      key?: string;
    },
  ): Promise<ProfileEntry> {
    const all = await this.profile();
    const id = entry.key ? `pref_${entry.key}` : undefined;
    const existing = all.find((p) => (id ? p.id === id : p.statement === entry.statement));
    const at = new Date().toISOString();
    const next: ProfileEntry = existing
      ? {
          ...existing,
          statement: entry.statement,
          strength: round(existing.strength + (1 - existing.strength) * 0.3),
          evidence: [...existing.evidence, { note: entry.evidence, at }].slice(-8),
        }
      : {
          id: id ?? `pref_${randomUUID().slice(0, 8)}`,
          statement: entry.statement,
          category: entry.category,
          source: entry.source,
          strength: 0.3,
          evidence: [{ note: entry.evidence, at }],
          status: "active",
        };
    await this.log.append({ actor: "planner", type: EVENTS.profile, payload: next });
    return next;
  }

  public async updateProfile(
    id: string,
    change: { status?: "active" | "dismissed"; statement?: string },
  ): Promise<ProfileEntry | undefined> {
    const entry = (await this.profile()).find((p) => p.id === id);
    if (!entry) return undefined;
    const next = { ...entry, ...change };
    await this.log.append({ actor: "human", type: EVENTS.profile, payload: next });
    return next;
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
