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
import {
  ENGINE_FLOOR,
  type EnginePlatform,
  type EngineStatus,
  SHIPPED_MODELS,
  type ShippedRole,
  detectEnginePlatform,
  engineFixes,
  engineStatus,
  llamaBuildNumber,
  supportedTierFor,
} from "@sekhemet/models";
import { type CiCommand, readCiSteps } from "./ci_files.js";

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
 *   (item 9a), and every CI step — GitHub Actions and GitLab CI, read with
 *   a YAML parser (`ci_files.ts`, DEC-44), multi-line `run: |` blocks
 *   included — each listed with the gate it became or why it did not
 *   (item 9b);
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

/**
 * The engine's check (models rule 6a, MD-N16-1, MD-N16-2): found by the one
 * resolution order (rule 6b) and its build read from `--version`, compared
 * with the shipped set's floor; below it, *llama-server bNNNN found; bMMMM
 * or later needed*; missing, this platform's fixes. A test's `run` answers
 * for `llama-server` on PATH instead of the resolution.
 */
function engineCheck(run: Run, opts: { platform?: EnginePlatform; engine?: EngineStatus }): Check {
  const platform = opts.platform ?? opts.engine?.platform ?? detectEnginePlatform();
  const status = opts.engine ?? (run === defaultRun ? engineStatus({ platform }) : undefined);
  const out = status ? undefined : run("llama-server", ["--version"]);
  const found = status ? status.engine !== undefined : Boolean(out);
  const build = status ? status.engine?.build : llamaBuildNumber(out ?? "");
  const floor = status?.floor ?? ENGINE_FLOOR;
  return {
    name: "llama-server (llama.cpp)",
    ok: found && build !== undefined && build >= floor,
    detail: !found
      ? "not found"
      : build === undefined
        ? `found, but it did not report its build; b${floor} or later needed`
        : build >= floor
          ? `b${build}`
          : `llama-server b${build} found; b${floor} or later needed`,
    fix: (status?.fixes ?? engineFixes(platform)).join("; or "),
    required: true,
  };
}

export function toolchainChecks(
  run: Run = defaultRun,
  nodeVersion = process.versions.node,
  opts: { platform?: EnginePlatform; engine?: EngineStatus } = {},
): Check[] {
  const version = (cmd: string, args = ["--version"]) => run(cmd, args)?.split("\n")[0];
  const git = version("git");
  const pnpm = version("pnpm");
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
    engineCheck(run, opts),
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
  /** v1 supports this machine's memory (rule 6c, MD-N16-3; DEC-47 O-5). */
  supported: boolean;
  worker: string;
  manager: string;
  /** Empty while the Review role is unfilled (rule 3, RG-P8-13). */
  reviewer: string;
  researcher: string;
  note: string;
}

const shippedId = (role: ShippedRole): string =>
  SHIPPED_MODELS.find((m) => m.role === role)?.id ?? "";

/**
 * The shipped set for this much memory (models rules 3 and 8a, MD-N22-2):
 * read from `SHIPPED_MODELS` and `SUPPORTED_HARDWARE`, never repeated here.
 * Below 24 GB the note says v1 does not support the machine (MD-N16-3); the
 * ids stay, for a person who continues at their own risk.
 */
export function recommendRoster(totalBytes = totalmem()): Roster {
  const t = supportedTierFor(totalBytes);
  return {
    tier: t.tier,
    supported: t.supported,
    worker: shippedId("coding"),
    manager: shippedId("planning"),
    reviewer: shippedId("review"),
    researcher: shippedId("research"),
    // Rule 6c: the supported tiers' residency is the table's; below them, the floor in words.
    note: t.supported
      ? t.residency
      : "v1 supports 24 GB of memory and above; you may continue at your own risk. The shipped models do not fit in this much memory.",
  };
}

