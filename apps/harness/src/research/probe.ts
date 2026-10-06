import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { type ReportedClaim, factsOfText, runProbe } from "@sekhemet/gates";
import {
  type DependencyRuntime,
  type Ecosystem,
  dependencyRuntime,
  resolveDependency,
} from "@sekhemet/loop";

/**
 * The Researcher's probe (design-stage DS-N9-17, DS-N9-18): a short Node or
 * Python program run against the project's installed dependencies in the
 * claim gate's sandbox, through the claim gate's own runner (`runProbe`):
 * no network, a fresh scratch directory as the only writable root and the
 * working directory, the dependency roots read-only and, for a research
 * card's question, the repository too; a research packet's probe cannot
 * read the repository beyond its dependency roots (`scope`).
 * One that exits 0 becomes an executable claim whose `reproduce` code is the
 * exact program that ran, so the claim gate re-runs it unchanged. Go and Rust
 * have no probe runner in this version: their claims are documented, not
 * reproduced.
 *
 * The probe's code is model-written and untrusted; the read-only roots and
 * the interpreter come from the harness (the ecosystem adapter's
 * `runtime()`), never from the model. Nothing here is model-facing text: a
 * refusal is a code, rendered by the Researcher's copy module.
 */

export const PROBE_LIMITS = {
  maxLines: 30,
  maxChars: 2000,
  timeoutMs: 10_000,
  maxMemoryBytes: 512 * 1024 * 1024,
  outputChars: 1000,
} as const;

export type ProbeLanguage = "node" | "python";

/** The package and version a probe targets. */
export interface ProbeTarget {
  eco: Ecosystem;
  name: string;
  version: string;
}

export interface ProbeRequest {
  /** As the Researcher gave it; only `node` and `python` run. */
  language: string;
  code: string;
  target: ProbeTarget;
  /** What the probe shows, in one sentence: the claim's text. */
  statement: string;
}

/** Injected by the caller: the repository and the adapter's runtime for the target's ecosystem. */
export interface ProbeContext {
  repoPath: string;
  runtime: DependencyRuntime;
  /**
   * What the probe may read of the repository (DS-N9-17): `repository`, all
   * of it, read-only (a research card's question); `dependencies`, its
   * dependency roots and nothing else (a research packet's question, whose
   * Researcher also holds the web; security item 8c). Default `repository`.
   */
  scope?: "repository" | "dependencies";
}

/** The sandbox's grants for a probe in `ctx` (DS-N9-17). */
export function probeGrants(ctx: ProbeContext): { readOnly: string[]; hiddenReads?: string[] } {
  const deps = [...ctx.runtime.readRoots, ...(ctx.runtime.envRoots ?? [])];
  if (ctx.scope === "dependencies") return { readOnly: deps, hiddenReads: [ctx.repoPath] };
  return { readOnly: [ctx.repoPath, ...deps] };
}

/** The run's record (DS-N9-17). `output` is the program's own text: untrusted. */
export interface ProbeResult {
  language: ProbeLanguage;
  /** sha256 of the program that ran: the claim's `reproduce.code`. */
  codeSha256: string;
  exitCode: number;
  /** The last 1,000 characters of stdout then stderr. */
  output: string;
  /** `pkg@ver`. */
  target: string;
  timedOut: boolean;
  oomKilled: boolean;
  durationMs: number;
}

export type ProbeRefusal = "too_many_lines" | "too_many_chars" | "language" | "language_mismatch";

export type ProbeOutcome =
  | { status: "refused"; refusal: ProbeRefusal; limit?: number; actual?: number | string }
  | { status: "documented"; target: string; claim: ReportedClaim }
  | { status: "ran"; result: ProbeResult; claim?: ReportedClaim };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const LANGUAGE_OF: Partial<Record<Ecosystem, ProbeLanguage>> = { npm: "node", python: "python" };

/** The recorded reason for a Go or Rust claim (DS-N9-18). */
export function noProbeRunnerReason(eco: Ecosystem): string {
  return `documented, not reproduced: no probe runner for ${eco} in this version`;
}

/** Why a probe is refused before it runs, or undefined when it may run (DS-N9-17). */
export function checkProbe(
  req: ProbeRequest,
): Extract<ProbeOutcome, { status: "refused" }> | undefined {
  const lines = req.code.replace(/\r?\n$/, "").split(/\r?\n/).length;
  if (lines > PROBE_LIMITS.maxLines)
    return {
      status: "refused",
      refusal: "too_many_lines",
      limit: PROBE_LIMITS.maxLines,
      actual: lines,
    };
  if (req.code.length > PROBE_LIMITS.maxChars)
    return {
      status: "refused",
      refusal: "too_many_chars",
      limit: PROBE_LIMITS.maxChars,
      actual: req.code.length,
    };
  if (req.language !== "node" && req.language !== "python")
    return { status: "refused", refusal: "language", actual: req.language };
  if (LANGUAGE_OF[req.target.eco] !== req.language)
    return { status: "refused", refusal: "language_mismatch", actual: req.language };
  return undefined;
}

