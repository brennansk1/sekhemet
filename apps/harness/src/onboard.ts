import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import {
  DEFAULT_LSP_SERVERS,
  LspClient,
  buildRankedRepoMap,
  loadProjectConventions,
} from "@sekhemet/context";
import {
  BASELINE_EVENT,
  type BaselineEntry,
  DeterministicGateRunner,
  baselineFromEvents,
  captureBaseline,
  loadGatesConfig,
  partialFiles,
  readWorkspace,
  verificationRungs,
} from "@sekhemet/gates";
import type { CardStore, EventLog } from "@sekhemet/kernel";
import {
  type LocalInferenceAdapter,
  type ModelRegistry,
  QUALIFICATION_CASES,
  type QualificationCase,
  qualifyModel,
} from "@sekhemet/models";
import { confinedSandbox } from "@sekhemet/sandbox";
import { readCiSteps } from "./ci_files.js";
import { type CiStep, deriveGates, installGates, shellWord } from "./init.js";
import { applyExploration, exploreProject } from "./learning/explore.js";
import { LearningStore } from "./learning/store.js";
import { ownRepoGitEnv } from "./takeover_recon.js";
import { isWorkspaceTrusted } from "./workspace_trust.js";

/**
 * `sekhemet onboard` (X1, design "Onboarding run"): the eight steps, in
 * order, each writing what it learned under `.sekhemet/onboard/` so the
 * next card does not rediscover it:
 *
 *   1. the ranked repo map, cached with its key;
 *   2. headless language servers started, and which succeeded;
 *   3. build, test, lint and format commands from manifests and CI configs;
 *   4. a proposed gates.toml (the live one is never overwritten here);
 *   5. conventions (naming, layout, test style, error patterns) as a draft
 *      playbook with evidence;
 *   6. drafts of AGENTS.md and CLAUDE.md;
 *   7. the qualification suite for the machine's models, with cases built
 *      from this repository's own files;
 *   8. the onboarding baseline: what already fails, recorded on the ledger
 *      so cards count only new failures (gates rule 15a).
 *
 * Nothing is enforced until the user reviews it: `--apply` installs the
 * proposed gates and the AGENTS.md / CLAUDE.md drafts.
 *
 * Trust comes first (surface item 9, SUR-56; security item 38a): before the
 * person trusts the repository only files and git objects are read — steps
 * 2 and 8, which start language servers and run the project's gates, are
 * skipped and say so. A different live `gates.toml` is shown as a diff and
 * replaced only on confirmation, keeping a backup (item 10, SUR-7); the
 * AGENTS.md section is one marked block replaced in place (SUR-9), holding
 * only commands and locations no gate enforces (item 9a, SUR-37).
 */
export interface DetectedCommand {
  kind: "build" | "test" | "lint" | "format" | "typecheck";
  command: string;
  source: string;
}

export interface Conventions {
  fileNaming: Record<string, number>;
  dominantNaming: string;
  testLayout: "colocated" | "tests-dir" | "none";
  testStyle: string[];
  errorPatterns: string[];
  sourceRoots: string[];
  documented: string;
}

export interface OnboardReport {
  repoMap: { files: number; tokens: number; cacheKey: string };
  languageServers: { language: string; command: string; ok: boolean; detail: string }[];
  commands: DetectedCommand[];
  gatesProposal: { path: string; gates: string[] };
  conventions: Conventions;
  rulesProposed: number;
  drafts: string[];
  qualification: { modelId: string; passRate: number; qualified: boolean }[];
  applied: string[];
  /** Whether the repository was trusted to run its code (SUR-56). */
  trusted: boolean;
  /** The live gates.toml against the proposal, `-`/`+` lines; empty when equal or absent (SUR-7). */
  gatesDiff: string;
  /** Every CI step with the gate it became or why not (item 9b, SUR-35). */
  ciCoverage: CiStep[];
  /** The workspace graph recorded at onboarding (item 9d, SUR-39). */
  workspace?: WorkspaceGraph;
  /**
   * Step 8, the onboarding baseline (gates rule 15a, GT-BF-2): how many
   * pre-existing findings it holds, how many are flaky tests, and whether it
   * is on the ledger. Absent when the step was switched off.
   */
  baseline?: { entries: number; flaky: number; recorded: boolean; path: string };
}

