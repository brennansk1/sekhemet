import { execFileSync, spawn, spawnSync } from "node:child_process";

export function runScript(cmd, script) {
  // ruleid: sekhemet.js-spawn-shell-true
  const child = spawn(cmd, { shell: true, stdio: "inherit" });
  // ruleid: sekhemet.js-spawn-shell-true
  spawnSync(
    "npm",
    ["run", script, "--", "--reporter=verbose", "--coverage", "--watch=false", "--bail=1"],
    { shell: true, stdio: "inherit", cwd: process.cwd(), env: process.env },
  );
  // ruleid: sekhemet.js-spawn-shell-true
  execFileSync(cmd, [script], { shell: true });
  return child;
}

export function runSafely(script) {
  // ok: sekhemet.js-spawn-shell-true
  spawn("git", ["status"], { stdio: "inherit" });
  // ok: sekhemet.js-spawn-shell-true
  spawnSync("npm", ["run", script], { shell: false });
}
