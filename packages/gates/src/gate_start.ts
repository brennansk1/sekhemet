import { constants, accessSync, existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import type { GateDefinition, GatesConfig } from "./types.js";

/**
 * SUR-12 (surface P10): a derived test gate that cannot start stops the run
 * and names the file to edit, before any model loads — instead of every
 * card failing it and being charged for it.
 *
 * - **Its script is missing**: `npm run test` (or `npm test`, `pnpm run`,
 *   `pnpm test`, `yarn run`, `yarn test`) with no such script in
 *   `package.json` → edit `package.json`.
 * - **Its script is wrong**: the script's program is neither installed
 *   (`node_modules/.bin`, here or above) nor on `PATH` → edit `package.json`
 *   (or install the dependencies).
 * - **The gate's own program is not found** → edit `.sekhemet/gates.toml`.
 *
 * Only a derived `gates.toml` (the file the first run or onboarding wrote)
 * is judged, and only its test-rung gates. A script that goes missing while
 * cards run is caught by the runner instead (`missingScriptIn`): the gate is
 * reported as not run, never a failure charged to the card (gates rule 9).
 */

export interface GateStartProblem {
  gate: string;
  /** The file to edit, repository-relative. */
  file: "package.json" | ".sekhemet/gates.toml";
  reason: string;
}

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
/** Flags that move a package manager's work elsewhere: the script is not this package.json's. */
const ELSEWHERE = new Set([
  "--filter",
  "-F",
  "-r",
  "--recursive",
  "-C",
  "--dir",
  "--prefix",
  "-w",
  "--workspace",
  "--workspaces",
  "--cwd",
]);
/** Words a shell runs itself. */
const BUILTINS = new Set([
  "echo",
  "exit",
  "true",
  "false",
  "cd",
  "test",
  "[",
  ":",
  "export",
  "set",
  "exec",
  "env",
]);

/** The package.json script a package-manager gate runs, when it names one here. */
export function scriptOf(gate: Pick<GateDefinition, "command" | "args">): string | undefined {
  const pm = gate.command.split("/").pop() ?? gate.command;
  if (!PACKAGE_MANAGERS.has(pm)) return undefined;
  if (gate.args.some((a) => ELSEWHERE.has(a.split("=")[0] ?? a))) return undefined;
  const words = gate.args.filter((a) => !a.startsWith("-"));
  const [first, second] = words;
  if (first === "test" || first === "t") return "test";
  if (first === "run" || first === "run-script") return second;
  return undefined;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether a program would be found: a path from the root, an installed binary here or above, or on PATH. */
function resolvable(program: string, root: string, path: string | undefined): boolean {
  if (BUILTINS.has(program)) return true;
  if (program.includes("/")) return existsSync(resolve(root, program));
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    if (executable(join(dir, "node_modules", ".bin", program))) return true;
    if (dirname(dir) === dir) break;
  }
  return (path ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((d) => executable(join(d, program)));
}

/** The program a script's first command runs, past `VAR=value` assignments. */
function programOf(script: string): string | undefined {
  const first = script.split(/&&|\|\||;|\|/)[0] ?? "";
  return first
    .trim()
    .split(/\s+/)
    .find((w) => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
}

/** Every derived test gate that cannot start here, with the file to edit (SUR-12). */
export function gateStartProblems(
  config: Pick<GatesConfig, "gates" | "empty">,
  root: string,
  opts: { path?: string } = {},
): GateStartProblem[] {
  if (config.empty) return [];
  const path = opts.path ?? process.env.PATH;
  const problems: GateStartProblem[] = [];
  let scripts: Record<string, unknown> | undefined;
  const readScripts = (): Record<string, unknown> => {
    if (scripts) return scripts;
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        scripts?: Record<string, unknown>;
      };
      scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    } catch {
      scripts = {};
    }
    return scripts;
  };
  for (const gate of config.gates) {
    if (gate.rung !== "test") continue;
    const shown = [gate.command, ...gate.args].join(" ");
    if (!resolvable(gate.command, root, path)) {
      problems.push({
        gate: gate.id,
        file: ".sekhemet/gates.toml",
        reason: `the ${gate.id} gate runs ${gate.command}, which is not installed`,
      });
      continue;
    }
    const script = scriptOf(gate);
    if (!script) continue;
    const body = readScripts()[script];
    if (typeof body !== "string" || !body.trim()) {
      problems.push({
        gate: gate.id,
        file: "package.json",
        reason: `package.json has no "${script}" script, which the ${gate.id} gate runs (${shown})`,
      });
      continue;
    }
    const program = programOf(body);
    if (program && !resolvable(program, root, path)) {
      problems.push({
        gate: gate.id,
        file: "package.json",
        reason: `package.json's "${script}" script runs ${program}, which is not installed: install the dependencies, or change the script`,
      });
    }
  }
  return problems;
}

/** Whether `root`'s package.json has a non-empty script named `script`. */
export function packageScriptPresent(root: string, script: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const body = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts[script] : undefined;
    return typeof body === "string" && body.trim() !== "";
  } catch {
    return false;
  }
}

/**
 * The script a package manager said is missing, from its output: npm's
 * `Missing script: "test"`, pnpm's `ERR_PNPM_NO_SCRIPT … Missing script: test`,
 * yarn's `Command "test" not found`.
 */
export function missingScriptIn(output: string): string | undefined {
  const m =
    /Missing script:\s*"?([^"\s]+)"?/i.exec(output) ??
    /error Command "([^"]+)" not found/i.exec(output);
  return m?.[1];
}