/**
 * Node: packages resolve from the repository, not the scratch cwd. `require`
 * is a `createRequire` at the repository's package.json; `load(name)`
 * imports the resolved file, so an ESM-only package (an `import`-only export
 * map) loads too. The probe runs inside an async function, so it may await.
 */
function nodeProgram(code: string, repoPath: string): string {
  return `const __sekhemet = (() => {
  const { createRequire } = require("node:module");
  const { pathToFileURL } = require("node:url");
  const { existsSync, readFileSync } = require("node:fs");
  const { isAbsolute, join } = require("node:path");
  const req = createRequire(${JSON.stringify(join(repoPath, "package.json"))});
  const pick = (x) => typeof x === "string" ? x : Array.isArray(x) ? pick(x[0]) : x && typeof x === "object" ? pick(x.import ?? x.node ?? x.default) : undefined;
  const resolveImport = (name) => {
    try { return req.resolve(name); } catch (err) {
      const parts = name.split("/");
      const n = name.startsWith("@") ? 2 : 1;
      const pkg = parts.slice(0, n).join("/");
      const sub = parts.length > n ? "./" + parts.slice(n).join("/") : ".";
      for (const dir of req.resolve.paths(pkg) ?? []) {
        const file = join(dir, pkg, "package.json");
        if (!existsSync(file)) continue;
        const meta = JSON.parse(readFileSync(file, "utf8"));
        let map = meta.exports;
        if (map !== undefined && (typeof map !== "object" || Array.isArray(map) || !Object.keys(map).some((k) => k.startsWith(".")))) map = { ".": map };
        const target = map === undefined ? (sub === "." ? meta.module ?? meta.main ?? "index.js" : sub) : pick(map[sub]);
        if (target) return join(dir, pkg, target);
      }
      throw err;
    }
  };
  const load = (name) => { const p = resolveImport(name); return import(isAbsolute(p) ? pathToFileURL(p).href : p); };
  return { require: req, load };
})();
(async (require, load) => {
${code}
})(__sekhemet.require, __sekhemet.load).catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exitCode = 1; });
`;
}

/**
 * Python: the dependency roots go first on `sys.path`, so the program finds
 * the same packages under the project's interpreter and under the claim
 * gate's; no bytecode is written.
 */
function pythonProgram(code: string, readRoots: readonly string[]): string {
  return `import sys as _sekhemet_sys
_sekhemet_sys.dont_write_bytecode = True
_sekhemet_sys.path[:0] = ${JSON.stringify([...readRoots])}
del _sekhemet_sys
${code}
`;
}

/** The program a probe runs: the harness's prelude, then the probe's code. */
export function probeProgram(language: ProbeLanguage, code: string, ctx: ProbeContext): string {
  return language === "node"
    ? nodeProgram(code, ctx.repoPath)
    : pythonProgram(code, ctx.runtime.readRoots);
}

const NODE_OPEN = "(async (require, load) => {\n";
const NODE_CLOSE = "\n})(__sekhemet.require, __sekhemet.load)";
const PYTHON_OPEN = "\ndel _sekhemet_sys\n";

/**
 * The Researcher's own code inside a program `probeProgram` wrote, without
 * the harness's prelude (DS-N9-19); undefined for a program it did not write.
 */
export function researcherCode(language: ProbeLanguage, program: string): string | undefined {
  if (language === "node") {
    const start = program.indexOf(NODE_OPEN);
    const end = program.lastIndexOf(NODE_CLOSE);
    return start >= 0 && end > start ? program.slice(start + NODE_OPEN.length, end) : undefined;
  }
  const start = program.indexOf(PYTHON_OPEN);
  return start >= 0 ? program.slice(start + PYTHON_OPEN.length).replace(/\n$/, "") : undefined;
}

