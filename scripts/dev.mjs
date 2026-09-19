#!/usr/bin/env node
/**
 * `pnpm dev` (X24, design "Root scripts"): build once, then keep the
 * TypeScript build watching and the dashboard daemon running from it,
 * restarted by Node whenever the compiled harness changes. The design names
 * `tsx apps/harness/src/index.ts daemon`; tsc's watch plus `node --watch`
 * gives the same loop without adding a dependency, and runs the exact code
 * `pnpm build` ships.
 *
 *   pnpm dev [--port 4040] [--repo <path>]   (--dry-run prints the plan)
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const port = flag("--port", "4040");
const repo = resolve(flag("--repo", process.env.INIT_CWD ?? process.cwd()));
const tsc = join(ROOT, "node_modules", ".bin", "tsc");
const entry = join(ROOT, "apps", "harness", "dist", "index.js");

export const plan = [
  [tsc, ["-b"]],
  [tsc, ["-b", "--watch", "--preserveWatchOutput"]],
  [process.execPath, ["--watch", entry, "serve", "--repo", repo, "--port", port]],
];

if (args.includes("--dry-run")) {
  for (const [cmd, a] of plan) console.log([cmd, ...a].join(" "));
  process.exit(0);
}

const first = spawnSync(plan[0][0], plan[0][1], { cwd: ROOT, stdio: "inherit" });
if (first.status !== 0) process.exit(first.status ?? 1);
const children = plan.slice(1).map(([cmd, a]) => spawn(cmd, a, { cwd: ROOT, stdio: "inherit" }));
const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const c of children) c.on("exit", (code) => code && code !== 0 && stop());
