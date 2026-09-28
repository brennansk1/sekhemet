import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AcceptanceRun,
  type GateDefinition,
  type GateFailure,
  type GateRunner,
  type RungOutcome,
  loadGatesConfig,
  runAcceptanceTests,
} from "@sekhemet/gates";
import type { DesignStageResult, StackLanguage } from "@sekhemet/planner";
import type { GeneratorRegistry, ProcessSandbox } from "@sekhemet/sandbox";
import { gitEnvFor } from "@sekhemet/sync";
import { DERIVED_GATES_HEADER, deriveGates, installGates } from "./init.js";
import { CARD_ONE_COPY, CARD_ZERO_COPY } from "./pm/pm_copy.js";

/**
 * Card zero and card one (design-stage §2.4; DS-P2-1, -2, -3): how a project
 * started by conversation begins.
 *
 * **Card zero is the ecosystem's own generator**, never a model and never a
 * template of ours — `npm init` with `tsc --init` and Vitest for
 * TypeScript, `uv init` for Python, `cargo init` for Rust — run as a card:
 * each command is a step the Worker takes with its confined `run_cmd`, never
 * a command this harness runs on the host when the plan is made. Until the
 * generator has run the project has no gates of its own, so card zero's gate
 * is the one written here: `scaffold`, a Node check that the files the
 * generator leaves are there. Once card zero is done, the project's gates are
 * derived from what the generator produced (`deriveGates`, the one deriver)
 * and replace that gate, and the generator and its version are written into
 * the brief so the scaffold is reproducible.
 *
 * **Card one is a failing test.** Its deliverable is the test the Worker
 * writes, in the card's scope — never a staged or protected acceptance test,
 * so nothing is staged for it and no red-first or test-strength check of
 * staged tests judges it. Its gate passes only when the test runs and fails
 * at an assertion — not at an import, collection or setup — judged from the
 * test's own result (`runAcceptanceTests`, gates rule 6). From card two,
 * every card has a functional gate.
 */

/** Labels that mark the two cards on the board. */
export const CARD_ZERO_LABEL = "card-zero";
export const CARD_ONE_LABEL = "card-one";

export interface GeneratorStep {
  command: string;
  args: string[];
}

/** A file the generator leaves, and a text it must hold when one is named. */
export interface ScaffoldFile {
  file: string;
  contains?: string;
}

export interface EcosystemGenerator {
  stack: StackLanguage;
  /** How the brief and the card name it. */
  name: string;
  steps: GeneratorStep[];
  /** What card zero's gate checks for. */
  produces: ScaffoldFile[];
  /** What the .gitignore card zero writes names. */
  ignored: string[];
  /** The test command the derived gates are expected to hold. */
  test: string;
  /** Card one's test file. */
  firstTest: string;
  /** The package registry its steps may reach once a person approved it (DS-P2-1, -2). */
  registry: GeneratorRegistry;
}

const step = (line: string): GeneratorStep => {
  const [command = "", ...args] = line.split(" ");
  return { command, args };
};

const GENERATORS: Record<StackLanguage, EcosystemGenerator> = {
  typescript: {
    stack: "typescript",
    name: "npm init, tsc --init and Vitest",
    steps: ["npm init -y", "npm install --save-dev typescript vitest", "npx tsc --init"]
      .map(step)
      .concat({
        command: "npm",
        args: ["pkg", "set", "scripts.test=vitest run", "scripts.typecheck=tsc --noEmit"],
      }),
    produces: [
      { file: "package.json", contains: "vitest" },
      { file: "package-lock.json" },
      { file: "tsconfig.json" },
      { file: "node_modules/typescript/package.json" },
      { file: "node_modules/vitest/package.json" },
    ],
    ignored: ["node_modules"],
    test: "vitest",
    firstTest: "tests/first.test.ts",
    registry: "npm",
  },
  python: {
    stack: "python",
    name: "uv init",
    steps: ["uv init", "uv add --dev pytest"].map(step),
    produces: [
      { file: "pyproject.toml", contains: "pytest" },
      { file: "uv.lock", contains: "pytest" },
    ],
    ignored: [".venv", "__pycache__"],
    test: "pytest",
    firstTest: "tests/test_first.py",
    registry: "python",
  },
  rust: {
    stack: "rust",
    name: "cargo init",
    steps: ["cargo init --vcs none"].map(step),
    produces: [{ file: "Cargo.toml", contains: "[package]" }],
    ignored: ["target"],
    test: "cargo test",
    firstTest: "tests/first.rs",
    registry: "rust",
  },
  go: {
    stack: "go",
    name: "go mod init",
    steps: ["go mod init app"].map(step),
    produces: [{ file: "go.mod", contains: "module" }],
    ignored: [],
    test: "go test",
    firstTest: "first_test.go",
    registry: "go",
  },
};

