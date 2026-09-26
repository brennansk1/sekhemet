import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TomlTable, parseToml } from "@sekhemet/kernel";
import { resolveProgram, runConfined } from "@sekhemet/sandbox";
import ts from "typescript";
import { RERUN_GATES, gateCopy } from "./copy.js";
import { scanDiffForSecrets } from "./secrets.js";
import type {
  CompleteGateFailure,
  GateFailure,
  GateLayer,
  GateProjectConfig,
  GateRung,
  MutationMeasure,
  RungOutcome,
} from "./types.js";
import { VISUAL_GATE_IDS, runVisualGates } from "./visual.js";

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

/** The package registries the gate knows how to ask (G15/S10). */
export type Ecosystem = "npm" | "pypi" | "crates" | "go";

/** A registry answer for one package (G15/S10). */
export interface RegistryInfo {
  exists: boolean;
  /** ISO time the package was first published. */
  created?: string;
  /**
   * Downloads over the registry's recent window (a week where the registry
   * reports one, all time for crates.io). Part of the download profile the
   * design asks for: a real package that nobody downloads is worth a look,
   * not a refusal.
   */
  downloads?: number;
}

export type RegistryLookup = (
  name: string,
  ecosystem?: Ecosystem,
) => Promise<RegistryInfo | undefined>;

export interface BuiltinGateContext {
  /** The card's worktree. */
  root: string;
  /** Branch the card's diff is measured against. */
  base: string;
  /**
   * Unified diff of the card against `base` (staged); undefined when git
   * could not produce it, and then every layer that judges the diff is
   * reported as not run, never passed.
   */
  diff: string | undefined;
  project: GateProjectConfig;
  /** Which gates run; default `project.builtin` or DEFAULT_BUILTIN_GATES. */
  gates?: readonly BuiltinGateId[];
  /** Registry lookup for new dependencies; default reads the local cache only. */
  registry?: RegistryLookup;
  /** Runs the test rung against the worktree as it stands (mutation testing). */
  runTests?: () => Promise<boolean>;
  /** The project's .sekhemet directory (visual baselines). Default `<root>/.sekhemet`. */
  stateDir?: string;
  /** Run the visual layer (G17-G20); the session turns it on once the declared gates pass. */
  visual?: boolean;
  /**
   * Files the harness staged into the worktree and the card may not edit —
   * its acceptance tests. The secrets gate judges what the card wrote: suite
   * run 5's secret-scanner card could never pass, because its staged test holds
   * AWS's documented example key.
   */
  harnessOwned?: readonly string[];
  /** False turns a scanner off (tests). Scanners are otherwise found by `programs`. */
  which?: (program: string) => boolean;
  /** The scanner allowlist; default the harness's fixed PROGRAM_ALLOWLIST (tests override it). */
  programs?: Readonly<Record<string, readonly string[]>>;
  now?: () => number;
}

export interface BuiltinGateResult {
  failures: CompleteGateFailure[];
  outcomes: RungOutcome[];
  /** Advisory findings that do not fail the card (mutation survivors). */
  advisories: string[];
}

