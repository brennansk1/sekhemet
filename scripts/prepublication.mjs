#!/usr/bin/env node
/**
 * The pre-publication pass (DEC-54 c2, FINDINGS_C1 INS-06, W15).
 *
 *   node scripts/prepublication.mjs                 # write docs/reference/PREPUBLICATION.md
 *   node scripts/prepublication.mjs --check         # tracked files only; exit 1 on a finding
 *   node scripts/prepublication.mjs [--root <repo>] [--out <file>] [--no-gitleaks] [--marker <text>]...
 *
 * It REPORTS; it never rewrites anything, history least of all.
 *
 * - Every commit of the history is scanned for secrets: by gitleaks when it is
 *   installed, otherwise by the bundled offline rules (gitleaks' own rule file,
 *   vendored; `scanHistorySecrets` in packages/gates). A finding is its
 *   commit, path and rule; the secret is never read into the report.
 * - Every tracked file, as it is on disk now, is scanned for this machine's
 *   paths: the home directory, each mounted volume, an agent's scratch folder
 *   (`/private/tmp/claude-<uid>`), and the folders the environment names
 *   (SEKHEMET_MODELS_DIR, LIMA_HOME), plus any `--marker`. A finding names the
 *   file, the line and the kind of path, never the path itself.
 * - A tracked `.claude/launch.json` (a person's dev-server list) or
 *   `CLAUDE.local.md` (this machine's operations) is a finding.
 *
 * Machine paths are this host's, so another host finds what is its own.
 * Placeholders a test or a guide uses (`/Users/someone`, `/Volumes/USB`) are
 * not this machine's and pass.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const valuesOf = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
if (flag("--help") || flag("-h")) {
  console.log(
    "usage: node scripts/prepublication.mjs [--check] [--root <repo>] [--out <file>] [--no-gitleaks] [--marker <text>]...",
  );
  process.exit(0);
}
const root = resolve(argValue("--root") ?? REPO);
const check = flag("--check");
const out = resolve(argValue("--out") ?? join(root, "docs", "reference", "PREPUBLICATION.md"));

/**
 * Records this pass may not edit (CLAUDE.md: the lead keeps DEV_LOG and
 * DECISIONS): each may hold at most `max` machine paths, so the count only
 * falls and a new one fails. The report names each line for the lead to
 * redact; the entry goes when its file is clean.
 */
export const RECORDS = {
  "DEV_LOG.md": {
    max: 1,
    reason: "the lead's log; this pass may not edit it — the lead redacts the line",
  },
  "docs/design/DECISIONS.md": {
    max: 1,
    reason: "a decision record; this pass may not edit it — the lead redacts the line",
  },
};

/**
 * History findings read and judged (2026-10-08, by reading each file at its
 * commit): `<commit 9> <path> <rule>` → why it is not a secret. A finding not
 * listed here is "not triaged" until someone reads it.
 */
export const TRIAGED = {
  "a01201f2b apps/harness/tests/kernel_runs_entry_cli.spec.ts generic-api-key":
    "a made-up canary the test proves never leaves the sandbox",
  "75ecf9b1b fixtures/capstone/webbench/manifest.json generic-api-key":
    "a SHA-256 file hash beside a path named auth.ts",
  "4747051a6 scripts/milestones/team.mjs generic-api-key":
    "the milestone runner's password for throwaway local test accounts",
  "2d6286467 fixtures/seeded_defects/witness/onyx-scanner-first-token-only.spec.ts generic-api-key":
    "a seeded-defect witness: a fake key the fixture's scanner must catch",
  "2d6286467 fixtures/seeded_defects/witness/onyx-scanner-private-key-kinds.spec.ts private-key":
    "a seeded-defect witness: a fake private-key header the fixture's scanner must catch",
  "6bdaaa4c5 packages/gates/tests/gitleaks_rules.spec.ts aws-access-token":
    "the rule tests' fake key, there to be caught",
  "6bdaaa4c5 packages/gates/tests/gitleaks_rules.spec.ts generic-api-key":
    "the rule tests' fake key, there to be caught",
  "5e56b5db2 packages/gates/data/scancode-licensedb/categories.json generic-api-key":
    "licence ids (`license_key`) of the vendored ScanCode LicenseDB",
  "eb6776f5d packages/gates/rules/semgrep/fixtures/hardcoded-aws-access-key-id.py aws-access-token":
    "a Semgrep rule fixture: a fake key the rule must flag",
  "eb6776f5d packages/gates/rules/semgrep/fixtures/hardcoded-private-key.ts private-key":
    "a Semgrep rule fixture: a fake key the rule must flag",
  "eb6776f5d packages/gates/rules/semgrep/fixtures/js-hardcoded-password.ts generic-api-key":
    "a Semgrep rule fixture: a fake password the rule must flag",
  "18a31970c packages/kernel/tests/erasure.spec.ts generic-api-key":
    "the erasure test's made-up value, there to be erased",
  "5f8f21b8e apps/harness/tests/daemon_ws.spec.ts generic-api-key":
    "RFC 6455's sample Sec-WebSocket-Key",
  "abcc16ed0 apps/harness/tests/daemon_ws.spec.ts generic-api-key":
    "RFC 6455's sample Sec-WebSocket-Key",
  "4050296f1 fixtures/onyx/acceptance/scanner.spec.ts private-key":
    "the Onyx fixture's acceptance test: a fake key for the scanner it specifies",
};

