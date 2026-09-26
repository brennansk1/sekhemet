import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { getPackagesSync } from "@manypkg/get-packages";
import { gitEnvFor } from "@sekhemet/sync";
import { gatesConfigFromBytes } from "./config.js";
import { RERUN_GATES, gateCopy } from "./copy.js";
import type { GateStage, StageReport } from "./pipeline.js";
import type {
  GateDefinition,
  GateFailure,
  GateLayer,
  GateRung,
  GatesConfig,
  RungOutcome,
} from "./types.js";

/**
 * Workspaces (gates rule 34a, NEW-gates-7 GT-BF-4; review-git rule 5,
 * NEW-review-git-3 RG-N3-1).
 *
 * When a card's changed files belong to workspace packages (pnpm, npm or
 * yarn workspaces, read by `@manypkg/get-packages`), the packages it touched
 * and their dependents run their own gates first, in build order; when the
 * change crosses a package boundary the build step runs as a gate before the
 * dependents' tests, because a package that resolves another through its
 * built output sees a change only after a build. A card touching two
 * packages runs both packages' gate sets, and passes only when both pass.
 */

export interface WorkspacePackageInfo {
  name: string;
  /** Repository-relative directory. */
  dir: string;
  /** The workspace packages it depends on (any dependency field). */
  deps: string[];
  scripts: Record<string, string>;
}

export interface WorkspacePlan {
  /** The workspace tool: `pnpm`, `yarn`, `npm`, `lerna`, … */
  tool: string;
  /** The packages the change touched, by name. */
  touched: string[];
  /** Touched packages and their dependents, in build order (dependencies first). */
  order: WorkspacePackageInfo[];
  /** More than one package is involved: the build step runs as a gate. */
  crossesBoundary: boolean;
}

