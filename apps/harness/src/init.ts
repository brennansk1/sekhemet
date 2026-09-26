import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { gateTemplate } from "@sekhemet/gates";

/**
 * The first run's pieces (surface items 5–8, P10), shared by the bare
 * `sekhemet` (`first_run.ts`), onboarding (`onboard.ts`) and `sekhemet dev
 * init`:
 *
 * - the machine: memory, platform, and the tier and model roster that fit;
 * - the toolchain: Node.js (the floor is surface item 5a, 22.13), git, a
 *   package manager, llama-server, and the optional pieces, each with the
 *   command that installs it. It installs nothing itself;
 * - **the one gate deriver** (`deriveGates`): the package manager from the
 *   `packageManager` field or the lockfile (npm when neither says), a
 *   typecheck gate when TypeScript is a dependency, the project's lint and
 *   test scripts, the team's own linter and formatter configurations
 *   (item 9a), and every CI step — multi-line `run: |` blocks included —
 *   each listed with the gate it became or why it did not (item 9b);
 * - the writes: `.sekhemet/config.toml`, `.sekhemet/gates.toml` and one
 *   marked `.gitignore` block that ignores `.sekhemet/` by default and
 *   re-includes only the files a team shares (item 5.6, SUR-34). A file that
 *   exists is never overwritten; a different `gates.toml` is shown as a diff
 *   and replaced only on confirmation, keeping a backup (item 10, SUR-7).
 */

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
  required: boolean;
}

type Run = (cmd: string, args: string[]) => string | undefined;

/**
 * Where and how a toolchain probe runs (review M1, SUR-6, security S9): from
 * a neutral directory, never the repository — `pnpm --version` inside a
 * repository whose `packageManager` field names another version makes
 * Corepack download and run it, before any trust — and with Corepack's
 * strict mode, auto-pin and npm's version management off.
 */
export function toolProbeOptions(env: NodeJS.ProcessEnv = process.env): {
  cwd: string;
  env: NodeJS.ProcessEnv;
} {
  return {
    cwd: tmpdir(),
    env: {
      ...env,
      COREPACK_ENABLE_STRICT: "0",
      COREPACK_ENABLE_AUTO_PIN: "0",
      npm_config_manage_package_manager_versions: "false",
    },
  };
}