/** Python source with its string literals and `#` comments blanked out, line breaks kept. */
function pythonCodeOnly(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const ch = code[i] as string;
    if (ch === "#") {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const triple = code.startsWith(ch.repeat(3), i);
      const close = triple ? ch.repeat(3) : ch;
      i += close.length;
      while (i < code.length && !code.startsWith(close, i)) {
        if (code[i] === "\\") i++;
        else if (code[i] === "\n") out += "\n";
        i++;
      }
      i += close.length;
      out += " ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Whether `code` names `name` as code — an identifier or a member read —
 * and not only inside a string or a comment (DS-N9-19). Node code is read
 * through the source index; Python's strings and comments are blanked.
 */
export function codeNames(language: ProbeLanguage, code: string, name: string): boolean {
  if (language === "node")
    return factsOfText("probe.mjs", code).references.some((r) => r.name === name);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(pythonCodeOnly(code));
}

/**
 * The harness's own check that `symbol` resolves in `pkg` at runtime
 * (DS-N9-25): a program written from the subject alone — load the package,
 * read each part in turn, a type's member through its prototype — run in a
 * research packet's probe sandbox (the dependencies readable, the project
 * not). True only when it exits 0. Go and Rust have no probe runner.
 */
export async function confirmMember(
  repoPath: string,
  eco: Ecosystem,
  pkg: string,
  version: string,
  symbol: string,
): Promise<boolean> {
  const language = LANGUAGE_OF[eco];
  const dep = resolveDependency(repoPath, `${eco}:${pkg}`);
  if (!language || !dep?.installed || dep.version !== version) return false;
  const parts = symbol.split(/\.|::/).filter(Boolean);
  if (parts.length === 0) return false;
  const code =
    language === "node"
      ? [
          `const parts = ${JSON.stringify(parts)};`,
          `const m = await load(${JSON.stringify(dep.name)});`,
          "const step = (x, p) => {",
          "  if (x == null) return undefined;",
          "  const v = Object(x)[p] !== undefined ? Object(x)[p] : x.prototype ? x.prototype[p] : undefined;",
          "  return v === undefined || v === Object.prototype[p] || v === Function.prototype[p] ? undefined : v;",
          "};",
          "const found = [m, m && m.default].some((root) => parts.reduce(step, root) !== undefined);",
          "process.exitCode = found ? 0 : 1;",
        ].join("\n")
      : [
          "import importlib",
          `parts = ${JSON.stringify(parts)}`,
          `names = ${JSON.stringify(dep.entries.length ? dep.entries : [dep.name])}`,
          "def resolve(name):",
          "    x = importlib.import_module(name)",
          "    for p in parts:",
          "        if hasattr(x, p):",
          "            x = getattr(x, p)",
          "        else:",
          '            x = importlib.import_module(x.__name__ + "." + p)',
          "    return x",
          "for name in names:",
          "    try:",
          "        resolve(name)",
          "        raise SystemExit(0)",
          "    except (ImportError, AttributeError):",
          "        pass",
          "raise SystemExit(1)",
        ].join("\n");
  const ctx: ProbeContext = {
    repoPath,
    runtime: dependencyRuntime(repoPath, eco),
    scope: "dependencies",
  };
  const interpreter = ctx.runtime.interpreter;
  const run = await runProbe({
    language,
    code: probeProgram(language, code, ctx),
    ...(language === "python" && interpreter && isAbsolute(interpreter) ? { interpreter } : {}),
    ...probeGrants(ctx),
    timeoutMs: PROBE_LIMITS.timeoutMs,
    maxMemoryBytes: PROBE_LIMITS.maxMemoryBytes,
    env: { PYTHONDONTWRITEBYTECODE: "1" },
  });
  return run.ok;
}

/** Check, run and record one probe (DS-N9-17), and make its claim (DS-N9-18). */
export async function runResearchProbe(
  req: ProbeRequest,
  ctx: ProbeContext,
): Promise<ProbeOutcome> {
  const target = `${req.target.name}@${req.target.version}`;
  if (req.target.eco === "go" || req.target.eco === "rust") {
    const reason = noProbeRunnerReason(req.target.eco);
    return {
      status: "documented",
      target,
      claim: {
        id: `probe_${sha256(`${req.target.eco}|${target}|${req.statement}`).slice(0, 12)}`,
        kind: "executable",
        text: req.statement,
        unreproducible: reason,
      },
    };
  }
  const refused = checkProbe(req);
  if (refused) return refused;
  const language = req.language as ProbeLanguage;
  const program = probeProgram(language, req.code, ctx);
  const interpreter = ctx.runtime.interpreter;
  const run = await runProbe({
    language,
    code: program,
    // Only an absolute path the adapter found (the project's environment);
    // otherwise the trusted python3. Node is always the harness's own.
    ...(language === "python" && interpreter && isAbsolute(interpreter) ? { interpreter } : {}),
    ...probeGrants(ctx),
    timeoutMs: PROBE_LIMITS.timeoutMs,
    maxMemoryBytes: PROBE_LIMITS.maxMemoryBytes,
    env: { PYTHONDONTWRITEBYTECODE: "1" },
  });
  const codeSha256 = sha256(program);
  const result: ProbeResult = {
    language,
    codeSha256,
    exitCode: run.exitCode,
    output: `${run.stdout}${run.stderr}`.slice(-PROBE_LIMITS.outputChars),
    target,
    timedOut: run.timedOut,
    oomKilled: run.oomKilled,
    durationMs: run.durationMs,
  };
  if (!run.ok) return { status: "ran", result };
  return {
    status: "ran",
    result,
    claim: {
      id: `probe_${codeSha256.slice(0, 12)}`,
      kind: "executable",
      text: `${req.statement} (reproduced at ${target})`,
      reproduce: { language, code: program },
    },
  };
}
