import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Exemplar,
  type ExemplarStore,
  cardClassOf,
  trajectoryFromTurns,
} from "@sekhemet/context";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { reasoningForStep } from "@sekhemet/models";

/**
 * Self-improvement loops 3, 4, 5, 8 and 9 (E9, E10, E11, E14, E15; design
 * "The ten self-improvement loops"). Every loop produces candidates, never
 * live changes: a candidate goes through the SIFT pre-filter, the frozen
 * regression gate (E5) and human approval, and once live it is watched by
 * the learning guard (E17).
 */

// ----------------------------------------------------------- E14: SIFT

export interface TaskHistory {
  taskId: string;
  cardClass: string;
  passes: number;
  runs: number;
}

/**
 * Pick the informative slice for a quick evaluation (loop 8): tasks whose
 * pass rate is most uncertain (p(1-p), Laplace-smoothed) come first, and
 * classes are visited round-robin so the slice is diverse. Always-passing
 * and never-passing tasks tell a proposal nothing and go last.
 */
export function siftSlice(history: readonly TaskHistory[], size: number): TaskHistory[] {
  const p = (h: TaskHistory) => (h.passes + 1) / (h.runs + 2);
  const byClass = new Map<string, TaskHistory[]>();
  for (const h of [...history].sort(
    (a, b) => p(b) * (1 - p(b)) - p(a) * (1 - p(a)) || a.taskId.localeCompare(b.taskId),
  )) {
    byClass.set(h.cardClass, [...(byClass.get(h.cardClass) ?? []), h]);
  }
  const classes = [...byClass.keys()].sort();
  const out: TaskHistory[] = [];
  while (out.length < size && classes.some((c) => (byClass.get(c) ?? []).length > 0)) {
    for (const c of classes) {
      const next = byClass.get(c)?.shift();
      if (next && out.length < size) out.push(next);
    }
  }
  return out;
}

export interface Proposal {
  id: string;
  kind: "rule" | "skill" | "prompt" | "tool" | "budget";
  rationale: string;
  /** Files or config keys it changes. */
  touches: string[];
  /** Size of the change in tokens (text added to the prompt) or lines. */
  size: number;
}

export interface SiftVerdict {
  proposal: Proposal;
  passedRubric: boolean;
  rubricFailures: string[];
  sliceDelta?: number;
  keep: boolean;
}

const PROTECTED = [
  /loop\/src\/(session|card_runner)/,
  /gates\/src\/runner/,
  /sandbox\//,
  /permissions/,
];

/**
 * Loop 8, SIFT: a cheap rubric first (has a rationale, bounded size, never
 * touches the loop driver, gates runner or sandbox), then a small-slice
 * evaluation: the proposal is kept only if it does not lose cards on the
 * slice. Only kept proposals go on to the full frozen gate.
 */
export async function siftProposals(
  proposals: readonly Proposal[],
  evaluateOnSlice: (proposal: Proposal) => Promise<{ baseline: number; candidate: number }>,
  options: { maxSize?: number } = {},
): Promise<SiftVerdict[]> {
  const out: SiftVerdict[] = [];
  for (const proposal of proposals) {
    const failures: string[] = [];
    if (proposal.rationale.trim().length < 20) failures.push("no rationale");
    if (proposal.size > (options.maxSize ?? 300)) failures.push(`too large (${proposal.size})`);
    for (const t of proposal.touches) {
      if (PROTECTED.some((re) => re.test(t))) failures.push(`touches protected ${t}`);
    }
    if (failures.length > 0) {
      out.push({ proposal, passedRubric: false, rubricFailures: failures, keep: false });
      continue;
    }
    const r = await evaluateOnSlice(proposal);
    const delta = r.candidate - r.baseline;
    out.push({
      proposal,
      passedRubric: true,
      rubricFailures: [],
      sliceDelta: delta,
      keep: delta >= 0,
    });
  }
  return out;
}

// ------------------------------------------------ E9: prompt evolution

