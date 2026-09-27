import type { DatabaseSync } from "node:sqlite";
import type { EventLog } from "./log.js";
import type { RequirementCriterion, RequirementLedger } from "./requirements.js";

/**
 * The project's depth profile (design-stage §2.8, P14: DS-P14-1, -2, -3).
 *
 * A person chooses it — Seshat proposes one with its reason — and the choice
 * is one `project/depth_profile_chosen` event with the person's principal,
 * the profile proposed, and the test-approval level and test-strength rule
 * the profile selects (DS-P14-3). Every reader goes through one function,
 * `depthProfileOf`: the project's own choice, else the repository's (a choice
 * naming no project), else *internal tool* — only when none is recorded.
 * Choosing a profile adds a requirement for every quality-checklist row it
 * marks must-have (DS-P14-2); the rows' words are the caller's copy, so the
 * kernel holds only the row ids.
 */
export type DepthProfile = "prototype" | "internal tool" | "production" | "regulated";

export const DEPTH_PROFILES: readonly DepthProfile[] = [
  "prototype",
  "internal tool",
  "production",
  "regulated",
];

/** The profile read when no person has chosen one (gates rule 32a). */
export const DEFAULT_DEPTH_PROFILE: DepthProfile = "internal tool";

/**
 * Which tests a person approves before a card leaves Planning (planner-pm
 * §2.17): the criteria for every profile; the example tables of must-have
 * requirements from production; every staged acceptance-test file at regulated.
 */
export type TestApprovalLevel = "criteria" | "must_have_examples" | "every_file";

/**
 * The test-strength rule (gates rule 32a, `STRENGTH_TABLE`): whether the
 * smell lint and stub-kill stop a card (`blocking`) or only tell a person
 * (`advisory`, a prototype). Red at an assertion blocks at every profile.
 */
export type TestStrengthRule = "advisory" | "blocking";

/** What each profile selects (DS-P14-3), recorded with the choice. */
export const DEPTH_PROFILE_SELECTS: Readonly<
  Record<DepthProfile, { approval: TestApprovalLevel; strength: TestStrengthRule }>
> = {
  prototype: { approval: "criteria", strength: "advisory" },
  "internal tool": { approval: "criteria", strength: "blocking" },
  production: { approval: "must_have_examples", strength: "blocking" },
  regulated: { approval: "every_file", strength: "blocking" },
};

/** The rows of the quality checklist: the product qualities of ISO/IEC 25010:2023 (§2.8). */
export type QualityRow =
  | "functional_suitability"
  | "performance_efficiency"
  | "compatibility"
  | "interaction_capability"
  | "reliability"
  | "security"
  | "maintainability"
  | "flexibility"
  | "safety";

/**
 * Each row with the shallowest profile that marks it must-have (DS-P14-2):
 * a prototype marks none; every deeper profile keeps the rows of the one
 * before. Regulated marks all nine and claims no compliance (DS-P14-4).
 */
export const QUALITY_CHECKLIST: readonly {
  row: QualityRow;
  mustHaveFrom: Exclude<DepthProfile, "prototype">;
}[] = [
  { row: "functional_suitability", mustHaveFrom: "internal tool" },
  { row: "performance_efficiency", mustHaveFrom: "production" },
  { row: "compatibility", mustHaveFrom: "production" },
  { row: "interaction_capability", mustHaveFrom: "production" },
  { row: "reliability", mustHaveFrom: "internal tool" },
  { row: "security", mustHaveFrom: "internal tool" },
  { row: "maintainability", mustHaveFrom: "internal tool" },
  { row: "flexibility", mustHaveFrom: "regulated" },
  { row: "safety", mustHaveFrom: "regulated" },
];

/** The checklist rows a profile marks must-have, in checklist order (DS-P14-2). */
export function checklistRowsFor(profile: DepthProfile): QualityRow[] {
  const depth = DEPTH_PROFILES.indexOf(profile);
  return QUALITY_CHECKLIST.filter((r) => DEPTH_PROFILES.indexOf(r.mustHaveFrom) <= depth).map(
    (r) => r.row,
  );
}

/** A profile's name as a person or a configuration file writes it, or undefined. */
export function parseDepthProfile(name: string): DepthProfile | undefined {
  const key = name.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  return DEPTH_PROFILES.find((p) => p === key);
}

/** The profile in force, and whether a person recorded it. */
export interface DepthProfileRecord {
  profile: DepthProfile;
  /** False only for the default: no person has chosen a profile that applies. */
  recorded: boolean;
  approval: TestApprovalLevel;
  strength: TestStrengthRule;
  /** The project the choice named; absent for a repository-wide choice or the default. */
  projectId?: string;
  /** The profile Seshat proposed, when the choice records one (DS-P14-1). */
  proposed?: DepthProfile;
  /** The person who chose it. */
  principal?: string;
  /** The choice's event. */
  seq?: number;
}

export const DEPTH_PROFILE_EVENT = "project/depth_profile_chosen";

/**
 * The one reader of the depth profile (DS-P14-3): the latest choice for the
 * project, else the latest choice naming no project, else the internal-tool
 * default, unrecorded. Reads the ledger directly, so any connection to the
 * file — the board, the gates, the planner — reads the same answer.
 */
