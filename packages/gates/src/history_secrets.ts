import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { runConfined } from "@sekhemet/sandbox";
import { HARDENED_GIT_CONFIG, HARDENED_GIT_PINS, hardenedGitEnv } from "@sekhemet/sync";
import { onPath } from "./builtin.js";
import { gitleaksRulesText, rulesNotRunNote } from "./gitleaks_rules.js";
import { scanSecrets } from "./secrets.js";

/**
 * The take-over's history secret scan (design-stage §2.10 step 1, DS-TO-3;
 * security item 34c, SEC-55). Every commit of a repository someone else
 * wrote is scanned before any of its text reaches a prompt:
 *
 * - by gitleaks (MIT) as a confined subprocess when it is installed, with
 *   its history read through `--log-opts` carrying `--no-ext-diff
 *   --no-textconv` and item 19's hardened git environment;
 * - otherwise by the bundled offline rule set of `secrets.ts` — gitleaks'
 *   own rule file, vendored (DEC-44), so the rule ids are gitleaks' and the
 *   diff gate's — over `git log -p --no-ext-diff --no-textconv` in the same
 *   hardened environment, one fragment per hunk as gitleaks reads it.
 *
 * Both run only after the item 21 preflight over the repository's own git
 * config; when it refuses, nothing is scanned and the reason is returned
 * (*history not scanned*). Nothing leaves the machine: no finding is
 * verified with its provider. A finding is its commit, path and rule — the
 * secret is never returned, not even redacted.
 */
export interface HistorySecretFinding {
  commit: string;
  path: string;
  rule: string;
}

export interface HistorySecretScan {
  scanner: "gitleaks" | "builtin";
  /** Commits in the history (`git rev-list --all --count`). */
  commits: number;
  findings: HistorySecretFinding[];
  /** A reason code when the scan did not run (the `takeover/secrets_scanned` payload's). */
  notScanned?: "preflight_refused" | "not_a_repository" | "scanner_failed";
  /** The reason in words. */
  reason?: string;
}

export interface HistoryScanOptions {
  /** The gitleaks program; `false` forces the bundled rules. Default: gitleaks on PATH. */
  gitleaks?: string | false;
  /** `--restricted`: confinement may not be opted out of. */
  restricted?: boolean;
  timeoutMs?: number;
}

/** Item 21's refused keys: config that makes git run a program or reach elsewhere. */
const REFUSED_KEYS: readonly RegExp[] = [
  /^core\.(fsmonitor|hookspath|sshcommand|pager|editor|askpass|gitproxy)$/i,
  /^filter\./i,
  /^diff\..+\.(command|textconv)$/i,
  /^diff\.external$/i,
  /^merge\..+\.driver$/i,
  /^include/i,
  /^gpg\./i,
  /^credential\./i,
  /^remote\..+\.(uploadpack|receivepack)$/i,
];

function gitDirOf(root: string): string | undefined {
  const dotGit = join(root, ".git");
  return existsSync(join(dotGit, "HEAD")) ? dotGit : undefined;
}

/**
 * The item 21 preflight for a repository's main checkout: its local config
 * read with `--no-includes`, refused on any program-running key, and a
 * `.gitmodules` holding a carriage return (CVE-2025-48384). Empty when git
 * may read the history.
 */
export function historyPreflight(root: string): string[] {
  const gitDir = gitDirOf(root);
  if (!gitDir) return ["no git directory at the repository root"];
  let text: string;
  try {
    text = execFileSync("git", ["config", "--no-includes", "--list", "--show-scope", "--null"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...HARDENED_GIT_PINS,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_DIR: gitDir,
        GIT_WORK_TREE: root,
      },
    });
  } catch {
    return ["the repository config could not be read"];
  }
  const out: string[] = [];
  const parts = text.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i] ?? "";
    const key = (parts[i + 1] ?? "").split("\n")[0] ?? "";
    if (scope !== "local" && scope !== "worktree") continue;
    if (REFUSED_KEYS.some((r) => r.test(key))) out.push(`repository config sets ${key}`);
  }
  const modules = join(root, ".gitmodules");
  if (existsSync(modules) && readFileSync(modules, "utf8").includes("\r")) {
    out.push(".gitmodules contains a carriage return");
  }
  return out.sort();
}

/**
 * The one preflight finding the history scan may pass (lead ruling under
 * DEC-42 on security item 21's scope, DS-TO-3): Husky's `core.hooksPath`.
 * The scan only reads history, and every git it runs has item 19's
 * `core.hooksPath=/dev/null` on the command level (`historyGitEnv`, and
 * gitleaks' `GIT_CONFIG_PARAMETERS`), which overrides the repository's, so
 * no hook can run. Every other finding still refuses the scan.
 */
const SCAN_PASSES = /^repository config sets core\.hookspath$/i;

/** The guarded git environment every git call of the scan runs with (item 19, command level). */
export function historyGitEnv(root: string): NodeJS.ProcessEnv {
  return gitEnv(root);
}

