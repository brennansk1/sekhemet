import { runDoctor } from "../doctor.js";
import { baseResult } from "./cli_result.js";
import type { CommandHandler } from "./registry.js";

/**
 * `sekhemet doctor [--json]` and `sekhemet doctor --airgap …` (surface item
 * 13). The catalogue's verdict and each check's next step are C5's
 * (NEW-surface-8, CLI-02); this moves the command into the registry and
 * gives it `--json` (NEW-surface-10), the checks as `runDoctor` reports them.
 */
export const doctorCommand: CommandHandler = async (args, env) => {
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
  }
  const message = report.ok ? "All critical checks passed." : "One or more checks FAILED.";
  console.log(`\n${message}\n`);
  // SUR-90: the redacted report folder, its path and table of contents; nothing sent.
  if (args.values.report) {
    const { contentsLines, writeReportBundle } = await import("../report_bundle.js");
    const bundle = writeReportBundle(env.repoPath, report);
    for (const line of contentsLines(bundle.dir, bundle.contents)) console.log(line);
  }
  return {
    ...baseResult("doctor", report.ok ? 0 : 1, message),
    checks: report.checks.map((c) => ({ name: c.name, status: c.status, detail: c.detail })),
  };
};
