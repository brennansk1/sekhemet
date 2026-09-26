import type { CardStore, Requirement } from "@sekhemet/kernel";
import { sameWord } from "./criteria.js";
import { deriveCapabilities } from "./spidr.js";
import { contentWords, sentenceCase } from "./text.js";
import type { PlannedStory } from "./types.js";

/**
 * Traceability at persist (planner-pm §2.15.2, PM-P13-2): every card
 * records the requirement ids and versions it traces to (`trace/linked`,
 * made against the requirement's current version), and a card that traces
 * to none is not created — it is offered as a proposed change.
 *
 * **The rule when a spec has no brief** (requirements derived from the
 * spec): each capability the spec enumerates — the clauses the slicer cuts
 * it into — that no requirement of the project already covers becomes one
 * must-have requirement, titled in the spec's words and created with the
 * principal who asked for the plan. A card traces to the requirement of the
 * capability it was sliced from; the contract, failure-mode and riskiest-
 * assumption cards trace to the spec's first (headline) capability. When a
 * brief's accepted requirements are the only ones (`derive: false`),
 * nothing is derived and a card that covers none of them is refused.
 */

/** How much two phrases share: common words over the shorter one's. */
export function overlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const common = a.filter((w) => b.some((x) => sameWord(w, x))).length;
  return common / Math.min(a.length, b.length);
}

/** Words of a requirement: its title and its criteria. */
function requirementWords(r: Requirement): string[] {
  return contentWords([r.title ?? "", ...r.criteria.map((c) => c.text)].join(" "));
}

/** The best-covering requirement for a phrase, at least half its words. */
function bestRequirement(
  words: readonly string[],
  pool: readonly Requirement[],
): Requirement | undefined {
  let best: { r: Requirement; score: number } | undefined;
  for (const r of pool) {
    const score = overlap(words, requirementWords(r));
    if (score >= 0.5 && (!best || score > best.score)) best = { r, score };
  }
  return best?.r;
}

export interface TraceResolution {
  /** Requirement ids per story id; a story missing here traces to none. */
  byStory: Map<string, string[]>;
  /** Requirements derived from the spec in this plan. */
  derived: string[];
}

/**
 * Resolve what each story traces to, deriving requirements from the spec
 * where the rule above allows.
 */
export async function resolveTraces(
  store: CardStore,
  input: {
    stories: readonly PlannedStory[];
    spec: string | undefined;
    projectId: string | undefined;
    derive: boolean;
    principal: string;
  },
): Promise<TraceResolution> {
  const pool = (
    await store.requirements.list(input.projectId ? { projectId: input.projectId } : {})
  ).filter((r) => !r.cut);
  const capabilities = input.spec ? deriveCapabilities(input.spec).map((c) => c.text) : [];
  const byCapability = new Map<string, string>();
  const derived: string[] = [];

  const requirementFor = async (capability: string): Promise<string | undefined> => {
    const known = byCapability.get(capability);
    if (known) return known;
    const match = bestRequirement(contentWords(capability), pool);
    if (match) {
      byCapability.set(capability, match.id);
      return match.id;
    }
    if (!input.derive || !capabilities.includes(capability)) return undefined;
    const { id } = await store.requirements.create(
      {
        title: sentenceCase(capability.trim().replace(/[.;:]+$/, "")),
        mustHave: true,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      },
      input.principal,
    );
    const created = await store.requirements.get(id);
    if (created) pool.push(created);
    byCapability.set(capability, id);
    derived.push(id);
    return id;
  };

  const byStory = new Map<string, string[]>();
  for (const story of input.stories) {
    // A model may name the requirement ids it proves: those that exist count.
    const named = (story.requirementIds ?? []).filter((id) => pool.some((r) => r.id === id));
    if (named.length > 0) {
      byStory.set(story.card.id, named);
      continue;
    }
    const words = contentWords(`${story.card.title} ${story.keywords.join(" ")}`);
    // The capability it was sliced from; a model's slice is placed on the
    // spec capability it shares most words with.
    const capability =
      story.capability ??
      capabilities
        .map((c) => ({ c, score: overlap(words, contentWords(c)) }))
        .filter((x) => x.score >= 0.5)
        .sort((a, b) => b.score - a.score)[0]?.c;
    const id = capability ? await requirementFor(capability) : bestRequirement(words, pool)?.id;
    if (id) byStory.set(story.card.id, [id]);
  }
  return { byStory, derived };
}
