import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseToml } from "@sekhemet/kernel";
import semver from "semver";
import { missingTrailers } from "./git_adapter.js";
import { gitEnvFor } from "./git_preflight.js";
import type { GitHubClient } from "./github_app.js";

/**
 * Release cards (Y17), CI as a gate source through `act` (Y18) and
 * monorepo / multi-repo scope (Y19).
 */

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function has(bin: string): boolean {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- Y17

export type Bump = "major" | "minor" | "patch" | "none";

export interface ReleaseCommit {
  sha: string;
  type: string;
  scope?: string;
  subject: string;
  breaking: boolean;
}

/** Keep a Changelog's categories (planner-pm §2.15.8, PM-P13-13). */
export type KeepAChangelogCategory =
  | "Added"
  | "Changed"
  | "Deprecated"
  | "Removed"
  | "Fixed"
  | "Security";

export const KEEP_A_CHANGELOG: readonly KeepAChangelogCategory[] = [
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
];

export interface ReleasePlan {
  previousTag?: string;
  nextVersion: string;
  bump: Bump;
  commits: ReleaseCommit[];
  /** The commit the release is computed at and tagged on; the checkout's HEAD when absent. */
  ref?: string;
  /** The squashes grouped by Keep a Changelog's categories; empty ones left out. */
  categories: Partial<Record<KeepAChangelogCategory, string[]>>;
  changelog: string;
  engine: "git-cliff" | "builtin";
}

const HOUSEKEEPING = new Set(["chore", "docs", "test", "tests", "ci", "build", "style"]);

/**
 * Group Conventional-Commit squashes into Keep a Changelog's categories
 * (PM-P13-13): `feat` is Added; `fix` is Fixed, or Security when its scope
 * or type says security; `deprecate` is Deprecated; `revert` and `remove`
 * are Removed; `refactor`, `perf` and any breaking change are Changed.
 * Housekeeping (chore, docs, test, ci, build, style) is left out.
 */
export function keepAChangelog(
  commits: readonly ReleaseCommit[],
): Partial<Record<KeepAChangelogCategory, string[]>> {
  const out: Partial<Record<KeepAChangelogCategory, string[]>> = {};
  const put = (cat: KeepAChangelogCategory, line: string) => {
    out[cat] = [...(out[cat] ?? []), line];
  };
  for (const c of commits) {
    const type = c.type.toLowerCase();
    const scope = c.scope?.toLowerCase();
    const sec = type === "security" || scope === "security" || scope === "sec";
    const item = `${c.scope && !sec ? `**${c.scope}:** ` : ""}${c.subject} (${c.sha.slice(0, 7)})`;
    if (c.breaking) put("Changed", `**Breaking:** ${item}`);
    else if (sec) put("Security", item);
    else if (type === "feat") put("Added", item);
    else if (type === "fix") put("Fixed", item);
    else if (type === "deprecate" || type === "deprecated") put("Deprecated", item);
    else if (type === "revert" || type === "remove" || type === "removed") put("Removed", item);
    else if (!HOUSEKEEPING.has(type) && type !== "other") put("Changed", item);
  }
  return Object.fromEntries(
    KEEP_A_CHANGELOG.filter((k) => out[k]).map((k) => [k, out[k] as string[]]),
  ) as Partial<Record<KeepAChangelogCategory, string[]>>;
}

const CC = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;

/**
 * A tag name as projects write a version: `v1.2.3`, `name@1.2.3`,
 * `name-1.2.3`, `name/1.2.3`, a prerelease and build included. A tag that
 * merely holds a number (`deploy-2026`, `build42`) is not one.
 */
const VERSION_TAG =
  /^(?:[\w@./-]*?[-@/_])?v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * A version as SemVer reads it (DEC-44: the `semver` library): a tag's `v`
 * or `=` is dropped, and a tag name shaped like a version (`release-1.2.3`,
 * `pkg@2.0.0-beta.1`) gives the version inside it, prerelease included; any
 * other string is no version (fix review C1: `deploy-2026` is not 2026.0.0).
 */
export function parseVersion(v: string | undefined): semver.SemVer | undefined {
  if (!v) return undefined;
  const t = v.trim();
  return (
    semver.parse(t, { loose: true }) ??
    (VERSION_TAG.test(t) ? semver.coerce(t, { includePrerelease: true }) : null) ??
    undefined
  );
}

/**
 * SemVer precedence (a prerelease before its release, `0.10.0` after
 * `0.9.0`); a string that holds no version sorts first. For `sort`.
 */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  return semver.compare(x, y);
}