/** The workspace rooted at `root`, or undefined when `root` is not a workspace root. */
export function readWorkspace(
  root: string,
): { tool: string; packages: WorkspacePackageInfo[] } | undefined {
  let found: ReturnType<typeof getPackagesSync>;
  try {
    found = getPackagesSync(root);
  } catch {
    return undefined;
  }
  // The search walks up from `root`: a parent directory's workspace is not
  // this repository's, and a single package is no workspace.
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  if (found.tool.type === "root" || real(found.rootDir) !== real(root)) return undefined;
  const names = new Set(found.packages.map((p) => p.packageJson.name));
  const packages = found.packages
    .filter((p) => p.relativeDir !== ".")
    .map((p) => {
      const pj = p.packageJson as typeof p.packageJson & { scripts?: Record<string, string> };
      const deps = new Set(
        [pj.dependencies, pj.devDependencies, pj.peerDependencies, pj.optionalDependencies]
          .flatMap((d) => Object.keys(d ?? {}))
          .filter((d) => names.has(d) && d !== pj.name),
      );
      return {
        name: pj.name,
        dir: p.relativeDir.replace(/\\/g, "/"),
        deps: [...deps].sort(),
        scripts: pj.scripts ?? {},
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { tool: found.tool.type, packages };
}

/**
 * The packages a change runs gates for: those it touched and every package
 * that depends on one of them, in build order. Undefined outside a
 * workspace.
 */
export function workspacePlan(root: string, changed: readonly string[]): WorkspacePlan | undefined {
  const ws = readWorkspace(root);
  if (!ws) return undefined;
  const byDepth = [...ws.packages].sort((a, b) => b.dir.length - a.dir.length);
  const touched = new Set<string>();
  for (const f of changed) {
    const file = f.replace(/^\.\//, "");
    const p = byDepth.find((x) => file === x.dir || file.startsWith(`${x.dir}/`));
    if (p) touched.add(p.name);
  }
  // Dependents, transitively.
  const involved = new Set(touched);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of ws.packages) {
      if (!involved.has(p.name) && p.deps.some((d) => involved.has(d))) {
        involved.add(p.name);
        grew = true;
      }
    }
  }
  // Build order: a package after every involved package it depends on; ties by name.
  const order: WorkspacePackageInfo[] = [];
  const placed = new Set<string>();
  const pending = ws.packages.filter((p) => involved.has(p.name));
  while (pending.length > 0) {
    const next =
      pending.find((p) => p.deps.every((d) => !involved.has(d) || placed.has(d))) ?? pending[0];
    if (!next) break;
    order.push(next);
    placed.add(next.name);
    pending.splice(pending.indexOf(next), 1);
  }
  return {
    tool: ws.tool,
    touched: [...touched].sort(),
    order,
    crossesBoundary: order.length > 1,
  };
}

/** The parser a script's output is read with, from the tool it runs. */
function parserFor(script: string): string {
  if (/\btsc\b/.test(script)) return "tsc";
  if (/\bvitest\b/.test(script)) return "vitest";
  if (/\bjest\b/.test(script)) return "jest";
  if (/\bbiome\b/.test(script)) return "biome";
  if (/\beslint\b/.test(script)) return "eslint";
  return "generic";
}

/** The package manager's command that runs one package's script from the workspace root. */
function scriptCommand(tool: string, pkg: WorkspacePackageInfo, script: string): string[] {
  if (tool === "pnpm") return ["pnpm", "--filter", pkg.name, "run", script];
  if (tool === "yarn") return ["yarn", "workspace", pkg.name, "run", script];
  return ["npm", "run", script, `--workspace=${pkg.dir}`];
}

export interface PackageGate {
  pkg: WorkspacePackageInfo;
  def: GateDefinition;
  /** Where it runs: the workspace root for a script, the package for its own gates.toml. */
  cwd: string;
  build: boolean;
  /**
   * The package's own gates.toml could not be read from the base (git
   * refused, or failed): its gates are unavailable, never replaced by its
   * scripts (fail closed).
   */
  unreadable?: string;
}

/**
 * A package's own `.sekhemet/gates.toml` as the card's base has it — never
 * the card's copy, which the Worker could have written (review-git rule 5).
 * Without a base, the working tree's (onboarding: the tree is the base).
 */
function packageConfig(
  root: string,
  pkg: WorkspacePackageInfo,
  base: string | undefined,
): GatesConfig | { unreadable: string } | undefined {
  const rel = `${pkg.dir}/.sekhemet/gates.toml`;
  const dir = join(root, pkg.dir);
  if (base === undefined) {
    if (!existsSync(join(root, rel))) return undefined;
    return gatesConfigFromBytes(readFileSync(join(root, rel)), join(root, rel), dir);
  }
  if (base.startsWith("-")) return { unreadable: `${base} is not a branch name` };
  let bytes: Buffer;
  try {
    // The guarded git of a card's worktree: no hook or filter the repository names runs.
    bytes = execFileSync("git", ["show", `${base}:${rel}`], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnvFor(root),
      timeout: 60_000,
    });
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "");
    // Absent on the base: the package has no gates of its own there.
    if (/does not exist in|exists on disk, but not in/.test(stderr)) return undefined;
    const why = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
    return {
      unreadable: `its .sekhemet/gates.toml could not be read from ${base}: ${stderr.trim().split("\n")[0] || why}`,
    };
  }
  return gatesConfigFromBytes(bytes, join(root, rel), dir);
}

/** A declared command line that builds the workspace (`tsc -b`, `pnpm build`, `turbo run build`). */
const BUILDS = /\btsc\b.*\s(?:-b|--build)\b|(?:^|\s)(?:run\s+)?build(?:\s|$)/;

/**
 * The declared static gate that builds the workspace, if any: then it is the
 * build step, run once before the package gates, and no package's own
 * `build` script runs (review efficiency).
 */
export function declaredBuildGate(gates: readonly GateDefinition[]): GateDefinition | undefined {
  return gates.find(
    (g) => g.blocking && g.layer === "static" && BUILDS.test([g.command, ...g.args].join(" ")),
  );
}

/**
 * One package's gates: the build step when the change crosses a boundary
 * (unless the declared suite builds), then its own gates, read from the
 * card's base, else its `typecheck` and `test` scripts; only those of the
 * requested rungs when `rungs` is given.
 */
