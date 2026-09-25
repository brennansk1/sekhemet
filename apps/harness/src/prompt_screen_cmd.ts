import {
  type StepReplayModel,
  type StepReplayReport,
  canonicalStates,
  recordedReplayCases,
  runStepReplay,
} from "@sekhemet/context";
import { TOOL_CATALOG, toolDefinition, toolsForClass } from "@sekhemet/loop";

/**
 * `sekhemet prompt-screen [--from <repo,...>] [--limit N] [--worker cyber-tiel]`
 * (PROMPT_STANDARD rule 35.3): one model step on each canonical state of the
 * Worker's fixed tool set, and on each recorded context pack of the named
 * run ledgers. It screens a prompt change; it never admits one; admission
 * is the suite A/B (DEC-28).
 */
export async function runPromptScreen(opts: {
  model: StepReplayModel;
  repos: readonly string[];
  limit?: number;
  say?: (line: string) => void;
}): Promise<StepReplayReport> {
  const say = opts.say ?? ((l: string) => console.log(l));
  const tools = toolsForClass("implement", TOOL_CATALOG, { arm: "fixed" });
  const recorded = recordedReplayCases(opts.repos, {
    modelId: opts.model.modelId,
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  });
  const cases = [
    ...canonicalStates({ tools, definitions: tools.map(toolDefinition) }),
    ...recorded.cases,
  ];
  const report = await runStepReplay(cases, opts.model);
  say(`Step-replay screen for ${report.modelId}: ${report.passed ? "passed" : "FAILED"}.`);
  for (const [state, ok] of Object.entries(report.byState)) {
    say(`  ${state}: ${ok ? "right first call" : "wrong first call"}`);
  }
  for (const [check, n] of Object.entries(report.byCheck)) {
    say(`  ${check}: ${n.pass} passed, ${n.fail} failed`);
  }
  if (report.asStored > 0) say(`  ${report.asStored} recorded step(s) replayed as stored.`);
  for (const [why, n] of Object.entries(recorded.skipped)) say(`  skipped ${n}: ${why}`);
  say("The screen screens only; it never admits a change (the suite A/B does).");
  return report;
}
