import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform, totalmem } from "node:os";
import { join } from "node:path";

/**
 * `sekhemet init` (H25): the first-run wizard. It looks before it writes:
 *
 * - the machine: memory, platform, and the tier and model roster that fit;
 * - the toolchain: node, git, a package manager, llama-server, and the
 *   optional pieces (Docker for SearXNG, the gh CLI, Crawl4AI), each with the
 *   command that installs it. It installs nothing itself: a download is the
 *   user's decision;
 * - the project: its package manager and scripts, from which it derives a
 *   gates.toml whose gates are the project's own typecheck, lint and test.
 *
 * It writes .sekhemet/config.toml, .sekhemet/gates.toml and the .gitignore
 * lines Sekhemet needs, and never overwrites a file that exists (unless
 * --force).
 */

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
  required: boolean;
}

type Run = (cmd: string, args: string[]) => string | undefined;

const defaultRun: Run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, {
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

export function toolchainChecks(run: Run = defaultRun): Check[] {
  const node = process.versions.node;
  const nodeMajor = Number(node.split(".")[0]);
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
      name: "Node.js 22+",
      ok: nodeMajor >= 22,
      detail: `v${node}`,
      fix: "Install Node.js 22 or newer (nodejs.org, or `brew install node`).",
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

interface PackageJson {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  packageManager?: string;
}

function packageManager(repo: string, pkg: PackageJson): string {
  if (pkg.packageManager?.startsWith("pnpm") || existsSync(join(repo, "pnpm-lock.yaml")))
    return "pnpm";
  if (existsSync(join(repo, "yarn.lock"))) return "yarn";
  if (existsSync(join(repo, "bun.lockb")) || existsSync(join(repo, "bun.lock"))) return "bun";
  return "npm";
}

/** A gates.toml from the project's own scripts (or its Python tooling). */
export function deriveGates(repo: string): { toml: string; gates: string[] } {
  const gates: {
    id: string;
    rung: string;
    layer: string;
    command: string;
    args: string[];
    parser: string;
    timeout: number;
  }[] = [];
  const pkgPath = join(repo, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
    const pm = packageManager(repo, pkg);
    const scripts = pkg.scripts ?? {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const script = (names: string[]) => names.find((n) => scripts[n]);
    const typecheck = script(["typecheck", "type-check", "tsc", "check-types"]);
    if (typecheck)
      gates.push({
        id: "typecheck",
        rung: "typecheck",
        layer: "static",
        command: pm,
        args: ["run", typecheck],
        parser: "tsc",
        timeout: 180,
      });
    else if (deps.typescript)
      gates.push({
        id: "typecheck",
        rung: "typecheck",
        layer: "static",
        command: "npx",
        args: ["tsc", "--noEmit"],
        parser: "tsc",
        timeout: 180,
      });
    const lint = script(["lint", "check"]);
    if (lint)
      gates.push({
        id: "lint",
        rung: "lint",
        layer: "static",
        command: pm,
        args: ["run", lint],
        parser: deps["@biomejs/biome"] ? "biome" : "generic",
        timeout: 120,
      });
    const test = script(["test", "test:unit"]);
    if (test) {
      gates.push({
        id: "unit",
        rung: "test",
        layer: "functional",
        command: pm,
        args: ["run", test],
        parser: deps.vitest ? "vitest" : deps.jest ? "jest" : "generic",
        timeout: 600,
      });
    }
  } else if (
    existsSync(join(repo, "pyproject.toml")) ||
    existsSync(join(repo, "requirements.txt"))
  ) {
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
      });
    gates.push({
      id: "unit",
      rung: "test",
      layer: "functional",
      command: "pytest",
      args: ["-q"],
      parser: "generic",
      timeout: 600,
    });
  }
  const toml = [
    "# Generated by `sekhemet init` from this project's own scripts. Edit freely;",
    "# the hash of this file is pinned when a card starts.",
    "[project]",
    "max_files = 3",
    "max_diff_lines = 200",
    'protected = ["**/*.spec.ts", "**/*.test.ts", "tests/acceptance/**", ".sekhemet/gates.toml"]',
    "",
    ...gates.flatMap((g) => [
      "[[gate]]",
      `id = "${g.id}"`,
      `rung = "${g.rung}"`,
      `layer = "${g.layer}"`,
      `command = "${g.command}"`,
      `args = [${g.args.map((a) => `"${a}"`).join(", ")}]`,
      `timeout_s = ${g.timeout}`,
      `parser = "${g.parser}"`,
      "",
    ]),
  ].join("\n");
  return { toml, gates: gates.map((g) => `${g.id}: ${g.command} ${g.args.join(" ")}`) };
}

export interface InitResult {
  checks: Check[];
  roster: Roster;
  wrote: string[];
  kept: string[];
  gates: string[];
  ready: boolean;
}

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
  write(
    "config.toml",
    [
      "# Sekhemet project configuration (`sekhemet init`). Layers: defaults, ~/.sekhemet/config.toml, this file.",
      "[machine]",
      "# Hours reserved for you; `sekhemet overnight` runs outside them (or when you are away).",
      'hours = "08:00-18:00 Mon-Fri"',
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
    ].join("\n"),
  );
  const gi = join(repo, ".gitignore");
  const need = [
    ".sekhemet/worktrees/",
    ".sekhemet/*.db",
    ".sekhemet/*.db-*",
    ".sekhemet/daemon.*",
    ".sekhemet/observations/",
  ];
  const have = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  const missing = need.filter((l) => !have.split("\n").includes(l));
  if (missing.length) {
    appendFileSync(
      gi,
      `${have && !have.endsWith("\n") ? "\n" : ""}# Sekhemet\n${missing.join("\n")}\n`,
    );
    wrote.push(".gitignore");
  }

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
      ? "Ready. Next: `sekhemet calibrate`, then `sekhemet board`."
      : "Install the ✗ items above, then run `sekhemet init` again.",
  );
  return { checks, roster, wrote, kept, gates, ready };
}