/**
 * The next version after `previous` for a Conventional-Commit bump, with a
 * `v` (review-git §2.6 item 7, RG-N4-1). While the version is `0.y.z` a
 * breaking change bumps minor, never to 1.0.0: SemVer's major version zero
 * is initial development, and 1.0 is a person's decision (they tag it). A
 * prerelease is released rather than skipped (`1.0.0-rc.1` + patch is
 * `1.0.0`).
 */
export function nextVersion(previous: string | undefined, bump: Bump): string {
  const from = parseVersion(previous) ?? new semver.SemVer("0.0.0");
  if (bump === "none") return `v${from.version}`;
  const release = bump === "major" && from.major === 0 ? "minor" : bump;
  return `v${semver.inc(from.version, release) ?? from.version}`;
}

/** `git log --format=%H%x1f%B%x1e` output as Conventional-Commit squashes. */
function parseLog(raw: string): ReleaseCommit[] {
  return raw
    .split("\x1e")
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => {
      const [sha, msg = ""] = b.split("\x1f");
      const m = CC.exec(msg.split("\n")[0] ?? "");
      return {
        sha: sha as string,
        type: m?.[1] ?? "other",
        ...(m?.[2] ? { scope: m[2] } : {}),
        subject: m?.[4] ?? msg.split("\n")[0] ?? "",
        breaking: Boolean(m?.[3]) || /^BREAKING CHANGE:/m.test(msg),
      };
    });
}

/**
 * The bump a set of squashes gives (review-git §2.6 item 7): a breaking
 * change is major, a `feat` minor, a `fix` or `perf` patch, anything else
 * none. `nextVersion` keeps a breaking change on 0.y.z to the next minor.
 */
export function releaseBump(commits: readonly ReleaseCommit[]): Bump {
  return commits.some((c) => c.breaking)
    ? "major"
    : commits.some((c) => c.type === "feat")
      ? "minor"
      : commits.some((c) => c.type === "fix" || c.type === "perf")
        ? "patch"
        : "none";
}

/**
 * The squashes at `shas`, in the order given (planner-pm PM-N12-2): a
 * maintenance release is computed from its own issues' squashes, not from
 * every commit since the last tag. A sha the repository lacks is refused,
 * named.
 */
export function releaseCommitsAt(repoPath: string, shas: readonly string[]): ReleaseCommit[] {
  return shas.flatMap((sha) => {
    let raw: string;
    try {
      raw = git(["log", "-1", "--format=%H%x1f%B%x1e", `${sha}^{commit}`, "--"], repoPath);
    } catch {
      throw new Error(`The repository holds no commit ${sha}`);
    }
    return parseLog(raw);
  });
}

/**
 * Aggregate the Conventional Commits since the last tag on `ref` (the
 * checkout's HEAD when omitted; a slice's release passes the integration
 * branch), propose the semver bump (breaking -> major, feat -> minor,
 * fix/perf -> patch; a breaking change on 0.y.z is the next minor, see
 * `nextVersion`) and write the changelog with git-cliff when installed,
 * else grouped by Keep a Changelog's categories (PM-P13-13).
 */