export function depthProfileOf(
  db: DatabaseSync | undefined,
  projectId?: string,
): DepthProfileRecord {
  const fallback: DepthProfileRecord = {
    profile: DEFAULT_DEPTH_PROFILE,
    recorded: false,
    ...DEPTH_PROFILE_SELECTS[DEFAULT_DEPTH_PROFILE],
  };
  if (!db) return fallback;
  const latest = (project: string | undefined) =>
    db
      .prepare(
        `SELECT seq, payload, principal FROM events WHERE type = ?
           AND ${project === undefined ? "json_extract(payload, '$.projectId') IS NULL" : "json_extract(payload, '$.projectId') = ?"}
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(...(project === undefined ? [DEPTH_PROFILE_EVENT] : [DEPTH_PROFILE_EVENT, project])) as
      | { seq: number; payload: string; principal: string | null }
      | undefined;
  const row = (projectId !== undefined ? latest(projectId) : undefined) ?? latest(undefined);
  if (!row) return fallback;
  const p = JSON.parse(row.payload) as {
    profile: DepthProfile;
    projectId?: string;
    proposed?: DepthProfile;
  };
  return {
    profile: p.profile,
    recorded: true,
    ...DEPTH_PROFILE_SELECTS[p.profile],
    ...(p.projectId !== undefined ? { projectId: p.projectId } : {}),
    ...(p.proposed !== undefined ? { proposed: p.proposed } : {}),
    ...(row.principal ? { principal: row.principal } : {}),
    seq: row.seq,
  };
}

/** A checklist row's requirement, in the caller's words: a criterion or a project-gate invariant. */
export interface ChecklistRequirementText {
  title: string;
  criteria?: RequirementCriterion[];
  /** A project gate's id whose invariant proves the row, in place of a criterion. */
  invariant?: string;
}

export interface DepthProfileChoice {
  profile: DepthProfile;
  /** Omitted: the repository's profile, for every project with none of its own. */
  projectId?: string;
  /** The profile Seshat proposed (DS-P14-1). */
  proposed?: DepthProfile;
  /** Seshat's reason for the proposal: free text, private. */
  reason?: string;
  /** One requirement's words per must-have row not yet covered (DS-P14-2). */
  checklist?: Partial<Record<QualityRow, ChecklistRequirementText>>;
}

export class DepthProfileLedger {
  constructor(
    private readonly db: DatabaseSync,
    private readonly log: EventLog,
    private readonly requirements: RequirementLedger,
  ) {}

  /** The profile in force for a project (`depthProfileOf`). */
  public of(projectId?: string): DepthProfileRecord {
    return depthProfileOf(this.db, projectId);
  }

  /**
   * Record a person's choice (DS-P14-1, -3) and add a requirement for each
   * must-have checklist row the project does not yet cover (DS-P14-2), each
   * with a criterion or a project-gate invariant. Everything is checked
   * before anything is appended.
   */
  public async choose(
    input: DepthProfileChoice,
    principal: string,
  ): Promise<{ record: DepthProfileRecord; checklistRequirementIds: string[] }> {
    if (!principal)
      throw new Error("A depth profile is chosen by a person; no principal was given");
    const names = DEPTH_PROFILES.join(", ");
    if (!DEPTH_PROFILES.includes(input.profile)) {
      throw new Error(`A depth profile is one of ${names}, got ${String(input.profile)}`);
    }
    if (input.proposed !== undefined && !DEPTH_PROFILES.includes(input.proposed)) {
      throw new Error(`A proposed depth profile is one of ${names}, got ${String(input.proposed)}`);
    }
    if (
      input.projectId !== undefined &&
      !this.db.prepare("SELECT 1 AS x FROM projects WHERE id = ?").get(input.projectId)
    ) {
      throw new Error(`No project ${input.projectId}`);
    }
    const covered = new Set(
      (
        await this.requirements.list(
          input.projectId !== undefined ? { projectId: input.projectId } : {},
        )
      )
        .filter(
          (r) =>
            r.source === "checklist" &&
            !r.cut &&
            (input.projectId !== undefined || r.projectId === undefined),
        )
        .map((r) => r.checklistRow),
    );
    const due = checklistRowsFor(input.profile).filter((row) => !covered.has(row));
    const missing = due.filter((row) => !input.checklist?.[row]?.title);
    if (missing.length > 0) {
      throw new Error(
        `The ${input.profile} profile marks ${missing.join(", ")} must-have: each needs a requirement's words (DS-P14-2)`,
      );
    }
    const unproven = due.filter((row) => {
      const t = input.checklist?.[row] as ChecklistRequirementText;
      return (t.criteria?.length ?? 0) === 0 && !t.invariant;
    });
    if (unproven.length > 0) {
      throw new Error(
        `Checklist row ${unproven.join(", ")}: each requirement needs an acceptance criterion or a project-gate invariant (DS-P14-2)`,
      );
    }
    const selects = DEPTH_PROFILE_SELECTS[input.profile];
    await this.log.append({
      actor: "human",
      type: DEPTH_PROFILE_EVENT,
      payload: {
        profile: input.profile,
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        ...(input.proposed !== undefined ? { proposed: input.proposed } : {}),
        approval: selects.approval,
        strength: selects.strength,
      },
      principal,
      ...(input.reason !== undefined ? { private: { reason: input.reason } } : {}),
    });
    const ids: string[] = [];
    for (const row of due) {
      const t = input.checklist?.[row] as ChecklistRequirementText;
      const created = await this.requirements.create(
        {
          title: t.title,
          ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
          ...(t.criteria !== undefined ? { criteria: t.criteria } : {}),
          ...(t.invariant !== undefined ? { invariant: t.invariant } : {}),
          mustHave: true,
          source: "checklist",
          checklistRow: row,
        },
        principal,
      );
      ids.push(created.id);
    }
    return { record: this.of(input.projectId), checklistRequirementIds: ids };
  }
}