const SKIP = new Set([
  "node_modules",
  "dist",
  ".git",
  ".sekhemet",
  "coverage",
  "build",
  "target",
  ".venv",
]);

function walk(root: string, max = 3000): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < max) {
    const dir = stack.pop() as string;
    let names: string[] = [];
    try {
      names = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      if (SKIP.has(n) || (n.startsWith(".") && n !== ".github")) continue;
      const p = join(dir, n);
      try {
        if (statSync(p).isDirectory()) stack.push(p);
        else out.push(relative(root, p).replace(/\\/g, "/"));
      } catch {
        // unreadable
      }
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------- step 3

export function detectCommands(root: string): DetectedCommand[] {
  const out: DetectedCommand[] = [];
  const add = (kind: DetectedCommand["kind"], command: string, source: string) => {
    if (!out.some((c) => c.kind === kind && c.command === command))
      out.push({ kind, command, source });
  };
  const classify = (name: string): DetectedCommand["kind"] | undefined =>
    /^(test|test:.*|spec)$/.test(name)
      ? "test"
      : /^(lint|lint:.*|check)$/.test(name)
        ? "lint"
        : /^(format|fmt|prettier)$/.test(name)
          ? "format"
          : /^(typecheck|type-check|tsc|check-types)$/.test(name)
            ? "typecheck"
            : /^(build|compile)$/.test(name)
              ? "build"
              : undefined;
  const pkg = join(root, "package.json");
  if (existsSync(pkg)) {
    const scripts =
      (JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
    const pm = existsSync(join(root, "pnpm-lock.yaml"))
      ? "pnpm"
      : existsSync(join(root, "yarn.lock"))
        ? "yarn"
        : "npm";
    for (const name of Object.keys(scripts).sort()) {
      const kind = classify(name);
      if (kind) add(kind, `${pm} run ${name}`, "package.json");
    }
  }
  const py = join(root, "pyproject.toml");
  if (existsSync(py)) {
    const t = readFileSync(py, "utf8");
    add("test", "pytest -q", "pyproject.toml");
    if (/ruff/.test(t)) add("lint", "ruff check .", "pyproject.toml");
    if (/ruff/.test(t) || /black/.test(t))
      add("format", /ruff/.test(t) ? "ruff format ." : "black .", "pyproject.toml");
    if (/mypy/.test(t)) add("typecheck", "mypy .", "pyproject.toml");
  }
  if (existsSync(join(root, "Cargo.toml"))) {
    add("build", "cargo build", "Cargo.toml");
    add("test", "cargo test", "Cargo.toml");
    add("lint", "cargo clippy -- -D warnings", "Cargo.toml");
    add("format", "cargo fmt --check", "Cargo.toml");
  }
  if (existsSync(join(root, "go.mod"))) {
    add("build", "go build ./...", "go.mod");
    add("test", "go test ./...", "go.mod");
    add("lint", "go vet ./...", "go.mod");
  }
  const mk = join(root, "Makefile");
  if (existsSync(mk)) {
    for (const m of readFileSync(mk, "utf8").matchAll(/^([a-zA-Z][\w-]*):/gm)) {
      const kind = classify(m[1] as string);
      if (kind) add(kind, `make ${m[1]}`, "Makefile");
    }
  }
  // CI commands from the one CI reader (YAML-parsed, DEC-44): GitHub
  // Actions and GitLab CI, block scalars included.
  for (const step of readCiSteps(root)) {
    // A step in a subdirectory is that directory's command (fix review C2a).
    const cmd =
      step.command && step.directory && !step.directory.includes("${{")
        ? `cd ${shellWord(step.directory)} && ${step.command}`
        : step.command;
    if (!cmd) continue;
    const kind: DetectedCommand["kind"] | undefined = /\btest\b/.test(cmd)
      ? "test"
      : /\blint\b|clippy|ruff check|eslint|biome/.test(cmd)
        ? "lint"
        : /typecheck|tsc|mypy/.test(cmd)
          ? "typecheck"
          : /\bbuild\b/.test(cmd)
            ? "build"
            : /fmt|format|prettier/.test(cmd)
              ? "format"
              : undefined;
    if (kind) add(kind, cmd, step.file);
  }
  return out;
}

// ---------------------------------------------------------------- step 5

function namingStyle(stem: string): string {
  if (/^[a-z0-9]+$/.test(stem)) return "lowercase";
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(stem)) return "kebab-case";
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(stem)) return "snake_case";
  if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(stem)) return "camelCase";
  if (/^[A-Z][A-Za-z0-9]*$/.test(stem)) return "PascalCase";
  return "mixed";
}