export function packageGates(
  root: string,
  plan: WorkspacePlan,
  options: { base?: string; rungs?: ReadonlySet<GateRung>; declaredBuild?: boolean } = {},
): PackageGate[] {
  const wanted = (r: GateRung) => !options.rungs || options.rungs.has(r);
  const out: PackageGate[] = [];
  const def = (
    pkg: WorkspacePackageInfo,
    step: string,
    rung: GateRung,
    layer: GateLayer,
  ): GateDefinition => {
    const [command, ...args] = scriptCommand(plan.tool, pkg, step) as [string, ...string[]];
    return {
      id: `${pkg.name}:${step}`,
      rung,
      layer,
      command,
      args,
      timeoutMs: 600_000,
      parser: parserFor(pkg.scripts[step] ?? ""),
      blocking: true,
    };
  };
  const building = wanted("test") || wanted("typecheck");
  for (const pkg of plan.order) {
    if (plan.crossesBoundary && building && !options.declaredBuild && pkg.scripts.build) {
      out.push({ pkg, def: def(pkg, "build", "typecheck", "static"), cwd: root, build: true });
    }
    // The package's own gates.toml, when its base has one (review-git rule 5).
    const dir = join(root, pkg.dir);
    const own = packageConfig(root, pkg, options.base);
    if (own && "unreadable" in own) {
      out.push({
        pkg,
        def: {
          id: `${pkg.name}:gates`,
          rung: "test",
          layer: "functional",
          command: "",
          args: [],
          timeoutMs: 0,
          parser: "generic",
          blocking: true,
        },
        cwd: dir,
        build: false,
        unreadable: own.unreadable,
      });
      continue;
    }
    if (own) {
      for (const g of own.gates.filter((x) => x.blocking && wanted(x.rung))) {
        out.push({ pkg, def: { ...g, id: `${pkg.name}:${g.id}` }, cwd: dir, build: false });
      }
      continue;
    }
    if (pkg.scripts.typecheck && wanted("typecheck")) {
      out.push({
        pkg,
        def: def(pkg, "typecheck", "typecheck", "static"),
        cwd: root,
        build: false,
      });
    }
    if (pkg.scripts.test && wanted("test")) {
      out.push({ pkg, def: def(pkg, "test", "test", "functional"), cwd: root, build: false });
    }
  }
  return out;
}

/** A path the tool printed relative to the package, as the repository names it. */
function repoRelative(file: string, root: string, pkg: WorkspacePackageInfo): string {
  if (file === "." || file.startsWith(`${pkg.dir}/`)) return file;
  if (existsSync(join(root, pkg.dir, file)) && !existsSync(join(root, file))) {
    return `${pkg.dir}/${file}`;
  }
  return file;
}

/** A package gate's failure with its paths as the repository names them. */
export function repoRelativeFailure(
  f: GateFailure,
  root: string,
  pkg: WorkspacePackageInfo,
): GateFailure {
  return {
    ...f,
    location: { ...f.location, file: repoRelative(f.location.file, root, pkg) },
    suggestedFixFiles: f.suggestedFixFiles.map((x) => repoRelative(x, root, pkg)),
  };
}

/** What the package stage reports: outcomes, failures, and the packages whose tests passed. */
export interface PackageStageReport {
  outcomes: RungOutcome[];
  failures: GateFailure[];
  /** Directories of the packages whose test gate passed. */
  passedTests: string[];
}

/**
 * Run a plan's package gates in build order. A declared build gate, when
 * given, runs first and stands for every package's build. A failed build
 * skips that package's other gates and every gate of the packages that
 * depend on it, each outcome saying why; a failed test does not stop
 * another package's gates.
 */
