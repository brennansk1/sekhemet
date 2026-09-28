import type { DatabaseSync } from "node:sqlite";
import type { Access, Level } from "../team/access.js";
import { personName } from "../team/members.js";

/**
 * Who Seshat is speaking to and about (planner-pm §2.8.5, §2.18; teams items
 * 6, 19a, 20): the setup, each person's level, the projects they can see,
 * a project's lead and a person's name. The product builds it from the
 * access module; a Solo install with no access module is one person who
 * sees everything.
 */
export interface Audience {
  setup: "solo" | "team";
  /** A person's recorded name; undefined when none is recorded. */
  nameOf(principal: string): string | undefined;
  /** A person's level on a project (or the workspace); undefined for no access. */
  levelOf(principal: string, project?: string): Level | undefined;
  /** Whether a person can see a project's issues (PM-N9-8); an issue with no project goes by the workspace. */
  canSee(principal: string, project: string | undefined): boolean;
  /** The project's lead, when one is named. */
  leadOf(project: string | undefined): string | undefined;
  /**
   * The Admin whose auto-apply rule applies Seshat's suggestion of this kind
   * on this project (planner-pm PM-N9-2, teams TEAM-41); undefined, or
   * absent, when no rule is on and a person applies it.
   */
  autoApplier?(project: string | undefined, kind: string): string | undefined;
}

/** The one person of a Solo install: sees everything, holds every level. */
export function soloAudience(): Audience {
  return {
    setup: "solo",
    nameOf: () => undefined,
    levelOf: () => "admin",
    canSee: () => true,
    leadOf: () => undefined,
  };
}

/**
 * The audience the access module describes. A project is visible to a
 * person with a level on it (teams item 6); a per-project hiding rule, when
 * teams adds one, belongs in `Access.level` and reaches Seshat here.
 */
export function audienceFromAccess(access: () => Access, db: DatabaseSync): Audience {
  return {
    get setup() {
      return access().setup;
    },
    nameOf: (p) => personName(db, p),
    levelOf: (p, project) => access().level(p, project),
    canSee: (p, project) => access().level(p, project) !== undefined,
    leadOf: (project) => (project ? access().settings(project).lead : undefined),
    autoApplier: (project, kind) => access().autoApplier(project, kind),
  };
}

/** How a person is named in Seshat's text: their name, else "you" for the asker, else their id. */
export function nameFor(audience: Audience, principal: string | undefined, asker?: string): string {
  if (!principal) return "the issue's owner";
  if (asker && principal === asker) return "you";
  return audience.nameOf(principal) ?? (audience.setup === "solo" ? "you" : principal);
}

/**
 * Why a person may not apply a change to this issue (planner-pm §2.18.6,
 * PM-N9-9): in the Team setup, a change to an issue someone else owns is
 * theirs to apply. Undefined when the person may.
 */
export function ownerRefusal(
  card: { title: string; owner?: string | undefined },
  principal: string | undefined,
  audience: Audience | undefined,
  owner: string | undefined = card.owner,
): string | undefined {
  if (!audience || audience.setup !== "team" || !owner) return undefined;
  if (principal && principal === owner) return undefined;
  const who = nameFor(audience, owner);
  return `${who} owns ${card.title}; only ${who} can apply this change.`;
}