/** The roster's models in words, or why none is presented as fitting (MD-N16-3). */
export function rosterLine(roster: Roster): string {
  if (!roster.supported) return `Models: ${roster.note}`;
  return `Models: Coding model ${roster.worker}, Planning model (Seshat) ${roster.manager}, Review model ${roster.reviewer || "unfilled until a model is admitted for it"}, Research model ${roster.researcher}.`;
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
  | "not_a_check"
  /** The CI file is not YAML (its parser's message in `detail`). */
  | "unreadable"
  /** Something the reader cannot follow: a GitLab `include:`, a missing `!reference`, a working directory set by an expression (`detail` says which). */
  | "not_read"
  /** A GitHub Actions job that calls a reusable workflow (`detail` says whether its jobs are read). */
  | "reusable_workflow"
  /** Shell control flow over several lines (`if … fi`, a loop): the check runs only under it. */
  | "shell_block";

/** One CI command, with the gate it became or the reason it did not. */
export interface CiStep {
  file: string;
  /** 1-based line of the command in the workflow file. */
  line: number;
  command: string;
  gate?: string;
  reason?: CiReason;
  /** Why, in words, when the reason needs them (`unreadable`, `not_read`, `reusable_workflow`). */
  detail?: string;
  /** The directory the command runs in (GitHub Actions' `working-directory`); absent at the root. */
  directory?: string;
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
  // A uv project (`uv init`, card zero's generator, DS-P2-2) runs its tools
  // in its own environment: `uv run <tool>`.
  const uv = existsSync(join(repo, "uv.lock"));
  const tool = (name: string, args: string[]): { command: string; args: string[] } =>
    uv ? { command: "uv", args: ["run", name, ...args] } : { command: name, args };
  const source = existsSync(join(repo, "pyproject.toml")) ? "pyproject.toml" : "requirements.txt";
  const py = existsSync(join(repo, "pyproject.toml"))
    ? readFileSync(join(repo, "pyproject.toml"), "utf8")
    : "";
  if (/mypy/.test(py))
    gates.push({
      id: "typecheck",
      rung: "typecheck",
      layer: "static",
      ...tool("mypy", ["."]),
      parser: "generic",
      timeout: 180,
      source,
    });
  if (/ruff/.test(py))
    gates.push({
      id: "lint",
      rung: "lint",
      layer: "static",
      ...tool("ruff", ["check", "."]),
      parser: "generic",
      timeout: 120,
      source,
    });
  gates.push({
    id: "unit",
    rung: "test",
    layer: "functional",
    ...tool("pytest", ["-q"]),
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

/** A word for `sh`, quoted only when it needs to be. */
export function shellWord(w: string): string {
  return /^[\w./@%+=:,-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`;
}

/** A CI command as a gate's command and arguments; shell syntax goes through `sh -c`. */
function commandOf(cmd: string): [string, string[]] {
  if (/[|&;<>$`()]|^\w+=/.test(cmd)) return ["sh", ["-c", cmd]];
  const words = cmd.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const [first = "", ...rest] = words.map((w) => w.replace(/^(["'])(.*)\1$/, "$2"));
  return [first, rest];
}

function classifyCi(steps: readonly CiCommand[], gates: DerivedGate[]): CiStep[] {
  const out: CiStep[] = [];
  const counters: Partial<Record<CheckKind, number>> = {};
  const known = () =>
    new Map(gates.map((g) => [normalise(`${g.command} ${g.args.join(" ")}`), g.id]));
  for (const s of steps) {
    if (s.error !== undefined) {
      // A CI file that is not YAML: named, so its checks are not lost silently.
      out.push({
        file: s.file,
        line: s.line,
        command: s.file,
        reason: "unreadable",
        detail: s.error,
      });
      continue;
    }
    if (s.unread !== undefined) {
      out.push({
        file: s.file,
        line: s.line,
        command: s.file,
        reason: "not_read",
        detail: s.unread,
      });
      continue;
    }
    if (s.uses && s.reusable) {
      const local = s.uses.startsWith("./");
      out.push({
        file: s.file,
        line: s.line,
        command: s.uses,
        reason: "reusable_workflow",
        detail: local
          ? `its jobs are read from ${s.uses.slice(2)}`
          : "a workflow in another repository is not read",
      });
      continue;
    }
    if (s.uses) {
      out.push({ file: s.file, line: s.line, command: s.uses, reason: "action" });
      continue;
    }
    const cmd = s.command as string;
    const dir = s.directory;
    const step = { file: s.file, line: s.line, command: cmd, ...(dir ? { directory: dir } : {}) };
    if (dir?.includes("${{")) {
      out.push(
        /\$\{\{\s*matrix\./.test(dir)
          ? { ...step, reason: "matrix" }
          : {
              ...step,
              reason: "not_read",
              detail: `its working directory is set by an expression (${dir})`,
            },
      );
      continue;
    }
    if (/^(?:if|for|while|until|case|select)\b|^\{|\(\)\s*\{/.test(cmd)) {
      out.push({ ...step, reason: "shell_block" });
      continue;
    }
    const tool = (cmd.split(/\s+/)[0] ?? "").replace(/^\.\//, "./");
    const kind = checkKind(cmd);
    if (/\$\{\{\s*matrix\./.test(cmd)) out.push({ ...step, reason: "matrix" });
    else if (SETUP.test(cmd)) out.push({ ...step, reason: "setup" });
    else if (!KNOWN_TOOLS.has(tool)) out.push({ ...step, reason: "unknown_tool" });
    else if (s.service && kind) out.push({ ...step, reason: "needs_service" });
    else if (s.secret && kind) out.push({ ...step, reason: "needs_secret" });
    else if (!kind || kind === "build") out.push({ ...step, reason: "not_a_check" });
    else {
      // A command in a subdirectory runs there (`cd web && npm test`): never
      // the root's own check of the same words.
      const run = dir ? `cd ${shellWord(dir)} && ${cmd}` : cmd;
      const same = known().get(normalise(run));
      if (same) out.push({ ...step, gate: same });
      else {
        const n = (counters[kind] ?? 0) + 1;
        counters[kind] = n;
        const id = `ci-${kind}-${n}`;
        const [command, args] = commandOf(run);
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

/** The first line of every `gates.toml` the deriver writes. */
export const DERIVED_GATES_HEADER =
  "# Derived by Sekhemet's first run from this project's own scripts, tools and CI.";

function renderToml(gates: readonly DerivedGate[]): string {
  const q = (v: string) => JSON.stringify(v);
  return [
    DERIVED_GATES_HEADER,
    "# Edit freely; the hash of this file is pinned when an issue starts.",
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
  const ci = classifyCi(readCiSteps(repo), gates);
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
    "# offline, allowlist or open. The Research model's web access is also switched in Integrations.",
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

/**
 * What an empty directory is offered (design-stage §2.4 item 4, DS-P2-4):
 * a start by conversation with Seshat, instead of only "No gates found".
 */
export const START_BY_CONVERSATION =
  "Nothing here yet, so there are no checks to find. Start a project by conversation: tell Seshat on the board what you want built, in one sentence. It proposes the plan — a setup issue first runs the ecosystem's own generator, and the checks come from what that makes — and nothing is created until you apply it.";

/** Files a new, empty project may hold without being a project yet. */
const NOT_A_PROJECT = new Set([".git", ".sekhemet", ".gitignore", ".DS_Store"]);

/** A directory with nothing in it but git's and Sekhemet's own files (DS-P2-4). */
export function isEmptyProject(repo: string): boolean {
  try {
    return readdirSync(repo).every((name) => NOT_A_PROJECT.has(name));
  } catch {
    return false;
  }
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
    `Machine: ${Math.round((opts.totalBytes ?? totalmem()) / 1024 ** 3)} GB, class ${roster.tier}. ${roster.note}`,
  );
  say(rosterLine(roster));
  for (const c of checks)
    say(
      `  ${c.ok ? "✓" : c.required ? "✗" : "·"} ${c.name}: ${c.detail}${c.ok ? "" : ` → ${c.fix}`}`,
    );
  say(
    gates.length
      ? `Checks from this project: ${gates.join("; ")}.`
      : isEmptyProject(repo)
        ? START_BY_CONVERSATION
        : "No checks found: add typecheck, lint and test scripts, then rerun with --force.",
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