const SOURCE = /\.(ts|tsx|js|jsx|mjs|py|rs|go)$/;
const TEST = /(\.|_)(spec|test)\.[a-z]+$|^test_.*\.py$|(^|\/)tests?\//;

/** Conventions of a set of files (step 5; also what drift re-measures, X2). */
export function measureConventions(root: string, files: string[]): Conventions {
  const source = files.filter((f) => SOURCE.test(f));
  const fileNaming: Record<string, number> = {};
  for (const f of source) {
    const stem = basename(f, extname(f)).replace(/\.(spec|test)$/, "");
    const s = namingStyle(stem);
    if (s !== "lowercase") fileNaming[s] = (fileNaming[s] ?? 0) + 1;
  }
  const dominantNaming =
    Object.entries(fileNaming).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ??
    "lowercase";
  const tests = source.filter((f) => TEST.test(f));
  const inTestsDir = tests.filter((f) => /(^|\/)tests?\//.test(f)).length;
  const testLayout =
    tests.length === 0 ? "none" : inTestsDir * 2 >= tests.length ? "tests-dir" : "colocated";
  const style = new Set<string>();
  const errors = new Map<string, number>();
  for (const f of source.slice(0, 400)) {
    let text = "";
    try {
      text = readFileSync(join(root, f), "utf8");
    } catch {
      continue;
    }
    if (TEST.test(f)) {
      if (/\bdescribe\(/.test(text)) style.add("describe/it blocks");
      if (/from "vitest"/.test(text)) style.add("vitest");
      if (/from "@jest|jest\./.test(text)) style.add("jest");
      if (/^def test_/m.test(text)) style.add("pytest functions");
      if (/#\[test\]/.test(text)) style.add("#[test] functions");
    }
    for (const m of text.matchAll(/throw new (\w+Error)\(/g))
      errors.set(m[1] as string, (errors.get(m[1] as string) ?? 0) + 1);
    if (/Result<.*,\s*\w+Error>/.test(text))
      errors.set("Result<_, Error>", (errors.get("Result<_, Error>") ?? 0) + 1);
    if (/raise \w+Error\(/.test(text))
      errors.set("raise ...Error", (errors.get("raise ...Error") ?? 0) + 1);
  }
  const roots = new Map<string, number>();
  for (const f of source.filter((x) => !TEST.test(x))) {
    const top = f.includes("/")
      ? f
          .split("/")
          .slice(0, f.startsWith("packages/") || f.startsWith("apps/") ? 3 : 1)
          .join("/")
      : ".";
    roots.set(top, (roots.get(top) ?? 0) + 1);
  }
  return {
    fileNaming,
    dominantNaming,
    testLayout,
    testStyle: [...style].sort(),
    errorPatterns: [...errors.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([e]) => e),
    sourceRoots: [...roots.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([r]) => r),
    documented: loadProjectConventions(root, 250),
  };
}

// ---------------------------------------------------------------- step 6

export function agentsDraft(root: string, commands: DetectedCommand[], c: Conventions): string {
  const byKind = (k: DetectedCommand["kind"]) =>
    commands.filter((x) => x.kind === k).map((x) => `\`${x.command}\``);
  const lines = [
    `# AGENTS.md: ${basename(root)}`,
    "",
    "Generated by `sekhemet onboard` from this repository. Review before committing; edit freely.",
    "",
    "## Commands",
    ...(["build", "typecheck", "lint", "format", "test"] as const)
      .filter((k) => byKind(k).length)
      .map((k) => `- ${k}: ${byKind(k).join(", ")}`),
    "",
    "## Code Conventions",
    `- File names: ${c.dominantNaming}.`,
    `- Tests: ${c.testLayout === "tests-dir" ? "under tests/" : c.testLayout === "colocated" ? "next to the source" : "none found yet"}${c.testStyle.length ? ` (${c.testStyle.join(", ")})` : ""}.`,
    ...(c.errorPatterns.length ? [`- Errors: ${c.errorPatterns.join(", ")}.`] : []),
    ...(c.sourceRoots.length ? [`- Source lives in: ${c.sourceRoots.join(", ")}.`] : []),
    "",
  ];
  // SUR-37: only commands and locations; a rule a gate enforces (change
  // size, test-first, protected tests) is not repeated to other agents.
  return lines.join("\n");
}

const AGENTS_BEGIN = "<!-- sekhemet:begin -->";
const AGENTS_END = "<!-- sekhemet:end -->";

/**
 * AGENTS.md with Sekhemet's one marked block (item 10, SUR-9): replaced in
 * place when present, appended once when not; the person's text around it
 * is kept as written.
 */
export function withAgentsBlock(existing: string, draft: string): string {
  const body = draft.split("\n").slice(4).join("\n").trim();
  const block = `${AGENTS_BEGIN}\n## Sekhemet: commands and locations\n\n${body}\n${AGENTS_END}`;
  if (!existing) return `${draft.split("\n").slice(0, 4).join("\n")}\n${block}\n`;
  const start = existing.indexOf(AGENTS_BEGIN);
  const end = existing.indexOf(AGENTS_END);
  if (start !== -1 && end > start) {
    return `${existing.slice(0, start)}${block}${existing.slice(end + AGENTS_END.length)}`;
  }
  return `${existing.trimEnd()}\n\n${block}\n`;
}

// ------------------------------------------------ item 9d: the workspace graph

export interface WorkspaceGraph {
  tool?: string;
  packages: { name: string; dir: string; deps: string[] }[];
  /** Workspace packages, dependencies first. */
  buildOrder: string[];
  /** TypeScript project references: each tsconfig's directory and the directories it references. */
  tsReferences: { dir: string; references: string[] }[];
}

function tsReferences(root: string): WorkspaceGraph["tsReferences"] {
  const out: WorkspaceGraph["tsReferences"] = [];
  const seen = new Set<string>();
  const visit = (dir: string) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const file = join(root, dir, "tsconfig.json");
    if (!existsSync(file)) return;
    let refs: string[] = [];
    try {
      // tsconfig allows comments and trailing commas; strip the common forms.
      const text = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/,(\s*[}\]])/g, "$1");
      const parsed = JSON.parse(text) as { references?: { path?: string }[] };
      refs = (parsed.references ?? [])
        .map((r) => r.path)
        .filter((p): p is string => typeof p === "string")
        .map(
          (p) =>
            relative(root, join(root, dir, p))
              .replace(/\\/g, "/")
              .replace(/\/tsconfig[^/]*\.json$/, "") || ".",
        );
    } catch {
      return;
    }
    if (refs.length) out.push({ dir, references: [...refs].sort() });
    for (const r of refs) visit(r);
  };
  visit(".");
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * Record the workspace at onboarding (item 9d, SUR-39): pnpm, npm and yarn
 * workspaces (read by `@manypkg/get-packages`) with each package's name,
 * workspace dependencies and the build order, and the TypeScript project
 * references, in `.sekhemet/onboard/workspace.json`. Undefined when the
 * repository has neither.
 */
export function recordWorkspaceGraph(root: string, dir: string): WorkspaceGraph | undefined {
  const ws = readWorkspace(root);
  const refs = tsReferences(root);
  if (!ws && refs.length === 0) return undefined;
  const packages = (ws?.packages ?? []).map((p) => ({ name: p.name, dir: p.dir, deps: p.deps }));
  const order: string[] = [];
  const byName = new Map(packages.map((p) => [p.name, p]));
  const visiting = new Set<string>();
  const place = (name: string) => {
    if (order.includes(name) || visiting.has(name)) return;
    visiting.add(name);
    for (const d of byName.get(name)?.deps ?? []) place(d);
    visiting.delete(name);
    order.push(name);
  };
  for (const p of [...packages].sort(
    (a, b) => a.deps.length - b.deps.length || a.name.localeCompare(b.name),
  ))
    place(p.name);
  const graph: WorkspaceGraph = {
    ...(ws ? { tool: ws.tool } : {}),
    packages,
    buildOrder: order,
    tsReferences: refs,
  };
  writeFileSync(join(dir, "workspace.json"), `${JSON.stringify(graph, null, 2)}\n`);
  return graph;
}

// ---------------------------------------------------------------- step 7

/** Qualification cases grounded in this repository's own files. */
export function repoQualificationCases(files: string[]): QualificationCase[] {
  const src = files.filter((f) => SOURCE.test(f) && !TEST.test(f)).slice(0, 2);
  return src.map((f, i) => ({
    id: `repo-read-${i + 1}`,
    category: "arguments" as const,
    prompt: `Open ${f} so we can see how it is written.`,
    score: (calls) =>
      calls[0]?.name === "read_file" &&
      String(calls[0].arguments.path ?? "").replace(/^\.\//, "") === f
        ? undefined
        : `expected read_file ${f}`,
  }));
}

export interface OnboardOptions {
  apply?: boolean;
  /** Replace a different live gates.toml (its diff was shown), keeping a backup (SUR-7). */
  confirm?: boolean;
  /** Trusted to run repository code; default: the user directory's record (SUR-56). */
  trusted?: boolean;
  /** Models to qualify (step 7); none: the step is skipped and says so. */
  models?: LocalInferenceAdapter[];
  registry?: ModelRegistry;
  release?: (a: LocalInferenceAdapter) => Promise<void>;
  /** Language servers per language (tests inject a fake). */
  lspServers?: typeof DEFAULT_LSP_SERVERS;
  lspTimeoutMs?: number;
  store?: { log: EventLog; cardStore: CardStore };
  say?: (line: string) => void;
  /**
   * Step 8, the onboarding baseline (gates rule 15a): run the gates, the
   * suite twice, confined with no network, and record what already fails.
   * Default on.
   */
  baseline?: boolean;
  /** A read-only audit (S12): only the static gates run for the baseline. */
  restricted?: boolean;
}

export async function runOnboard(root: string, opts: OnboardOptions = {}): Promise<OnboardReport> {
  const say = opts.say ?? ((l: string) => console.log(l));
  const dir = join(root, ".sekhemet", "onboard");
  mkdirSync(dir, { recursive: true });
  const files = walk(root);

  // 1. Repo map, cached.
  const map = buildRankedRepoMap(root, { budgetTokens: 4000 });
  writeFileSync(join(dir, "repo_map.txt"), map.text);
  writeFileSync(join(dir, "repo_map.key"), `${map.cacheKey}\n`);
  say(
    `1. Repo map: ${map.files.length} of ${map.considered} files, ${map.usedTokens} tokens (key ${map.cacheKey}).`,
  );

  // 2. Language servers.
  const langs = new Set<string>();
  for (const f of files) {
    if (/\.(ts|tsx|js|jsx)$/.test(f)) langs.add("typescript");
    if (/\.py$/.test(f)) langs.add("python");
    if (/\.rs$/.test(f)) langs.add("rust");
  }
  const servers = opts.lspServers ?? DEFAULT_LSP_SERVERS;
  const languageServers: OnboardReport["languageServers"] = [];
  const trusted = opts.trusted ?? isWorkspaceTrusted(root);
  for (const language of [...langs].sort()) {
    const server = servers[language];
    if (!server) continue;
    if (!trusted) {
      // SUR-56: a language server loads repository configuration and plugins.
      languageServers.push({
        language,
        command: server.command,
        ok: false,
        detail: "not started: the repository is not trusted",
      });
      say(
        `2. ${language} language server not started: this repository is not trusted yet (\`sekhemet dev trust\` shows what would run).`,
      );
      continue;
    }
    const client = new LspClient(server, root, opts.lspTimeoutMs ?? 10_000);
    let ok = false;
    let detail = "";
    try {
      await client.initialize();
      ok = true;
      detail = "initialized";
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
    }
    await client.shutdown().catch(() => undefined);
    languageServers.push({ language, command: server.command, ok, detail });
    say(
      `2. ${language} language server (${server.command}): ${ok ? "ok" : `unavailable (${detail})`}.`,
    );
  }

  // 3. Commands.
  const commands = detectCommands(root);
  say(`3. Commands: ${commands.map((c) => `${c.kind} ${c.command}`).join("; ") || "none found"}.`);

  // 4. Proposed gates, from the one deriver (the live gates.toml is never
  // touched here): the CI coverage beside them (item 9b, SUR-35).
  const derived = deriveGates(root);
  const toml = derived.toml;
  const gatesPath = join(dir, "gates.proposed.toml");
  writeFileSync(gatesPath, toml);
  const gates = derived.gates;
  writeFileSync(join(dir, "ci_coverage.json"), `${JSON.stringify(derived.ci, null, 2)}\n`);
  say(`4. Proposed checks (${relative(root, gatesPath)}): ${gates.join("; ") || "none"}.`);
  for (const step of derived.ci) {
    say(
      `   CI ${step.file}:${step.line}${step.directory ? ` (in ${step.directory}/)` : ""} ${step.command} → ${step.gate ? `check ${step.gate}` : (step.reason ?? "").replace(/_/g, " ")}${step.detail ? ` (${step.detail})` : ""}`,
    );
  }
  const liveGates = join(root, ".sekhemet", "gates.toml");
  const gatesDiff = existsSync(liveGates) ? installGates(root, toml, false).diff : "";
  const workspace = recordWorkspaceGraph(root, dir);

  // 5. Conventions and a draft playbook.
  const conventions = measureConventions(root, files);
  writeFileSync(join(dir, "conventions.json"), `${JSON.stringify(conventions, null, 2)}\n`);
  try {
    // Drift (X2) compares commits made after this point.
    writeFileSync(
      join(dir, "head.txt"),
      `${execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: ownRepoGitEnv(root),
      }).trim()}\n`,
    );
  } catch {
    // Not a git repository yet.
  }
  let rulesProposed = 0;
  if (opts.store) {
    const learning = new LearningStore(opts.store.log);
    const explored = await applyExploration(
      learning,
      root,
      false,
      await opts.store.cardStore.listCards(),
    );
    rulesProposed += explored.proposed;
    // The conventions themselves go to the AGENTS.md draft (step 6), which
    // the Worker reads as project conventions: a rule restating one would
    // have no scope and reach every prompt (context rules 24b, 24c).
  } else {
    rulesProposed = exploreProject(root).length;
  }
  say(
    `5. Conventions: ${conventions.dominantNaming} files, tests ${conventions.testLayout}; ${rulesProposed} draft rule(s) for the playbook (candidates until approved).`,
  );

  // 6. AGENTS.md / CLAUDE.md drafts.
  const agents = agentsDraft(root, commands, conventions);
  const drafts: string[] = [];
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const existing = existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : "";
    const body =
      name === "AGENTS.md"
        ? withAgentsBlock(existing, agents)
        : existing ||
          `# CLAUDE.md\n\nFollow [AGENTS.md](AGENTS.md): it lists this repository's commands and conventions.\n`;
    const draft = join(dir, `${name}.draft`);
    writeFileSync(draft, body);
    drafts.push(relative(root, draft));
  }
  say(`6. Drafts: ${drafts.join(", ")}.`);

  // 7. Qualification on this repository.
  const qualification: OnboardReport["qualification"] = [];
  if (opts.models?.length) {
    const cases = [...QUALIFICATION_CASES, ...repoQualificationCases(files)];
    for (const m of opts.models) {
      const { best } = await qualifyModel(m, {
        ...(opts.registry ? { registry: opts.registry } : {}),
        cases,
      });
      qualification.push({
        modelId: m.modelId,
        passRate: best.passRate,
        qualified: best.qualified,
      });
      say(
        `7. ${m.modelId}: ${(best.passRate * 100).toFixed(0)}% ${best.qualified ? "verified on this machine" : "not verified on this machine"} on ${cases.length} cases.`,
      );
      await opts.release?.(m);
    }
  } else {
    say(
      "7. Verification skipped: pass --models to verify this machine's models on this repository.",
    );
  }

  const applied: string[] = [];
  if (opts.apply) {
    const installed = installGates(root, toml, opts.confirm === true);
    if (installed.state === "written" || installed.state === "replaced") {
      applied.push(".sekhemet/gates.toml");
    }
    if (installed.state === "replaced") say(`Kept the previous checks as ${installed.backup}.`);
    if (installed.state === "needs_confirmation") {
      say("Your .sekhemet/gates.toml differs from the proposal; kept. The difference:");
      for (const l of installed.diff.split("\n")) say(`   ${l}`);
      say("Rerun with --apply --yes to replace it (the old file is kept as gates.toml.bak).");
    }
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      writeFileSync(join(root, name), readFileSync(join(dir, `${name}.draft`), "utf8"));
      applied.push(name);
    }
    // Drift is measured against what the person accepted (item 12, SUR-10).
    writeFileSync(
      join(dir, "conventions.json"),
      `${JSON.stringify({ ...conventions, documented: loadProjectConventions(root, 250) }, null, 2)}\n`,
    );
    say(`Applied: ${applied.join(", ")}.`);
  } else {
    say(
      "Review .sekhemet/onboard/ and rerun with --apply to install the checks and the AGENTS.md / CLAUDE.md drafts.",
    );
  }

  // 8. The onboarding baseline, on the gates cards will run (after --apply,
  // the proposed ones): what already fails is recorded, so a card is never
  // asked to fix what it did not write (gates rule 15a, GT-BF-2).
  let baseline: OnboardReport["baseline"];
  if (opts.baseline !== false && !trusted) {
    say(
      "8. Baseline not taken: it runs the project's checks, and this repository is not trusted yet.",
    );
  } else if (opts.baseline !== false) {
    baseline = await recordOnboardingBaseline(root, dir, opts.store?.log, opts.restricted === true);
    say(
      `8. Baseline: ${baseline.entries} pre-existing finding(s), ${baseline.flaky} flaky test(s)${baseline.recorded ? ", on the ledger" : ""} (${baseline.path}); issues count only new ones.`,
    );
  }

  const report: OnboardReport = {
    repoMap: { files: map.files.length, tokens: map.usedTokens, cacheKey: map.cacheKey },
    languageServers,
    commands,
    gatesProposal: { path: relative(root, gatesPath), gates },
    conventions,
    rulesProposed,
    drafts,
    qualification,
    applied,
    trusted,
    gatesDiff,
    ciCoverage: derived.ci,
    ...(workspace ? { workspace } : {}),
    ...(baseline ? { baseline } : {}),
  };
  writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

// ------------------------------------------------ step 8: the onboarding baseline

/**
 * Take the onboarding baseline (gates rule 15a, GT-BF-2; design-stage
 * DS-TO-6): every blocking gate the project runs — the static ones once, the
 * suite twice — confined, with no network and no verdict cache, and record it
 * as one `project/baseline` event with each run's command and exit code.
 * Written to `.sekhemet/onboard/baseline.json` too, for the person to read.
 */
export async function recordOnboardingBaseline(
  root: string,
  dir: string,
  log: EventLog | undefined,
  restricted = false,
): Promise<NonNullable<OnboardReport["baseline"]>> {
  const gatesConfig = loadGatesConfig(root);
  const runner = new DeterministicGateRunner(confinedSandbox(restricted), {
    repoRoot: root,
    expectedConfigSha256: gatesConfig.sha256,
    maxFailuresReported: Number.POSITIVE_INFINITY,
    verdictCache: false,
  });
  // In a workspace, every package's own gates too, as a card's run has them
  // (rule 34a, review M3): the tree is the base.
  const ws = readWorkspace(root);
  const taken = await captureBaseline({
    runner,
    root,
    rungs: verificationRungs(gatesConfig.gates, restricted),
    gates: gatesConfig.gates,
    ...(ws ? { workspace: { base: "HEAD", changed: ws.packages.map((p) => p.dir) } } : {}),
  });
  const payload = {
    kind: "recorded",
    entries: taken.entries,
    runs: taken.runs,
    // Minor 1: flaky tests are left to quarantine, and listed.
    flaky: taken.flaky,
    // Review M2: files the source index reads only in part are pre-existing.
    partial: partialFiles(root),
    gatesSha256: gatesConfig.sha256,
  };
  const path = join(dir, "baseline.json");
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
  if (log) await log.append({ actor: "system", type: BASELINE_EVENT, payload });
  return {
    entries: taken.entries.length,
    flaky: taken.flaky.length,
    recorded: log !== undefined,
    path: relative(root, path),
  };
}

/** The baseline in force, from the ledger (GT-BF-2); undefined when onboarding never recorded one. */
export async function loadBaseline(
  log: Pick<EventLog, "getEventsByTypes">,
): Promise<ReturnType<typeof baselineFromEvents>> {
  return baselineFromEvents(await log.getEventsByTypes([BASELINE_EVENT, "card/accepted"]));
}

/** What records a baseline event: the event log, or the card store's project-wide facts. */
export interface BaselineWriter {
  append(params: { actor: string; type: string; payload: unknown }): Promise<unknown>;
}

/**
 * Record baselined diagnostics a card's gates no longer found (rule 15a):
 * the baseline shrinks by them once the card is accepted.
 */
export async function recordBaselineShrink(
  log: BaselineWriter,
  gone: readonly BaselineEntry[],
  card?: string,
  gates?: readonly string[],
): Promise<void> {
  // Review M4: a card's run that judged its gates and found every baselined
  // diagnostic still there is recorded too — its shrink is the card's last
  // judged run's, so an earlier run's disappearance is taken back. Without a
  // card there is nothing to take back.
  if (gone.length === 0 && (card === undefined || !gates?.length)) return;
  await log.append({
    actor: "system",
    type: BASELINE_EVENT,
    payload: {
      kind: "shrink",
      fingerprints: gone.map((e) => e.fingerprint),
      ...(card ? { card } : {}),
      ...(gates?.length ? { gates: [...gates] } : {}),
    },
  });
}

// ----------------------------------------------------------- X2: convention drift

export interface DriftItem {
  aspect: string;
  was: string;
  now: string;
}

/**
 * Re-measure conventions over the files changed in recent commits and diff
 * them against the onboarding snapshot and the playbook (X2). A drift is
 * posted as a note from Seshat (planner) and recorded on the ledger.
 */
export function detectConventionDrift(
  root: string,
  sinceDays = 7,
): { drift: DriftItem[]; files: number } {
  const snapPath = join(root, ".sekhemet", "onboard", "conventions.json");
  if (!existsSync(snapPath)) return { drift: [], files: 0 };
  const was = JSON.parse(readFileSync(snapPath, "utf8")) as Conventions;
  let changed: string[] = [];
  try {
    const headPath = join(root, ".sekhemet", "onboard", "head.txt");
    const base = existsSync(headPath) ? readFileSync(headPath, "utf8").trim() : "";
    const range = base ? [`${base}..HEAD`] : [];
    changed = execFileSync(
      "git",
      ["log", `--since=${sinceDays}.days`, "--name-only", "--format=", ...range],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: ownRepoGitEnv(root),
      },
    )
      .split("\n")
      .map((l) => l.trim())
      .filter((f) => f && existsSync(join(root, f)));
  } catch {
    return { drift: [], files: 0 };
  }
  const files = [...new Set(changed)];
  if (files.length === 0) return { drift: [], files: 0 };
  const now = measureConventions(root, files);
  const drift: DriftItem[] = [];
  const total = Object.values(now.fileNaming).reduce((a, b) => a + b, 0);
  if (total >= 3 && now.dominantNaming !== was.dominantNaming) {
    drift.push({ aspect: "file naming", was: was.dominantNaming, now: now.dominantNaming });
  }
  if (now.testLayout !== "none" && was.testLayout !== "none" && now.testLayout !== was.testLayout) {
    drift.push({ aspect: "test layout", was: was.testLayout, now: now.testLayout });
  }
  const newStyles = now.testStyle.filter((s) => !was.testStyle.includes(s));
  if (newStyles.length)
    drift.push({
      aspect: "test style",
      was: was.testStyle.join(", ") || "none",
      now: newStyles.join(", "),
    });
  // SUR-10: the documented conventions drift only when a commit changed
  // AGENTS.md or CLAUDE.md, measured the way the snapshot was.
  const documentedNow = loadProjectConventions(root, 250);
  const docsChanged = files.some((f) => f === "AGENTS.md" || f === "CLAUDE.md");
  if (docsChanged && was.documented && documentedNow && documentedNow !== was.documented) {
    drift.push({
      aspect: "documented conventions",
      was: "the onboarding snapshot",
      now: "AGENTS.md/CLAUDE.md changed",
    });
  }
  return { drift, files: files.length };
}

export async function postConventionDrift(
  root: string,
  log: EventLog,
  sinceDays = 7,
): Promise<DriftItem[]> {
  const { drift, files } = detectConventionDrift(root, sinceDays);
  if (drift.length === 0) return [];
  const text = [
    `Convention drift over the last ${sinceDays} days (${files} changed files):`,
    ...drift.map((d) => `- ${d.aspect}: was ${d.was}, now ${d.now}`),
    "Rerun `sekhemet onboard` to refresh the conventions, or tell me which one is right.",
  ].join("\n");
  const { PmStore } = await import("./pm/store.js");
  await new PmStore(log).appendReply({ replyTo: [], text, model: "ledger" });
  await log.append({
    actor: "planner",
    type: "convention/drift",
    payload: { drift, files, sinceDays },
  });
  return drift;
}