/** The generator for a stack (design-stage §2.4 item 1). */
export function generatorFor(stack: StackLanguage): EcosystemGenerator {
  return GENERATORS[stack];
}

/**
 * The stack a card-zero card's generator is for, read from the card itself:
 * labelled card zero, and its spec names every step of that generator
 * (DS-P2-1, -2). Undefined for any other card.
 */
export function generatorOfCard(card: {
  labels?: readonly string[] | undefined;
  spec?: string | undefined;
}): StackLanguage | undefined {
  if (!card.labels?.includes(CARD_ZERO_LABEL) || !card.spec) return undefined;
  const spec = card.spec;
  return (Object.keys(GENERATORS) as StackLanguage[]).find((stack) =>
    GENERATORS[stack].steps.every((s) => spec.includes(`- ${stepLine(s)}`)),
  );
}

/**
 * Card zero's generator as the card's declared tool steps (gates rule 12):
 * what each step writes through run_cmd is the generator's — its lockfile
 * and manifests — counted against card zero's tool-applied bound, never the
 * Worker's lines. Create project was the person's approval of this
 * generator, so its steps — only they — may reach its ecosystem's package
 * registry (`registry`, through the one network policy's
 * `generatorAllowlist`, each request recorded as the card's egress).
 * Undefined for any other card.
 */
export function cardZeroSteps(card: {
  labels?: readonly string[] | undefined;
  spec?: string | undefined;
}):
  | { tool: "generator"; steps: GeneratorStep[]; ignored: string[]; registry: GeneratorRegistry }
  | undefined {
  const stack = generatorOfCard(card);
  if (!stack) return undefined;
  const g = generatorFor(stack);
  return { tool: "generator", steps: g.steps, ignored: g.ignored, registry: g.registry };
}

