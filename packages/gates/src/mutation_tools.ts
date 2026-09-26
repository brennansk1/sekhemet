import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { runConfined } from "@sekhemet/sandbox";
import { XMLParser } from "fast-xml-parser";

/**
 * The optional per-language mutation tools (GT-N5-2, DEC-44): mutmut for
 * Python, cargo-mutants for Rust, PIT for Java and Kotlin. Each runs as a
 * confined subprocess over the card's worktree (security item 20b: the
 * worktree as root, a private HOME, no network), scoped to the diff, and only
 * the mutants on the diff's added lines are kept. A run whose unmutated tests
 * fail, or whose report is missing or unreadable, is `refused` — never a pass
 * (gates rule 9). The caller records a language whose tool is not installed
 * as "mutation not measured: <tool> not installed".
 */

export type MutationToolId = "mutmut" | "cargo-mutants" | "pit";

export interface ToolMutant {
  /** The diff's path of the mutated file. */
  file: string;
  /** 1-based line in the new file. */
  line: number;
  description: string;
  status: "killed" | "survived" | "stillborn" | "timeout" | "not_covered";
}

export interface ToolMutationRun {
  tool: MutationToolId;
  files: string[];
  /** Only the mutants on the diff's added lines. */
  mutants: ToolMutant[];
  /** Why the run measured nothing: a failing baseline, a missing or unreadable report. */
  refused?: string;
}

/**
 * The tool for a file and the allowlisted programs that run it
 * (`PROGRAM_ALLOWLIST`, first installed wins). Java and Kotlin run PIT through
 * the project's build: `mvn` with a `pom.xml`, `gradle` with a
 * `build.gradle(.kts)`; with no `root`, both are candidates; with a root that
 * has neither, there is no tool.
 */
export function mutationToolFor(
  file: string,
  root?: string,
): { tool: MutationToolId; programs: string[] } | undefined {
  const ext = extname(file).toLowerCase();
  if (ext === ".py") return { tool: "mutmut", programs: ["mutmut"] };
  if (ext === ".rs") return { tool: "cargo-mutants", programs: ["cargo-mutants"] };
  if (ext === ".java" || ext === ".kt") {
    if (root === undefined) return { tool: "pit", programs: ["mvn", "gradle"] };
    const programs: string[] = [];
    if (existsSync(join(root, "pom.xml"))) programs.push("mvn");
    if (existsSync(join(root, "build.gradle")) || existsSync(join(root, "build.gradle.kts"))) {
      programs.push("gradle");
    }
    return programs.length ? { tool: "pit", programs } : undefined;
  }
  return undefined;
}

