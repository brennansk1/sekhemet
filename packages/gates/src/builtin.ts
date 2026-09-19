import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { scanDiffForSecrets } from "./secrets.js";
import type { GateFailure, GateLayer, GateProjectConfig, GateRung, RungOutcome } from "./types.js";

/**
 * The harness's own gates for the layers a project's `gates.toml` rarely
 * covers (G3): security (G14 secrets, G15/S10 dependency existence, age and
 * typosquatting, S11 osv-scanner, G16 semgrep), hygiene (G22 debug output,
 * changelog, commit trailers) and robustness (G13 diff-scoped mutation
 * testing, advisory unless the project makes it blocking). They run at every
 * verification beside the declared gates, on the card's diff.
 *
 * External scanners (gitleaks, osv-scanner, semgrep) are used when they are
 * installed and reported as skipped when they are not; nothing is ever
 * downloaded at gate time.
 */
export type BuiltinGateId = "secrets" | "dependencies" | "osv" | "semgrep" | "hygiene" | "mutation";

export const DEFAULT_BUILTIN_GATES: readonly BuiltinGateId[] = [
  "secrets",
  "dependencies",
  "osv",
  "semgrep",
  "hygiene",
];

/** A registry answer for one package (G15/S10). */
export interface RegistryInfo {
  exists: boolean;
  /** ISO time the package was first published. */
  created?: string;
}

export type RegistryLookup = (name: string) => Promise<RegistryInfo | undefined>;

export interface BuiltinGateContext {
  /** The card's worktree. */
  root: string;
  /** Branch the card's diff is measured against. */
  base: string;
  /** Unified diff of the card against `base` (staged). */
  diff: string;
  project: GateProjectConfig;
  /** Which gates run; default `project.builtin` or DEFAULT_BUILTIN_GATES. */
  gates?: readonly BuiltinGateId[];
  /** Registry lookup for new dependencies; default reads the local cache only. */
  registry?: RegistryLookup;
  /** Runs the test rung against the worktree as it stands (mutation testing). */
  runTests?: () => Promise<boolean>;
  /** Is this program on PATH? Injectable for tests. */
  which?: (program: string) => boolean;
  now?: () => number;
}

export interface BuiltinGateResult {
  failures: GateFailure[];
  outcomes: RungOutcome[];
  /** Advisory findings that do not fail the card (mutation survivors). */
  advisories: string[];
}

export function onPath(program: string): boolean {
  const r = spawnSync("sh", ["-c", `command -v ${program}`], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim().length > 0;
}

/** Files the diff touches (new paths). */
export function diffFiles(diff: string): string[] {
  return [
    ...new Set(
      diff
        .split("\n")
        .filter((l) => l.startsWith("+++ b/"))
        .map((l) => l.slice(6)),
    ),
  ];
}

/** Added lines per file, with their new line numbers. */
export function addedLines(diff: string): Map<string, { line: number; text: string }[]> {
  const out = new Map<string, { line: number; text: string }[]>();
  let file = "";
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.replace(/^\+\+\+ (b\/)?/, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      const list = out.get(file) ?? [];
      list.push({ line, text: raw.slice(1) });
      out.set(file, list);
      line++;
    } else if (!raw.startsWith("-") && !raw.startsWith("\\")) {
      line++;
    }
  }
  return out;
}

function outcome(
  gate: string,
  rung: GateRung,
  layer: GateLayer,
  passed: boolean,
  started: number,
  skipped = false,
): RungOutcome {
  return {
    gate,
    rung,
    layer,
    passed,
    exitCode: passed ? 0 : 1,
    durationMs: Date.now() - started,
    ...(skipped ? { skipped: true } : {}),
  };
}

function failure(
  gate: string,
  rung: GateRung,
  layer: GateLayer,
  excerpt: string,
  extra: Partial<GateFailure> = {},
): GateFailure {
  return {
    gate,
    rung,
    layer,
    exitCode: 1,
    errorExcerpt: excerpt,
    suggestedFixFiles: extra.location?.file ? [extra.location.file] : [],
    ...extra,
  };
}

// --- G14 secrets -------------------------------------------------------------