export interface PromptVariant {
  id: string;
  parentId?: string;
  /** Section name -> text (only the evolvable sections, e.g. laws, repair). */
  sections: Record<string, string>;
}

export interface PromptEvaluation {
  passRate: number;
  tokens: number;
  /** Failure excerpts, the feedback the next mutation reflects on. */
  failures: string[];
}

export interface EvolutionResult {
  front: (PromptVariant & PromptEvaluation)[];
  evaluated: (PromptVariant & PromptEvaluation)[];
  generations: number;
}

export function variantId(sections: Record<string, string>): string {
  return `pv_${createHash("sha256").update(JSON.stringify(sections)).digest("hex").slice(0, 10)}`;
}

/** Pareto front: higher pass rate, fewer tokens. */
export function paretoFront<T extends PromptEvaluation>(items: readonly T[]): T[] {
  return items.filter(
    (a) =>
      !items.some(
        (b) =>
          b !== a &&
          b.passRate >= a.passRate &&
          b.tokens <= a.tokens &&
          (b.passRate > a.passRate || b.tokens < a.tokens),
      ),
  );
}

/**
 * Loop 3, reflective prompt evolution (GEPA-style): each generation,
 * members of the Pareto front are mutated by a reflective step that reads
 * their failures, the children are evaluated on the task slice, and the
 * front is recomputed. Bounded by generations and population; the result
 * is candidates only.
 */
export async function evolvePrompts(options: {
  seed: PromptVariant;
  evaluate: (v: PromptVariant) => Promise<PromptEvaluation>;
  mutate: (v: PromptVariant & PromptEvaluation) => Promise<PromptVariant[]>;
  generations?: number;
  population?: number;
}): Promise<EvolutionResult> {
  const evaluated: (PromptVariant & PromptEvaluation)[] = [];
  const seen = new Set<string>();
  const add = async (v: PromptVariant) => {
    const id = variantId(v.sections);
    if (seen.has(id)) return;
    seen.add(id);
    evaluated.push({ ...v, id, ...(await options.evaluate(v)) });
  };
  await add(options.seed);
  const generations = options.generations ?? 3;
  let g = 0;
  for (; g < generations; g++) {
    const front = paretoFront(evaluated)
      .sort((a, b) => b.passRate - a.passRate || a.tokens - b.tokens)
      .slice(0, options.population ?? 4);
    const before = evaluated.length;
    for (const parent of front) {
      for (const child of await options.mutate(parent))
        await add({ ...child, parentId: parent.id });
    }
    if (evaluated.length === before) break;
  }
  return { front: paretoFront(evaluated), evaluated, generations: g };
}

/** A reflective mutator over a planning model: rewrite one section given the failures. */
export function reflectiveMutator(adapter: LocalInferenceAdapter, perParent = 2) {
  return async (v: PromptVariant & PromptEvaluation): Promise<PromptVariant[]> => {
    const names = Object.keys(v.sections).sort();
    const out: PromptVariant[] = [];
    for (let i = 0; i < Math.min(perParent, names.length); i++) {
      const name = names[(v.failures.length + i) % names.length] as string;
      const thinking = reasoningForStep({ purpose: "planning" });
      const res = await adapter.generate({
        systemPrompt:
          "You improve one section of a coding agent's system prompt. Keep it short and concrete. Reply with the new section text only.",
        prompt: `Section "${name}":\n${v.sections[name]}\n\nThe agent failed like this (pass rate ${(v.passRate * 100).toFixed(0)}%):\n${v.failures.slice(0, 5).join("\n---\n")}\n\nRewrite the section so these failures do not recur.`,
        toolArm: "arm_a_flat",
        purpose: "planning",
        reasoning: thinking.reasoning,
        reasoningBudgetTokens: thinking.reasoningBudgetTokens,
        maxTokens: 600,
      });
      const text = res.text.trim();
      if (text && text !== v.sections[name]) {
        out.push({ id: "", sections: { ...v.sections, [name]: text } });
      }
    }
    return out;
  };
}

// ------------------------------------------------ E10: skill distillation