/** A step as a person types it: an argument with a space is quoted. */
export const stepLine = (s: GeneratorStep) =>
  [s.command, ...s.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(" ");

export interface CardFields {
  title: string;
  spec: string;
  acceptanceCriteria: string[];
  labels: string[];
  scopeFiles: string[];
  estimate: number;
  acceptanceTests?: string[];
}

/** Card zero's card: the generator's commands as its steps (DS-P2-1, -2). */
export function cardZeroCard(stack: StackLanguage): CardFields {
  const g = generatorFor(stack);
  const top = [...new Set(g.produces.map((p) => p.file.split("/")[0] as string))].filter(
    (f) => !g.ignored.includes(f),
  );
  return {
    title: CARD_ZERO_COPY.title(g.name),
    spec: CARD_ZERO_COPY.spec(
      g.name,
      g.steps.map(stepLine),
      g.ignored.length ? g.ignored : ["nothing"],
    ),
    acceptanceCriteria: CARD_ZERO_COPY.criteria(top, g.test),
    labels: [CARD_ZERO_LABEL],
    scopeFiles: [...top, ".gitignore"],
    estimate: 1,
  };
}

/**
 * Card one's card (DS-P2-3): one test for the first slice's first behaviour,
 * which must run and fail at an assertion for the reason it states. The test
 * is the Worker's to write, in the card's scope: no acceptance test.
 */
export function cardOneCard(
  design: Pick<DesignStageResult, "firstSlice">,
  stack: StackLanguage,
): CardFields & { reason: string } {
  const g = generatorFor(stack);
  const behaviour = design.firstSlice.trim().replace(/[.!?]+$/, "");
  const reason = CARD_ONE_COPY.reason(behaviour);
  return {
    title: CARD_ONE_COPY.title(behaviour),
    spec: CARD_ONE_COPY.spec(behaviour, g.firstTest, reason),
    acceptanceCriteria: [CARD_ONE_COPY.criterion(g.firstTest, reason)],
    labels: [CARD_ONE_LABEL],
    scopeFiles: [g.firstTest],
    estimate: 1,
    reason,
  };
}

const FIRST_TESTS = new Set(Object.values(GENERATORS).map((g) => g.firstTest));

/**
 * The test a card-one card's gate runs (DS-P2-3): the generator's first test
 * in its scope, else its whole scope. None for any other card.
 */
export function cardOneTests(card: {
  labels?: readonly string[] | undefined;
  scopeFiles?: readonly string[] | undefined;
}): string[] {
  if (!card.labels?.includes(CARD_ONE_LABEL)) return [];
  const scope = card.scopeFiles ?? [];
  const first = scope.filter((f) => FIRST_TESTS.has(f));
  return first.length > 0 ? first : [...scope];
}

/**
 * A card-one card without its test among the staged acceptance tests: a card
 * planned before DS-P2-3 was settled named it there, and a staged test would
 * be protected from the Worker who writes it and judged red-first. Any other
 * card unchanged.
 */
export function withoutCardOneStaging<
  T extends {
    labels?: string[] | undefined;
    scopeFiles?: string[] | undefined;
    acceptanceTests?: string[] | undefined;
  },
>(card: T): T {
  const own = cardOneTests(card);
  if (own.length === 0 || !card.acceptanceTests?.length) return card;
  const norm = (t: string) => t.replace(/^tests\//, "");
  const mine = new Set(own.map(norm));
  return { ...card, acceptanceTests: card.acceptanceTests.filter((t) => !mine.has(norm(t))) };
}

// --- Card zero's gate ------------------------------------------------------

/** What card zero's gate finds missing from the generator's output. */
export function scaffoldCheck(
  root: string,
  stack: StackLanguage,
  options: { tracked?: boolean } = {},
): { ok: boolean; missing: string[] } {
  const g = generatorFor(stack);
  // On the tree where accepted work lands only what git tracks is there: the
  // generator's installed packages (its ignored directories) never merge.
  const ignored = (file: string) => g.ignored.includes(file.split("/")[0] as string);
  const missing = g.produces
    .filter((p) => !(options.tracked && ignored(p.file)))
    .filter((p) => {
      try {
        const text = readFileSync(join(root, p.file), "utf8");
        return p.contains !== undefined && !text.includes(p.contains);
      } catch {
        return true;
      }
    })
    .map((p) => p.file);
  return { ok: missing.length === 0, missing };
}

/**
 * The same check as a command a gate runs: a Node one-liner, since Node is
 * the one runtime the harness itself needs, with the files to look for as
 * its argument. It fails naming what is missing.
 */
const SCAFFOLD_SCRIPT =
  'const fs=require("node:fs");const want=JSON.parse(process.argv[1]);const missing=want.filter((w)=>{try{const t=fs.readFileSync(w.file,"utf8");return w.contains!==undefined&&!t.includes(w.contains)}catch{return true}}).map((w)=>w.file);if(missing.length){console.error("The generator has not left: "+missing.join(", "));process.exit(1)}console.log("The generator\'s output is all there.")';

/**
 * Card zero's bound on the lines its generator writes (gates rule 12): a
 * package manager's lockfile runs to thousands of lines, all the tool's.
 * The Worker's own lines stay under `max_diff_lines`.
 */
export const SCAFFOLD_MAX_TOOL_APPLIED_LINES = 20_000;

/** The first line of the `gates.toml` card zero writes: how it is known again. */
export const SCAFFOLD_GATES_MARKER =
  "# Card zero's gate: replaced by the project's own once card zero is done.";

export function scaffoldGatesToml(stack: StackLanguage): string {
  const q = (v: string) => JSON.stringify(v);
  const want = JSON.stringify(generatorFor(stack).produces);
  return [
    SCAFFOLD_GATES_MARKER,
    "[project]",
    "max_files = 3",
    "max_diff_lines = 200",
    `max_tool_applied_lines = ${SCAFFOLD_MAX_TOOL_APPLIED_LINES}`,
    'protected = [".sekhemet/gates.toml"]',
    "",
    "[[gate]]",
    'id = "scaffold"',
    'rung = "test"',
    'layer = "functional"',
    'command = "node"',
    `args = [${["-e", SCAFFOLD_SCRIPT, want].map(q).join(", ")}]`,
    "timeout_s = 30",
    'parser = "generic"',
    "",
  ].join("\n");
}

const gatesPath = (root: string) => join(root, ".sekhemet", "gates.toml");

/**
 * Write card zero's gate when the project has no `gates.toml` of its own,
 * or only the first run's with no gate in it. Any other file is never
 * replaced: "kept".
 */
export function installScaffoldGate(root: string, stack: StackLanguage): "written" | "kept" {
  // The first run's own file with no gate in it (an empty directory,
  // DS-P2-4) declares nothing to keep; any other file is a person's.
  if (existsSync(gatesPath(root))) {
    const live = readFileSync(gatesPath(root), "utf8");
    if (!live.startsWith(DERIVED_GATES_HEADER) || /^\s*\[\[gate\]\]/m.test(live)) return "kept";
  }
  mkdirSync(dirname(gatesPath(root)), { recursive: true });
  writeFileSync(gatesPath(root), scaffoldGatesToml(stack));
  return "written";
}

// --- After card zero ------------------------------------------------------

const readJson = (path: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

/** The generator and the versions its output records, as the brief states them. */
export function generatorRecord(root: string, stack: StackLanguage): string {
  const g = generatorFor(stack);
  const versions: string[] = [];
  if (stack === "typescript") {
    // The installed package, else the lockfile: the accepted tree has no node_modules.
    const locked = readJson(join(root, "package-lock.json"))?.packages as
      | Record<string, { version?: unknown }>
      | undefined;
    for (const [pkg, name] of [
      ["typescript", "TypeScript"],
      ["vitest", "Vitest"],
    ] as const) {
      const v =
        readJson(join(root, "node_modules", pkg, "package.json"))?.version ??
        locked?.[`node_modules/${pkg}`]?.version;
      if (typeof v === "string") versions.push(`${name} ${v}`);
    }
  } else if (stack === "python") {
    const lock = existsSync(join(root, "uv.lock"))
      ? readFileSync(join(root, "uv.lock"), "utf8")
      : "";
    const pytest = /\[\[package\]\]\s*\nname = "pytest"\s*\nversion = "([^"]+)"/.exec(lock)?.[1];
    if (pytest) versions.push(`pytest ${pytest}`);
    const python = /^requires-python = "([^"]+)"/m.exec(lock)?.[1];
    if (python) versions.push(`Python ${python}`);
  } else if (stack === "rust") {
    const cargo = existsSync(join(root, "Cargo.toml"))
      ? readFileSync(join(root, "Cargo.toml"), "utf8")
      : "";
    const edition = /^edition = "([^"]+)"/m.exec(cargo)?.[1];
    if (edition) versions.push(`edition ${edition}`);
  }
  return `${g.name}${versions.length ? ` (${versions.join(", ")})` : ""}`;
}