/** SEC-35: the name travels as `$1`, never spliced into the script. */
export function onPath(program: string): boolean {
  const r = spawnSync("sh", ["-c", 'command -v -- "$1"', "_", program], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim().length > 0;
}

/**
 * A scanner over the card's files (security item 20b): resolved by absolute
 * path from the fixed allowlist, never PATH, and run through runConfined()
 * with the card's worktree as its root, the allowlisted environment, a
 * private HOME for its caches and no network.
 */
async function runScanner(
  ctx: BuiltinGateContext,
  program: string,
  args: string[],
  timeoutMs: number,
  cwd?: string,
  /**
   * A report file the scanner writes: `{report}` in `args` becomes a path in
   * its own writable home, and what it wrote is read back as `stdout` (a
   * confined scanner may not open /dev/stdout). Absent or empty, stdout stays.
   */
  reportFile?: string,
): Promise<{ status: number; stdout: string; stderr: string; refused: boolean }> {
  const home = mkdtempSync(join(tmpdir(), "sekhemet-scan-home-"));
  try {
    const report = reportFile ? join(home, reportFile) : undefined;
    const r = await runConfined(
      program,
      report ? args.map((a) => (a === "{report}" ? report : a)) : args,
      {
        root: ctx.root,
        ...(cwd ? { cwd } : {}),
        writable: [home],
        env: { HOME: home },
        timeoutMs,
      },
    );
    const written = report && existsSync(report) ? readFileSync(report, "utf8") : "";
    return {
      status: r.exitCode,
      stdout: written.trim() ? written : r.stdout,
      stderr: r.stderr,
      refused: r.exitCode === 126 && r.stderr.startsWith("Refusing to execute"),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function isObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A scanner's JSON report, or undefined when it printed none or one that cannot be read. */
function parseJsonReport(stdout: string, shape: (v: unknown) => boolean): unknown {
  if (!stdout.trim()) return undefined;
  try {
    const v = JSON.parse(stdout) as unknown;
    return shape(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** A scanner that could not run confined: said, never a silent pass. */
function notRun(gate: string, program: string, stderr: string): Draft {
  return failure(
    gate,
    "security",
    "security",
    `${program} not run: ${stderr.split("\n")[0] ?? "no confinement"}`,
    { suggestedAction: gateCopy.gateNotRun(gate), notRun: true },
  );
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

/** The context a layer that judges the diff runs with: the diff was read. */
type DiffContext = BuiltinGateContext & { diff: string };

function outcome(
  gate: string,
  rung: GateRung,
  layer: GateLayer,
  passed: boolean,
  started: number,
  skipped = false,
  reason?: string,
): RungOutcome {
  return {
    gate,
    rung,
    layer,
    // A layer that did not run never records a pass (GT-T1-11).
    passed: passed && !skipped,
    exitCode: skipped ? -1 : passed ? 0 : 1,
    durationMs: Date.now() - started,
    ...(skipped ? { skipped: true } : {}),
    ...(reason ? { reason } : {}),
  };
}

/**
 * A failure as a layer writes it: what the layer knows. `complete` fills the
 * rest from the diff before any failure leaves this module.
 */
type Draft = Omit<
  GateFailure,
  "gate" | "location" | "expected" | "actual" | "minimalRepro" | "suggestedAction"
> & { gate: string } & Partial<
    Pick<GateFailure, "location" | "expected" | "actual" | "minimalRepro" | "suggestedAction">
  >;

function failure(
  gate: string,
  rung: GateRung,
  layer: GateLayer,
  excerpt: string,
  extra: Partial<Draft> = {},
): Draft {
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

async function secretsGate(
  ctx: DiffContext,
  locate: (p: string) => string | undefined,
): Promise<Draft[]> {
  const owned = new Set(ctx.harnessOwned ?? []);
  const found = scanDiffForSecrets(ctx.diff)
    .filter((f) => !owned.has(f.file))
    .map((f) =>
      failure(
        "secrets",
        "security",
        "security",
        `${f.file}:${f.line} adds a ${f.description} (${f.redacted})`,
        {
          location: { file: f.file, line: f.line },
          expected: "no credentials in source",
          actual: f.rule,
          suggestedAction: gateCopy.secret,
        },
      ),
    );
  // gitleaks, when installed, over the changed files (its rule set is larger).
  const gitleaks = locate("gitleaks");
  if (gitleaks) {
    for (const file of diffFiles(ctx.diff)
      .filter((f) => !owned.has(f))
      .slice(0, 50)) {
      const abs = join(ctx.root, file);
      if (!existsSync(abs)) continue;
      const r = await runScanner(
        ctx,
        gitleaks,
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
          "{report}",
        ],
        60_000,
        undefined,
        "gitleaks.json",
      );
      if (r.refused) {
        found.push(notRun("secrets", "gitleaks", r.stderr));
        break;
      }
      // Exit 1 means leaks; anything else is gitleaks failing, never a pass.
      if (r.status !== 0 && r.status !== 1) {
        found.push(notRun("secrets", "gitleaks", r.stderr || `exited ${r.status}`));
        break;
      }
      // Its JSON report is an array, empty when clean: empty or unreadable
      // output is no verdict (GT-T1-3), whatever the exit code.
      const report = parseJsonReport(r.stdout, Array.isArray);
      if (report === undefined) {
        found.push(
          notRun(
            "secrets",
            "gitleaks",
            `exited ${r.status} with ${r.stdout.trim() ? "an unreadable" : "no"} report`,
          ),
        );
        break;
      }
      if (r.status === 0) continue;
      try {
        for (const leak of report as {
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
                suggestedAction: gateCopy.secret,
              },
            ),
          );
        }
      } catch {
        // An unparseable report: gitleaks' own exit code is still a finding.
        found.push(
          failure("secrets", "security", "security", `${file}: gitleaks reports a leak`, {
            location: { file },
            actual: "gitleaks exited 1",
            suggestedAction: gateCopy.secret,
          }),
        );
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

/** A requirement string ("requests>=2.31") reduced to its distribution name. */
function pyName(requirement: string): string {
  return (requirement.split(/[<>=!~\[; ]/)[0] as string).trim();
}

function toml(text: string | undefined): TomlTable {
  if (!text) return {};
  try {
    return parseToml(text);
  } catch {
    // A manifest the card is midway through editing is not the gate's business.
    return {};
  }
}

function table(source: unknown, key: string): TomlTable {
  const value = (source as TomlTable | undefined)?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as TomlTable) : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** PEP 621 `[project]` dependencies plus the Poetry and PDM tables. */
function pyprojectDeps(text: string | undefined): string[] {
  const root = toml(text);
  const project = table(root, "project");
  const names = stringList(project.dependencies).map(pyName);
  for (const group of Object.values(table(project, "optional-dependencies"))) {
    names.push(...stringList(group).map(pyName));
  }
  const tool = table(root, "tool");
  for (const t of ["poetry", "pdm"]) {
    const deps = table(table(tool, t), "dependencies");
    names.push(...Object.keys(deps).filter((n) => n !== "python"));
  }
  return names.filter(Boolean);
}

function cargoDeps(text: string | undefined): string[] {
  const root = toml(text);
  const names: string[] = [];
  for (const section of ["dependencies", "dev-dependencies", "build-dependencies"]) {
    names.push(...Object.keys(table(root, section)));
  }
  // A workspace root declares its shared versions under [workspace.dependencies].
  names.push(...Object.keys(table(table(root, "workspace"), "dependencies")));
  return names;
}

/** `require` lines, single or in a block; the version and any comment are dropped. */
function goDeps(text: string | undefined): string[] {
  if (!text) return [];
  const names: string[] = [];
  let inBlock = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\/\/.*/, "").trim();
    if (!line) continue;
    if (inBlock) {
      if (line === ")") inBlock = false;
      else names.push(line.split(/\s+/)[0] as string);
      continue;
    }
    if (line === "require (") inBlock = true;
    else if (line.startsWith("require ")) names.push(line.split(/\s+/)[1] as string);
  }
  return names.filter(Boolean);
}

/**
 * One cache key per ecosystem, because the same name is a different package
 * in each: `requests` is a top-20 PyPI distribution and an abandoned npm one.
 * npm keeps the bare name so caches written before the other registries
 * existed still answer.
 */
function cacheKey(name: string, ecosystem: Ecosystem): string {
  return ecosystem === "npm" ? name : `${ecosystem}:${name}`;
}

/** Registry answers cached in `.sekhemet/registry-cache.json`, offline. */
export function cachedRegistry(root: string): RegistryLookup {
  return async (name, ecosystem = "npm") => {
    try {
      const cache = JSON.parse(
        readFileSync(join(root, ".sekhemet", "registry-cache.json"), "utf8"),
      ) as Record<string, RegistryInfo>;
      return cache[cacheKey(name, ecosystem)];
    } catch {
      return undefined;
    }
  };
}

function writeCache(cacheRoot: string, key: string, info: RegistryInfo): void {
  const path = join(cacheRoot, ".sekhemet", "registry-cache.json");
  let cache: Record<string, RegistryInfo> = {};
  try {
    cache = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    cache = {};
  }
  cache[key] = info;
  try {
    writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`);
  } catch {
    // A cache write failure costs a lookup next time, nothing else.
  }
}

/**
 * Where each ecosystem's metadata is read from. The defaults are the public
 * registries; an air-gapped or mirrored install points these at its own
 * (verdaccio, devpi, a crates mirror), which is the only way a package that
 * is not mirrored can be refused. npm has no entry: `npm view` already
 * resolves through the user's `.npmrc`, mirror included.
 */
export interface RegistryEndpoints {
  /** npm registry base (the packument API), e.g. a Verdaccio mirror. */
  npm?: string;
  /** PyPI JSON API base, e.g. a devpi index. */
  pypi?: string;
  /** crates.io API base. */
  crates?: string;
  /** Go module proxy. */
  go?: string;
}

export const DEFAULT_REGISTRY_ENDPOINTS: Required<RegistryEndpoints> = {
  npm: "https://registry.npmjs.org",
  pypi: "https://pypi.org/pypi",
  crates: "https://crates.io/api/v1/crates",
  go: "https://proxy.golang.org",
};

export interface EcosystemRegistryOptions {
  cacheRoot?: string;
  endpoints?: RegistryEndpoints;
  /** Injectable for tests; nothing here ever runs offline. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function getJson(
  url: string,
  options: EcosystemRegistryOptions,
): Promise<{ status: number; body: unknown }> {
  const f = options.fetchImpl ?? fetch;
  const res = await f(url, {
    headers: { accept: "application/json", "user-agent": "sekhemet-supply-chain-gate" },
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  if (!res.ok) return { status: res.status, body: undefined };
  return { status: res.status, body: await res.json() };
}

/**
 * npm through the registry's own API, plus the download point it publishes.
 * An HTTP request made by the harness (security item 32, SEC-14): never
 * `npm view` in the worktree, so a worktree `.npmrc` cannot redirect it, and
 * the caller's `fetchImpl` is the network policy that records it.
 */
async function lookupNpm(
  _root: string,
  name: string,
  options: EcosystemRegistryOptions,
): Promise<RegistryInfo | undefined> {
  const base = options.endpoints?.npm ?? DEFAULT_REGISTRY_ENDPOINTS.npm;
  const res = await getJson(
    `${base}/${name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`,
    options,
  );
  if (res.status === 404) return { exists: false };
  const created = (res.body as { time?: { created?: string } } | undefined)?.time?.created;
  if (!res.body) return undefined;
  const downloads = await getJson(
    `https://api.npmjs.org/downloads/point/last-week/${name.split("/").map(encodeURIComponent).join("/")}`,
    options,
  )
    .then((r) => (r.body as { downloads?: number } | undefined)?.downloads)
    .catch(() => undefined);
  return {
    exists: true,
    ...(created ? { created } : {}),
    ...(typeof downloads === "number" ? { downloads } : {}),
  };
}

/** PyPI (or a mirror): first upload time, and the recent download count where one is served. */
async function lookupPypi(
  name: string,
  options: EcosystemRegistryOptions,
): Promise<RegistryInfo | undefined> {
  const base = options.endpoints?.pypi ?? DEFAULT_REGISTRY_ENDPOINTS.pypi;
  const res = await getJson(`${base}/${encodeURIComponent(name)}/json`, options);
  if (res.status === 404) return { exists: false };
  const body = res.body as
    | { releases?: Record<string, { upload_time_iso_8601?: string }[]>; info?: unknown }
    | undefined;
  if (!body) return undefined;
  // The first upload of any release is the distribution's age; the JSON API
  // orders releases by version, not by date, so take the earliest seen.
  let created: string | undefined;
  for (const files of Object.values(body.releases ?? {})) {
    for (const file of files) {
      const t = file.upload_time_iso_8601;
      if (t && (created === undefined || t < created)) created = t;
    }
  }
  const downloads = (body.info as { downloads?: { last_week?: number } } | undefined)?.downloads
    ?.last_week;
  return {
    exists: true,
    ...(created ? { created } : {}),
    // PyPI reports -1 where it keeps no count; that is "unknown", not zero.
    ...(typeof downloads === "number" && downloads >= 0 ? { downloads } : {}),
  };
}

/** crates.io (or a mirror): `created_at` and the crate's download total. */
async function lookupCrates(
  name: string,
  options: EcosystemRegistryOptions,
): Promise<RegistryInfo | undefined> {
  const base = options.endpoints?.crates ?? DEFAULT_REGISTRY_ENDPOINTS.crates;
  const res = await getJson(`${base}/${encodeURIComponent(name)}`, options);
  if (res.status === 404) return { exists: false };
  const crate = (res.body as { crate?: { created_at?: string; downloads?: number } } | undefined)
    ?.crate;
  if (!crate) return undefined;
  return {
    exists: true,
    ...(crate.created_at ? { created: crate.created_at } : {}),
    ...(typeof crate.downloads === "number" ? { downloads: crate.downloads } : {}),
  };
}

/**
 * The Go module proxy: `@v/list` answers 404 for a module that does not
 * exist. The proxy publishes no counts and no first-publish time, so a Go
 * module is checked for existence only.
 */
async function lookupGo(
  name: string,
  options: EcosystemRegistryOptions,
): Promise<RegistryInfo | undefined> {
  const base = options.endpoints?.go ?? DEFAULT_REGISTRY_ENDPOINTS.go;
  const f = options.fetchImpl ?? fetch;
  // Module paths are case-encoded on the proxy (!upper for each capital).
  const path = name.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
  const res = await f(`${base}/${path}/@v/list`, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  if (res.status === 404 || res.status === 410) return { exists: false };
  return res.ok ? { exists: true } : undefined;
}

/**
 * The registry lookup the supply-chain gate uses online (S10, G15): npm,
 * PyPI, crates.io and the Go module proxy, every answer cached so the same
 * question is not asked twice and so an air-gapped run can still answer it.
 * A registry that cannot be reached returns undefined, which the gate reports
 * as unverified rather than treating as absence.
 */
export function ecosystemRegistry(
  root: string,
  cacheRootOrOptions: string | EcosystemRegistryOptions = root,
): RegistryLookup {
  const options: EcosystemRegistryOptions =
    typeof cacheRootOrOptions === "string" ? { cacheRoot: cacheRootOrOptions } : cacheRootOrOptions;
  const cacheRoot = options.cacheRoot ?? root;
  const cached = cachedRegistry(cacheRoot);
  return async (name, ecosystem = "npm") => {
    const hit = await cached(name, ecosystem);
    if (hit) return hit;
    const info = await (ecosystem === "npm"
      ? lookupNpm(root, name, options)
      : ecosystem === "pypi"
        ? lookupPypi(name, options)
        : ecosystem === "crates"
          ? lookupCrates(name, options)
          : lookupGo(name, options)
    ).catch(() => undefined);
    if (info) writeCache(cacheRoot, cacheKey(name, ecosystem), info);
    return info;
  };
}

/**
 * The name the harness wires today. It is no longer npm-only: the lookup
 * answers for whichever ecosystem the manifest belongs to.
 */
export const npmRegistry = ecosystemRegistry;

/** Packages younger than this are not added without a person (days). */
export const MIN_PACKAGE_AGE_DAYS = 30;

/**
 * Download floor, one signal among the others. A package under it is
 * reported with its number and never blocked: a legitimate new library, an
 * internal package and a niche crate all sit below any floor worth setting,
 * so a block here would refuse correct work. crates.io reports lifetime
 * downloads rather than a week's, hence the separate floor.
 */
export const MIN_WEEKLY_DOWNLOADS: Record<Ecosystem, number> = {
  npm: 100,
  pypi: 100,
  crates: 1000,
  go: 0,
};

/**
 * The manifests a card can add a dependency to, and the registry each one
 * answers to. A Python addition checked against npm is not a check: the name
 * exists in the wrong registry, or does not exist in either, and both
 * answers are wrong.
 */
export const DEPENDENCY_MANIFESTS: readonly {
  file: string;
  ecosystem: Ecosystem;
  parse: (text: string | undefined) => string[];
}[] = [
  { file: "package.json", ecosystem: "npm", parse: npmDeps },
  { file: "requirements.txt", ecosystem: "pypi", parse: pyDeps },
  { file: "pyproject.toml", ecosystem: "pypi", parse: pyprojectDeps },
  { file: "Cargo.toml", ecosystem: "crates", parse: cargoDeps },
  { file: "go.mod", ecosystem: "go", parse: goDeps },
];

async function dependencyGate(
  ctx: DiffContext,
): Promise<{ failures: Draft[]; advisories: string[] }> {
  const failures: Draft[] = [];
  const advisories: string[] = [];
  const registry = ctx.registry ?? cachedRegistry(ctx.root);
  const now = ctx.now?.() ?? Date.now();
  const changed = new Set(diffFiles(ctx.diff));
  for (const m of DEPENDENCY_MANIFESTS) {
    if (!changed.has(m.file)) continue;
    const before = new Set(m.parse(gitShow(ctx.root, ctx.base, m.file)));
    const after = m.parse(
      existsSync(join(ctx.root, m.file)) ? readFileSync(join(ctx.root, m.file), "utf8") : undefined,
    );
    const added = after.filter((d) => !before.has(d));
    for (const dep of added) {
      // A Go module path shares no namespace with the popular-package list,
      // so it is only compared against the project's own dependencies.
      const known = m.ecosystem === "go" ? [...before] : [...before, ...POPULAR_PACKAGES];
      const squat = typosquatOf(dep, known);
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
              suggestedAction: gateCopy.typosquat(squat, dep),
            },
          ),
        );
        continue;
      }
      const info = await registry(dep, m.ecosystem).catch(() => undefined);
      if (!info) {
        advisories.push(
          `dependency ${dep} (${m.ecosystem}): not in the registry cache; existence and age unverified offline`,
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
              suggestedAction: gateCopy.unknownPackage,
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
                suggestedAction: gateCopy.newPackage(dep),
              },
            ),
          );
          continue;
        }
      }
      const floor = MIN_WEEKLY_DOWNLOADS[m.ecosystem];
      if (info.downloads !== undefined && floor > 0 && info.downloads < floor) {
        advisories.push(
          `dependency ${dep} (${m.ecosystem}): ${info.downloads} recent download(s), under the ${floor} floor — check it is the package you meant`,
        );
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

async function osvGate(ctx: BuiltinGateContext, osv: string): Promise<Draft[]> {
  const lock = LOCKFILES.find((f) => existsSync(join(ctx.root, f)));
  if (!lock) return [];
  const r = await runScanner(
    ctx,
    osv,
    ["--offline", "--format", "json", "--lockfile", join(ctx.root, lock)],
    120_000,
  );
  if (r.refused) return [notRun("osv", "osv-scanner", r.stderr)];
  // Its JSON report is an object even when clean: empty or unreadable output
  // is no verdict (GT-T1-3).
  if (parseJsonReport(r.stdout, isObject) === undefined) {
    return [
      notRun(
        "osv",
        "osv-scanner",
        `exited ${r.status} with ${r.stdout.trim() ? "an unreadable" : "no"} report`,
      ),
    ];
  }
  if (r.status === 0) return [];
  const out: Draft[] = [];
  try {
    const report = JSON.parse(r.stdout || "{}") as {
      results?: {
        packages?: {
          package?: { name?: string; version?: string };
          vulnerabilities?: { id?: string; summary?: string }[];
        }[];
      }[];
    };
    // A non-zero exit that names no vulnerability is a scanner failure, not a
    // clean result (B1 review): e.g. no local database under the private HOME.
    if (!(report.results ?? []).some((x) => (x.packages ?? []).length > 0)) {
      return [notRun("osv", "osv-scanner", r.stderr || `exited ${r.status} with no report`)];
    }
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
                suggestedAction: gateCopy.vulnerable(String(p.package?.name), String(v.id)),
              },
            ),
          );
        }
      }
    }
  } catch {
    return [notRun("osv", "osv-scanner", r.stderr || `exited ${r.status} with no report`)];
  }
  return out.slice(0, 10);
}

async function semgrepGate(ctx: DiffContext, semgrep: string): Promise<Draft[] | undefined> {
  const config = join(ctx.root, ".sekhemet", "semgrep.yml");
  if (!existsSync(config)) return undefined;
  const files = diffFiles(ctx.diff).filter((f) => existsSync(join(ctx.root, f)));
  if (files.length === 0) return [];
  const r = await runScanner(
    ctx,
    semgrep,
    ["scan", "--config", config, "--json", "--metrics=off", "--quiet", ...files],
    300_000,
  );
  if (r.refused) return [notRun("semgrep", "semgrep", r.stderr)];
  // `--json` prints an object with `results` even when clean: empty or
  // unreadable output is no verdict (GT-T1-3).
  const parsed = parseJsonReport(r.stdout, isObject) as { results?: unknown } | undefined;
  if (parsed === undefined || !Array.isArray(parsed.results)) {
    return [
      notRun(
        "semgrep",
        "semgrep",
        `exited ${r.status} with ${r.stdout.trim() ? "an unreadable" : "no"} report`,
      ),
    ];
  }
  try {
    const report = JSON.parse(r.stdout || "{}") as {
      errors?: unknown[];
      results?: {
        check_id?: string;
        path?: string;
        start?: { line?: number };
        extra?: { message?: string; severity?: string };
      }[];
    };
    // Exit 0 is clean and 1 is findings; any other exit with no results is
    // semgrep failing, never a pass.
    if (r.status !== 0 && r.status !== 1 && (report.results ?? []).length === 0) {
      return [notRun("semgrep", "semgrep", r.stderr || `exited ${r.status}`)];
    }
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
            suggestedAction: gateCopy.staticFinding(String(x.path), String(x.start?.line ?? 1)),
          },
        ),
      );
  } catch {
    return [notRun("semgrep", "semgrep", r.stderr || `exited ${r.status} with no report`)];
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

function hygieneGate(ctx: DiffContext): Draft[] {
  const out: Draft[] = [];
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
            suggestedAction: gateCopy.debugStatement,
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
          suggestedAction: gateCopy.changelog,
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
            suggestedAction: gateCopy.handCommit,
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

const MUTABLE_SOURCE = /\.[cm]?[jt]sx?$/;
const MUTATION_TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(spec|test)\.[cm]?[jt]sx?$/;
/**
 * Files that are not code: prose, data, configuration, styles, markup and
 * images. The rule names what is safe to skip, so an unlisted language is
 * reported rather than silently skipped.
 */
const NOT_CODE =
  /\.(md|mdx|markdown|txt|rst|adoc|json|jsonc|json5|ya?ml|toml|ini|cfg|conf|env|lock|csv|tsv|svg|png|jpe?g|gif|ico|webp|pdf|css|scss|sass|less|html?|xml|map|snap|d\.ts)$/i;

/**
 * Why a changed file's mutation was not measured (MS-M10-3), or undefined
 * when it is JS/TS the operators mutate, not code, a test, or has no
 * extension. One rule for this gate and the mutation step (B2.4 review).
 */
export function mutationNotMeasured(file: string): string | undefined {
  const ext = /\.[A-Za-z0-9]+$/.exec(file)?.[0];
  if (!ext || MUTABLE_SOURCE.test(file) || NOT_CODE.test(file)) return undefined;
  if (MUTATION_TEST_FILE.test(file)) return undefined;
  return `no mutation operators for ${ext} files`;
}

/** The unmutated tests fail: every mutant would count as killed (MS-M10-4). */
const BASELINE_FAILS =
  "the tests fail on the unmutated change, so a killed mutant would prove nothing";
const NO_MUTABLE_LINES = "no mutable lines in the change";

async function mutationGate(
  ctx: DiffContext,
): Promise<{ survivors: LineMutant[]; measure: MutationMeasure } | undefined> {
  const runTests = ctx.runTests;
  if (!runTests) return undefined;
  const max = ctx.project.mutationMax ?? 8;
  const mutants: LineMutant[] = [];
  const notMeasured: MutationMeasure["notMeasured"] = [];
  for (const [file, lines] of addedLines(ctx.diff)) {
    if (TEST_FILE.test(file)) continue;
    const notMutable = mutationNotMeasured(file);
    if (notMutable) {
      notMeasured.push({ file, reason: notMutable });
      continue;
    }
    if (!/\.[cm]?[jt]sx?$/.test(file) || mutants.length >= max) continue;
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
  }
  notMeasured.sort((a, b) => a.file.localeCompare(b.file));
  const unscored = (refused: string): { survivors: LineMutant[]; measure: MutationMeasure } => ({
    survivors: [],
    measure: { score: null, killed: 0, total: 0, refused, notMeasured },
  });
  // Nothing to mutate is not measured, never a pass (MS-M10-2).
  if (mutants.length === 0) return unscored(NO_MUTABLE_LINES);
  // The unmutated tests must pass before any mutant counts (MS-M10-1).
  if (!(await runTests())) return unscored(BASELINE_FAILS);
  const survivors: LineMutant[] = [];
  for (const m of mutants) {
    const abs = join(ctx.root, m.file);
    const original = readFileSync(abs, "utf8");
    try {
      writeFileSync(abs, m.source);
      if (await runTests()) survivors.push(m);
    } finally {
      writeFileSync(abs, original);
    }
  }
  const killed = mutants.length - survivors.length;
  return {
    survivors,
    // Rounded as the mutation step rounds it, so the two report one figure.
    measure: {
      score: Math.round((killed / mutants.length) * 1000) / 1000,
      killed,
      total: mutants.length,
      notMeasured,
    },
  };
}

// --- the runner ------------------------------------------------------------------

/** What a layer expects, for a failure that does not say (rule 19). */
const EXPECTED: Record<string, string> = {
  secrets: "no credentials in source",
  dependencies: "only existing, established packages",
  osv: "no known vulnerabilities in the dependencies",
  semgrep: "no static-analysis findings",
  hygiene: "no debug output, a changelog entry, harness-made commits",
  mutation: "a test that fails when this line changes",
};

/**
 * Every built-in failure carries all six fields (rule 19, GT-M6-6). The
 * layers name what they know; this fills the rest from the diff: the whole
 * change is `.`, and the repro shows the lines the gate judged.
 */
function complete(f: Draft, base: string): CompleteGateFailure {
  const file = f.location?.file || f.suggestedFixFiles[0] || ".";
  return {
    ...f,
    location: f.location?.file ? f.location : { file },
    expected: f.expected || EXPECTED[f.gate] || `${f.gate} to pass`,
    actual: f.actual || f.errorExcerpt,
    minimalRepro:
      f.minimalRepro || (file === "." ? `git diff ${base}` : `git diff ${base} -- ${file}`),
    suggestedAction: f.suggestedAction || gateCopy.rerun(RERUN_GATES),
  };
}

/**
 * Run one layer so that it can never vanish (B2.3): a layer that throws is
 * reported as not run, with its reason, and fails its outcome.
 */
async function guarded(
  gate: string,
  rung: GateRung,
  layer: GateLayer,
  failures: Draft[],
  outcomes: RungOutcome[],
  run: () => Promise<void>,
): Promise<void> {
  const t = Date.now();
  try {
    await run();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    failures.push(
      failure(gate, rung, layer, `${gate} not run: ${reason.split("\n")[0]}`, {
        actual: reason.split("\n")[0] ?? reason,
        suggestedAction: gateCopy.gateNotRun(gate),
        notRun: true,
      }),
    );
    outcomes.push(outcome(gate, rung, layer, false, t));
  }
}

/** The built-in layers a run enables: `gates` when given, else the project's, plus mutation. */
function enabledLayers(
  project: GateProjectConfig,
  gates?: readonly BuiltinGateId[],
): Set<BuiltinGateId> {
  const enabled = new Set(gates ?? project.builtin ?? DEFAULT_BUILTIN_GATES);
  if (project.mutation) enabled.add("mutation");
  return enabled;
}

/**
 * Every gate id the built-in layers can put on a failure for this project,
 * sorted: the enabled layers and, with a `[visual]` table, the visual layer's
 * ids and its guard's (GT-M6-5 builds `note`'s enum from here).
 */
export function builtinGateIds(project: GateProjectConfig): string[] {
  const ids: string[] = [...enabledLayers(project)];
  if (project.visual) ids.push("visual", ...VISUAL_GATE_IDS);
  return [...new Set(ids)].sort();
}

/** The layers that judge the card's diff: without the diff they cannot run. */
const DIFF_LAYERS: ReadonlySet<BuiltinGateId> = new Set([
  "secrets",
  "dependencies",
  "semgrep",
  "hygiene",
  "mutation",
]);

const LAYER_RUNGS: Record<BuiltinGateId, GateRung> = {
  secrets: "security",
  dependencies: "security",
  osv: "security",
  semgrep: "security",
  hygiene: "hygiene",
  mutation: "robustness",
};

export async function runBuiltinGates(ctx: BuiltinGateContext): Promise<BuiltinGateResult> {
  // Scanners by absolute path from the fixed allowlist, never PATH (20b);
  // `which` lets a test turn them off.
  const locate = (p: string) =>
    ctx.which && !ctx.which(p) ? undefined : resolveProgram(p, ctx.programs);
  const enabled = enabledLayers(ctx.project, ctx.gates);
  const failures: Draft[] = [];
  const outcomes: RungOutcome[] = [];
  const advisories: string[] = [];
  const guard = (gate: string, rung: GateRung, layer: GateLayer, run: () => Promise<void>) =>
    guarded(gate, rung, layer, failures, outcomes, run);

  // The diff could not be read (a git error): every layer that judges it is
  // reported as not run — never a clean result on an empty diff.
  if (ctx.diff === undefined) {
    for (const gate of [...enabled].filter((g) => DIFF_LAYERS.has(g)).sort()) {
      const rung = LAYER_RUNGS[gate];
      failures.push(
        failure(
          gate,
          rung,
          rung as GateLayer,
          `${gate} not run: the card's diff could not be read`,
          {
            actual: "git could not produce the diff",
            suggestedAction: gateCopy.gateNotRun(gate),
            notRun: true,
          },
        ),
      );
      outcomes.push(outcome(gate, rung, rung as GateLayer, false, Date.now()));
      enabled.delete(gate);
    }
  }
  const dctx: DiffContext = { ...ctx, diff: ctx.diff ?? "" };

  if (enabled.has("secrets")) {
    await guard("secrets", "security", "security", async () => {
      const t = Date.now();
      const f = await secretsGate(dctx, locate);
      failures.push(...f);
      outcomes.push(outcome("secrets", "security", "security", f.length === 0, t));
    });
  }
  if (enabled.has("dependencies")) {
    await guard("dependencies", "security", "security", async () => {
      const t = Date.now();
      const r = await dependencyGate(dctx);
      failures.push(...r.failures);
      advisories.push(...r.advisories);
      outcomes.push(outcome("dependencies", "security", "security", r.failures.length === 0, t));
    });
  }
  if (enabled.has("osv")) {
    await guard("osv", "security", "security", async () => {
      const t = Date.now();
      const osv = locate("osv-scanner");
      // Nothing to scan is a skip, never a pass.
      if (osv && !LOCKFILES.some((f) => existsSync(join(ctx.root, f)))) {
        outcomes.push(outcome("osv", "security", "security", true, t, true, "no lockfile to scan"));
      } else if (osv) {
        const f = await osvGate(ctx, osv);
        failures.push(...f);
        outcomes.push(outcome("osv", "security", "security", f.length === 0, t));
      } else {
        outcomes.push(
          outcome("osv", "security", "security", true, t, true, "osv-scanner is not installed"),
        );
      }
    });
  }
  if (enabled.has("semgrep")) {
    await guard("semgrep", "security", "security", async () => {
      const t = Date.now();
      const semgrep = locate("semgrep");
      const f = semgrep ? await semgrepGate(dctx, semgrep) : undefined;
      if (f) failures.push(...f);
      outcomes.push(
        outcome(
          "semgrep",
          "security",
          "security",
          (f ?? []).length === 0,
          t,
          f === undefined,
          !semgrep
            ? "semgrep is not installed"
            : f === undefined
              ? "no .sekhemet/semgrep.yml rules"
              : undefined,
        ),
      );
    });
  }
  if (enabled.has("hygiene")) {
    await guard("hygiene", "hygiene", "hygiene", async () => {
      const t = Date.now();
      const f = hygieneGate(dctx);
      failures.push(...f);
      outcomes.push(outcome("hygiene", "hygiene", "hygiene", f.length === 0, t));
    });
  }
  if (enabled.has("mutation")) {
    await guard("mutation", "robustness", "robustness", async () => {
      const t = Date.now();
      const r = await mutationGate(dctx);
      if (!r) {
        outcomes.push(
          outcome("mutation", "robustness", "robustness", true, t, true, "no test runner given"),
        );
        return;
      }
      const measured = (o: RungOutcome): RungOutcome => ({ ...o, mutation: r.measure });
      const refused = r.measure.refused;
      if (refused === BASELINE_FAILS && ctx.project.mutationBlocking === true) {
        // A blocking gate that could not score is not run: never a pass, and
        // never the Worker's failure (rule 9).
        failures.push(
          failure("mutation", "robustness", "robustness", `mutation not run: ${refused}`, {
            actual: refused,
            suggestedAction: gateCopy.gateNotRun("mutation"),
            notRun: true,
          }),
        );
        outcomes.push(
          measured(outcome("mutation", "robustness", "robustness", false, t, false, refused)),
        );
        return;
      }
      if (refused !== undefined) {
        outcomes.push(
          measured(outcome("mutation", "robustness", "robustness", true, t, true, refused)),
        );
        return;
      }
      for (const m of r.survivors) {
        advisories.push(
          `mutation survived: ${m.file}:${m.line} "${m.original}" -> "${m.replacement}" still passes every test; add a test that pins this behaviour`,
        );
      }
      const blocking = ctx.project.mutationBlocking === true && r.survivors.length > 0;
      if (blocking) {
        // A survivor is a gap in the tests, which the implementer may not
        // edit (rule 17, GT-M6-4): the remedy routes it to a person.
        failures.push(
          ...r.survivors.slice(0, 3).map((m) =>
            failure(
              "mutation",
              "robustness",
              "robustness",
              `${m.file}:${m.line} "${m.original}" -> "${m.replacement}" survives the tests`,
              {
                location: { file: m.file, line: m.line },
                actual: `"${m.original}" -> "${m.replacement}" passes every test`,
                suggestedAction: gateCopy.mutationGap(m.file, String(m.line)),
              },
            ),
          ),
        );
      }
      outcomes.push(measured(outcome("mutation", "robustness", "robustness", !blocking, t)));
    });
  }
  if (ctx.project.visual && ctx.visual) {
    const visual = ctx.project.visual;
    await guard("visual", "visual", "visual", async () => {
      const r = await runVisualGates({
        root: ctx.root,
        config: visual,
        stateDir: ctx.stateDir ?? join(ctx.root, ".sekhemet"),
      });
      failures.push(...r.failures);
      outcomes.push(...r.outcomes);
      advisories.push(...r.advisories);
    });
  }
  return { failures: failures.map((f) => complete(f, ctx.base)), outcomes, advisories };
}
