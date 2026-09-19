/**
 * The `test:unit` / `test:integration` split (X23, design "Root scripts").
 *
 * A spec is an integration test when it touches the outside world: real git
 * repositories, synthetic fixtures, on-disk SQLite, a listening server, or a
 * child process. Everything else is a unit test (mocked, in-memory). The
 * split is read from the files, so a new test lands in the right suite
 * without anyone maintaining a list. vitest.config.ts uses it for the two
 * projects; `pnpm test` still runs both.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const INTEGRATION_SIGNALS = [
  /execFileSync\(\s*["'`]/,
  /execSync\(\s*[`"']git /,
  /spawn(Sync)?\(\s*(["'](git|cargo|python3|node|sh|bash)["']|process\.execPath)/,
  /\bgit\(\s*["'](init|commit|clone)["']/,
  /createTestWorktree\(/,
  /NodeGitSyncAdapter/,
  /openDiskDb\(/,
  /new DatabaseSync\(\s*join\(/,
  /startDashboardServer\(/,
  /createServer\(/,
  /\.listen\(/,
  /DeterministicGateRunner\(/,
  /ProcessSandbox\(/,
];

/** Is this spec's source an integration test? */
export function isIntegrationSpec(source) {
  return INTEGRATION_SIGNALS.some((re) => re.test(source));
}

function specs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) specs(path, out);
    else if (name.endsWith(".spec.ts")) out.push(path);
  }
  return out;
}

/** Every spec under the packages and apps test folders, split in two. */
export function splitSpecs(root) {
  const unit = [];
  const integration = [];
  for (const group of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(root, group))) {
      let files = [];
      try {
        files = specs(join(root, group, pkg, "tests"));
      } catch {
        continue;
      }
      for (const f of files) {
        (isIntegrationSpec(readFileSync(f, "utf8")) ? integration : unit).push(relative(root, f));
      }
    }
  }
  return { unit: unit.sort(), integration: integration.sort() };
}