function secretsGate(ctx: BuiltinGateContext, which: (p: string) => boolean): GateFailure[] {
  const found = scanDiffForSecrets(ctx.diff).map((f) =>
    failure(
      "secrets",
      "security",
      "security",
      `${f.file}:${f.line} adds a ${f.description} (${f.redacted})`,
      {
        location: { file: f.file, line: f.line },
        expected: "no credentials in source",
        actual: f.rule,
        suggestedAction:
          "Remove the credential; read it from the environment or a config file outside the repository, and rotate it if it was real.",
      },
    ),
  );
  // gitleaks, when installed, over the changed files (its rule set is larger).
  if (which("gitleaks")) {
    for (const file of diffFiles(ctx.diff).slice(0, 50)) {
      const abs = join(ctx.root, file);
      if (!existsSync(abs)) continue;
      const r = spawnSync(
        "gitleaks",
        [
          "detect",
          "--no-git",
          "--no-banner",
          "--redact",
          "--source",
          abs,
          "--report-format",
          "json",
          "--report-path",
          "/dev/stdout",
        ],
        { encoding: "utf8", timeout: 60_000 },
      );
      if (r.status !== 1) continue;
      try {
        for (const leak of JSON.parse(r.stdout || "[]") as {
          RuleID?: string;
          StartLine?: number;
          Description?: string;
        }[]) {
          if (found.some((f) => f.location?.file === file && f.location?.line === leak.StartLine)) {
            continue;
          }
          found.push(
            failure(
              "secrets",
              "security",
              "security",
              `${file}:${leak.StartLine ?? 0} gitleaks: ${leak.Description ?? leak.RuleID}`,
              {
                location: { file, ...(leak.StartLine ? { line: leak.StartLine } : {}) },
                actual: leak.RuleID ?? "gitleaks",
              },
            ),
          );
        }
      } catch {
        // An unparseable report: gitleaks' own exit code is still a finding.
      }
    }
  }
  return found;
}

// --- G15 / S10 dependency existence, age, typosquatting ----------------------

/** Widely used packages a typosquat imitates (npm and PyPI). */
export const POPULAR_PACKAGES = [
  "react",
  "react-dom",
  "lodash",
  "express",
  "axios",
  "typescript",
  "zod",
  "vitest",
  "jest",
  "chalk",
  "commander",
  "debug",
  "dotenv",
  "uuid",
  "moment",
  "dayjs",
  "webpack",
  "vite",
  "eslint",
  "prettier",
  "next",
  "vue",
  "rxjs",
  "yargs",
  "glob",
  "semver",
  "minimist",
  "request",
  "colors",
  "crypto-js",
  "node-fetch",
  "mongoose",
  "sequelize",
  "pg",
  "mysql",
  "redis",
  "ws",
  "socket.io",
  "cross-env",
  "nodemon",
  "ts-node",
  "tslib",
  "better-sqlite3",
  "sqlite3",
  "fastify",
  "koa",
  "requests",
  "numpy",
  "pandas",
  "flask",
  "django",
  "pytest",
  "urllib3",
  "setuptools",
  "boto3",
];

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0] as number;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j] as number;
      dp[j] = Math.min(
        (dp[j] as number) + 1,
        (dp[j - 1] as number) + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return dp[b.length] as number;
}

/** The known package a new name is suspiciously close to, if any. */
export function typosquatOf(name: string, known: readonly string[]): string | undefined {
  const bare = name.replace(/^@[^/]+\//, "");
  for (const k of known) {
    if (k === name || k === bare) return undefined;
  }
  for (const k of known) {
    const d = levenshtein(bare.toLowerCase(), k.toLowerCase());
    const limit = k.length <= 4 ? 1 : 2;
    if (d > 0 && d <= limit) return k;
    // Separator games: lodash_ vs lodash, react-dom vs reactdom.
    if (bare.replace(/[-_.]/g, "") === k.replace(/[-_.]/g, "") && bare !== k) return k;
  }
  return undefined;
}

function gitShow(root: string, base: string, file: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${base}:${file}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
  } catch {
    return undefined;
  }
}

