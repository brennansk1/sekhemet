/**
 * The milestone runners' shared parts (MODERNIZATION_PLAN "Milestones the
 * owner sees", close-out C4). Each runner (`b1.mjs` … `b4_11.mjs`, reached
 * through `run.mjs` and `pnpm milestone <id>`) produces one evidence file on
 * this machine under `evidence/milestones/`, and `docs/reference/MILESTONES.md`
 * is rendered from the newest file of each milestone.
 *
 * A runner never loads a model and never touches the owner's user directory:
 * every process it starts gets a temporary HOME and Sekhemet user directory
 * (`isolatedEnv`), and where a model's turn is needed a stand-in server
 * answers the OpenAI chat API the product's own adapter speaks
 * (`stand_in.mjs`).
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, release, tmpdir, totalmem } from "node:os";
import { isAbsolute, join } from "node:path";

import { ROOT, verdictOf } from "./core.mjs";

export {
  CLI,
  ROOT,
  built,
  check,
  isolatedEnv,
  runCli,
  useIsolatedEnv,
  verdictOf,
} from "./core.mjs";
export const EVIDENCE_DIR = join(ROOT, "evidence", "milestones");

/** Today's date on this machine, YYYY-MM-DD. */
export function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/**
 * The tree a runner ran on (close-out review C4): `git write-tree` of the
 * working tree as it is — tracked changes and untracked files included,
 * ignored ones not — through a copy of the index, so the real index is
 * untouched. The commit that later holds exactly these files has this tree
 * (`git rev-parse <commit>^{tree}`), and `git diff <tree> <commit>` shows
 * anything else, so evidence from an uncommitted tree is tied to its commit.
 */