export function planRelease(
  repoPath: string,
  options: { ref?: string; engine?: "auto" | "builtin" } = {},
): ReleasePlan {
  const ref = options.ref ?? "HEAD";
  let previousTag: string | undefined;
  try {
    previousTag = git(["describe", "--tags", "--abbrev=0", ref], repoPath);
  } catch {
    previousTag = undefined;
  }
  const range = previousTag ? `${previousTag}..${ref}` : ref;
  const raw = git(["log", "--no-merges", "--format=%H%x1f%B%x1e", range], repoPath);
  const commits = parseLog(raw);
  const bump = releaseBump(commits);
  // With no bump the version stays the previous tag's, normalised (`release-1.2.3` is v1.2.3).
  const version = nextVersion(previousTag, bump);
  let changelog: string | undefined;
  let engine: ReleasePlan["engine"] = "builtin";
  const categories = keepAChangelog(commits);
  if (options.engine !== "builtin" && ref === "HEAD" && has("git-cliff")) {
    try {
      changelog = execFileSync("git-cliff", ["--unreleased", "--tag", version, "--strip", "all"], {
        cwd: repoPath,
        encoding: "utf8",
      });
      engine = "git-cliff";
    } catch {
      changelog = undefined;
    }
  }
  if (!changelog) {
    changelog = [
      `## ${version}`,
      ...Object.entries(categories).map(
        ([title, items]) => `### ${title}\n${items.map((i) => `- ${i}`).join("\n")}`,
      ),
    ].join("\n\n");
  }
  return {
    ...(previousTag ? { previousTag } : {}),
    ...(options.ref ? { ref: options.ref } : {}),
    nextVersion: version,
    bump,
    commits,
    categories,
    changelog: changelog.trim(),
    engine,
  };
}

/** After human confirmation: tag and publish the GitHub Release. */
export async function publishRelease(
  repoPath: string,
  plan: ReleasePlan,
  github?: { client: GitHubClient; owner: string; repo: string },
): Promise<{ tag: string; url?: string }> {
  if (plan.bump === "none")
    throw new Error("Nothing to release: no feat, fix or breaking commits since the last tag");
  git(
    ["tag", "-a", plan.nextVersion, "-m", `Release ${plan.nextVersion}`, plan.ref ?? "HEAD"],
    repoPath,
  );
  if (!github) return { tag: plan.nextVersion };
  const rel = await github.client.rest<{ html_url: string }>(
    "POST",
    `/repos/${github.owner}/${github.repo}/releases`,
    {
      tag_name: plan.nextVersion,
      name: plan.nextVersion,
      body: plan.changelog,
    },
  );
  return { tag: plan.nextVersion, url: rel.html_url };
}

// ------------------------------------------- project documents (DS-N3-1, -8)

/** Left to the person: never written by an export (design-stage DS-N3-7). */
const PERSON_FILES = new Set(["readme.md", "contributing.md"]);

function checkDocumentPath(path: string): void {
  const parts = path.split("/");
  if (
    !path ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\\") ||
    parts.some((p) => p === ".." || p === "." || p === "")
  ) {
    throw new Error(
      `A project document's path is repository-relative and inside the repository: ${path}`,
    );
  }
  if (parts.length === 1 && PERSON_FILES.has(path.toLowerCase())) {
    throw new Error(
      `${path} is the person's: Sekhemet offers a change to it as a proposal and never writes it (DS-N3-7)`,
    );
  }
}

