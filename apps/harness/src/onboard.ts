import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import {
  DEFAULT_LSP_SERVERS,
  LspClient,
  buildRankedRepoMap,
  extractConventions,
  loadProjectConventions,
} from "@sekhemet/context";
import { detectGateTemplate, gateTemplate, renderGatesToml } from "@sekhemet/gates";
import type { CardStore, EventLog } from "@sekhemet/kernel";
import {
  type LocalInferenceAdapter,
  type ModelRegistry,
  QUALIFICATION_CASES,
  type QualificationCase,
  qualifyModel,
} from "@sekhemet/models";
import { deriveGates } from "./init.js";
import { applyExploration, exploreProject } from "./learning/explore.js";
import { LearningStore } from "./learning/store.js";

/**
 * `sekhemet onboard` (X1, design "Onboarding run"): the seven steps, in
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
 *      from this repository's own files.
 *
 * Nothing is enforced until the user reviews it: `--apply` installs the
 * proposed gates and the AGENTS.md / CLAUDE.md drafts.
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
}

const SKIP = new Set(["node_modules", "dist", ".git", ".sekhemet", "coverage", "build", "target", ".venv"]);

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
    if (!out.some((c) => c.kind === kind && c.command === command)) out.push({ kind, command, source });
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
    const scripts = (JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
    const pm = existsSync(join(root, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(root, "yarn.lock")) ? "yarn" : "npm";
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
    if (/ruff/.test(t) || /black/.test(t)) add("format", /ruff/.test(t) ? "ruff format ." : "black .", "pyproject.toml");
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
  const wf = join(root, ".github", "workflows");
  if (existsSync(wf)) {
    for (const f of readdirSync(wf).filter((n) => /\.ya?ml$/.test(n)).sort()) {
      for (const m of readFileSync(join(wf, f), "utf8").matchAll(/^\s*(?:-\s*)?run:\s*(.+)$/gm)) {
        const cmd = (m[1] as string).trim().replace(/^["']|["']$/g, "");
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
        if (kind) add(kind, cmd, `.github/workflows/${f}`);
      }
    }
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
    Object.entries(fileNaming).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "lowercase";
  const tests = source.filter((f) => TEST.test(f));
  const inTestsDir = tests.filter((f) => /(^|\/)tests?\//.test(f)).length;
  const testLayout = tests.length === 0 ? "none" : inTestsDir * 2 >= tests.length ? "tests-dir" : "colocated";
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
    for (const m of text.matchAll(/throw new (\w+Error)\(/g)) errors.set(m[1] as string, (errors.get(m[1] as string) ?? 0) + 1);
    if (/Result<.*,\s*\w+Error>/.test(text)) errors.set("Result<_, Error>", (errors.get("Result<_, Error>") ?? 0) + 1);
    if (/raise \w+Error\(/.test(text)) errors.set("raise ...Error", (errors.get("raise ...Error") ?? 0) + 1);
  }
  const roots = new Map<string, number>();
  for (const f of source.filter((x) => !TEST.test(x))) {
    const top = f.includes("/") ? f.split("/").slice(0, f.startsWith("packages/") || f.startsWith("apps/") ? 3 : 1).join("/") : ".";
    roots.set(top, (roots.get(top) ?? 0) + 1);
  }
  return {
    fileNaming,
    dominantNaming,
    testLayout,
    testStyle: [...style].sort(),
    errorPatterns: [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([e]) => e),
    sourceRoots: [...roots.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r]) => r),
    documented: loadProjectConventions(root, 250),
  };
}

function conventionRules(c: Conventions): { text: string; evidence: string }[] {
  const out: { text: string; evidence: string }[] = [];
  const total = Object.values(c.fileNaming).reduce((a, b) => a + b, 0);
  const n = c.fileNaming[c.dominantNaming] ?? 0;
  if (total >= 4 && n / total >= 0.7) {
    out.push({ text: `Name new source files in ${c.dominantNaming}, like the rest of the repository.`, evidence: `${n} of ${total} multi-word file names are ${c.dominantNaming}` });
  }
  if (c.testLayout === "tests-dir") out.push({ text: "Put tests under the tests/ directory, not next to the source.", evidence: "most test files live in tests/" });
  if (c.testLayout === "colocated") out.push({ text: "Put a test next to the file it tests (x.spec.ts beside x.ts).", evidence: "most test files are colocated" });
  if (c.testStyle.length) out.push({ text: `Write tests in this project's style: ${c.testStyle.join(", ")}.`, evidence: "seen in the existing tests" });
  if (c.errorPatterns.length) out.push({ text: `Report errors the way the codebase does: ${c.errorPatterns.join(", ")}.`, evidence: "most frequent error constructions" });
  return out;
}

// ---------------------------------------------------------------- step 6

export function agentsDraft(root: string, commands: DetectedCommand[], c: Conventions): string {
  const byKind = (k: DetectedCommand["kind"]) => commands.filter((x) => x.kind === k).map((x) => `\`${x.command}\``);
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
    "## Rules for agents",
    "- Keep each change small: at most 3 files and 200 changed lines.",
    "- Write or update the failing test first, then the code.",
    "- Never weaken a test assertion to make it pass.",
    "",
  ];
  return lines.join("\n");
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
      calls[0]?.name === "read_file" && String(calls[0].arguments.path ?? "").replace(/^\.\//, "") === f
        ? undefined
        : `expected read_file ${f}`,
  }));
}

export interface OnboardOptions {
  apply?: boolean;
  /** Models to qualify (step 7); none: the step is skipped and says so. */
  models?: LocalInferenceAdapter[];
  registry?: ModelRegistry;
  release?: (a: LocalInferenceAdapter) => Promise<void>;
  /** Language servers per language (tests inject a fake). */
  lspServers?: typeof DEFAULT_LSP_SERVERS;
  lspTimeoutMs?: number;
  store?: { log: EventLog; cardStore: CardStore };
  say?: (line: string) => void;
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
  say(`1. Repo map: ${map.files.length} of ${map.considered} files, ${map.usedTokens} tokens (key ${map.cacheKey}).`);

  // 2. Language servers.
  const langs = new Set<string>();
  for (const f of files) {
    if (/\.(ts|tsx|js|jsx)$/.test(f)) langs.add("typescript");
    if (/\.py$/.test(f)) langs.add("python");
    if (/\.rs$/.test(f)) langs.add("rust");
  }
  const servers = opts.lspServers ?? DEFAULT_LSP_SERVERS;
  const languageServers: OnboardReport["languageServers"] = [];
  for (const language of [...langs].sort()) {
    const server = servers[language];
    if (!server) continue;
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
    say(`2. ${language} language server (${server.command}): ${ok ? "ok" : `unavailable (${detail})`}.`);
  }

  // 3. Commands.
  const commands = detectCommands(root);
  say(`3. Commands: ${commands.map((c) => `${c.kind} ${c.command}`).join("; ") || "none found"}.`);

  // 4. Proposed gates (the live gates.toml is never touched here).
  const template = gateTemplate(root, detectGateTemplate(root));
  const derived = deriveGates(root);
  const toml = template ? renderGatesToml(template) : derived.toml;
  const gatesPath = join(dir, "gates.proposed.toml");
  writeFileSync(gatesPath, toml);
  const gates = template ? template.map((g) => `${g.id}: ${g.command} ${g.args.join(" ")}`) : derived.gates;
  say(`4. Proposed gates (${relative(root, gatesPath)}): ${gates.join("; ") || "none"}.`);

  // 5. Conventions and a draft playbook.
  const conventions = measureConventions(root, files);
  writeFileSync(join(dir, "conventions.json"), `${JSON.stringify(conventions, null, 2)}\n`);
  try {
    // Drift (X2) compares commits made after this point.
    writeFileSync(
      join(dir, "head.txt"),
      `${execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()}\n`,
    );
  } catch {
    // Not a git repository yet.
  }
  let rulesProposed = 0;
  if (opts.store) {
    const learning = new LearningStore(opts.store.log);
    const explored = await applyExploration(learning, root, false, await opts.store.cardStore.listCards());
    rulesProposed += explored.proposed;
    for (const r of conventionRules(conventions)) {
      const rule = await learning.propose({ role: "worker", text: r.text, scope: {}, source: "seed", evidence: [{ note: `onboarding: ${r.evidence}` }] });
      if (rule) rulesProposed++;
    }
  } else {
    rulesProposed = exploreProject(root).length + conventionRules(conventions).length;
  }
  say(`5. Conventions: ${conventions.dominantNaming} files, tests ${conventions.testLayout}; ${rulesProposed} draft rule(s) for the playbook (candidates until approved).`);

  // 6. AGENTS.md / CLAUDE.md drafts.
  const agents = agentsDraft(root, commands, conventions);
  const drafts: string[] = [];
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const existing = existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : "";
    const body =
      name === "AGENTS.md"
        ? existing
          ? `${existing.trimEnd()}\n\n<!-- sekhemet onboard -->\n${agents.split("\n").slice(4).join("\n")}`
          : agents
        : existing || `# CLAUDE.md\n\nFollow [AGENTS.md](AGENTS.md): it lists this repository's commands and conventions.\n`;
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
      const { best } = await qualifyModel(m, { ...(opts.registry ? { registry: opts.registry } : {}), cases });
      qualification.push({ modelId: m.modelId, passRate: best.passRate, qualified: best.qualified });
      say(`7. ${m.modelId}: ${(best.passRate * 100).toFixed(0)}% ${best.qualified ? "qualified" : "not qualified"} on ${cases.length} cases.`);
      await opts.release?.(m);
    }
  } else {
    say("7. Qualification skipped: pass --models to qualify this machine's models on this repository.");
  }

  const applied: string[] = [];
  if (opts.apply) {
    const live = join(root, ".sekhemet", "gates.toml");
    writeFileSync(live, toml);
    applied.push(relative(root, live));
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      writeFileSync(join(root, name), readFileSync(join(dir, `${name}.draft`), "utf8"));
      applied.push(name);
    }
    say(`Applied: ${applied.join(", ")}.`);
  } else {
    say("Review .sekhemet/onboard/ and rerun with --apply to install the gates and the AGENTS.md / CLAUDE.md drafts.");
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
  };
  writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
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
export function detectConventionDrift(root: string, sinceDays = 7): { drift: DriftItem[]; files: number } {
  const snapPath = join(root, ".sekhemet", "onboard", "conventions.json");
  if (!existsSync(snapPath)) return { drift: [], files: 0 };
  const was = JSON.parse(readFileSync(snapPath, "utf8")) as Conventions;
  let changed: string[] = [];
  try {
    const headPath = join(root, ".sekhemet", "onboard", "head.txt");
    const base = existsSync(headPath) ? readFileSync(headPath, "utf8").trim() : "";
    const range = base ? [`${base}..HEAD`] : [];
    changed = execFileSync("git", ["log", `--since=${sinceDays}.days`, "--name-only", "--format=", ...range], {
      cwd: root,
      encoding: "utf8",
    })
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
  if (newStyles.length) drift.push({ aspect: "test style", was: was.testStyle.join(", ") || "none", now: newStyles.join(", ") });
  const documentedNow = extractConventions(
    ["AGENTS.md", "CLAUDE.md"].map((n) => (existsSync(join(root, n)) ? readFileSync(join(root, n), "utf8") : "")).join("\n"),
    250,
  );
  if (was.documented && documentedNow && documentedNow !== was.documented) {
    drift.push({ aspect: "documented conventions", was: "the onboarding snapshot", now: "AGENTS.md/CLAUDE.md changed" });
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
  await log.append({ actor: "planner", type: "convention/drift", payload: { drift, files, sinceDays } });
  return drift;
}