/** Item 19's keys as `GIT_CONFIG_PARAMETERS` (git's own `-c` list), which outranks repository config. */
function configParameters(): string {
  const quote = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  return HARDENED_GIT_CONFIG.map(([k, v]) => `${quote(k)}=${quote(v)}`).join(" ");
}

function gitEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...hardenedGitEnv(process.env),
    GIT_DIR: join(root, ".git"),
    GIT_WORK_TREE: root,
    GIT_CEILING_DIRECTORIES: join(root, ".."),
  };
}

/**
 * The commits in the history (`git rev-list --all --count`). An empty
 * repository counts 0 with exit 0; any non-zero exit — a dangling ref, a
 * repository git refuses as of dubious ownership, a corrupt object — is a
 * scan that could not run, never an empty history (review B1).
 */
function commitCount(root: string): { count: number } | { error: string } {
  try {
    const out = execFileSync("git", ["rev-list", "--all", "--count"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(root),
    });
    const count = Number.parseInt(out.trim(), 10);
    if (!Number.isInteger(count) || count < 0) {
      return { error: `git rev-list gave no count (${out.trim().slice(0, 80)})` };
    }
    return { count };
  } catch (err) {
    const e = err as { status?: number | null; stderr?: string | Buffer; message?: string };
    return { error: `git rev-list exited ${e.status ?? "abnormally"}${gitReason(e.stderr)}` };
  }
}