const defaultRun: Run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, {
      ...toolProbeOptions(),
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: string };
    if (e.code === "ENOENT") return undefined;
    return `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || undefined;
  }
};

/** The Node.js floor (surface item 5a): `node:sqlite` without a flag arrived in 22.13. */
export const NODE_FLOOR = "22.13.0";

/** Whether `version` (e.g. "22.12.0" or "v26.0.0") meets the floor. */
export function nodeMeetsFloor(version: string, floor = NODE_FLOOR): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split(".")
      .map((n) => Number.parseInt(n, 10));
  const [a = 0, b = 0, c = 0] = parse(version);
  const [x = 0, y = 0, z = 0] = parse(floor);
  return a !== x ? a > x : b !== y ? b > y : c >= z;
}

export function toolchainChecks(
  run: Run = defaultRun,
  nodeVersion = process.versions.node,
): Check[] {
  const version = (cmd: string, args = ["--version"]) => run(cmd, args)?.split("\n")[0];
  const git = version("git");
  const pnpm = version("pnpm");
  const llama = run("llama-server", ["--version"]);
  const docker = version("docker");
  const gh = version("gh");
  const crawl = existsSync(
    join(homedir(), ".local", "share", "sekhemet", "crawl4ai", ".venv", "bin", "python"),
  );
  const mac = platform() === "darwin";
  return [
    {
      name: "Node.js 22.13+",
      ok: nodeMeetsFloor(nodeVersion),
      detail: `v${nodeVersion.replace(/^v/, "")}`,
      fix: "Install Node.js 22.13 or newer (nodejs.org, or `brew install node`).",
      required: true,
    },
    {
      name: "git",
      ok: Boolean(git),
      detail: git ?? "not found",
      fix: mac ? "`xcode-select --install`" : "`sudo apt install git`",
      required: true,
    },
    {
      name: "pnpm",
      ok: Boolean(pnpm),
      detail: pnpm ?? "not found",
      fix: "`corepack enable pnpm`",
      required: false,
    },
    {
      name: "llama-server (llama.cpp)",
      ok: Boolean(llama && /version/i.test(llama)),
      detail: llama ? (/version:\s*(\S+)/.exec(llama)?.[1] ?? "found") : "not found",
      fix: mac
        ? "`brew install llama.cpp`"
        : "build llama.cpp with Vulkan or ROCm (see docs/design/HARNESS_DESIGN.md)",
      required: true,
    },
    {
      name: "Docker (for private web search)",
      ok: Boolean(docker),
      detail: docker ?? "not found",
      fix: mac ? "Docker Desktop, or `brew install colima docker`" : "`sudo apt install docker.io`",
      required: false,
    },
    {
      name: "GitHub CLI (issues, pull requests)",
      ok: Boolean(gh),
      detail: gh ?? "not found",
      fix: mac ? "`brew install gh`" : "`sudo apt install gh`",
      required: false,
    },
    {
      name: "Crawl4AI (rendered page reading)",
      ok: crawl,
      detail: crawl ? "installed" : "not installed",
      fix: "`uv venv --python 3.12 ~/.local/share/sekhemet/crawl4ai/.venv && uv pip install --python ~/.local/share/sekhemet/crawl4ai/.venv/bin/python crawl4ai && ~/.local/share/sekhemet/crawl4ai/.venv/bin/python -m playwright install chromium`",
      required: false,
    },
  ];
}

export interface Roster {
  tier: string;
  worker: string;
  manager: string;
  reviewer: string;
  researcher: string;
  note: string;
}

/** The model roster that fits this much memory. */
export function recommendRoster(totalBytes = totalmem()): Roster {
  const gb = totalBytes / 1024 ** 3;
  if (gb >= 96) {
    return {
      tier: "XL",
      worker: "cyber-tiel",
      manager: "qwen3.8-27b",
      reviewer: "mistral-small3.2:24b",
      researcher: "apodex",
      note: "All four roles stay resident; use the Q8_0 Researcher (SEKHEMET_RESEARCHER_GGUF).",
    };
  }
  if (gb >= 48) {
    return {
      tier: "L",
      worker: "cyber-tiel",
      manager: "qwen3.8-27b",
      reviewer: "mistral-small3.2:24b",
      researcher: "apodex",
      note: "Worker and manager resident together; reviewer and Researcher swap in.",
    };
  }
  return {
    tier: gb >= 24 ? "M" : "S",
    worker: "cyber-tiel",
    manager: "qwen3.8-27b",
    reviewer: "mistral-small3.2:24b",
    researcher: "apodex",
    note: "One large model at a time: the Worker stays resident; manager, reviewer and Researcher swap in by role batch.",
  };
}

// ---------------------------------------------------------- the one deriver

interface PackageJson {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  packageManager?: string;
  prettier?: unknown;
  eslintConfig?: unknown;
}

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** The package manager: the `packageManager` field, else the lockfile, else npm (SUR-1). */
export function packageManagerOf(repo: string, pkg: PackageJson = {}): PackageManager {
  const field = /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager ?? "")?.[1] as
    | PackageManager
    | undefined;
  if (field) return field;
  if (existsSync(join(repo, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repo, "yarn.lock"))) return "yarn";
  if (existsSync(join(repo, "bun.lockb")) || existsSync(join(repo, "bun.lock"))) return "bun";
  return "npm";
}

/** One derived gate, in the shape `gates.toml` holds. */
export interface DerivedGate {
  id: string;
  rung: "typecheck" | "lint" | "test";
  layer: "static" | "functional";
  command: string;
  args: string[];
  parser: string;
  timeout: number;
  /** Where it came from: `package.json`, a linter's config file, a workflow file. */
  source: string;
}

/** Why a CI step did not become a gate (surface item 9b, SUR-35). */
export type CiReason =
  | "action"
  | "setup"
  | "needs_service"
  | "needs_secret"
  | "matrix"
  | "unknown_tool"
  | "not_a_check";

/** One CI command, with the gate it became or the reason it did not. */
export interface CiStep {
  file: string;
  /** 1-based line of the command in the workflow file. */
  line: number;
  command: string;
  gate?: string;
  reason?: CiReason;
}

export interface DerivedGates {
  toml: string;
  /** `id: command args`, one per gate, in order. */
  gates: string[];
  defs: DerivedGate[];
  /** Every CI step, in file order (SUR-35). */
  ci: CiStep[];
  packageManager?: PackageManager;
  /** The team's own linter and formatter configurations the gates use (SUR-36). */
  teamTools: string[];
  /** Where the gates came from, for the first run's paragraph. */
  sources: string[];
}

const ESLINT_CONFIGS = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
];
const PRETTIER_CONFIGS = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.json5",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  ".prettierrc.toml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  "prettier.config.ts",
];
const BIOME_CONFIGS = ["biome.json", "biome.jsonc"];

/** How a package manager runs a tool the project installed. */
function exec(pm: PackageManager, tool: string, args: string[]): [string, string[]] {
  if (pm === "npm") return ["npx", [tool, ...args]];
  if (pm === "bun") return ["bunx", [tool, ...args]];
  if (pm === "yarn") return ["yarn", [tool, ...args]];
  return ["pnpm", ["exec", tool, ...args]];
}

function jsGates(
  repo: string,
  pkg: PackageJson,
): {
  gates: DerivedGate[];
  teamTools: string[];
  pm: PackageManager;
} {
  const pm = packageManagerOf(repo, pkg);
  const scripts = pkg.scripts ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (f: string) => existsSync(join(repo, f));
  const script = (names: string[]) => names.find((n) => scripts[n]);
  const gates: DerivedGate[] = [];
  const teamTools: string[] = [];
  const add = (g: Omit<DerivedGate, "source">, source = "package.json") =>
    gates.push({ ...g, source });

  const typecheck = script(["typecheck", "type-check", "tsc", "check-types"]);
  if (typecheck) {
    add({
      id: "typecheck",
      rung: "typecheck",
      layer: "static",
      command: pm,
      args: ["run", typecheck],
      parser: "tsc",
      timeout: 180,
    });
  } else if (deps.typescript) {
    const [command, args] = exec(pm, "tsc", ["--noEmit"]);
    add({
      id: "typecheck",
      rung: "typecheck",
      layer: "static",
      command,
      args,
      parser: "tsc",
      timeout: 180,
    });
  }

  const eslint = ESLINT_CONFIGS.find(has) ?? (pkg.eslintConfig ? "package.json" : undefined);
  const biome = BIOME_CONFIGS.find(has);
  const prettier =
    PRETTIER_CONFIGS.find(has) ?? (pkg.prettier !== undefined ? "package.json" : undefined);
  const lint = script(["lint", "check"]);
  const lintText = lint ? (scripts[lint] ?? "") : "";
  if (lint) {
    add({
      id: "lint",
      rung: "lint",
      layer: "static",
      command: pm,
      args: ["run", lint],
      parser:
        /\bbiome\b/.test(lintText) || deps["@biomejs/biome"]
          ? "biome"
          : /eslint/.test(lintText)
            ? "eslint"
            : "generic",
      timeout: 120,
    });
  } else if (biome) {
    // SUR-36: the team's Biome with its own biome.json (check covers format too).
    const [command, args] = exec(pm, "biome", ["check", "."]);
    add(
      { id: "lint", rung: "lint", layer: "static", command, args, parser: "biome", timeout: 120 },
      biome,
    );
  } else if (eslint) {
    const [command, args] = exec(pm, "eslint", ["."]);
    add(
      { id: "lint", rung: "lint", layer: "static", command, args, parser: "eslint", timeout: 120 },
      eslint,
    );
  }
  if (biome) teamTools.push(`biome (${biome})`);
  if (eslint) teamTools.push(`eslint (${eslint})`);
  const biomeChecks = biome && (!lint || /\bbiome\s+(check|ci)\b/.test(lintText));
  if (prettier && !biomeChecks) {
    const [command, args] = exec(pm, "prettier", ["--check", "."]);
    add(
      {
        id: "format",
        rung: "lint",
        layer: "static",
        command,
        args,
        parser: "generic",
        timeout: 120,
      },
      prettier,
    );
    teamTools.push(`prettier (${prettier})`);
  }

  const test = script(["test", "test:unit"]);
  if (test) {
    const text = scripts[test] ?? "";
    add({
      id: "unit",
      rung: "test",
      layer: "functional",
      command: pm,
      args: ["run", test],
      parser:
        /vitest/.test(text) || deps.vitest
          ? "vitest"
          : /jest/.test(text) || deps.jest
            ? "jest"
            : "generic",
      timeout: 600,
    });
  }
  return { gates, teamTools, pm };
}

function pythonGates(repo: string): DerivedGate[] {
  const gates: DerivedGate[] = [];
  const source = existsSync(join(repo, "pyproject.toml")) ? "pyproject.toml" : "requirements.txt";
  const py = existsSync(join(repo, "pyproject.toml"))
    ? readFileSync(join(repo, "pyproject.toml"), "utf8")
    : "";
  if (/mypy/.test(py))
    gates.push({
      id: "typecheck",
      rung: "typecheck",
      layer: "static",
      command: "mypy",
      args: ["."],
      parser: "generic",
      timeout: 180,
      source,
    });
  if (/ruff/.test(py))
    gates.push({
      id: "lint",
      rung: "lint",
      layer: "static",
      command: "ruff",
      args: ["check", "."],
      parser: "generic",
      timeout: 120,
      source,
    });
  gates.push({
    id: "unit",
    rung: "test",
    layer: "functional",
    command: "pytest",
    args: ["-q"],
    parser: "generic",
    timeout: 600,
    source,
  });
  return gates;
}

/** Rust and Go: the gates package's templates for those languages. */
function templateGates(repo: string, id: "rust" | "go"): DerivedGate[] {
  const source = id === "rust" ? "Cargo.toml" : "go.mod";
  return (gateTemplate(repo, id) ?? []).map((g) => ({
    id: g.id,
    rung: g.rung === "typecheck" ? "typecheck" : g.rung === "test" ? "test" : "lint",
    layer: g.layer === "functional" ? "functional" : "static",
    command: g.command,
    args: g.args,
    parser: g.parser,
    timeout: Math.round(g.timeoutMs / 1000),
    source,
  }));
}

// ------------------------------------------------------------- CI steps

const KNOWN_TOOLS = new Set([
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "bunx",
  "node",
  "tsc",
  "eslint",
  "biome",
  "prettier",
  "vitest",
  "jest",
  "playwright",
  "pytest",
  "python",
  "python3",
  "ruff",
  "mypy",
  "uv",
  "poetry",
  "pip",
  "cargo",
  "go",
  "make",
]);

const SETUP =
  /^(npm (ci|install|i)\b|pnpm (install|i|fetch)\b|yarn( install)?$|yarn install\b|bun install\b|pip3? install\b|uv (sync|pip install)\b|poetry install\b|corepack\b|apt(-get)? |brew |cd |echo |export |go mod download\b|cargo fetch\b)/;

type CheckKind = "test" | "lint" | "typecheck" | "format" | "build";

function checkKind(cmd: string): CheckKind | undefined {
  if (/\btest\b|\btest:|vitest|jest|pytest|playwright test/.test(cmd)) return "test";
  if (/typecheck|type-check|\btsc\b|mypy/.test(cmd)) return "typecheck";
  if (/\blint\b|eslint|biome (check|ci|lint)|ruff check|clippy|go vet/.test(cmd)) return "lint";
  if (/\bformat\b|prettier|\bfmt\b/.test(cmd)) return "format";
  if (/\bbuild\b|\bcompile\b/.test(cmd)) return "build";
  return undefined;
}

/** `pnpm test` and `pnpm run test` are one command, as are npm's and yarn's forms. */
function normalise(cmd: string): string {
  return cmd
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(npm|pnpm|yarn|bun) run /, "$1 ")
    .replace(/^npm (test|start)\b/, "npm $1");
}

interface RawStep {
  file: string;
  line: number;
  command?: string;
  uses?: string;
  secret: boolean;
  service: boolean;
}

const indentOf = (l: string) => l.length - l.trimStart().length;

/**
 * The steps of a GitHub Actions workflow, read by indentation (no YAML
 * library is taken for this): each `uses:`, and each command of each `run:`
 * — a block scalar (`|`, `>`) is split into its lines, a trailing `\`
 * joining a line to the next.
 */
function workflowSteps(file: string, text: string): RawStep[] {
  const lines = text.split("\n");
  const out: RawStep[] = [];
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsAt === -1) return out;
  const jobIndent = lines.slice(jobsAt + 1).find((l) => l.trim() && !l.trim().startsWith("#"));
  const ji = jobIndent ? indentOf(jobIndent) : 2;
  let i = jobsAt + 1;
  while (i < lines.length) {
    const l = lines[i] as string;
    if (!(indentOf(l) === ji && /^\s*[\w-]+:\s*$/.test(l))) {
      i++;
      continue;
    }
    // One job: from here to the next line at its indent or less.
    let end = i + 1;
    while (
      end < lines.length &&
      (!(lines[end] as string).trim() || indentOf(lines[end] as string) > ji)
    )
      end++;
    const job = lines.slice(i + 1, end);
    const childIndent = Math.min(...job.filter((x) => x.trim()).map(indentOf));
    const service = job.some((x) => indentOf(x) === childIndent && /^\s*services:\s*$/.test(x));
    const stepsRel = job.findIndex((x) => indentOf(x) === childIndent && /^\s*steps:\s*$/.test(x));
    if (stepsRel !== -1) {
      const from = i + 1 + stepsRel + 1;
      let itemIndent = -1;
      let item: { start: number; lines: number[] } | undefined;
      const flush = () => {
        if (item) out.push(...stepCommands(file, lines, item.lines, service));
      };
      for (let k = from; k < end; k++) {
        const x = lines[k] as string;
        if (!x.trim()) {
          item?.lines.push(k);
          continue;
        }
        const ind = indentOf(x);
        if (ind <= childIndent) break;
        if (/^\s*-\s/.test(x) && (itemIndent === -1 || ind === itemIndent)) {
          itemIndent = ind;
          flush();
          item = { start: k, lines: [k] };
        } else item?.lines.push(k);
      }
      flush();
    }
    i = end;
  }
  return out;
}

function stepCommands(
  file: string,
  lines: readonly string[],
  idx: readonly number[],
  service: boolean,
): RawStep[] {
  const text = idx.map((k) => lines[k] as string);
  const secret = text.some((l) => /\$\{\{\s*secrets\./.test(l));
  const out: RawStep[] = [];
  for (let n = 0; n < idx.length; n++) {
    const raw = text[n] as string;
    const uses = /^\s*(?:-\s+)?uses:\s*(.+?)\s*$/.exec(raw);
    if (uses) {
      out.push({
        file,
        line: (idx[n] as number) + 1,
        uses: unquote(uses[1] as string),
        secret,
        service,
      });
      continue;
    }
    const run = /^(\s*)(?:-\s+)?run:\s*(.*?)\s*$/.exec(raw);
    if (!run) continue;
    const value = run[2] as string;
    if (/^[|>][-+0-9]*$/.test(value)) {
      const keyIndent = indentOf(raw) + (/^\s*-\s/.test(raw) ? 2 : 0);
      let pending: { line: number; text: string } | undefined;
      for (let m = n + 1; m < idx.length; m++) {
        const b = text[m] as string;
        if (b.trim() && indentOf(b) <= keyIndent) break;
        const t = b.trim();
        if (!t || t.startsWith("#")) continue;
        const line = (idx[m] as number) + 1;
        const joined = pending
          ? { line: pending.line, text: `${pending.text} ${t}` }
          : { line, text: t };
        if (joined.text.endsWith("\\")) {
          pending = { line: joined.line, text: joined.text.slice(0, -1).trim() };
          continue;
        }
        pending = undefined;
        out.push({ file, line: joined.line, command: joined.text, secret, service });
      }
    } else if (value) {
      out.push({ file, line: (idx[n] as number) + 1, command: unquote(value), secret, service });
    }
  }
  return out;
}

const unquote = (v: string) => v.replace(/^(["'])(.*)\1$/, "$2");

function ciSteps(repo: string): RawStep[] {
  const dir = join(repo, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /\.ya?ml$/.test(n))
    .sort()
    .flatMap((n) => workflowSteps(`.github/workflows/${n}`, readFileSync(join(dir, n), "utf8")));
}

/** A CI command as a gate's command and arguments; shell syntax goes through `sh -c`. */
function commandOf(cmd: string): [string, string[]] {
  if (/[|&;<>$`()]|^\w+=/.test(cmd)) return ["sh", ["-c", cmd]];
  const words = cmd.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const [first = "", ...rest] = words.map((w) => w.replace(/^(["'])(.*)\1$/, "$2"));
  return [first, rest];
}

function classifyCi(steps: readonly RawStep[], gates: DerivedGate[]): CiStep[] {
  const out: CiStep[] = [];
  const counters: Partial<Record<CheckKind, number>> = {};
  const known = () =>
    new Map(gates.map((g) => [normalise(`${g.command} ${g.args.join(" ")}`), g.id]));
  for (const s of steps) {
    if (s.uses) {
      out.push({ file: s.file, line: s.line, command: s.uses, reason: "action" });
      continue;
    }
    const cmd = s.command as string;
    const step = { file: s.file, line: s.line, command: cmd };
    const tool = (cmd.split(/\s+/)[0] ?? "").replace(/^\.\//, "./");
    const kind = checkKind(cmd);
    if (/\$\{\{\s*matrix\./.test(cmd)) out.push({ ...step, reason: "matrix" });
    else if (SETUP.test(cmd)) out.push({ ...step, reason: "setup" });
    else if (!KNOWN_TOOLS.has(tool)) out.push({ ...step, reason: "unknown_tool" });
    else if (s.service && kind) out.push({ ...step, reason: "needs_service" });
    else if (s.secret && kind) out.push({ ...step, reason: "needs_secret" });
    else if (!kind || kind === "build") out.push({ ...step, reason: "not_a_check" });
    else {
      const same = known().get(normalise(cmd));
      if (same) out.push({ ...step, gate: same });
      else {
        const n = (counters[kind] ?? 0) + 1;
        counters[kind] = n;
        const id = `ci-${kind}-${n}`;
        const [command, args] = commandOf(cmd);
        gates.push({
          id,
          rung: kind === "test" ? "test" : kind === "typecheck" ? "typecheck" : "lint",
          layer: kind === "test" ? "functional" : "static",
          command,
          args,
          parser: "generic",
          timeout: kind === "test" ? 600 : 180,
          source: s.file,
        });
        out.push({ ...step, gate: id });
      }
    }
  }
  return out;
}

const PROTECTED = ["**/*.spec.ts", "**/*.test.ts", "tests/acceptance/**", ".sekhemet/gates.toml"];

function renderToml(gates: readonly DerivedGate[]): string {
  const q = (v: string) => JSON.stringify(v);
  return [
    "# Derived by Sekhemet's first run from this project's own scripts, tools and CI.",
    "# Edit freely; the hash of this file is pinned when a card starts.",
    "[project]",
    "max_files = 3",
    "max_diff_lines = 200",
    `protected = [${PROTECTED.map(q).join(", ")}]`,
    "",
    ...gates.flatMap((g) => [
      "[[gate]]",
      `id = ${q(g.id)}`,
      `rung = ${q(g.rung)}`,
      `layer = ${q(g.layer)}`,
      `command = ${q(g.command)}`,
      `args = [${g.args.map(q).join(", ")}]`,
      `timeout_s = ${g.timeout}`,
      `parser = ${q(g.parser)}`,
      "",
    ]),
  ].join("\n");
}

/**
 * The one gate deriver (surface item 5.3, P10): every path that proposes
 * gates — the first run, onboarding, `gates init` — calls this.
 */
export function deriveGates(repo: string): DerivedGates {
  let gates: DerivedGate[] = [];
  let teamTools: string[] = [];
  let pm: PackageManager | undefined;
  const pkgPath = join(repo, "package.json");
  if (existsSync(pkgPath)) {
    let pkg: PackageJson = {};
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
    } catch {
      pkg = {};
    }
    const js = jsGates(repo, pkg);
    gates = js.gates;
    teamTools = js.teamTools;
    pm = js.pm;
  } else if (
    existsSync(join(repo, "pyproject.toml")) ||
    existsSync(join(repo, "requirements.txt"))
  ) {
    gates = pythonGates(repo);
  } else if (existsSync(join(repo, "Cargo.toml"))) {
    gates = templateGates(repo, "rust");
  } else if (existsSync(join(repo, "go.mod"))) {
    gates = templateGates(repo, "go");
  }
  const ci = classifyCi(ciSteps(repo), gates);
  return {
    toml: renderToml(gates),
    gates: gates.map((g) => `${g.id}: ${g.command} ${g.args.join(" ")}`),
    defs: gates,
    ci,
    ...(pm ? { packageManager: pm } : {}),
    teamTools,
    sources: [...new Set(gates.map((g) => g.source))],
  };
}

// ------------------------------------------------------------- the writes

/** The marked `.gitignore` block (surface item 5.6, SUR-34): `.sekhemet/` ignored by default. */
export const GITIGNORE_BEGIN = "# >>> sekhemet: personal and secret state stays out of git";
export const GITIGNORE_END = "# <<< sekhemet";
const GITIGNORE_BLOCK = [
  GITIGNORE_BEGIN,
  ".sekhemet/*",
  "!.sekhemet/config.toml",
  "!.sekhemet/gates.toml",
  "!.sekhemet/hooks.toml",
  "!.sekhemet/mcp.json",
  "!.sekhemet/skills/",
  "!.sekhemet/playbook.toml",
  GITIGNORE_END,
];

/**
 * Add the block once; never remove or reorder a line a person wrote. True
 * when the file changed.
 */
export function writeGitignoreBlock(repo: string): boolean {
  const gi = join(repo, ".gitignore");
  const have = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (have.split("\n").includes(GITIGNORE_BEGIN)) return false;
  const sep = have && !have.endsWith("\n") ? "\n" : "";
  writeFileSync(gi, `${have}${sep}${GITIGNORE_BLOCK.join("\n")}\n`);
  return true;
}

/** `.sekhemet/config.toml` for a first run. */
export function configToml(roster: Roster): string {
  return [
    "# Sekhemet project configuration. Layers: defaults, ~/.sekhemet/config.toml, this file.",
    "[machine]",
    "# Hours reserved for you; unattended work runs outside them (or when you are away).",
    'reserved_hours = "08:00-18:00 Mon-Fri"',
    "# Daily energy budget for unattended runs, kWh (0 = no limit).",
    "power_budget_kwh_day = 0",
    "",
    "[models]",
    `# Tier ${roster.tier}: ${roster.note}`,
    `executor = "${roster.worker}"`,
    `planner = "${roster.manager}"`,
    "",
    "[network]",
    "# offline, allowlist or open. The Researcher's web access is also switched in Integrations.",
    'mode = "offline"',
    "",
    "[review]",
    "review_minutes_per_day = 60",
    "",
  ].join("\n");
}

/** A line diff of the live `gates.toml` against a proposal (item 10), `-`/`+` prefixed; empty when equal. */
export function gatesDiff(current: string, proposed: string): string {
  if (current === proposed) return "";
  const a = current.split("\n");
  const b = proposed.split("\n");
  // Longest common subsequence, line by line: gates files are short.
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      (lcs[i] as number[])[j] =
        a[i] === b[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, (lcs[i] as number[])[j + 1] as number);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (
      j < b.length &&
      (i >= a.length ||
        ((lcs[i] as number[])[j + 1] as number) >= ((lcs[i + 1] as number[])[j] as number))
    ) {
      out.push(`+ ${b[j]}`);
      j++;
    } else {
      out.push(`- ${a[i]}`);
      i++;
    }
  }
  return out.join("\n");
}

/**
 * Install a proposed `gates.toml` (item 10, SUR-7): written when none exists;
 * when one differs it is replaced only when `confirmed`, keeping the previous
 * file as `gates.toml.bak`. Returns what happened.
 */
export function installGates(
  repo: string,
  proposed: string,
  confirmed: boolean,
): {
  state: "written" | "unchanged" | "replaced" | "needs_confirmation";
  diff: string;
  backup?: string;
} {
  const dir = join(repo, ".sekhemet");
  const live = join(dir, "gates.toml");
  if (!existsSync(live)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(live, proposed);
    return { state: "written", diff: "" };
  }
  const diff = gatesDiff(readFileSync(live, "utf8"), proposed);
  if (!diff) return { state: "unchanged", diff };
  if (!confirmed) return { state: "needs_confirmation", diff };
  const backup = join(dir, "gates.toml.bak");
  copyFileSync(live, backup);
  writeFileSync(live, proposed);
  return { state: "replaced", diff, backup: ".sekhemet/gates.toml.bak" };
}

export interface InitResult {
  checks: Check[];
  roster: Roster;
  wrote: string[];
  kept: string[];
  gates: string[];
  ready: boolean;
}

/**
 * `sekhemet dev init [--force]`: the first run's writes without its
 * confirmation, for scripts. The bare `sekhemet` is the path people meet
 * (`first_run.ts`).
 */
export function runInit(
  repo: string,
  opts: { force?: boolean; run?: Run; totalBytes?: number; say?: (l: string) => void } = {},
): InitResult {
  const say = opts.say ?? ((l: string) => console.log(l));
  const checks = toolchainChecks(opts.run);
  const roster = recommendRoster(opts.totalBytes);
  const dir = join(repo, ".sekhemet");
  mkdirSync(dir, { recursive: true });
  const wrote: string[] = [];
  const kept: string[] = [];
  const write = (name: string, body: string) => {
    const path = join(dir, name);
    if (existsSync(path) && !opts.force) {
      kept.push(name);
      return;
    }
    writeFileSync(path, body);
    wrote.push(name);
  };
  const { toml, gates } = deriveGates(repo);
  write("gates.toml", toml);
  write("config.toml", configToml(roster));
  if (writeGitignoreBlock(repo)) wrote.push(".gitignore");

  const ready = checks.every((c) => c.ok || !c.required);
  say(
    `Machine: ${Math.round((opts.totalBytes ?? totalmem()) / 1024 ** 3)} GB, tier ${roster.tier}. ${roster.note}`,
  );
  say(
    `Roster: Worker ${roster.worker}, Seshat ${roster.manager}, Reviewer ${roster.reviewer}, Researcher ${roster.researcher}.`,
  );
  for (const c of checks)
    say(
      `  ${c.ok ? "✓" : c.required ? "✗" : "·"} ${c.name}: ${c.detail}${c.ok ? "" : ` → ${c.fix}`}`,
    );
  say(
    gates.length
      ? `Gates from this project: ${gates.join("; ")}.`
      : "No gates found: add typecheck, lint and test scripts, then rerun with --force.",
  );
  if (wrote.length) say(`Wrote ${wrote.join(", ")}.`);
  if (kept.length) say(`Kept existing ${kept.join(", ")} (use --force to regenerate).`);
  say(
    ready
      ? 'Ready. Ask for work with: sekhemet "add rate limiting to the API"'
      : "Install the ✗ items above, then run `sekhemet` again.",
  );
  return { checks, roster, wrote, kept, gates, ready };
}
