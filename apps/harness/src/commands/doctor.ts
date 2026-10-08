import { runDoctor } from "../doctor.js";
import { baseResult } from "./cli_result.js";
import type { CommandEnv, CommandHandler } from "./registry.js";

/**
 * `sekhemet doctor [--json]` and `sekhemet doctor --airgap …` (surface items
 * 13, 20b): every check of the catalogue, each that is not a pass followed
 * by its next step on its own line (`Do: …`, SUR-62), then one verdict —
 * *Ready to run an issue*, or *Not ready* naming the first missing step —
 * exit 1 while not ready (SUR-61). `--json` (NEW-surface-10) carries the
 * same checks, steps and verdict.
 */
export const doctorCommand: CommandHandler = async (args, env) => {
  // SUR-66, SUR-67: the one update request Sekhemet makes, and only on a yes.
  if (args.values["check-updates"]) return checkUpdatesBranch(args.values.yes === true, env);
  if (args.values.airgap) {
    // SUR-70: the air-gap self-test prints lines and has no result object
    // yet, so `--json` with it is refused before it runs, exit 2 with the object.
    if (env.json) {
      const message =
        "--airgap has no JSON object yet; run `sekhemet doctor --airgap` without --json";
      console.error(`sekhemet: ${message}`);
      return baseResult("doctor", 2, message);
    }
    // X14: the air-gap self-test, written to the audit log.
    const { airgapCommand } = await import("../airgap.js");
    const { log } = await env.kernel("read");
    const rest = env.argv.slice(env.argv.indexOf("--airgap") + 1);
    const code = await airgapCommand(env.repoPath, ["selftest", ...rest], {
      log,
      print: (l) => console.log(l),
    });
    return code === 0 ? 0 : code === 2 ? 2 : 1;
  }
  // SUR-89: the weights are hashed only when asked.
  const report = await runDoctor(env.repoPath, {
    verifyWeights: args.values["verify-weights"] === true,
  });
  console.log("\n=== Sekhemet Doctor Diagnostics ===");
  for (const c of report.checks) {
    const mark = c.status === "pass" ? "✓" : c.status === "warn" ? "!" : "✗";
    console.log(`  ${mark} ${c.name}: ${c.detail}`);
    if (c.status !== "pass" && c.do) console.log(`      Do: ${c.do}`);
  }
  const message = report.verdict;
  console.log(`\n${message}\n`);
  // SUR-90: the redacted report folder, its path and table of contents; nothing sent.
  if (args.values.report) {
    const { contentsLines, writeReportBundle } = await import("../report_bundle.js");
    const bundle = writeReportBundle(env.repoPath, report);
    for (const line of contentsLines(bundle.dir, bundle.contents)) console.log(line);
  }
  return {
    ...baseResult("doctor", report.ok ? 0 : 1, message),
    ready: report.ok,
    verdict: report.verdict,
    checks: report.checks.map((c) => ({
      name: c.name,
      status: c.status,
      detail: c.detail,
      ...(c.do ? { do: c.do } : {}),
    })),
  };
};

/** `doctor --check-updates [--yes]` (surface item 34, NEW-surface-9). */
async function checkUpdatesBranch(yes: boolean, env: CommandEnv): Promise<0 | 1 | 2> {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { checkForUpdates } = await import("../update_check.js");
  const { installedVersion } = await import("../whats_new.js");
  // The request is recorded where a ledger is open; a folder with none gets none.
  const hasLedger = existsSync(join(env.repoPath, ".sekhemet", "events.db"));
  return checkForUpdates({
    repoPath: env.repoPath,
    installed: installedVersion(),
    ...(hasLedger ? { log: (await env.kernel("read")).log } : {}),
    confirm: async () => {
      if (yes) return true;
      if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl.question("Ask registry.npmjs.org now? [y/N] ")).trim());
      } finally {
        rl.close();
      }
    },
  });
}