const git = (args, cwd = root) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The same, for git's extended regular expressions (`git log -E -G`). */
const ereEscape = (s) =>
  s.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "^" || c === "\\" ? `\\${c}` : `[${c}]`));
/** A path ends where a path character does not follow. */
const END = "(?![A-Za-z0-9_.-])";

/** This host's machine paths, each a pattern and the kind it names. */
function machineMarkers(env) {
  const markers = [];
  const home = env.HOME || homedir();
  // `/root` alone is too short to be told from text; a home is two levels deep.
  if (isAbsolute(home) && home.split("/").filter(Boolean).length >= 2) {
    const h = home.replace(/\/+$/, "");
    markers.push({
      re: new RegExp(reEscape(h) + END),
      ere: ereEscape(h),
      kind: "this host's home directory",
    });
  }
  markers.push({
    re: /\/(?:private\/)?tmp\/claude-\d+/,
    ere: "/(private/)?tmp/claude-[0-9]+",
    kind: "an agent's scratch folder",
  });
  if (existsSync("/Volumes")) {
    for (const name of readdirSync("/Volumes")) {
      let link = true;
      try {
        link = lstatSync(join("/Volumes", name)).isSymbolicLink();
      } catch {}
      // The boot volume is a link to `/`; the rest are mounted drives.
      if (!link)
        markers.push({
          re: new RegExp(`/Volumes/${reEscape(name)}${END}`),
          ere: `/Volumes/${ereEscape(name)}`,
          kind: "a volume mounted on this host",
        });
    }
  }
  for (const name of ["SEKHEMET_MODELS_DIR", "LIMA_HOME"]) {
    const v = env[name];
    if (v && isAbsolute(v) && v.split("/").filter(Boolean).length >= 2) {
      const kind =
        name === "LIMA_HOME"
          ? "the Lima home (LIMA_HOME)"
          : "the models folder (SEKHEMET_MODELS_DIR)";
      const p = v.replace(/\/+$/, "");
      markers.push({ re: new RegExp(reEscape(p) + END), ere: ereEscape(p), kind });
    }
  }
  for (const m of valuesOf("--marker"))
    markers.push({ re: new RegExp(reEscape(m)), ere: ereEscape(m), kind: "a named marker" });
  return markers;
}

/**
 * Tracked files, and new ones git does not ignore, as they are on disk now:
 * what the next `git add -A` and commit publish.
 */
function trackedFiles() {
  return [
    ...new Set(
      git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        .split("\0")
        .filter(Boolean),
    ),
  ];
}

function scanTracked(markers) {
  const files = trackedFiles();
  const hits = [];
  for (const rel of files) {
    const abs = join(root, rel);
    let buf;
    try {
      if (!lstatSync(abs).isFile()) continue;
      buf = readFileSync(abs);
    } catch {
      continue;
    }
    // Binary files (a NUL in the first 8 KiB) are not text a path hides in.
    if (buf.subarray(0, 8192).includes(0)) continue;
    const lines = buf.toString("utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of markers)
        if (m.re.test(line)) hits.push({ file: rel, line: i + 1, kind: m.kind });
    });
  }
  const tracked = new Set(files);
  const forbidden = [".claude/launch.json", "CLAUDE.local.md"].filter((f) => tracked.has(f));
  const worktrees = files.filter((f) => f.startsWith(".claude/worktrees/"));
  return { files: files.length, hits, forbidden, worktrees };
}