export function treeIdentity(cwd = ROOT) {
  const run = (args, env) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();
  const dir = mkdtempSync(join(tmpdir(), "milestone-tree-"));
  try {
    const index = join(dir, "index");
    const real = run(["rev-parse", "--git-path", "index"]);
    const realPath = isAbsolute(real) ? real : join(cwd, real);
    if (existsSync(realPath)) copyFileSync(realPath, index);
    const env = { GIT_INDEX_FILE: index };
    run(["add", "-A"], env);
    return run(["write-tree"], env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Write a milestone's evidence: its checks and verdict, with the commit it
 * ran on, whether the tree had uncommitted changes and the tree itself
 * (`treeIdentity`), the date and the host.
 */
export function writeEvidence(record, options = {}) {
  const dir = options.dir ?? EVIDENCE_DIR;
  const date = options.date ?? today();
  const checks = record.checks ?? [];
  const verdict = record.verdict ?? verdictOf(checks);
  const evidence = {
    id: record.id,
    title: record.title,
    verdict,
    reason:
      record.reason ??
      checks
        .filter((c) => c.ok !== true)
        .map((c) => `${c.name}: ${c.detail ?? (c.ok === false ? "failed" : "not run")}`)
        .join("; "),
    commit: git("rev-parse", "HEAD"),
    treeClean: git("status", "--porcelain") === "",
    tree: treeIdentity(),
    date,
    recordedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: arch(),
      release: release(),
      node: process.version,
      memoryGB: Math.round(totalmem() / 2 ** 30),
    },
    checks,
    ...(record.details ? { details: record.details } : {}),
  };
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${record.id}_${date}.json`);
  writeFileSync(path, gateFormattedJson(evidence, `${record.id}_${date}.json`));
  return path;
}

/**
 * JSON as the gate's formatter writes it (W1 finding): `JSON.stringify` puts
 * each item of a short array on its own line, which biome joins, so a fresh
 * evidence file failed `biome check .`. The repository's own biome formats
 * it, with the repository's settings, as if it stood in `evidence/milestones/`.
 * Should biome be missing the plain JSON is kept, and the runner says so.
 */
export function gateFormattedJson(value, name = "evidence.json") {
  const plain = `${JSON.stringify(value, null, 2)}\n`;
  const biome = join(ROOT, "node_modules", ".bin", "biome");
  try {
    return execFileSync(
      biome,
      ["format", `--stdin-file-path=${join("evidence", "milestones", name)}`],
      { cwd: ROOT, input: plain, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch (err) {
    process.stderr.write(
      `The evidence file ${name} was written unformatted (${err?.code ?? "biome failed"}); run pnpm format before committing it.\n`,
    );
    return plain;
  }
}

/** The plan's milestones, in its order (MODERNIZATION_PLAN "Milestones the owner sees"). */
export const MILESTONES = [
  {
    id: "B1",
    title:
      "The uncensored Worker cannot leave its sandbox: the containment suite, including a Worker that tries, is green on macOS and Linux",
    runner: "b1.mjs",
  },
  {
    id: "B2.5",
    title:
      "A recorded, reproducible baseline: one RunProfile, the full suite and the planning measure, every failure named",
    runner: "b2_5.mjs",
  },
  {
    id: "B3",
    title:
      "A person can safely accept, undo and send back cards on a real repository, and the ledger survives a crash and an upgrade",
    runner: "b3.mjs",
  },
  {
    id: "B4.4",
    title:
      "A non-developer starts or takes over a project on the reference machine by conversation and watches its must-haves become proven",
    runner: "b4_4.mjs",
  },
  {
    id: "B4.10",
    title:
      "A team shares one server: each person signs in at their access level, the project's Accept rule decides who may accept, and each person gets fair turns on the model",
    runner: "b4_10.mjs",
  },
  {
    id: "B4.11",
    title:
      "A team of five, at four access levels, takes a project from a stakeholder's conversation to an accepted release on one server",
    runner: "b4_11.mjs",
  },
  {
    id: "C",
    title: "v1: DEFINITION_OF_DONE §6 on one release commit",
    runner: undefined,
  },
];

/** What each runner stands in for or leaves out, said on the page beside its verdict. */
export const NOTES = {
  B1: "How it ran: the containment suite is `packages/sandbox/tests`, run here with one worker. The Worker that tries to leave is the recorded live injection run (14 RedCode-Exec fixtures across four channels), read from its evidence file, not re-run; it counts only while the sandbox (`packages/sandbox/src`) and the Worker's tools (`packages/loop/src/tools.ts`, `tool_catalog.ts`, `tool_schema.ts`) are unchanged since the commit that recorded it, and is NOT RUN otherwise, naming what changed. Linux waits on the Lima VM the owner approved.",
  "B2.5":
    "How it ran: read only from `~/.sekhemet/baseline` (results and arms); the driver and its runs are not touched. It passes when every arm has its second round, a planning-measure result exists, and SUITE_RUNS.md records the frozen RunProfile under a `## Baseline RunProfile (frozen …)` heading.",
  B3: "How it ran: the issues are built by the product's Worker loop (`executeCard`, its tools, sandboxed checks and evidence) against the stand-in model; every step a person takes is this build's CLI. Each crash kills, with SIGKILL, a process that creates and moves issues without pause. The older build is 5937e83, the baseline's commit, extracted with `git archive`, installed offline from the local pnpm store and built; its own seed script, Worker loop and CLI make the ledger this build then opens.",
  "B4.4":
    "How it ran: the take-over half runs `apps/harness/tests/takeover_fixtures.spec.ts` on this machine (real git repositories, the product's `runTakeover` and `approveTakeoverPlan`, no model). The conversation and the built issues need the live models.",
  "B4.10":
    "How it ran: a real `sekhemet serve` process in the Team setup, each person signed in through its routes. The five queue issues are filed and delegated over HTTP; moving them to Ready is done in the runner's process for the person who filed them, because the board has no HTTP route for that move. The queue is what `sekhemet queue` runs, the product's `fairOrder` picking each next issue and `executeCard` building it, in the runner's process against the stand-in model, because the Worker's own port belongs to the overnight run. A run the server itself launches starts nothing here.",
  "B4.11":
    "How it ran: B4.10's team on a real server, and the journey's audit over the ledger (`plan/sent_for_approval` by the Stakeholder, `plan/approved` by a Member, `slice/accepted`, and every person's event naming one of the five). The live run is the capstone's.",
};

const MARK = { true: "✓", false: "✗" };

/**
 * docs/reference/MILESTONES.md: one section per milestone, each with its
 * newest evidence file, the commit and date it ran on, and its verdict with
 * the reason; a milestone with no evidence says so.
 */
export function renderMilestones(records, options = {}) {
  const lines = [
    "# Milestones the owner sees",
    "",
    "The plan's milestones ([MODERNIZATION_PLAN.md](MODERNIZATION_PLAN.md), *Milestones the owner sees*), each with the evidence a runner produced on the reference machine. A verdict is **PASS** only when every check of its runner passed, **FAIL** when any failed, and **NOT RUN** otherwise, with the reason. Nothing here is a claim a runner did not check.",
    "",
    "Run one with `pnpm milestone <id>` (for example `pnpm milestone B3`), or `pnpm milestone all`; each writes `evidence/milestones/<id>_<date>.json`, and `pnpm milestone report` renders this page from the newest file of each. The runners are `scripts/milestones/*.mjs`. They load no model: where a model's turn is needed, a stand-in server answers the chat API the product's adapter speaks, and a milestone that needs the real model says NOT RUN and what it needs.",
    "",
    "| Milestone | Verdict | Date | Commit |",
    "| --- | --- | --- | --- |",
  ];
  const newest = new Map();
  for (const r of records) {
    const had = newest.get(r.id);
    if (!had || `${r.date}${r.recordedAt ?? ""}` >= `${had.date}${had.recordedAt ?? ""}`) {
      newest.set(r.id, r);
    }
  }
  for (const m of MILESTONES) {
    const r = newest.get(m.id);
    lines.push(
      `| [${m.id}](#${m.id.replace(".", "").toLowerCase()}) | ${r ? r.verdict : "NOT RUN"} | ${r?.date ?? "—"} | ${r ? `\`${r.commit.slice(0, 10)}\`` : "—"} |`,
    );
  }
  lines.push("");
  for (const m of MILESTONES) {
    const r = newest.get(m.id);
    lines.push(`## ${m.id}`, "", `*${m.title}.*`, "");
    if (!r) {
      lines.push(
        "**NOT RUN** — no evidence recorded yet.",
        "",
        m.runner
          ? `Runner: \`scripts/milestones/${m.runner}\`.`
          : "Runner: none; Phase C's release gate decides it.",
        "",
      );
      continue;
    }
    lines.push(`**${r.verdict}**${r.reason ? ` — ${r.reason}` : ""}`, "");
    lines.push(
      `- Evidence: \`${r.evidence}\``,
      `- Commit: \`${r.commit.slice(0, 10)}\`${r.treeClean ? "" : " with uncommitted changes"}`,
      r.tree
        ? `- Tree: tree \`${r.tree}\`, the files it ran on (the commit that holds them has this tree; \`git diff ${r.tree.slice(0, 10)} <commit>\` shows any difference)`
        : "- Tree: tree not recorded (evidence from before trees were recorded); run it again to tie it to a commit",
      `- Date: ${r.date}${r.host ? `, on ${r.host.platform} ${r.host.arch} with ${r.host.memoryGB} GB` : ""}`,
      `- Runner: \`scripts/milestones/${m.runner}\``,
      "",
    );
    for (const c of r.checks ?? []) {
      lines.push(`- ${MARK[String(c.ok)] ?? "–"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
    }
    lines.push("");
    const note = (options.notes ?? NOTES)[m.id];
    if (note) lines.push(note, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export { summarizeBaseline } from "./baseline.mjs";
export { summarizeVitest } from "./containment.mjs";
export {
  chainRows,
  compareChains,
  crashTrial,
  unreadablePayloads,
} from "./ledger.mjs";
export { buildCards, makeRepo, openKernel, startFakeModel } from "./stand_in.mjs";
