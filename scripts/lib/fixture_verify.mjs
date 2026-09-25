// Shared by the verifiers of the frozen suite's evaluation assets
// (scripts/verify_reference_solutions.mjs, scripts/verify_held_out.mjs): a
// fixture copied and seeded exactly as scripts/run_suite.mjs prepares it, and
// one vitest run read from its JSON report.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export function run(dir, bin, args) {
  const r = spawnSync(join(dir, "node_modules", ".bin", bin), args, {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  return { status: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/**
 * A test file's path from `tests/` on: the temporary directory's own name
 * (and macOS's /var vs /private/var) never reaches the output hash.
 */
const stagedPath = (file) => {
  const at = file.lastIndexOf("/tests/");
  return at >= 0 ? file.slice(at + 1) : file;
};

/**
 * One vitest run over the given test files, read from its JSON report. The
 * output hash is over each test's full name and status, sorted, so it is the
 * same on every run that gives the same results (durations are left out).
 */
export function vitest(dir, files) {
  // Outside the repository, so the lint gate never reads it.
  const report = `${dir}.vitest-report.json`;
  rmSync(report, { force: true });
  const r = run(dir, "vitest", ["run", ...files, "--reporter=json", `--outputFile=${report}`]);
  let tests = [];
  if (existsSync(report)) {
    const json = JSON.parse(readFileSync(report, "utf8"));
    tests = (json.testResults ?? []).flatMap((f) =>
      (f.assertionResults ?? []).map((a) => ({
        name: `${stagedPath(f.name)} > ${a.fullName}`,
        status: a.status,
      })),
    );
    // A file that failed to load (a missing module) has no assertions.
    for (const f of json.testResults ?? []) {
      if ((f.assertionResults ?? []).length === 0 && f.status === "failed") {
        tests.push({ name: `${stagedPath(f.name)} > (file failed to load)`, status: "failed" });
      }
    }
  }
  tests.sort((a, b) => a.name.localeCompare(b.name));
  const passed = tests.filter((t) => t.status === "passed").length;
  return {
    exitCode: r.status,
    passed,
    total: tests.length,
    outputSha256: sha256(tests.map((t) => `${t.status} ${t.name}`).join("\n")),
    output: r.output,
  };
}

/** The fixture's copy and board, exactly as scripts/run_suite.mjs prepares them. */
export function prepare(fixture, prefix = "refsol") {
  const dir = mkdtempSync(join(tmpdir(), `sekhemet-${prefix}-${fixture}-`));
  execFileSync("cp", ["-R", `${join(ROOT, "fixtures", fixture)}/.`, dir]);
  execFileSync("ln", ["-s", join(ROOT, "node_modules"), join(dir, "node_modules")]);
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "suite@sekhemet.local");
  git("config", "user.name", "Frozen Suite");
  git("add", "-A");
  git("commit", "-q", "-m", `seed: ${fixture}`);
  const seeder = existsSync(join(ROOT, "fixtures", fixture, "cards.json"))
    ? ["scripts/seed_project.mjs", join(ROOT, "fixtures", fixture), dir]
    : ["scripts/seed_chronicle.mjs", dir];
  execFileSync("node", [join(ROOT, seeder[0]), ...seeder.slice(1)], { stdio: "ignore" });
  return { dir, git };
}

export function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).replaceAll("\\", "/"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

export function formatJson(file) {
  const r = spawnSync(join(ROOT, "node_modules", ".bin", "biome"), ["format", "--write", file], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`biome format ${file}: ${r.stdout}${r.stderr}`);
}