/** Findings over each record's allowance, and the lines each record holds. */
function judge(scan) {
  const byFile = new Map();
  for (const h of scan.hits) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h]);
  const failing = [];
  const recorded = [];
  for (const [file, hits] of byFile) {
    const record = RECORDS[file];
    if (record && hits.length <= record.max) recorded.push({ file, hits, record });
    else failing.push(...hits);
  }
  return { failing, recorded };
}

const scan = scanTracked(machineMarkers(process.env));
const verdict = judge(scan);
const problems = [
  ...verdict.failing.map((h) => `${h.file}:${h.line} holds a machine path (${h.kind})`),
  ...scan.forbidden.map(
    (f) => `${f} is tracked: it is this machine's, never published (git rm --cached ${f})`,
  ),
  ...scan.worktrees
    .slice(0, 1)
    .map(() => `${scan.worktrees.length} files under .claude/worktrees/ are tracked`),
];

if (check) {
  if (problems.length === 0) {
    const kept = verdict.recorded.reduce((n, r) => n + r.hits.length, 0);
    console.log(
      `prepublication: no machine path in ${scan.files} tracked files${
        kept
          ? ` (${kept} kept in records the lead redacts: ${verdict.recorded.map((r) => r.file).join(", ")})`
          : ""
      }`,
    );
    process.exit(0);
  }
  for (const p of problems) console.error(`prepublication: ${p}`);
  process.exit(1);
}

// ---- The full pass: the report ----

/** The main checkout's folder: the history scanner reads `<root>/.git`. */
function mainCheckout() {
  const common = resolve(root, git(["rev-parse", "--git-common-dir"]).trim());
  return common.endsWith("/.git") ? dirname(common) : root;
}

const mask = (address) => {
  const [local = "", domain = ""] = address.split("@");
  return `${local.slice(0, 1)}…@${domain}`;
};