/** A file's text on a branch (or any commit), or undefined when it has none there. Read only. */
export function readBranchFile(repoPath: string, ref: string, path: string): string | undefined {
  try {
    return execFileSync("git", ["cat-file", "blob", `${ref}:${path}`], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnvFor(repoPath),
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

/** Every file path on a branch, sorted; empty when the branch has no commit. Read only. */
export function listBranchFiles(repoPath: string, ref: string): string[] {
  try {
    return execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", ref], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnvFor(repoPath),
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

/** The last commit on `ref` that changed `path`, or undefined. Read only. */
export function lastCommitTouching(
  repoPath: string,
  ref: string,
  path: string,
): string | undefined {
  try {
    const sha = execFileSync("git", ["log", "-1", "--format=%H", ref, "--", path], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnvFor(repoPath),
    }).trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Commit project documents onto a branch by plumbing (design-stage DS-N3-1,
 * review-git RG-S5-1, -2): the branch's tree plus these files is written
 * through a private index, committed on the branch's head with the
 * attribution trailers, and the ref moved by compare-and-set from
 * `expectedOld` — never the person's checkout or index. Refused before
 * anything moves for a path outside the repository, `README.md` or
 * `CONTRIBUTING.md` (DS-N3-7), a missing trailer, or a branch that moved.
 */
export function commitFilesOnBranch(
  repoPath: string,
  input: {
    branch: string;
    expectedOld: string;
    files: readonly { path: string; text: string }[];
    subject: string;
    body?: string;
    trailers: Record<string, string>;
  },
): string {
  for (const f of input.files) checkDocumentPath(f.path);
  const lines = Object.entries(input.trailers).map(([k, v]) => `${k}: ${v}`);
  const message = `${input.subject}${input.body?.trim() ? `\n\n${input.body.trim()}` : ""}\n\n${lines.join("\n")}\n`;
  const missing = missingTrailers(message);
  if (missing.length > 0) {
    throw new Error(`Project documents' commit refused: missing trailer(s): ${missing.join(", ")}`);
  }
  const env = gitEnvFor(repoPath);
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}, stdin?: string) =>
    execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf8",
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...env, ...extra },
      ...(stdin === undefined ? {} : { input: stdin }),
    }).trim();
  const old = run(["rev-parse", "--verify", `refs/heads/${input.branch}^{commit}`]);
  if (old !== input.expectedOld) {
    throw new Error(
      `${input.branch} moved (${input.expectedOld.slice(0, 10)} → ${old.slice(0, 10)}); the project documents were not written`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "sekhemet-docs-index-"));
  try {
    const index = { GIT_INDEX_FILE: join(dir, "index") };
    run(["read-tree", old], index);
    for (const f of input.files) {
      const blob = run(["hash-object", "-w", "--stdin"], {}, f.text);
      run(["update-index", "--add", "--cacheinfo", `100644,${blob},${f.path}`], index);
    }
    const tree = run(["write-tree"], index);
    const sha = run(["commit-tree", tree, "-p", old, "-F", "-"], {}, message);
    try {
      run([
        "update-ref",
        "-m",
        "sekhemet project documents",
        `refs/heads/${input.branch}`,
        sha,
        old,
      ]);
    } catch {
      throw new Error(
        `${input.branch} moved while the project documents were written; nothing was written`,
      );
    }
    return sha;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NEW_CHANGELOG_TOP = `# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
`;

/** One version's section of CHANGELOG.md in the Keep a Changelog format (DS-N3-8). */
export function keepAChangelogSection(
  version: string,
  date: string,
  categories: Partial<Record<KeepAChangelogCategory, string[]>>,
): string {
  const parts = KEEP_A_CHANGELOG.filter((k) => categories[k]?.length).map(
    (k) => `### ${k}\n\n${(categories[k] as string[]).map((i) => `- ${i}`).join("\n")}\n`,
  );
  const v = version.replace(/^v/, "");
  return `## [${v}] - ${date}\n\n${parts.length ? parts.join("\n") : "No user-facing change.\n"}`;
}

const RELEASE_HEADING = /^## \[?v?(\d+\.\d+\.\d+[^\]\s]*)\]?/;

/**
 * Put a release's section on top of CHANGELOG.md (DS-N3-8): above the
 * earlier releases and below an `Unreleased` section, every other byte kept
 * as it was. A version already there is never added again; a missing file
 * starts with the Keep a Changelog preamble.
 */
export function prependChangelogSection(
  existing: string | undefined,
  section: string,
  version: string,
): string {
  if (existing === undefined) return `${NEW_CHANGELOG_TOP}\n${section}`;
  const v = version.replace(/^v/, "");
  const lines = existing.split("\n");
  if (lines.some((l) => RELEASE_HEADING.exec(l)?.[1] === v)) return existing;
  let offset = 0;
  for (const line of lines) {
    if (RELEASE_HEADING.test(line)) {
      return `${existing.slice(0, offset)}${section}\n${existing.slice(offset)}`;
    }
    offset += line.length + 1;
  }
  const base = existing.endsWith("\n") ? existing : `${existing}\n`;
  return `${base}\n${section}`;
}

// ------------------------------------------------------------------- Y18

export interface ActJobResult {
  job: string;
  passed: boolean;
  failedSteps: string[];
}

export type ActRun =
  | { available: false; reason: string }
  | { available: true; passed: boolean; jobs: ActJobResult[]; argv: string[]; output: string };

export function actArgv(options: {
  event?: string;
  workflow?: string;
  job?: string;
  offline?: boolean;
}): string[] {
  return [
    options.event ?? "push",
    ...(options.workflow ? ["-W", options.workflow] : []),
    ...(options.job ? ["-j", options.job] : []),
    ...(options.offline !== false ? ["--action-offline-mode", "--pull=false"] : []),
  ];
}

/** Parse act's per-step log lines (`[wf/job] ✅  Success - Main step` / `❌  Failure - ...`). */
export function parseActOutput(output: string): ActJobResult[] {
  const jobs = new Map<string, ActJobResult>();
  for (const line of output.split("\n")) {
    const m = /^\[([^\]]+)\]\s+(✅|❌)\s+(Success|Failure)\s+-\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const job = m[1] as string;
    const j = jobs.get(job) ?? { job, passed: true, failedSteps: [] };
    if (m[3] === "Failure") {
      j.passed = false;
      j.failedSteps.push((m[4] as string).trim());
    }
    jobs.set(job, j);
  }
  return [...jobs.values()];
}

/** Run the project's GitHub Actions locally as a gate; typed `unavailable` when act is missing. */
export function runActGate(
  cwd: string,
  options: {
    event?: string;
    workflow?: string;
    job?: string;
    binary?: string;
    timeoutMs?: number;
  } = {},
): ActRun {
  const bin = options.binary ?? "act";
  if (!has(bin)) return { available: false, reason: `${bin} is not installed` };
  if (!existsSync(join(cwd, ".github", "workflows"))) {
    return { available: false, reason: "no .github/workflows in the repository" };
  }
  const argv = actArgv(options);
  let output: string;
  let status = 0;
  try {
    output = execFileSync(bin, argv, {
      cwd,
      encoding: "utf8",
      timeout: options.timeoutMs ?? 900_000,
    });
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    output = e.stdout ?? String(err);
    status = e.status ?? 1;
  }
  const jobs = parseActOutput(output);
  return {
    available: true,
    passed: status === 0 && jobs.every((j) => j.passed),
    jobs,
    argv,
    output,
  };
}

// ------------------------------------------------------------------- Y19

export interface WorkspacePackage {
  name: string;
  dir: string;
  kind: "node" | "cargo";
}

function globDirs(root: string, pattern: string): string[] {
  const clean = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!clean.includes("*")) return existsSync(join(root, clean)) ? [clean] : [];
  const [head, ...rest] = clean.split("/*");
  const base = join(root, head as string);
  if (!existsSync(base)) return [];
  const out: string[] = [];
  for (const d of readdirSync(base).sort()) {
    const rel = `${head}/${d}`;
    if (!statSync(join(root, rel)).isDirectory()) continue;
    if (rest.length && rest.join("/*").includes("*"))
      out.push(...globDirs(root, `${rel}${rest.join("/*")}`));
    else out.push(rest.length ? `${rel}${rest.join("")}` : rel);
  }
  return out;
}

/** Workspace packages from pnpm-workspace.yaml, package.json workspaces, or Cargo [workspace]. */
export function detectWorkspaces(root: string): WorkspacePackage[] {
  const patterns: string[] = [];
  const pnpm = join(root, "pnpm-workspace.yaml");
  if (existsSync(pnpm)) {
    for (const m of readFileSync(pnpm, "utf8").matchAll(/^\s*-\s*["']?([^"'\n#]+)["']?/gm))
      patterns.push((m[1] as string).trim());
  }
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      workspaces?: string[] | { packages?: string[] };
    };
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
    patterns.push(...ws);
  }
  const out: WorkspacePackage[] = [];
  for (const dir of [...new Set(patterns.flatMap((p) => globDirs(root, p)))].sort()) {
    const pj = join(root, dir, "package.json");
    if (!existsSync(pj)) continue;
    out.push({
      name: (JSON.parse(readFileSync(pj, "utf8")) as { name?: string }).name ?? dir,
      dir,
      kind: "node",
    });
  }
  const cargo = join(root, "Cargo.toml");
  if (existsSync(cargo)) {
    const t = parseToml(readFileSync(cargo, "utf8")) as { workspace?: { members?: string[] } };
    for (const dir of (t.workspace?.members ?? []).flatMap((p) => globDirs(root, p))) {
      const ct = join(root, dir, "Cargo.toml");
      if (!existsSync(ct)) continue;
      const pkg = parseToml(readFileSync(ct, "utf8")) as { package?: { name?: string } };
      out.push({ name: pkg.package?.name ?? dir, dir, kind: "cargo" });
    }
  }
  return out;
}

