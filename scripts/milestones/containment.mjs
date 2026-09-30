/**
 * B1's reading of the containment suite (security SEC-38, SEC-43): the
 * sandbox package's tests, run by vitest with its JSON reporter. A skipped
 * test is not a pass: SEC-43 asks for no test skipped on either platform.
 */
import { basename } from "node:path";

export function summarizeVitest(report) {
  const files = report.testResults ?? [];
  let passed = 0;
  let failed = 0;
  const skippedTitles = [];
  const failedTitles = [];
  const brokenFiles = [];
  /** Each test's status by `file: full name`, to read platforms together. */
  const statuses = {};
  for (const f of files) {
    const assertions = f.assertionResults ?? [];
    // A file that failed to load has no assertions and a failed status.
    if (assertions.length === 0 && f.status === "failed") brokenFiles.push(basename(f.name));
    for (const a of assertions) {
      const title = `${basename(f.name)}: ${a.fullName ?? a.title}`;
      statuses[title] = a.status;
      if (a.status === "passed") passed++;
      else if (a.status === "failed") {
        failed++;
        failedTitles.push(title);
      } else skippedTitles.push(`${basename(f.name)}: ${a.title}`);
    }
  }
  const tests = passed + failed + skippedTitles.length;
  return {
    files: files.length,
    tests,
    passed,
    failed,
    skipped: skippedTitles.length,
    skippedTitles,
    failedTitles,
    brokenFiles,
    statuses,
    ok: tests > 0 && failed === 0 && skippedTitles.length === 0 && brokenFiles.length === 0,
  };
}