/** git's first error line, for the reason. */
function gitReason(stderr: string | Buffer | undefined): string {
  const first = String(stderr ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  return first ? `: ${first.slice(0, 200)}` : "";
}

const COMMIT_MARK = "@@sekhemet-commit ";

/**
 * The bundled rules over every commit's added lines, streamed (a large
 * history never sits in memory): each hunk's added lines are one fragment,
 * as gitleaks reads a commit, so a multi-line private key is found; a
 * binary file added is judged by its path alone.
 */
async function builtinScan(root: string, timeoutMs: number): Promise<HistorySecretFinding[]> {
  const child = spawn(
    "git",
    [
      "log",
      "--all",
      "-p",
      "--unified=0",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-renames",
      `--format=${COMMIT_MARK}%H`,
    ],
    { cwd: root, env: gitEnv(root), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    if (stderr.length < 4096) stderr += d.toString("utf8");
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const seen = new Set<string>();
  const out: HistorySecretFinding[] = [];
  let commit = "";
  let path = "";
  let added: string[] = [];
  const report = (text: string, file: string) => {
    for (const f of scanSecrets(text, file, 1, commit)) {
      const key = `${commit}\0${file}\0${f.rule}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ commit, path: file, rule: f.rule });
    }
  };
  const flush = () => {
    if (added.length > 0 && path && commit) report(added.join("\n"), path);
    added = [];
  };
  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (line.startsWith(COMMIT_MARK)) {
      flush();
      commit = line.slice(COMMIT_MARK.length).trim();
      path = "";
    } else if (line.startsWith("diff --git ")) {
      flush();
      path = "";
    } else if (line.startsWith("+++ ")) {
      flush();
      path = line === "+++ /dev/null" ? "" : line.replace(/^\+\+\+ (b\/)?/, "");
    } else if (line.startsWith("@@ ")) {
      flush();
    } else if (line.startsWith("+") && path && commit) {
      added.push(line.slice(1));
    } else if (commit) {
      const binary = /^Binary files .* and b\/(.+) differ$/.exec(line);
      if (binary) report("", binary[1] as string);
    }
  }
  flush();
  const status = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("close", (code) => resolve(code));
  });
  clearTimeout(timer);
  // `git log --all` over an empty repository exits 0; any other exit (a
  // dangling ref, a missing object, a kill on timeout) is no verdict (review B1).
  if (status !== 0)
    throw new Error(`git log exited ${status ?? "on a signal"}${gitReason(stderr)}`);
  return out;
}

/** gitleaks, confined, over the whole history; undefined when it could not give a verdict. */
async function gitleaksScan(
  root: string,
  program: string,
  options: HistoryScanOptions,
): Promise<{ findings: HistorySecretFinding[] } | { error: string }> {
  const home = mkdtempSync(join(tmpdir(), "sekhemet-history-scan-"));
  try {
    // Item 19 through the one variable the confinement passes that git reads
    // for config: a global file holding the hardened keys. (GIT_CONFIG_KEY_n
    // is dropped by the confinement's credential-name filter.)
    const globalConfig = join(home, "hardened.gitconfig");
    const sections = new Map<string, string[]>();
    for (const [key, value] of HARDENED_GIT_CONFIG) {
      const dot = key.lastIndexOf(".");
      const section = key.slice(0, dot);
      const list = sections.get(section) ?? [];
      list.push(`\t${key.slice(dot + 1)} = ${value === "" ? '""' : value}`);
      sections.set(section, list);
    }
    writeFileSync(
      globalConfig,
      [...sections].map(([s, l]) => `[${s}]\n${l.join("\n")}`).join("\n"),
      { mode: 0o600 },
    );
    // Review M3: gitleaks reads none of the repository's own configuration.
    // An explicit config outranks the repository's `.gitleaks.toml` (a
    // harness-owned file: the vendored gitleaks v8.30.1 rule file, so the
    // program reports the bundled scan's rule ids whatever version is
    // installed, not that binary's own built-in rules; C2b), and the
    // ignore path is an empty directory of ours, not the repository's
    // `.gitleaksignore`.
    const config = join(home, "gitleaks.toml");
    writeFileSync(config, gitleaksRulesText(), { mode: 0o600 });
    const ignoreDir = join(home, "ignore");
    mkdirSync(ignoreDir);
    const report = join(home, "gitleaks.json");
    const r = await runConfined(
      program,
      [
        "detect",
        "--source",
        root,
        "--no-banner",
        "--redact",
        "--report-format",
        "json",
        "--report-path",
        report,
        "--log-opts=--all --full-history --no-ext-diff --no-textconv",
        "--config",
        config,
        "--gitleaks-ignore-path",
        ignoreDir,
      ],
      {
        root,
        writable: [home],
        env: {
          HOME: home,
          ...HARDENED_GIT_PINS,
          GIT_CONFIG_GLOBAL: globalConfig,
          // A global file is outranked by the repository's own config (a
          // Husky hooks path); the command level is not.
          GIT_CONFIG_PARAMETERS: configParameters(),
        },
        timeoutMs: options.timeoutMs ?? 600_000,
        ...(options.restricted ? { restricted: true } : {}),
      },
    );
    if (r.exitCode !== 0 && r.exitCode !== 1) {
      return { error: `gitleaks exited ${r.exitCode}${r.stderr ? `: ${r.stderr.trim()}` : ""}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(existsSync(report) ? readFileSync(report, "utf8") : "");
    } catch {
      return { error: `gitleaks exited ${r.exitCode} with no readable report` };
    }
    if (!Array.isArray(parsed)) return { error: "gitleaks wrote a report that is not a list" };
    const seen = new Set<string>();
    const findings: HistorySecretFinding[] = [];
    for (const leak of parsed as { RuleID?: unknown; Commit?: unknown; File?: unknown }[]) {
      // Only the commit, the path and the rule are read; the secret is never.
      const commit = typeof leak.Commit === "string" ? leak.Commit : "";
      const path = typeof leak.File === "string" ? leak.File : "";
      const rule = typeof leak.RuleID === "string" ? leak.RuleID : "gitleaks";
      // A SHA-1 commit (abbreviated or whole) or a SHA-256 one.
      if (!/^(?:[0-9a-f]{7,40}|[0-9a-f]{64})$/.test(commit) || !path) continue;
      const key = `${commit}\0${path}\0${rule}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ commit, path, rule });
    }
    return { findings };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Scan every commit of `root`'s history for secrets, offline (DS-TO-3, SEC-55). */
export async function scanHistorySecrets(
  root: string,
  options: HistoryScanOptions = {},
): Promise<HistorySecretScan> {
  const program =
    options.gitleaks === false
      ? undefined
      : (options.gitleaks ?? (onPath("gitleaks") ? "gitleaks" : undefined));
  const scanner = program ? "gitleaks" : "builtin";
  if (!gitDirOf(root)) {
    return {
      scanner,
      commits: 0,
      findings: [],
      notScanned: "not_a_repository",
      reason: "no git history at the repository root",
    };
  }
  const refused = historyPreflight(root).filter((f) => !SCAN_PASSES.test(f));
  if (refused.length > 0) {
    return {
      scanner,
      commits: 0,
      findings: [],
      notScanned: "preflight_refused",
      reason: `history not scanned: ${refused.join("; ")}`,
    };
  }
  const counted = commitCount(root);
  if ("error" in counted) {
    return {
      scanner,
      commits: 0,
      findings: [],
      notScanned: "scanner_failed",
      reason: counted.error,
    };
  }
  const commits = counted.count;
  if (commits === 0) return { scanner, commits, findings: [] };
  const timeoutMs = options.timeoutMs ?? 600_000;
  let gitleaksReason: string | undefined;
  // gitleaks honours a `.gitleaksignore` in the directory it scans whatever
  // `--gitleaks-ignore-path` says: a repository shipping one could hide its
  // own findings, so the bundled rules scan it instead (review M3).
  if (program && existsSync(join(root, ".gitleaksignore"))) {
    gitleaksReason =
      "gitleaks not used: the repository ships a .gitleaksignore gitleaks would honour";
  } else if (program) {
    const r = await gitleaksScan(root, program, options);
    if ("findings" in r) return { scanner: "gitleaks", commits, findings: r.findings };
    // gitleaks gave no verdict: the bundled rules still scan, and say why.
    gitleaksReason = `gitleaks: ${r.error}`;
  }
  // Rules of the vendored file JavaScript cannot run are named, never skipped silently.
  const reason = [gitleaksReason, rulesNotRunNote()].filter(Boolean).join("; ");
  try {
    const findings = await builtinScan(root, timeoutMs);
    return {
      scanner: "builtin",
      commits,
      findings,
      ...(reason ? { reason } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      scanner: "builtin",
      commits,
      findings: [],
      notScanned: "scanner_failed",
      reason: gitleaksReason ? `${gitleaksReason}; then ${message}` : message,
    };
  }
}
