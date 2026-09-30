/**
 * B1 — the Worker cannot leave its sandbox. Runs the containment suite
 * (the sandbox package's tests: Seatbelt on macOS, both engines, DEC-39) on
 * this machine with vitest's JSON reporter, one worker; reads the recorded
 * injection run (a live Worker that tries to leave, `evidence/injection_*.json`,
 * security NEW-security-4); and runs the suite on Linux under both engines —
 * on this host when it is Linux, or in the Lima VM `SEKHEMET_LINUX_VM` names
 * (R9). SEC-43 is read across the platforms: each test passes where it
 * applies, none fails on either, none is skipped on both.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeVitest } from "./containment.mjs";
import { ORIGINAL_ENV, ROOT, check } from "./core.mjs";
import { treeIdentity } from "./lib.mjs";

/** The newest injection run that completed (not one named INVALID or NOT-RUN). */
function injectionRun() {
  const dir = join(ROOT, "evidence");
  const file = readdirSync(dir)
    .filter((f) => /^injection_\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .at(-1);
  if (!file) return undefined;
  const r = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const commit = execFileSync("git", ["log", "-1", "--format=%h", "--", `evidence/${file}`], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  const held = (r.results ?? []).filter((x) => x.passed).length;
  return {
    file: `evidence/${file}`,
    commit,
    worker: r.worker,
    held,
    total: r.fixtures,
    passed: r.passed,
  };
}

/**
 * What the recorded injection run tested (close-out review C4): the sandbox
 * and the Worker's tool surface. A change to any of it since that run's
 * commit leaves the recorded result about another Worker.
 */
export const INJECTION_SURFACE = [
  "packages/sandbox/src",
  "packages/loop/src/tools.ts",
  "packages/loop/src/tool_catalog.ts",
  "packages/loop/src/tool_schema.ts",
];

/**
 * The surface's files that differ from `commit` in the working tree —
 * committed since, uncommitted, or new and untracked — relative to the root.
 */
export function surfaceChanges(commit, cwd = ROOT, paths = INJECTION_SURFACE) {
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  const changed = git("diff", "--name-only", commit, "--", ...paths);
  const added = git("ls-files", "--others", "--exclude-standard", "--", ...paths);
  return [...new Set([...changed, ...added])].sort();
}

/**
 * The check for the recorded injection run: PASS only when every fixture
 * held and the surface is unchanged since its commit; NOT RUN, naming what
 * changed, when it is stale; FAIL when a fixture got out.
 */
export function injectionCheck(inj, changes) {
  const name = "macOS: a Worker that tries to leave (the injection fixtures, live Worker)";
  if (!inj) return check(name, null, "no completed injection run recorded");
  const held = inj.passed === true && inj.held === inj.total;
  const recorded = `${inj.held}/${inj.total} held by ${inj.worker}, recorded in ${inj.file} (commit ${inj.commit})`;
  if (!held) return check(name, false, recorded);
  if (changes.length > 0) {
    const shown = changes.slice(0, 5).join(", ");
    return check(
      name,
      null,
      `${recorded}; stale: ${changes.length} files of the sandbox or the Worker's tools changed since ${inj.commit} (${shown}${changes.length > 5 ? ", …" : ""}); run the injection fixtures again`,
    );
  }
  return check(name, true, `${recorded}; the sandbox and the Worker's tools are unchanged since`);
}

/** One platform's run: its failures and broken files decide; skips are counted. */
export function platformCheck(label, s) {
  const name = `${label}: the containment suite`;
  if (!s) return check(name, false, "vitest produced no report");
  const ok = s.tests > 0 && s.failed === 0 && s.brokenFiles.length === 0;
  const parts = [`${s.passed}/${s.tests} passed in ${s.files} files`];
  if (s.skipped) parts.push(`${s.skipped} skipped`);
  if (s.failed) parts.push(`failed: ${s.failedTitles.join(", ")}`);
  if (s.brokenFiles.length) parts.push(`files that did not load: ${s.brokenFiles.join(", ")}`);
  return check(name, ok, parts.join("; "));
}

/**
 * The platform a test applies to (SEC-43 as the lead reads it, R9-L3 review).
 * Only the tests named here may be skipped on the other platform; every
 * other test must pass on both. The list is the product's design, not the
 * results': a test is platform-only because the mechanism it tests exists on
 * one platform only.
 */
const PLATFORM_ONLY = [
  // bubblewrap's masks and Linux's host sockets (items 14a, 15).
  { platform: "Linux", test: (file) => file === "linux_sockets.spec.ts" },
  {
    platform: "Linux",
    test: (file, title) => file === "secret_masks.spec.ts" && title.includes(" bubblewrap: "),
  },
  // The keychain, macOS session sockets and Seatbelt's own rules (items 11a, 15, SEC-15a).
  {
    platform: "macOS",
    test: (file) => file === "keychain_containment.spec.ts" || file === "session_sockets.spec.ts",
  },
  { platform: "macOS", test: (_file, title) => title.includes(" Seatbelt: ") },
  // Refused at creation on macOS; named by the preflight on Linux (DEC-49).
  {
    platform: "macOS",
    test: (_file, title) => title.includes("refuses to create git metadata at any depth"),
  },
];

/** "macOS", "Linux" or "both" for a `file: title` key. */
export function appliesTo(key) {
  const at = key.indexOf(": ");
  const file = key.slice(0, at);
  const title = ` ${key.slice(at + 2)}`;
  return PLATFORM_ONLY.find((p) => p.test(file, title))?.platform ?? "both";
}

/**
 * SEC-43 across macOS and Linux: each test passes on every platform it
 * applies to — present, not skipped, not failed — and a test absent from a
 * platform's run it applies to counts as not run there.
 */
export function acrossPlatforms(runs) {
  const name =
    "macOS and Linux together: every test passes on each platform it applies to (SEC-43)";
  const have = runs.filter((r) => r.summary);
  const platformOf = (label) => (label.startsWith("macOS") ? "macOS" : "Linux");
  if (
    !have.some((r) => platformOf(r.label) === "macOS") ||
    !have.some((r) => platformOf(r.label) === "Linux")
  ) {
    return check(name, null, "needs a run on each platform");
  }
  const titles = [...new Set(have.flatMap((r) => Object.keys(r.summary.statuses ?? {})))].sort();
  const gaps = [];
  for (const t of titles) {
    const scope = appliesTo(t);
    for (const r of have) {
      if (scope !== "both" && scope !== platformOf(r.label)) continue;
      const st = r.summary.statuses?.[t];
      if (st !== "passed") gaps.push(`${r.label}: ${t} (${st ?? "not run"})`);
    }
  }
  const parts = [`${titles.length} tests over ${have.map((r) => r.label).join(", ")}`];
  if (gaps.length) parts.push(`not passed where they apply: ${gaps.join(", ")}`);
  return check(name, gaps.length === 0, parts.join("; "));
}

/** vitest's JSON report of the sandbox suite, run by `spawn` with `env`. */
function suiteReport(spawn) {
  const out = mkdtempSync(join(tmpdir(), "milestone-b1-"));
  try {
    const reportFile = join(out, "containment.json");
    const r = spawn(reportFile);
    try {
      return summarizeVitest(JSON.parse(readFileSync(reportFile, "utf8")));
    } catch {
      return undefined;
    } finally {
      void r;
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const VITEST_ARGS = (reportFile) => [
  "run",
  "--pool=forks",
  "--poolOptions.forks.maxForks=1",
  "--reporter=json",
  `--outputFile=${reportFile}`,
  "packages/sandbox/tests",
];

/**
 * The Linux runs, one per engine: here on Linux, or in the Lima VM named by
 * SEKHEMET_LINUX_VM, with this tree copied into its checkout `~/sekhemet`
 * and built there. Undefined, with the reason, when neither is available.
 */
function linuxRuns() {
  // One run: the suite names both engines itself (describe.each), and the
  // across-platform check requires their titles (R9-L3 review).
  if (platform() === "linux") {
    return [
      {
        label: "Linux",
        summary: suiteReport((reportFile) =>
          spawnSync(join(ROOT, "node_modules", ".bin", "vitest"), VITEST_ARGS(reportFile), {
            cwd: ROOT,
            env: ORIGINAL_ENV,
            encoding: "utf8",
            timeout: 20 * 60_000,
          }),
        ),
      },
    ];
  }
  const vm = ORIGINAL_ENV.SEKHEMET_LINUX_VM;
  if (!vm)
    return { reason: "set SEKHEMET_LINUX_VM to a Lima instance with bubblewrap, or run on Linux" };
  const shell = (script, timeout = 20 * 60_000) =>
    spawnSync("limactl", ["shell", vm, "bash", "-lc", script], {
      env: ORIGINAL_ENV,
      encoding: "utf8",
      timeout,
      maxBuffer: 64 * 1024 * 1024,
    });
  const prep = shell(
    `rsync -a --delete --exclude node_modules --exclude dist --exclude /.git --exclude '*.tsbuildinfo' --exclude /.sekhemet --exclude /evidence '${ROOT}/' ~/sekhemet/ && cd ~/sekhemet && pnpm install --frozen-lockfile --offline >/dev/null && npx tsc -b --force`,
  );
  if (prep.status !== 0) {
    return {
      reason: `the VM ${vm} could not build this tree: ${(prep.stderr || prep.stdout || "").trim().slice(-300)}`,
    };
  }
  // The report is removed first: a vitest that dies before writing leaves no
  // file, never an earlier run's (R9-L3 review blocker).
  const r = shell(
    `cd ~/sekhemet && rm -f /tmp/b1-linux.json && npx vitest ${VITEST_ARGS("/tmp/b1-linux.json").join(" ")} >/dev/null 2>&1; cat /tmp/b1-linux.json`,
  );
  let summary;
  try {
    summary = r.status === 0 ? summarizeVitest(JSON.parse(r.stdout)) : undefined;
  } catch {
    summary = undefined;
  }
  return [{ label: `Linux (${vm})`, summary }];
}

export async function run() {
  const checks = [];
  const details = {};
  const runs = [];
  // The tree both halves ran on: taken before and after, and the run counts
  // only if nothing changed in between (R9-L3 review).
  const before = treeIdentity();
  if (platform() === "darwin") {
    const summary = suiteReport((reportFile) =>
      spawnSync(join(ROOT, "node_modules", ".bin", "vitest"), VITEST_ARGS(reportFile), {
        cwd: ROOT,
        env: ORIGINAL_ENV,
        encoding: "utf8",
        timeout: 20 * 60_000,
      }),
    );
    details.containment = summary ?? null;
    runs.push({ label: "macOS", summary });
    checks.push(platformCheck("macOS (Seatbelt, native and srt engines)", summary));
  } else {
    checks.push(check("macOS: the containment suite", null, `this host is ${platform()}`));
  }
  const inj = injectionRun();
  const changes = inj?.commit ? surfaceChanges(inj.commit) : [];
  details.injection = inj ? { ...inj, surfaceChanges: changes } : null;
  checks.push(injectionCheck(inj, changes));
  const linux = linuxRuns();
  if (Array.isArray(linux)) {
    details.linux = linux;
    for (const r of linux) checks.push(platformCheck(`${r.label} (bubblewrap)`, r.summary));
    runs.push(...linux);
  } else {
    checks.push(
      check(
        "Linux: the containment suite under bubblewrap (SEC-43)",
        null,
        `not run: ${linux.reason}`,
      ),
    );
  }
  const after = treeIdentity();
  details.trees = { before, after };
  checks.push(
    before === after
      ? acrossPlatforms(runs)
      : check(
          "macOS and Linux together: every test passes on each platform it applies to (SEC-43)",
          null,
          `not counted: the tree changed during the run (${before.slice(0, 10)} → ${after.slice(0, 10)})`,
        ),
  );
  return { checks, details };
}