export interface RunMutationToolOptions {
  tool: MutationToolId;
  /** The tool's absolute path, resolved from the allowlist (never PATH). */
  program: string;
  /** The card's worktree. */
  root: string;
  /** The diff's paths in this tool's language. */
  files: string[];
  /** Added lines per file (new line numbers): only mutants on these are kept. */
  lines: Map<string, Set<number>>;
  /** The card's unified diff (cargo-mutants reads it with `--in-diff`). */
  diff: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000;

/** What one confined invocation returned, or why it did not run. */
interface Invocation {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Set when the process never ran to an exit: not started, refused, timed out, out of memory. */
  failed?: string;
}

export async function runMutationTool(opts: RunMutationToolOptions): Promise<ToolMutationRun> {
  const home = mkdtempSync(join(tmpdir(), "sekhemet-mutation-home-"));
  const base: ToolMutationRun = { tool: opts.tool, files: [...opts.files], mutants: [] };
  const invoke = async (args: string[], env: Record<string, string> = {}): Promise<Invocation> => {
    const r = await runConfined(opts.program, args, {
      root: opts.root,
      writable: [home],
      env: { HOME: home, ...env },
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const firstErr = r.stderr.split("\n").find((l) => l.trim()) ?? "";
    const failed = r.notStarted
      ? `could not start (${firstErr || "no confinement"})`
      : r.exitCode === 126 && r.stderr.startsWith("Refusing to execute")
        ? `not run: ${firstErr}`
        : r.timedOut
          ? "timed out"
          : r.oomKilled
            ? "exceeded its memory cap"
            : undefined;
    return {
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      ...(failed ? { failed } : {}),
    };
  };
  try {
    const result =
      opts.tool === "mutmut"
        ? await runMutmut(opts, invoke)
        : opts.tool === "cargo-mutants"
          ? await runCargoMutants(opts, home, invoke)
          : await runPit(opts, invoke);
    if (typeof result === "string") return { ...base, refused: `${opts.tool}: ${result}` };
    return { ...base, mutants: onAddedLines(result, opts.lines) };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

type Invoke = (args: string[], env?: Record<string, string>) => Promise<Invocation>;

function onAddedLines(mutants: ToolMutant[], lines: Map<string, Set<number>>): ToolMutant[] {
  return mutants.filter((m) => lines.get(m.file)?.has(m.line) === true);
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim()) ?? "";
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
}

function nodes(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.filter((x) => x && typeof x === "object");
  return v && typeof v === "object" ? [v as Record<string, unknown>] : [];
}

function stripDot(path: string): string {
  return path.replace(/^\.\//, "");
}

// ---- mutmut ---------------------------------------------------------------

/*
 * mutmut 2.x (https://github.com/boxed/mutmut, README "Command line" and
 * "Exit codes"; https://mutmut.readthedocs.io/): `mutmut run
 * --paths-to-mutate a.py,b.py` first runs the tests unmutated and aborts when
 * they fail. Its exit code is a bit field: 1 fatal error (a failing baseline
 * among them), 2 survivors, 4 timeouts, 8 suspicious. `mutmut junitxml`
 * prints the results as JUnit XML, one testcase per mutant with its `file`
 * and 1-based `line`: a `failure` is a survivor (`bad_survived`), an `error`
 * a timeout (`bad_timeout`); `--untested-policy=skipped` reports untested
 * mutants as `skipped`, `--suspicious-policy=ignore` counts a slow kill as
 * killed. mutmut keeps its results in `.mutmut-cache` in the working tree.
 */

const junitParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "#text",
  isArray: (name) => ["testsuite", "testcase"].includes(name),
  parseAttributeValue: false,
  trimValues: true,
});

async function runMutmut(
  opts: RunMutationToolOptions,
  invoke: Invoke,
): Promise<ToolMutant[] | string> {
  const files = opts.files.filter((f) => extname(f).toLowerCase() === ".py");
  if (files.length === 0) return [];
  // A cache left in the worktree (by an earlier run, or written by the card)
  // would be read as this run's results: it never counts.
  rmSync(join(opts.root, ".mutmut-cache"), { force: true });
  const run = await invoke(["run", "--paths-to-mutate", files.join(",")]);
  if (run.failed) return run.failed;
  if ((run.exitCode & 1) !== 0) {
    return `the unmutated tests did not pass, or mutmut failed (exit ${run.exitCode}): ${firstLine(run.stderr || run.stdout)}`;
  }
  const report = await invoke([
    "junitxml",
    "--suspicious-policy=ignore",
    "--untested-policy=skipped",
  ]);
  if (report.failed) return report.failed;
  if (report.exitCode !== 0) return `junitxml exited ${report.exitCode}`;
  return parseMutmutJUnit(report.stdout);
}

function parseMutmutJUnit(xml: string): ToolMutant[] | string {
  if (!xml.trim()) return "no report";
  let doc: Record<string, unknown>;
  try {
    doc = junitParser.parse(xml, true) as Record<string, unknown>;
  } catch {
    return "an unreadable report";
  }
  const top = (doc.testsuites ?? doc) as Record<string, unknown>;
  const suites = nodes(top.testsuite);
  if (suites.length === 0) return "an unreadable report (no testsuite)";
  const out: ToolMutant[] = [];
  for (const suite of suites) {
    for (const c of nodes(suite.testcase)) {
      const file = str(c.file);
      const line = Number(str(c.line));
      if (!file || !Number.isInteger(line))
        return "an unreadable report (a mutant without file or line)";
      const status: ToolMutant["status"] =
        c.failure !== undefined
          ? "survived"
          : c.error !== undefined
            ? "timeout"
            : c.skipped !== undefined
              ? "not_covered"
              : "killed";
      const failureText = str(nodes(c.failure)[0]?.["#text"]) ?? str(c.failure) ?? "";
      const mutated = failureText
        .split("\n")
        .find((l) => l.startsWith("+") && !l.startsWith("+++"))
        ?.slice(1)
        .trim();
      const original = str(c["system-out"])?.trim();
      const name = str(c.name) ?? "mutant";
      out.push({
        file: stripDot(file),
        line,
        description: mutated ? `${name}: ${mutated}` : original ? `${name} on ${original}` : name,
        status,
      });
    }
  }
  return out;
}

// ---- cargo-mutants ----------------------------------------------------------

/*
 * cargo-mutants (https://mutants.rs/): `cargo mutants --in-diff FILE` tests
 * only the mutants on the diff's lines (https://mutants.rs/in-diff.html);
 * `--output DIR` puts results in `DIR/mutants.out/`, whose `outcomes.json`
 * lists every scenario with its `summary`
 * (https://mutants.rs/mutants-out.html): the `Baseline` scenario (the
 * unmutated build and tests) and each `{"Mutant": {file, span, replacement,
 * genre, function}}` as CaughtMutant, MissedMutant, Unviable or Timeout.
 * Exit codes (https://mutants.rs/exit-codes.html): 0 all caught, 2 missed
 * mutants, 3 timeouts, 4 the baseline failed. As a cargo subcommand the
 * binary receives `mutants` as its first argument.
 */

const CARGO_SUMMARY: Record<string, ToolMutant["status"]> = {
  CaughtMutant: "killed",
  MissedMutant: "survived",
  Unviable: "stillborn",
  Timeout: "timeout",
};

async function runCargoMutants(
  opts: RunMutationToolOptions,
  home: string,
  invoke: Invoke,
): Promise<ToolMutant[] | string> {
  if (!opts.files.some((f) => extname(f).toLowerCase() === ".rs")) return [];
  const diffFile = join(home, "card.diff");
  const out = join(home, "out");
  writeFileSync(diffFile, opts.diff);
  // `cargo` beside cargo-mutants (~/.cargo/bin) and the user's toolchains:
  // HOME is private, so rustup would otherwise find none. Offline: no network.
  const realRustup = process.env.RUSTUP_HOME ?? join(homedir(), ".rustup");
  const env: Record<string, string> = {
    PATH: [dirname(opts.program), process.env.PATH ?? ""].filter(Boolean).join(":"),
    CARGO_NET_OFFLINE: "true",
    ...(existsSync(realRustup) ? { RUSTUP_HOME: realRustup } : {}),
  };
  const r = await invoke(["mutants", "--in-diff", diffFile, "--output", out, "--no-shuffle"], env);
  if (r.failed) return r.failed;
  if (r.exitCode === 4) return "the unmutated build or tests failed (baseline, exit 4)";
  if (![0, 2, 3].includes(r.exitCode)) {
    return `exited ${r.exitCode}: ${firstLine(r.stderr || r.stdout)}`;
  }
  const path = join(out, "mutants.out", "outcomes.json");
  if (!existsSync(path)) return "no outcomes.json";
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return "an unreadable outcomes.json";
  }
  const outcomes = (doc as { outcomes?: unknown } | null)?.outcomes;
  if (!Array.isArray(outcomes)) return "an unreadable outcomes.json (no outcomes)";
  let baseline: string | undefined;
  const mutants: ToolMutant[] = [];
  for (const o of outcomes as Record<string, unknown>[]) {
    const summary = str(o?.summary);
    const scenario = o?.scenario;
    if (scenario === "Baseline") {
      baseline = summary;
      continue;
    }
    const m = (scenario as { Mutant?: Record<string, unknown> } | null)?.Mutant;
    if (!m) continue;
    const status = summary ? CARGO_SUMMARY[summary] : undefined;
    if (!status) return `an unknown outcome "${summary}"`;
    const file = str(m.file);
    const span = m.span as { start?: { line?: unknown } } | undefined;
    const line = Number(span?.start?.line ?? m.line);
    if (!file || !Number.isInteger(line))
      return "an unreadable outcomes.json (a mutant without file or line)";
    const fn = str((m.function as Record<string, unknown> | undefined)?.function_name);
    const replacement = str(m.replacement) ?? "?";
    const genre = str(m.genre);
    mutants.push({
      file: stripDot(file),
      line,
      description: `${genre ? `${genre}: ` : ""}replace with ${replacement}${fn ? ` in ${fn}` : ""}`,
      status,
    });
  }
  if (baseline === undefined) return "no Baseline outcome: the unmutated tests were not run";
  if (baseline !== "Success") return `the unmutated build or tests failed (Baseline: ${baseline})`;
  return mutants;
}

// ---- PIT --------------------------------------------------------------------

/*
 * PIT (https://pitest.org/quickstart/maven/): `mvn
 * org.pitest:pitest-maven:mutationCoverage -DtargetClasses=a.B*
 * -DoutputFormats=XML -DtimestampedReports=false` writes
 * `target/pit-reports/mutations.xml`; with Gradle
 * (https://gradle-pitest-plugin.solidsoft.info/) `gradle pitest` writes
 * `build/reports/pitest/mutations.xml` when the project sets
 * `outputFormats = ['XML']` and `timestampedReports = false`. PIT fails the
 * build when the tests do not pass unmutated. Each `<mutation status=…>`
 * names its `sourceFile`, `mutatedClass`, `lineNumber` and `description`;
 * statuses (https://pitest.org/quickstart/basic_concepts/): KILLED, SURVIVED,
 * NO_COVERAGE, TIMED_OUT, NON_VIABLE, MEMORY_ERROR, RUN_ERROR. PIT counts
 * MEMORY_ERROR as detected, so it is `killed` here as there.
 */

const PIT_STATUS: Record<string, ToolMutant["status"]> = {
  KILLED: "killed",
  SURVIVED: "survived",
  NO_COVERAGE: "not_covered",
  TIMED_OUT: "timeout",
  NON_VIABLE: "stillborn",
  RUN_ERROR: "stillborn",
  MEMORY_ERROR: "killed",
};

const pitParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (name) => name === "mutation",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

/** A Java or Kotlin file's package, from its `package` declaration. */
function packageOf(root: string, file: string): string | undefined {
  try {
    const text = readFileSync(join(root, file), "utf8");
    return /^\s*package\s+([\w.]+)/m.exec(text)?.[1] ?? "";
  } catch {
    return undefined;
  }
}

async function runPit(
  opts: RunMutationToolOptions,
  invoke: Invoke,
): Promise<ToolMutant[] | string> {
  const sources = opts.files
    .filter((f) => [".java", ".kt"].includes(extname(f).toLowerCase()))
    .map((file) => ({ file, pkg: packageOf(opts.root, file) }))
    .filter((s): s is { file: string; pkg: string } => s.pkg !== undefined);
  if (sources.length === 0) return [];
  const gradle = basename(opts.program).startsWith("gradle");
  const reportPath = gradle
    ? join(opts.root, "build", "reports", "pitest", "mutations.xml")
    : join(opts.root, "target", "pit-reports", "mutations.xml");
  // A report left in the worktree is never read as this run's.
  rmSync(reportPath, { force: true });
  const className = (s: { file: string; pkg: string }) => {
    const cls = basename(s.file, extname(s.file));
    return s.pkg ? `${s.pkg}.${cls}` : cls;
  };
  const m2 = join(homedir(), ".m2", "repository");
  const gradleCaches = join(homedir(), ".gradle", "caches");
  const r = gradle
    ? // Gradle's read-only dependency cache stands in for the network.
      await invoke(
        ["--offline", "--no-daemon", "pitest"],
        existsSync(gradleCaches) ? { GRADLE_RO_DEP_CACHE: gradleCaches } : {},
      )
    : await invoke([
        "-B",
        "-o",
        ...(existsSync(m2) ? [`-Dmaven.repo.local=${m2}`] : []),
        "org.pitest:pitest-maven:mutationCoverage",
        `-DtargetClasses=${[...new Set(sources.map((s) => `${className(s)}*`))].join(",")}`,
        "-DoutputFormats=XML",
        "-DtimestampedReports=false",
      ]);
  if (r.failed) return r.failed;
  if (r.exitCode !== 0) {
    return `the build failed (exit ${r.exitCode}; the unmutated tests may not pass): ${firstLine(r.stderr || r.stdout)}`;
  }
  if (!existsSync(reportPath)) return "no mutations.xml";
  const xml = readFileSync(reportPath, "utf8");
  if (!xml.trim()) return "an empty mutations.xml";
  let doc: Record<string, unknown>;
  try {
    doc = pitParser.parse(xml, true) as Record<string, unknown>;
  } catch {
    return "an unreadable mutations.xml";
  }
  if (!("mutations" in doc)) return "an unreadable mutations.xml (no mutations element)";
  const root = doc.mutations;
  const list =
    root && typeof root === "object" ? nodes((root as Record<string, unknown>).mutation) : [];
  const out: ToolMutant[] = [];
  for (const m of list) {
    const statusName = str(m.status) ?? "";
    const status = PIT_STATUS[statusName];
    if (!status) return `an unknown mutation status "${statusName}"`;
    const sourceFile = str(m.sourceFile);
    const mutatedClass = str(m.mutatedClass);
    const line = Number(str(m.lineNumber));
    if (!sourceFile || !mutatedClass || !Number.isInteger(line)) {
      return "an unreadable mutations.xml (a mutation without file, class or line)";
    }
    const outer = mutatedClass.split("$")[0] ?? mutatedClass;
    const dot = outer.lastIndexOf(".");
    const pkg = dot >= 0 ? outer.slice(0, dot) : "";
    const match = sources.find((s) => s.pkg === pkg && basename(s.file) === sourceFile);
    if (!match) continue; // a class the card did not change
    out.push({
      file: match.file,
      line,
      description: str(m.description) ?? str(m.mutator) ?? "mutation",
      status,
    });
  }
  return out;
}