function authors() {
  const counts = new Map();
  for (const a of git(["log", "--all", "--format=%ae"]).split("\n").filter(Boolean))
    counts.set(a, (counts.get(a) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

/** Commits whose changes add or remove a line holding a machine path (never rewritten). */
function historyMachinePaths(markers) {
  const pattern = markers.map((m) => m.ere).join("|");
  if (!pattern) return 0;
  return git(["log", "--all", "--format=%H", "-E", "-G", pattern]).split("\n").filter(Boolean)
    .length;
}

const gates = await import(pathToFileURL(join(REPO, "packages", "gates", "dist", "index.js")).href);
const checkout = mainCheckout();
const history = await gates.scanHistorySecrets(
  checkout,
  flag("--no-gitleaks") ? { gitleaks: false } : {},
);
const head = git(["rev-parse", "--short=9", "HEAD"]).trim();
const findings = history.findings.map((f) => {
  const key = `${f.commit.slice(0, 9)} ${f.path} ${f.rule}`;
  return { ...f, triage: TRIAGED[key] };
});
const untriaged = findings.filter((f) => !f.triage).length;
const people = authors();
const markers = machineMarkers(process.env);
const historyHits = historyMachinePaths(markers);
const today = new Date().toISOString().slice(0, 10);

const lines = [];
const w = (s = "") => lines.push(s);
w("# Pre-publication pass");
w();
w(
  `Generated by \`node scripts/prepublication.mjs\` on ${today} at \`${head}\` (DEC-54 c2, FINDINGS_C1 INS-06). The pass **reports**; it never rewrites history. Run it again before the first public push, and \`--check\` before every commit that adds files.`,
);
w();
w("## 1. Secrets in the history");
w();
const scanner = history.scanner === "gitleaks" ? "gitleaks" : "the bundled rules (builtin)";
w(
  `Scanner: ${scanner}, ${history.commits} commit${history.commits === 1 ? "" : "s"}, every ref. ${history.notScanned ? `**Not scanned: ${history.reason}.** ` : ""}${history.reason && !history.notScanned ? `Note: ${history.reason}. ` : ""}A finding is its commit, path and rule; the secret itself is never read into this report.`,
);
w();
if (findings.length === 0) w("No finding.");
else {
  w("| Commit | Path | Rule | Triage |");
  w("| --- | --- | --- | --- |");
  for (const f of findings)
    w(
      `| \`${f.commit.slice(0, 9)}\` | \`${f.path}\` | ${f.rule} | ${f.triage ? `not a secret: ${f.triage}` : "not triaged: read it before publishing"} |`,
    );
  w();
  w(
    untriaged === 0
      ? `All ${findings.length} findings read: none is a secret.`
      : `${untriaged} finding${untriaged === 1 ? "" : "s"} not triaged.`,
  );
}
w();
w("## 2. Author addresses");
w();
w(
  "The history is not rewritten for an address: the owner accepted the addresses already public on the commits (DEC-54, 2026-10-01). Each is shown masked.",
);
w();
w("| Address | Commits |");
w("| --- | --- |");
for (const [a, n] of people) w(`| ${mask(a)} | ${n} |`);
w();
w("## 3. Machine paths in tracked files");
w();
w(
  `Scanned: ${scan.files} tracked files as they are on disk, for this host's home directory, its mounted volumes, an agent's scratch folder and the folders SEKHEMET_MODELS_DIR and LIMA_HOME name. A finding names the file, the line and the kind of path, never the path.`,
);
w();
if (verdict.failing.length === 0) w("No machine path outside the records below.");
else {
  w("| File | Line | Kind |");
  w("| --- | --- | --- |");
  for (const h of verdict.failing) w(`| \`${h.file}\` | ${h.line} | ${h.kind} |`);
}
w();
if (verdict.recorded.length) {
  w("Kept for the lead to redact (records this pass may not edit; each may only fall):");
  w();
  w("| File | Lines | Why it is kept |");
  w("| --- | --- | --- |");
  for (const r of verdict.recorded)
    w(`| \`${r.file}\` | ${r.hits.map((h) => h.line).join(", ")} | ${r.record.reason} |`);
  w();
}
w(
  `In the history: ${historyHits} commit${historyHits === 1 ? "" : "s"} add or remove a line holding one of these paths. They stay: the pass never rewrites history (DEC-54).`,
);
w();
w("## 4. This machine's files");
w();
const ignored = (path) => {
  try {
    git(["check-ignore", "-q", "--no-index", path]);
    return true;
  } catch {
    return false;
  }
};
const unignored = [".claude/launch.json", ".claude/worktrees/x", "CLAUDE.local.md"].filter(
  (p) => !ignored(p),
);
w(
  scan.forbidden.length === 0
    ? "`.claude/launch.json` and `CLAUDE.local.md` are not tracked."
    : `Tracked and must not be: ${scan.forbidden.map((f) => `\`${f}\``).join(", ")}.`,
);
w(
  unignored.length === 0
    ? "`.gitignore` ignores `.claude/launch.json`, `.claude/worktrees/` and `CLAUDE.local.md`."
    : `\`.gitignore\` does not ignore: ${unignored.map((f) => `\`${f}\``).join(", ")}.`,
);
w(
  "This machine's operations (its memory, its drive, its Lima home) are in the git-ignored `CLAUDE.local.md`, which `CLAUDE.md` imports; the procedure, parameterised, is [DEVELOPING.md](DEVELOPING.md).",
);
w();
w("## 5. DEC-54 c2, item by item");
w();
w("| Item | State |");
w("| --- | --- |");
w(
  `| The history scanned for secrets | ${history.notScanned ? "not scanned" : history.scanner === "gitleaks" ? `done with gitleaks: ${findings.length} findings, ${untriaged} not triaged` : `**partial**: the bundled rules only (${findings.length} findings, ${untriaged} not triaged); gitleaks was not used (not installed here, or \`--no-gitleaks\`), so run the pass again with it before the first public push`} |`,
);
w(
  `| \`.claude/launch.json\` untracked | ${scan.forbidden.includes(".claude/launch.json") ? "**no**" : "done"} |`,
);
w(
  `| This machine's operations moved out of CLAUDE.md | ${scan.forbidden.includes("CLAUDE.local.md") ? "**no**: CLAUDE.local.md is tracked" : "done"} |`,
);
w(
  `| The external-drive paths parameterised | ${verdict.failing.length > 0 ? `**no**: ${verdict.failing.length} lines` : verdict.recorded.length > 0 ? `**not yet**: parameterised (SEKHEMET_MODELS_DIR) everywhere but the records in §3, ${verdict.recorded.map((r) => `${r.file} (${r.hits.length})`).join(", ")}, which the lead redacts` : "done (SEKHEMET_MODELS_DIR)"} |`,
);
w();

const text = `${lines.join("\n")}`;
// The report must hold no machine path of its own.
for (const m of markers) {
  if (m.re.test(text)) {
    console.error(`prepublication: the report would hold a machine path (${m.kind}); not written`);
    process.exit(1);
  }
}
writeFileSync(out, text);
const shown = relative(root, out);
console.log(`prepublication: wrote ${shown.startsWith("..") ? out : shown}`);
for (const p of problems) console.error(`prepublication: ${p}`);
process.exit(problems.length || untriaged ? 1 : 0);
