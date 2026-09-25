import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Exemplar,
  type ExemplarStore,
  cardClassOf,
  trajectoryFromTurns,
} from "@sekhemet/context";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { runConfined } from "@sekhemet/sandbox";

/**
 * Self-improvement loops 4, 5, 8 and 9 (E10, E11, E14, E15). Loop 3 (prompt
 * evolution) and loop 8's proposal rubric were cut in B0 (DEC-25 R31).
 * Every loop produces candidates, never live changes: a candidate goes through the SIFT pre-filter, the frozen
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

// ------------------------------------------------ E10: skill distillation

export interface Trajectory {
  cardId: string;
  title: string;
  cardClass: string;
  passed: boolean;
  /** `closed: false` marks a tool call that never got its result. */
  steps: { action: string; result: string; closed?: boolean }[];
}

/**
 * A trajectory is structurally complete when its turns are in order and
 * every tool call got its result (measurement MS-T8-6, context rule 25):
 * only such a trajectory may become an exemplar or a skill's source. Counts
 * a caller does not know are not held against it.
 */
export function structurallyComplete(
  steps: readonly { turn?: number; calls?: number; observations?: number; closed?: boolean }[],
): boolean {
  let last = Number.NEGATIVE_INFINITY;
  for (const st of steps) {
    if (st.closed === false) return false;
    if (st.calls !== undefined && st.observations !== undefined && st.observations < st.calls)
      return false;
    if (st.turn !== undefined) {
      if (st.turn <= last) return false;
      last = st.turn;
    }
  }
  return true;
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
  const wins = trajectories.filter((t) => t.passed && structurallyComplete(t.steps));
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

// ------------------------------------------------ MS-T8-5: a skill's own checks

export interface SkillCheckResult {
  status: "checked" | "discarded" | "unchecked";
  passed: number;
  reason: string;
}

/** Runs one check confined to `root`; tests pass a scripted one. */
export type SkillCheckRunner = (
  command: string,
  args: string[],
  root: string,
) => Promise<{ exitCode: number; output: string }>;

const confinedCheck: SkillCheckRunner = async (command, args, root) => {
  const r = await runConfined(command, args, { root, timeoutMs: 120_000 });
  return { exitCode: r.exitCode, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-400) };
};

/**
 * A skill candidate's own checks, `evals/checks.json` (a list of
 * `{command, args}`), run confined in the candidate's directory before the
 * suite or a person sees it (measurement rule 18(4), MS-T8-5). One failing
 * check discards the candidate; with no checks it stays "unchecked" —
 * nothing measured grounds it, so it cannot be approved.
 */
export async function checkSkillCandidate(
  dir: string,
  /** `discard: false` keeps a failing skill's files (a person's own skill, EXT-27a). */
  options: { run?: SkillCheckRunner; discard?: boolean } = {},
): Promise<SkillCheckResult> {
  const file = join(dir, "evals", "checks.json");
  let checks: { command: string; args?: string[] }[] = [];
  try {
    checks = JSON.parse(readFileSync(file, "utf8")) as typeof checks;
  } catch {
    checks = [];
  }
  if (!Array.isArray(checks) || checks.length === 0) {
    return {
      status: "unchecked",
      passed: 0,
      reason:
        "no checks in evals/checks.json: a skill is admitted by its own checks passing (rule 18), so this candidate cannot be approved until it has some",
    };
  }
  const run = options.run ?? confinedCheck;
  let passed = 0;
  for (const c of checks) {
    const args = c.args ?? [];
    const r = await run(c.command, args, dir);
    if (r.exitCode !== 0) {
      if (options.discard !== false) rmSync(dir, { recursive: true, force: true });
      return {
        status: "discarded",
        passed,
        reason: `discarded: its check ${[c.command, ...args].join(" ")} exited ${r.exitCode}${r.output ? ` (${r.output.trim().split("\n").at(-1)})` : ""}`,
      };
    }
    passed++;
  }
  return { status: "checked", passed, reason: `its ${passed} check(s) pass, confined` };
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
    turns: {
      turn: number;
      action: string;
      result: string;
      calls?: number;
      observations?: number;
    }[];
    date?: string;
  }[],
  options: {
    /** Where candidates wait until their class has enough (rule 20). */
    poolPath?: string;
    /** Complete passing cards a class needs before any is offered; 5 (rule 20). */
    minPerClass?: number;
  } = {},
): Exemplar[] {
  const min = options.minPerClass ?? EXEMPLAR_MINIMUM;
  const pool: ExemplarPool = options.poolPath
    ? readPool(options.poolPath)
    : { waiting: {}, open: [] };
  const out: Exemplar[] = [];
  for (const c of cards) {
    if (!c.passed || c.turns.length === 0) continue;
    // An unclosed tool call or turns out of order never become an exemplar (MS-T8-6).
    if (!structurallyComplete(c.turns)) continue;
    const ex: Exemplar = {
      cardId: c.id,
      cardClass: cardClassOf(c),
      title: c.title,
      trajectory: trajectoryFromTurns(c.turns),
      steps: c.turns.length,
      tokens: c.tokens,
      date: c.date ?? new Date().toISOString(),
    };
    const cls = ex.cardClass;
    if (pool.open.includes(cls)) {
      store.record(ex);
      out.push(ex);
      continue;
    }
    // Below the volume threshold the inlet waits (rule 20): the class's
    // candidates are held until it has `min` of them, then all are offered.
    const waiting = [...(pool.waiting[cls] ?? []).filter((w) => w.cardId !== ex.cardId), ex];
    if (waiting.length >= min) {
      for (const w of waiting) {
        store.record(w);
        out.push(w);
      }
      pool.open.push(cls);
      delete pool.waiting[cls];
    } else {
      pool.waiting[cls] = waiting;
    }
  }
  if (options.poolPath) {
    mkdirSync(dirname(options.poolPath), { recursive: true });
    writeFileSync(options.poolPath, `${JSON.stringify(pool, null, 2)}\n`);
  }
  return out;
}

/** The exemplar inlet's volume threshold (measurement rule 20). */
export const EXEMPLAR_MINIMUM = 5;

interface ExemplarPool {
  waiting: Record<string, Exemplar[]>;
  /** Classes that reached the threshold: new cards go straight to the store. */
  open: string[];
}

function readPool(path: string): ExemplarPool {
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as Partial<ExemplarPool>;
    return { waiting: p.waiting ?? {}, open: p.open ?? [] };
  } catch {
    return { waiting: {}, open: [] };
  }
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
    // The last line of output says why (a refused connection, a denied write).
    const why = r.output.trim().split("\n").at(-1)?.slice(0, 200);
    if (r.exitCode !== 0) failures.push(`${ex}: exit ${r.exitCode}${why ? ` (${why})` : ""}`);
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