function npmDeps(text: string | undefined): string[] {
  if (!text) return [];
  try {
    const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
    return Object.keys({
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
      ...(pkg.peerDependencies ?? {}),
      ...(pkg.optionalDependencies ?? {}),
    });
  } catch {
    return [];
  }
}

function pyDeps(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean)
    .map((l) => l.split(/[<>=!~\[; ]/)[0] as string)
    .filter(Boolean);
}

/** Registry answers cached in `.sekhemet/registry-cache.json`, offline. */
export function cachedRegistry(root: string): RegistryLookup {
  return async (name) => {
    try {
      const cache = JSON.parse(
        readFileSync(join(root, ".sekhemet", "registry-cache.json"), "utf8"),
      ) as Record<string, RegistryInfo>;
      return cache[name];
    } catch {
      return undefined;
    }
  };
}

/** The npm registry through `npm view`, caching every answer (network allowed only). */
export function npmRegistry(root: string, cacheRoot = root): RegistryLookup {
  const cached = cachedRegistry(cacheRoot);
  return async (name) => {
    const hit = await cached(name);
    if (hit) return hit;
    const r = spawnSync("npm", ["view", name, "time.created", "--json"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
    let info: RegistryInfo | undefined;
    if (r.status === 0) {
      const created = JSON.parse(r.stdout || '""') as string;
      info = { exists: true, ...(created ? { created } : {}) };
    } else if (/E404|404 Not Found/.test(`${r.stderr}${r.stdout}`)) {
      info = { exists: false };
    }
    if (info) {
      const path = join(cacheRoot, ".sekhemet", "registry-cache.json");
      let cache: Record<string, RegistryInfo> = {};
      try {
        cache = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        cache = {};
      }
      cache[name] = info;
      try {
        writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`);
      } catch {
        // A cache write failure costs a lookup next time, nothing else.
      }
    }
    return info;
  };
}

/** Packages younger than this are not added without a person (days). */
export const MIN_PACKAGE_AGE_DAYS = 30;

async function dependencyGate(
  ctx: BuiltinGateContext,
): Promise<{ failures: GateFailure[]; advisories: string[] }> {
  const failures: GateFailure[] = [];
  const advisories: string[] = [];
  const registry = ctx.registry ?? cachedRegistry(ctx.root);
  const now = ctx.now?.() ?? Date.now();
  const manifests: { file: string; parse: (t: string | undefined) => string[] }[] = [
    { file: "package.json", parse: npmDeps },
    { file: "requirements.txt", parse: pyDeps },
  ];
  const changed = new Set(diffFiles(ctx.diff));
  for (const m of manifests) {
    if (!changed.has(m.file)) continue;
    const before = new Set(m.parse(gitShow(ctx.root, ctx.base, m.file)));
    const after = m.parse(
      existsSync(join(ctx.root, m.file)) ? readFileSync(join(ctx.root, m.file), "utf8") : undefined,
    );
    const added = after.filter((d) => !before.has(d));
    for (const dep of added) {
      const squat = typosquatOf(dep, [...before, ...POPULAR_PACKAGES]);
      if (squat) {
        failures.push(
          failure(
            "dependencies",
            "security",
            "security",
            `${m.file} adds "${dep}", one edit away from "${squat}": a likely typosquat or a hallucinated name`,
            {
              location: { file: m.file },
              expected: squat,
              actual: dep,
              suggestedAction: `Use "${squat}" if that was meant; a person must approve "${dep}" otherwise.`,
            },
          ),
        );
        continue;
      }
      const info = await registry(dep).catch(() => undefined);
      if (!info) {
        advisories.push(
          `dependency ${dep}: not in the registry cache; existence and age unverified offline`,
        );
        continue;
      }
      if (!info.exists) {
        failures.push(
          failure(
            "dependencies",
            "security",
            "security",
            `${m.file} adds "${dep}", which does not exist in the registry (a hallucinated package name)`,
            {
              location: { file: m.file },
              actual: dep,
              suggestedAction: "Remove it, or name the package that really provides this.",
            },
          ),
        );
        continue;
      }
      if (info.created) {
        const days = (now - Date.parse(info.created)) / 86_400_000;
        if (days < MIN_PACKAGE_AGE_DAYS) {
          failures.push(
            failure(
              "dependencies",
              "security",
              "security",
              `${m.file} adds "${dep}", first published ${Math.max(0, Math.floor(days))} day(s) ago (under ${MIN_PACKAGE_AGE_DAYS})`,
              {
                location: { file: m.file },
                actual: dep,
                suggestedAction: "New packages are a supply-chain risk; a person must approve it.",
              },
            ),
          );
        }
      }
    }
  }
  return { failures, advisories };
}

// --- S11 osv-scanner, G16 semgrep ---------------------------------------------

const LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "requirements.txt",
  "poetry.lock",
  "Cargo.lock",
  "go.sum",
];

function osvGate(ctx: BuiltinGateContext): GateFailure[] {
  const lock = LOCKFILES.find((f) => existsSync(join(ctx.root, f)));
  if (!lock) return [];
  const r = spawnSync(
    "osv-scanner",
    ["--offline", "--format", "json", "--lockfile", join(ctx.root, lock)],
    { encoding: "utf8", timeout: 120_000 },
  );
  if (r.status === 0) return [];
  const out: GateFailure[] = [];
  try {
    const report = JSON.parse(r.stdout || "{}") as {
      results?: {
        packages?: {
          package?: { name?: string; version?: string };
          vulnerabilities?: { id?: string; summary?: string }[];
        }[];
      }[];
    };
    for (const res of report.results ?? []) {
      for (const p of res.packages ?? []) {
        for (const v of p.vulnerabilities ?? []) {
          out.push(
            failure(
              "osv",
              "security",
              "security",
              `${p.package?.name}@${p.package?.version}: ${v.id} ${v.summary ?? ""}`.trim(),
              {
                location: { file: lock },
                suggestedAction: `Upgrade ${p.package?.name} past ${v.id}.`,
              },
            ),
          );
        }
      }
    }
  } catch {
    out.push(
      failure(
        "osv",
        "security",
        "security",
        `osv-scanner exited ${r.status}: ${(r.stderr || "").split("\n")[0]}`,
      ),
    );
  }
  return out.slice(0, 10);
}

function semgrepGate(ctx: BuiltinGateContext): GateFailure[] | undefined {
  const config = join(ctx.root, ".sekhemet", "semgrep.yml");
  if (!existsSync(config)) return undefined;
  const files = diffFiles(ctx.diff).filter((f) => existsSync(join(ctx.root, f)));
  if (files.length === 0) return [];
  const r = spawnSync(
    "semgrep",
    ["scan", "--config", config, "--json", "--metrics=off", "--quiet", ...files],
    { cwd: ctx.root, encoding: "utf8", timeout: 300_000 },
  );
  try {
    const report = JSON.parse(r.stdout || "{}") as {
      results?: {
        check_id?: string;
        path?: string;
        start?: { line?: number };
        extra?: { message?: string; severity?: string };
      }[];
    };
    return (report.results ?? [])
      .filter((x) => x.extra?.severity !== "INFO")
      .slice(0, 10)
      .map((x) =>
        failure(
          "semgrep",
          "security",
          "security",
          `${x.path}:${x.start?.line ?? 0} ${x.check_id}: ${x.extra?.message ?? ""}`,
          {
            location: { file: String(x.path), ...(x.start?.line ? { line: x.start.line } : {}) },
          },
        ),
      );
  } catch {
    return [failure("semgrep", "security", "security", `semgrep exited ${r.status}`)];
  }
}

// --- G22 hygiene ----------------------------------------------------------------

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(spec|test)\.[cm]?[jt]sx?$|_test\.(py|go)$/;
export const DEFAULT_DEBUG_PATTERNS = [
  "debugger;",
  "console.debug(",
  "breakpoint()",
  "dbg!(",
  "pdb.set_trace(",
];

function hygieneGate(ctx: BuiltinGateContext): GateFailure[] {
  const out: GateFailure[] = [];
  const patterns = [...DEFAULT_DEBUG_PATTERNS, ...(ctx.project.debugPatterns ?? [])];
  for (const [file, lines] of addedLines(ctx.diff)) {
    if (TEST_FILE.test(file) || file.startsWith(".sekhemet/")) continue;
    for (const { line, text } of lines) {
      const hit = patterns.find((p) => text.includes(p));
      if (!hit) continue;
      out.push(
        failure(
          "hygiene",
          "hygiene",
          "hygiene",
          `${file}:${line} leaves debug output: ${text.trim().slice(0, 120)}`,
          {
            location: { file, line },
            actual: hit,
            suggestedAction: "Remove the debugging statement before the card is reviewed.",
          },
        ),
      );
      if (out.length >= 5) return out;
    }
  }
  // A changelog, when the project keeps one, records every source change.
  const files = diffFiles(ctx.diff);
  const keepsChangelog = ctx.project.changelog ?? existsSync(join(ctx.root, "CHANGELOG.md"));
  const sourceChanged = files.some(
    (f) => !TEST_FILE.test(f) && !f.startsWith(".sekhemet/") && !/\.md$/.test(f),
  );
  if (keepsChangelog && sourceChanged && !files.includes("CHANGELOG.md")) {
    out.push(
      failure(
        "hygiene",
        "hygiene",
        "hygiene",
        "Source changed but CHANGELOG.md has no entry for it",
        {
          location: { file: "CHANGELOG.md" },
          suggestedAction: "Add a one-line entry under Unreleased describing the change.",
        },
      ),
    );
  }
  // Every commit on the card's branch carries the attribution trailers.
  let log = "";
  try {
    log = execFileSync("git", ["log", "--format=%H%x00%B%x01", `${ctx.base}..HEAD`], {
      cwd: ctx.root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
  } catch {
    log = "";
  }
  for (const entry of log.split("").filter((e) => e.trim())) {
    const [sha, body = ""] = entry.trim().split(" ");
    // The sync adapter's own pre-rebase checkpoint (Y6) and merge restacks are the harness's.
    if (/^checkpoint: before rebase onto /.test(body.trim()) && body.includes("Card:")) continue;
    const missing = ["Agent-Model:", "Agent-Harness:"].filter((t) => !body.includes(t));
    if (missing.length > 0) {
      out.push(
        failure(
          "hygiene",
          "hygiene",
          "hygiene",
          `commit ${sha?.slice(0, 10)} lacks the ${missing.join(" and ")} trailer(s)`,
          {
            suggestedAction:
              "Commits on a card branch are made by the harness's checkpoints; do not commit by hand with run_cmd.",
          },
        ),
      );
    }
  }
  return out;
}

// --- G13 diff-scoped mutation testing ------------------------------------------

const SWAPS: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: "!==",
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "===",
  [ts.SyntaxKind.LessThanToken]: "<=",
  [ts.SyntaxKind.LessThanEqualsToken]: "<",
  [ts.SyntaxKind.GreaterThanToken]: ">=",
  [ts.SyntaxKind.GreaterThanEqualsToken]: ">",
  [ts.SyntaxKind.PlusToken]: "-",
  [ts.SyntaxKind.MinusToken]: "+",
  [ts.SyntaxKind.AmpersandAmpersandToken]: "||",
  [ts.SyntaxKind.BarBarToken]: "&&",
  [ts.SyntaxKind.TrueKeyword]: "false",
  [ts.SyntaxKind.FalseKeyword]: "true",
};

export interface LineMutant {
  file: string;
  line: number;
  original: string;
  replacement: string;
  source: string;
}

/** Single-token mutants of `source` on the given lines (scanner tokens: never strings or comments). */
export function mutantsOnLines(
  file: string,
  source: string,
  lines: Set<number>,
  max: number,
): LineMutant[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source,
  );
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  const out: LineMutant[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const replacement = SWAPS[kind];
    if (!replacement) continue;
    const start = scanner.getTokenStart();
    const line = sf.getLineAndCharacterOfPosition(start).line + 1;
    if (!lines.has(line)) continue;
    const original = scanner.getTokenText();
    out.push({
      file,
      line,
      original,
      replacement,
      source: `${source.slice(0, start)}${replacement}${source.slice(start + original.length)}`,
    });
    if (out.length >= max) break;
  }
  return out;
}

async function mutationGate(
  ctx: BuiltinGateContext,
): Promise<{ survivors: LineMutant[]; total: number } | undefined> {
  if (!ctx.runTests) return undefined;
  const max = ctx.project.mutationMax ?? 8;
  const mutants: LineMutant[] = [];
  for (const [file, lines] of addedLines(ctx.diff)) {
    if (TEST_FILE.test(file) || !/\.[cm]?[jt]sx?$/.test(file)) continue;
    const abs = join(ctx.root, file);
    if (!existsSync(abs)) continue;
    mutants.push(
      ...mutantsOnLines(
        file,
        readFileSync(abs, "utf8"),
        new Set(lines.map((l) => l.line)),
        max - mutants.length,
      ),
    );
    if (mutants.length >= max) break;
  }
  const survivors: LineMutant[] = [];
  for (const m of mutants) {
    const abs = join(ctx.root, m.file);
    const original = readFileSync(abs, "utf8");
    try {
      writeFileSync(abs, m.source);
      if (await ctx.runTests()) survivors.push(m);
    } finally {
      writeFileSync(abs, original);
    }
  }
  return { survivors, total: mutants.length };
}

// --- the runner ------------------------------------------------------------------

export async function runBuiltinGates(ctx: BuiltinGateContext): Promise<BuiltinGateResult> {
  const which = ctx.which ?? onPath;
  const enabled = new Set(ctx.gates ?? ctx.project.builtin ?? DEFAULT_BUILTIN_GATES);
  if (ctx.project.mutation) enabled.add("mutation");
  const failures: GateFailure[] = [];
  const outcomes: RungOutcome[] = [];
  const advisories: string[] = [];

  if (enabled.has("secrets")) {
    const t = Date.now();
    const f = secretsGate(ctx, which);
    failures.push(...f);
    outcomes.push(outcome("secrets", "security", "security", f.length === 0, t));
  }
  if (enabled.has("dependencies")) {
    const t = Date.now();
    const r = await dependencyGate(ctx);
    failures.push(...r.failures);
    advisories.push(...r.advisories);
    outcomes.push(outcome("dependencies", "security", "security", r.failures.length === 0, t));
  }
  if (enabled.has("osv")) {
    const t = Date.now();
    if (which("osv-scanner")) {
      const f = osvGate(ctx);
      failures.push(...f);
      outcomes.push(outcome("osv", "security", "security", f.length === 0, t));
    } else outcomes.push(outcome("osv", "security", "security", true, t, true));
  }
  if (enabled.has("semgrep")) {
    const t = Date.now();
    const f = which("semgrep") ? semgrepGate(ctx) : undefined;
    if (f) failures.push(...f);
    outcomes.push(
      outcome("semgrep", "security", "security", (f ?? []).length === 0, t, f === undefined),
    );
  }
  if (enabled.has("hygiene")) {
    const t = Date.now();
    const f = hygieneGate(ctx);
    failures.push(...f);
    outcomes.push(outcome("hygiene", "hygiene", "hygiene", f.length === 0, t));
  }
  if (enabled.has("mutation")) {
    const t = Date.now();
    const r = await mutationGate(ctx);
    if (!r) outcomes.push(outcome("mutation", "robustness", "robustness", true, t, true));
    else {
      for (const m of r.survivors) {
        advisories.push(
          `mutation survived: ${m.file}:${m.line} "${m.original}" -> "${m.replacement}" still passes every test; add a test that pins this behaviour`,
        );
      }
      const blocking = ctx.project.mutationBlocking === true && r.survivors.length > 0;
      if (blocking) {
        failures.push(
          ...r.survivors.slice(0, 3).map((m) =>
            failure(
              "mutation",
              "robustness",
              "robustness",
              `${m.file}:${m.line} "${m.original}" -> "${m.replacement}" survives the tests`,
              {
                location: { file: m.file, line: m.line },
                suggestedAction: "Add a test that fails when this operator changes.",
              },
            ),
          ),
        );
      }
      outcomes.push(outcome("mutation", "robustness", "robustness", !blocking, t));
    }
  }
  return { failures, outcomes, advisories };
}