/** Which package each changed file belongs to (the longest matching dir). */
export function packagesForFiles(
  packages: readonly WorkspacePackage[],
  files: readonly string[],
): { byPackage: Record<string, string[]>; unowned: string[] } {
  const byPackage: Record<string, string[]> = {};
  const unowned: string[] = [];
  const sorted = [...packages].sort((a, b) => b.dir.length - a.dir.length);
  for (const f of files) {
    const p = sorted.find((x) => f === x.dir || f.startsWith(`${x.dir}/`));
    if (p) byPackage[p.name] = [...(byPackage[p.name] ?? []), f];
    else unowned.push(f);
  }
  return { byPackage, unowned };
}

export interface PackageGate {
  package: string;
  rung: string;
  command: string;
  args: string[];
  cwd: string;
}

/**
 * The gates a card runs: for each package it touches, that package's own
 * gates (its `.sekhemet/gates.toml` when present, else test/typecheck by
 * kind). A card touching two packages runs both gate sets.
 */
export function gatesForChange(root: string, files: readonly string[]): PackageGate[] {
  const packages = detectWorkspaces(root);
  const { byPackage } = packagesForFiles(packages, files);
  const out: PackageGate[] = [];
  for (const name of Object.keys(byPackage).sort()) {
    const pkg = packages.find((p) => p.name === name) as WorkspacePackage;
    const cwd = join(root, pkg.dir);
    const gatesToml = join(cwd, ".sekhemet", "gates.toml");
    if (existsSync(gatesToml)) {
      const t = parseToml(readFileSync(gatesToml, "utf8")) as {
        gates?: { rung?: string; command?: string; args?: string[] }[];
      };
      for (const g of t.gates ?? []) {
        if (g.rung && g.command)
          out.push({ package: name, rung: g.rung, command: g.command, args: g.args ?? [], cwd });
      }
      continue;
    }
    if (pkg.kind === "cargo") {
      out.push({
        package: name,
        rung: "test",
        command: "cargo",
        args: ["test", "-p", name],
        cwd: root,
      });
    } else {
      const scripts =
        (
          JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
            scripts?: Record<string, string>;
          }
        ).scripts ?? {};
      if (scripts.typecheck)
        out.push({
          package: name,
          rung: "typecheck",
          command: "pnpm",
          args: ["run", "typecheck"],
          cwd,
        });
      if (scripts.test)
        out.push({ package: name, rung: "test", command: "pnpm", args: ["run", "test"], cwd });
    }
  }
  return out;
}

/**
 * A cross-repository change is two cards with a dependency edge, never one
 * card with two worktrees (design): split a multi-repo scope accordingly.
 */
export function splitAcrossRepos(
  scope: readonly { repo: string; path: string }[],
  order: readonly string[],
): { repo: string; scopeFiles: string[]; dependsOnRepo?: string }[] {
  const repos = [...new Set(scope.map((s) => s.repo))].sort(
    (a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999),
  );
  return repos.map((repo, i) => ({
    repo,
    scopeFiles: scope.filter((s) => s.repo === repo).map((s) => s.path),
    ...(i > 0 ? { dependsOnRepo: repos[i - 1] as string } : {}),
  }));
}

export function relativeTo(root: string, abs: string): string {
  return relative(root, abs).replace(/\\/g, "/");
}