export interface Trajectory {
  cardId: string;
  title: string;
  cardClass: string;
  passed: boolean;
  steps: { action: string; result: string }[];
}

export interface SkillCandidate {
  name: string;
  description: string;
  triggers: string[];
  body: string;
  provenance: string[];
  path?: string;
}

const STOP = new Set(
  "the a an and or to of in for with on add fix make use card task story from into by is be".split(
    " ",
  ),
);

function toolOf(action: string): string {
  return action.split(/[\s(]/)[0] ?? action;
}

/**
 * Loop 4, skill distillation: from successful trajectories of one class
 * (at least `minExamples`), derive a candidate SKILL.md: triggers are the
 * title words the cards share, the procedure is the tool sequence they
 * have in common. With a model, the body is written by it from the same
 * evidence. Written to `.sekhemet/skill-candidates/`, never to the live
 * skills directory: skill trust (C10) needs a human to approve it.
 */
export async function distillSkill(
  trajectories: readonly Trajectory[],
  options: { minExamples?: number; adapter?: LocalInferenceAdapter; outDir?: string } = {},
): Promise<SkillCandidate | undefined> {
  const wins = trajectories.filter((t) => t.passed);
  if (wins.length < (options.minExamples ?? 3)) return undefined;
  const cls = wins[0]?.cardClass ?? "general";
  const counts = new Map<string, number>();
  for (const t of wins) {
    for (const w of new Set(t.title.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [])) {
      if (!STOP.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  const triggers = [...counts.entries()]
    .filter(([, n]) => n >= Math.ceil(wins.length / 2))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([w]) => w);
  if (triggers.length === 0) return undefined;
  // The common procedure: tool bigrams present in most wins, in first-seen order.
  const seqs = wins.map((t) => t.steps.map((s) => toolOf(s.action)));
  const steps: string[] = [];
  for (const tool of seqs[0] ?? []) {
    if (steps.includes(tool)) continue;
    if (seqs.filter((s) => s.includes(tool)).length >= Math.ceil(wins.length * 0.66))
      steps.push(tool);
  }
  const name = `${cls.replace(/[^a-z0-9]+/gi, "-")}-${triggers[0]}`.toLowerCase();
  let body = [
    `Distilled from ${wins.length} passing cards (${wins.map((w) => w.cardId).join(", ")}).`,
    "",
    "Procedure that worked:",
    ...steps.map((s, i) => `${i + 1}. ${s}`),
  ].join("\n");
  if (options.adapter) {
    const res = await options.adapter.generate({
      systemPrompt:
        "Write a short, concrete skill for a small coding model: numbered steps, no prose.",
      prompt: `Cards: ${wins.map((w) => w.title).join("; ")}\nCommon tool sequence: ${steps.join(" -> ")}\nOne trajectory:\n${(wins[0]?.steps ?? []).map((s) => `${s.action} -> ${s.result.split("\n")[0]}`).join("\n")}`,
      toolArm: "arm_a_flat",
      purpose: "planning",
      maxTokens: 500,
    });
    if (res.text.trim())
      body = `${res.text.trim()}\n\n(Distilled from ${wins.length} passing cards.)`;
  }
  const candidate: SkillCandidate = {
    name,
    description: `How cards like "${wins[0]?.title}" were done here`,
    triggers,
    body,
    provenance: wins.map((w) => w.cardId),
  };
  if (options.outDir) {
    const dir = join(options.outDir, name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    writeFileSync(
      path,
      `---\ndescription: ${candidate.description}\ntriggers: [${triggers.join(", ")}]\nprovenance: [${candidate.provenance.join(", ")}]\n---\n${body}\n`,
    );
    candidate.path = path;
  }
  return candidate;
}

// ------------------------------------------------ E11: exemplar harvesting

/**
 * Loop 5: every accepted card's trajectory is offered to the exemplar
 * store (C13), which keeps the best per class. Cards that did not pass are
 * ignored.
 */
export function harvestExemplars(
  store: ExemplarStore,
  cards: readonly {
    id: string;
    tier: string;
    title: string;
    scopeFiles: string[];
    passed: boolean;
    tokens: number;
    turns: { turn: number; action: string; result: string }[];
    date?: string;
  }[],
): Exemplar[] {
  const out: Exemplar[] = [];
  for (const c of cards) {
    if (!c.passed || c.turns.length === 0) continue;
    const ex: Exemplar = {
      cardId: c.id,
      cardClass: cardClassOf(c),
      title: c.title,
      trajectory: trajectoryFromTurns(c.turns),
      steps: c.turns.length,
      tokens: c.tokens,
      date: c.date ?? new Date().toISOString(),
    };
    store.record(ex);
    out.push(ex);
  }
  return out;
}

// ------------------------------------------------ E15: tool synthesis

export interface ToolProposal {
  name: string;
  template: string;
  params: string[];
  examples: string[];
  cards: string[];
  status: "candidate" | "validated" | "failed";
  failures?: string[];
}

/** Normalise a shell command: paths and numbers become parameters. */
export function commandShape(command: string): { shape: string; values: string[] } {
  const values: string[] = [];
  const shape = command
    .trim()
    .split(/\s+/)
    .map((tok) => {
      if (/^[\w.@-]*\/[\w./@-]+$/.test(tok) || /\.\w{1,5}$/.test(tok)) {
        values.push(tok);
        return "{path}";
      }
      if (/^\d+$/.test(tok)) {
        values.push(tok);
        return "{n}";
      }
      return tok;
    })
    .join(" ");
  return { shape, values };
}

/**
 * Loop 9, tool synthesis: a command shape the Worker ran by hand on at
 * least `minCards` different cards becomes a tool proposal with typed
 * parameters. `validateToolProposal` runs its examples in the sandbox.
 */
export function mineToolProposals(
  runs: readonly { cardId: string; command: string }[],
  options: { minCards?: number } = {},
): ToolProposal[] {
  const byShape = new Map<string, { cards: Set<string>; examples: string[] }>();
  for (const r of runs) {
    const { shape } = commandShape(r.command);
    if (!shape.includes("{")) continue;
    const e = byShape.get(shape) ?? { cards: new Set<string>(), examples: [] };
    e.cards.add(r.cardId);
    if (e.examples.length < 3 && !e.examples.includes(r.command)) e.examples.push(r.command);
    byShape.set(shape, e);
  }
  return [...byShape.entries()]
    .filter(([, e]) => e.cards.size >= (options.minCards ?? 3))
    .sort((a, b) => b[1].cards.size - a[1].cards.size || a[0].localeCompare(b[0]))
    .map(([shape, e]) => {
      const words = shape
        .split(" ")
        .filter((w) => /^[a-z][\w-]*$/.test(w))
        .slice(0, 3);
      let i = 0;
      const template = shape.replace(/\{(path|n)\}/g, (_m, k: string) => `{${k}${i++}}`);
      return {
        name: words.join("_").replace(/-/g, "_") || "command",
        template,
        params: [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string),
        examples: e.examples,
        cards: [...e.cards].sort(),
        status: "candidate" as const,
      };
    });
}

export async function validateToolProposal(
  proposal: ToolProposal,
  run: (command: string) => Promise<{ exitCode: number; output: string }>,
): Promise<ToolProposal> {
  const failures: string[] = [];
  for (const ex of proposal.examples) {
    const r = await run(ex);
    if (r.exitCode !== 0) failures.push(`${ex}: exit ${r.exitCode}`);
  }
  return {
    ...proposal,
    status: failures.length ? "failed" : "validated",
    ...(failures.length ? { failures } : {}),
  };
}

/** Write a validated proposal as a candidate for human approval. */
export function writeToolCandidate(dir: string, proposal: ToolProposal): string {
  if (proposal.status !== "validated") throw new Error(`Tool ${proposal.name} is not validated`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${proposal.name}.json`);
  if (existsSync(path)) return path;
  writeFileSync(path, `${JSON.stringify(proposal, null, 2)}\n`);
  return path;
}