export async function runPackageGates(options: {
  gates: readonly PackageGate[];
  run: (g: PackageGate) => Promise<{ outcome: RungOutcome; failures: GateFailure[] }>;
  declaredBuild?: () => Promise<{ outcome: RungOutcome; failures: GateFailure[] }>;
}): Promise<PackageStageReport> {
  const outcomes: RungOutcome[] = [];
  const failures: GateFailure[] = [];
  const passedTests: string[] = [];
  const broken = new Map<string, string>();
  let everything: string | undefined;
  if (options.declaredBuild) {
    const b = await options.declaredBuild();
    outcomes.push(b.outcome);
    failures.push(...b.failures);
    if (!b.outcome.passed) everything = `${b.outcome.gate} failed`;
  }
  const blockedBy = (pkg: WorkspacePackageInfo): string | undefined => {
    if (everything) return everything;
    if (broken.has(pkg.name)) return broken.get(pkg.name);
    for (const d of pkg.deps) if (broken.has(d)) return broken.get(d);
    return undefined;
  };
  for (const g of options.gates) {
    if (g.unreadable) {
      // Fail closed (rule 9): the package's gates are unavailable, and say why.
      outcomes.push({
        gate: g.def.id,
        rung: g.def.rung,
        layer: g.def.layer,
        passed: false,
        exitCode: -1,
        durationMs: 0,
        unavailable: true,
        reason: g.unreadable,
      });
      failures.push({
        rung: g.def.rung,
        gate: g.def.id,
        layer: g.def.layer,
        exitCode: -1,
        errorExcerpt: `${g.def.id} not run: ${g.unreadable}`,
        suggestedFixFiles: [],
        location: { file: "." },
        expected: `${g.pkg.name}'s gates to run`,
        actual: g.unreadable,
        minimalRepro: RERUN_GATES,
        suggestedAction: gateCopy.gateNotRun(g.def.id),
        notRun: true,
      });
      continue;
    }
    const why = blockedBy(g.pkg);
    if (why) {
      broken.set(g.pkg.name, why);
      outcomes.push({
        gate: g.def.id,
        rung: g.def.rung,
        layer: g.def.layer,
        passed: false,
        skipped: true,
        exitCode: -1,
        durationMs: 0,
        reason: `not run: ${why}`,
      });
      continue;
    }
    const r = await options.run(g);
    outcomes.push(r.outcome);
    failures.push(...r.failures);
    if (g.build && !r.outcome.passed) broken.set(g.pkg.name, `${g.def.id} failed`);
    if (g.def.rung === "test" && r.outcome.passed && r.failures.length === 0) {
      passedTests.push(g.pkg.dir);
    }
  }
  return { outcomes, failures, passedTests };
}

/** What runs one gate: the declared-gate runner's `runGate`. */
export interface PackageGateRunner {
  runGate(
    gate: GateDefinition,
    cwd: string,
  ): Promise<{ outcome: RungOutcome; failures: GateFailure[] }>;
}

/**
 * The workspace stage, for a declared-gate runner that does not run the
 * package stage itself (a gate host, a test double): the change's packages
 * and their dependents, each package's gates in build order (see
 * `runPackageGates`). Outside a workspace, or when the change touches no
 * package, it reports nothing. The card's own runner runs the package stage
 * inside its declared run instead (`RunGatesOptions.workspace`), through the
 * verdict cache, the baseline, supersession and quarantine (review M3).
 */
export function workspaceStage(options: {
  root: string;
  changed: readonly string[];
  runner: PackageGateRunner;
  base?: string;
}): GateStage {
  return {
    id: "workspace",
    rung: "test",
    layer: "functional",
    run: async (): Promise<StageReport> => {
      const { root } = options;
      const plan = workspacePlan(root, options.changed);
      if (!plan || plan.order.length === 0) return { outcomes: [], failures: [] };
      const gates = packageGates(root, plan, options.base ? { base: options.base } : {});
      const r = await runPackageGates({
        gates,
        run: async (g) => {
          const res = await options.runner.runGate(g.def, g.cwd);
          return {
            outcome: res.outcome,
            failures: res.failures.map((f) => repoRelativeFailure(f, root, g.pkg)),
          };
        },
      });
      return { outcomes: r.outcomes, failures: r.failures };
    },
  };
}