/** Write "Generator: …" under the brief's Constraints, once; later calls replace it. */
export function recordGeneratorInBrief(briefPath: string, record: string): boolean {
  if (!existsSync(briefPath)) return false;
  const text = readFileSync(briefPath, "utf8");
  const entry = `- Generator: ${record}`;
  let next: string;
  if (/^- Generator: .*$/m.test(text)) next = text.replace(/^- Generator: .*$/m, entry);
  else if (/^## Constraints\s*$/m.test(text))
    next = text.replace(/^## Constraints\s*$/m, `## Constraints\n${entry}`);
  else next = `${text.replace(/\s*$/, "")}\n\n## Constraints\n${entry}\n`;
  if (next === text) return false;
  writeFileSync(briefPath, next);
  return true;
}

export type AfterCardZero =
  /** The gates were derived from the generator's output and replace card zero's. */
  | "derived"
  /** They already were. */
  | "already"
  /** The generator's output is not all there yet; nothing changed. */
  | "incomplete"
  /** The project's `gates.toml` is a person's, not card zero's; it is kept. */
  | "kept";

/**
 * Once card zero is done (DS-P2-1, -2): the project's gates, derived from
 * what the generator left, replace card zero's gate (the previous file kept
 * as `gates.toml.bak`), and the generator and its version go into the brief.
 * Idempotent; a `gates.toml` card zero did not write is never touched. `root`
 * is the tree where accepted work lands: its tracked files are judged, or
 * those of `tree` — the accepted commit's files — when given; the gates and
 * the brief are written under `root`.
 */
export function afterCardZero(
  root: string,
  stack: StackLanguage,
  options: { briefPath?: string; tree?: string } = {},
): { state: AfterCardZero; gates: string[]; generator?: string } {
  const tree = options.tree ?? root;
  const live = existsSync(gatesPath(root)) ? readFileSync(gatesPath(root), "utf8") : undefined;
  const ours = live === undefined || live.startsWith(SCAFFOLD_GATES_MARKER);
  const derived = deriveGates(tree);
  if (!ours) {
    return live === derived.toml
      ? { state: "already", gates: derived.defs.map((d) => d.id) }
      : { state: "kept", gates: [] };
  }
  if (!scaffoldCheck(tree, stack, { tracked: true }).ok) return { state: "incomplete", gates: [] };
  const generator = generatorRecord(tree, stack);
  recordGeneratorInBrief(options.briefPath ?? join(root, ".sekhemet", "brief.md"), generator);
  const installed = installGates(root, derived.toml, true);
  return {
    state: installed.state === "unchanged" ? "already" : "derived",
    gates: derived.defs.map((d) => d.id),
    generator,
  };
}

/**
 * The pass after card zero is Done (DS-P2-1, -2): while `gates.toml` is card
 * zero's own, a card-zero card in Done derives the project's gates on `root`,
 * the tree where accepted work lands. Undefined when there is nothing to do.
 */
export function afterDoneCardZero(
  root: string,
  cards: readonly { status: string; labels?: string[] | undefined; spec?: string | undefined }[],
): ReturnType<typeof afterCardZero> | undefined {
  const live = existsSync(gatesPath(root)) ? readFileSync(gatesPath(root), "utf8") : undefined;
  if (!live?.startsWith(SCAFFOLD_GATES_MARKER)) return undefined;
  for (const c of cards) {
    if (c.status !== "done") continue;
    const stack = generatorOfCard(c);
    if (stack) return afterCardZero(root, stack);
  }
  return undefined;
}

/**
 * On a person's accept of card zero (DS-P2-1, -2): the project's gates,
 * derived from the files of the accepted commit `sha` — accept moves the
 * integration branch by plumbing, so a checkout on it may still hold its old
 * files — replace card zero's gate under `repoPath`, and the generator goes
 * into the brief. Undefined for any other card; the queue prelude's pass
 * (`afterDoneCardZero`) does the same for a card zero already Done.
 */
export function afterAcceptedCardZero(
  repoPath: string,
  card: { labels?: readonly string[] | undefined; spec?: string | undefined },
  sha: string,
): ReturnType<typeof afterCardZero> | undefined {
  const stack = generatorOfCard(card);
  if (!stack) return undefined;
  const live = existsSync(gatesPath(repoPath))
    ? readFileSync(gatesPath(repoPath), "utf8")
    : undefined;
  if (live !== undefined && !live.startsWith(SCAFFOLD_GATES_MARKER)) return undefined;
  const tree = mkdtempSync(join(tmpdir(), "sek-card0-accepted-"));
  try {
    // The accepted commit's tracked files, read without touching the index
    // or any checkout.
    const archive = join(tree, ".accepted.tar");
    execFileSync("git", ["archive", "--format=tar", "-o", archive, sha], {
      cwd: repoPath,
      env: gitEnvFor(repoPath),
      stdio: "ignore",
    });
    execFileSync("tar", ["-xf", archive, "-C", tree], { stdio: "ignore" });
    rmSync(archive, { force: true });
    return afterCardZero(repoPath, stack, { tree });
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

// --- Card one's gate ------------------------------------------------------

export interface CardOneVerdict {
  passed: boolean;
  detail: string;
}

/**
 * Card one's gate (DS-P2-3): it passes only when its test ran and every
 * result failed at an assertion. Passing, failing at an import, collection,
 * setup or at a runtime error of its own, or not running at all, fails it.
 */
export function cardOneVerdict(run: AcceptanceRun): CardOneVerdict {
  if ("unavailable" in run) return { passed: false, detail: `not run: ${run.unavailable}` };
  if (run.results.length === 0) return { passed: false, detail: "no test ran" };
  const wrong = run.results.filter((r) => r.kind !== "assertion");
  if (wrong.length > 0) {
    return {
      passed: false,
      detail: wrong
        .map((r) => `${r.test}: ${r.kind}${r.message ? ` (${r.message})` : ""}`)
        .join("; "),
    };
  }
  return {
    passed: true,
    detail: run.results.map((r) => `${r.test}: at an assertion (${r.message ?? ""})`).join("; "),
  };
}

/**
 * Run card one's test through the project's test gate, confined with no
 * network (`runAcceptanceTests`), and judge it. The gate is the project's
 * functional test gate, the one card zero's output derived.
 */
export async function checkCardOne(input: {
  sandbox: ProcessSandbox;
  root: string;
  gate?: GateDefinition;
  tests: readonly string[];
}): Promise<CardOneVerdict> {
  const gate =
    input.gate ??
    loadGatesConfig(input.root).gates.find((g) => g.layer === "functional" && g.rung === "test");
  if (!gate) return { passed: false, detail: "not run: the project has no test check yet" };
  return cardOneVerdict(await runAcceptanceTests(input.sandbox, input.root, gate, input.tests));
}

/** The gate id card one's own functional gate reports under. */
export const CARD_ONE_GATE = "card-one";

/**
 * Card one's functional gate in place of the unit gate (DS-P2-3): the test
 * rung is judged by `checkCardOne` — card one's test run through the
 * project's test gate, confined, passing only when it fails at an
 * assertion. Every other rung is the inner runner's.
 */
export function withCardOneGate(
  inner: GateRunner,
  options: { sandbox: ProcessSandbox; tests: readonly string[]; gate?: GateDefinition | undefined },
): GateRunner {
  return {
    gateIds: [...(inner.gateIds ?? []), CARD_ONE_GATE],
    runGates: async (rungs, cwd, runOptions) => {
      if (!rungs.includes("test")) return inner.runGates(rungs, cwd, runOptions);
      const others = rungs.filter((r) => r !== "test");
      const rest = others.length
        ? await inner.runGates(others, cwd, runOptions)
        : { passed: true, failures: [], durationMs: 0, rungResults: [] };
      const started = Date.now();
      const verdict = await checkCardOne({
        sandbox: options.sandbox,
        root: cwd,
        tests: options.tests,
        ...(options.gate ? { gate: options.gate } : {}),
      });
      const durationMs = Date.now() - started;
      const outcome: RungOutcome = {
        gate: CARD_ONE_GATE,
        rung: "test",
        layer: "functional",
        passed: verdict.passed,
        exitCode: verdict.passed ? 0 : 1,
        durationMs,
        ...(verdict.passed ? {} : { reason: verdict.detail }),
      };
      const failures: GateFailure[] = verdict.passed
        ? []
        : [
            {
              rung: "test",
              gate: CARD_ONE_GATE,
              layer: "functional",
              exitCode: 1,
              errorExcerpt: CARD_ONE_COPY.gateFailed(verdict.detail),
              suggestedFixFiles: [...options.tests],
              location: { file: options.tests[0] ?? "." },
              expected: CARD_ONE_COPY.gateExpected,
              actual: verdict.detail,
              minimalRepro: options.gate
                ? [options.gate.command, ...options.gate.args, ...options.tests].join(" ")
                : options.tests.join(" "),
              suggestedAction: CARD_ONE_COPY.gateAction,
            },
          ];
      return {
        ...rest,
        passed: rest.passed && verdict.passed,
        failures: [...rest.failures, ...failures],
        durationMs: rest.durationMs + durationMs,
        rungResults: [...(rest.rungResults ?? []), outcome],
      };
    },
  };
}
