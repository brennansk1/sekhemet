/**
 * B4.4 — a non-developer starts or takes over a project on the reference
 * machine by conversation, and watches its must-haves become proven.
 *
 * What needs no model runs here: the take-over of the five DS-TO-15 fixture
 * repositories — trust, recon, install, build and the suite twice
 * (confined), the brief as found and the evidenced backlog, approved into
 * issues — by the product's own `runTakeover` and `approveTakeoverPlan`, as
 * `apps/harness/tests/takeover_fixtures.spec.ts` drives them on real git
 * repositories. It is run on this machine with vitest's JSON reporter.
 *
 * What needs the model is NOT RUN, and says what it needs: the scripted
 * non-developer conversations with Seshat (the PM model; the scripted
 * conversations are drafts a person has not confirmed, B2.4), and each
 * fixture's first issue built by the Worker, gated and accepted, with its
 * must-haves shown proven (DS-TO-15, DoD §6.4).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeVitest } from "./containment.mjs";
import { ORIGINAL_ENV, ROOT, check } from "./core.mjs";

/** The scripted conversations a person has confirmed (none while only drafts exist). */
function confirmedConversations() {
  const dir = join(ROOT, "fixtures", "pm_conversations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json"));
}

export async function run() {
  const checks = [];
  const details = {};
  const out = mkdtempSync(join(tmpdir(), "milestone-b4-4-"));
  try {
    const reportFile = join(out, "takeover.json");
    const r = spawnSync(
      join(ROOT, "node_modules", ".bin", "vitest"),
      [
        "run",
        "--pool=forks",
        "--poolOptions.forks.maxForks=1",
        "--reporter=json",
        `--outputFile=${reportFile}`,
        "apps/harness/tests/takeover_fixtures.spec.ts",
      ],
      { cwd: ROOT, env: ORIGINAL_ENV, encoding: "utf8", timeout: 20 * 60_000 },
    );
    let s;
    try {
      s = summarizeVitest(JSON.parse(readFileSync(reportFile, "utf8")));
    } catch {
      s = undefined;
    }
    details.takeover = s ?? { exit: r.status, stderr: (r.stderr ?? "").slice(-2000) };
    checks.push(
      check(
        "take over: the five DS-TO-15 fixtures reach an approved, evidenced plan with issues, no model loaded",
        s ? s.ok : false,
        s
          ? `${s.passed}/${s.tests} (half-built-ts, broken-build, python-stubs, committed-secret, inherited-issues, and no fixture file edited)${s.failed ? `; failed: ${s.failedTitles.join(", ")}` : ""}`
          : `vitest exited ${r.status} without a report`,
      ),
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  const confirmed = confirmedConversations();
  checks.push(
    check(
      "start a project by conversation: a scripted non-developer talks to Seshat",
      null,
      `needs Seshat's model loaded on the reference machine and scripted conversations a person confirmed (${confirmed.length} confirmed; fixtures/pm_conversations holds drafts only)`,
    ),
  );
  checks.push(
    check(
      "must-haves become proven: an issue on each take-over fixture built, gated and accepted from the dashboard (DS-TO-15)",
      null,
      "needs the Worker model loaded for a live run on the reference machine",
    ),
  );
  return { checks, details };
}
