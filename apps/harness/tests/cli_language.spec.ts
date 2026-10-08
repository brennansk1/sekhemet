/**
 * dashboard NEW-dashboard-7, DB-N7-4 (DEC-31): what the CLI prints, and what
 * the server, its notifications and its reports say to a person, uses the
 * words Jira, Linear, GitHub and Scrum/Kanban use — *issue* (never *card*),
 * *checks* (never *gates*), *Agent* and the *Coding*, *Planning*, *Review* and
 * *Research model*, *sprint*, *release*, *verified on this machine*. Command
 * and flag names stay: they are identifiers a person types, not words
 * (`sekhemet gate`, `--worker`, `gates.toml`).
 *
 * Like DB-N7-1's dashboard scan, it reads every string literal of the CLI's
 * modules with the identifiers stripped (`copy_scan.ts`); the literals that
 * are a model's prompt are left to PROMPT_STANDARD, which changes them only
 * after a suite A/B, and are named below with why.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DESIGN_COPY } from "@sekhemet/planner";
import { describe, expect, it } from "vitest";
import { literals, rawRetiredIn, retiredIn } from "../../../packages/ui/tests/copy_scan.js";
import { START_BY_CONVERSATION, recommendRoster } from "../src/init.js";

const SRC = join(new URL(".", import.meta.url).pathname, "../src");

/** The modules whose literals are the CLI's output, then the server's person-facing strings. */
const CLI_FILES = [
  "cli_commands.ts",
  "index.ts",
  // The commands moved into the registry (surface T4).
  "commands/registry.ts",
  "commands/queue.ts",
  "commands/accept.ts",
  "commands/review.ts",
  "commands/run.ts",
  "commands/status.ts",
  "commands/doctor.ts",
  "commands/project_pause.ts",
  "init.ts",
  "first_run.ts",
  "card_zero.ts",
  "onboard.ts",
  "wave2.ts",
  "plan_approval.ts",
  "research/cli.ts",
  "research/plan_research.ts",
  // The server: API errors a page shows, notifications, Seshat's code replies.
  "server.ts",
  "run_routes.ts",
  "pm_api.ts",
  "github_routes.ts",
  "triage.ts",
  "accept.ts",
  "collaborate.ts",
  "attachments.ts",
  "reservation.ts",
  "notify.ts",
  "integrations.ts",
  "config_api.ts",
  "benchmark_api.ts",
  "team/access.ts",
  "pm/slash.ts",
  "pm/apply.ts",
  "pm/suggest.ts",
  "pm/service.ts",
  "pm/while_worker.ts",
  // The rest of the CLI's commands, reports and generated documents.
  "execute.ts",
  "project_done.ts",
  "project_docs.ts",
  "evidence_summary.ts",
  "measure_cmd.ts",
  "overnight.ts",
  "governance.ts",
  "airgap.ts",
  "replay.ts",
  "doctor.ts",
  "calibrate_cmd.ts",
  "benchmark_cmd.ts",
  "models_cmd.ts",
  "model_access.ts",
  "mutation_step.ts",
  "injection.ts",
  "vision_check.ts",
  "supervisor.ts",
  "takeover.ts",
  "external_review.ts",
  "github_sync.ts",
  "research_bakeoff.ts",
  "research/service.ts",
  "research/reuse.ts",
  "research/cards.ts",
  // FINDINGS_C1 WRD-01 and the rename table's places: Seshat's proposals and
  // replies, the terminal board, the Activity log commands, the Team pages'
  // refusals and the reports the CLI prints.
  "planner_live.ts",
  "pm/pm_copy.ts",
  "pm/agent.ts",
  "pm/standup.ts",
  "pm/weekly.ts",
  "pm/judgement.ts",
  "pm/pipeline.ts",
  "terminal_board.ts",
  "ledger_cmds.ts",
  "team/health.ts",
  "tracing.ts",
  "takeover_backlog.ts",
  "acp.ts",
  "ask_cmd.ts",
  "model_usage.ts",
  // The routes C2a moved out of the server, and the checks' failure text the
  // issue's Checks tab shows.
  "card_routes.ts",
  "issue_forms.ts",
  "workspaces.ts",
  "reachability_gate.ts",
  "regression_gate.ts",
  "architecture_gate.ts",
  "license_gate.ts",
  "watchdog_actions.ts",
  "visual_baseline.ts",
  "takeover_recon.ts",
  "smart_swap.ts",
];

/**
 * Literals that are not a person's copy, by file: a model's prompt (changed
 * only through PROMPT_STANDARD's suite A/B), a stored identifier, or the
 * config file's keys.
 */
const NOT_COPY: Record<string, RegExp[]> = {
  // The queue (moved from index.ts in C5): the question as it is filed in
  // Seshat's thread for the model, and the paragraph the Worker reads about
  // its team (`teamNote`). Model-facing, frozen by PROMPT_STANDARD.
  "commands/queue.ts": [
    /^\[The Worker asks about/,
    /^Seshat \(project manager,/,
    /^loaded between cards$/,
  ],
  "index.ts": [
    // A command in `sekhemet dev --help`'s usage column.
    /^gates init$/,
    // The Coding model comparison `bake-off` and the Research one: renamed
    // with the dev help in C5 (FINDINGS_C1 R-21, WRD-14).
    /bake-?off|golden set/i,
  ],
  // The squash commit's `Card:` trailer, matched to reconcile an Accept
  // (review-git RG-N8-2): git's record, read by a regular expression.
  "accept.ts": [/^\^Card:\s+\$\{\}\s+\$$/],
  // `config.toml`'s keys (`planner = "…"`) are names the file is read by.
  "init.ts": [/^planner = "/],
  "wave2.ts": [
    // An SQL query over the `cards` table.
    /^SELECT /,
    // The reason stored on an `m0/pending` event, which no screen prints.
    /^qualified for this combination on this host$/,
  ],
  // Request fields and role values an API caller types (`planner`, `worker=`).
  "server.ts": [/^Name an executor or a planner$/],
  "card_routes.ts": [/^Name an executor or a planner$/],
  "config_api.ts": [/^role is worker, planner, reviewer or researcher\.$/],
  "benchmark_api.ts": [/^Name the combination: \?combination=/],
  // Linear's own CSV column is named *Cycle*.
  "integrations.ts": [/^Cycle$/],
  // A usage line: `worker=<m>,planner=<m>` are the flag's keys.
  "benchmark_cmd.ts": [/^\s*sekhemet benchmark overnight \[--combination worker=/],
  // A *model card* is Hugging Face's word for a model's documentation.
  "models_cmd.ts": [/\bmodel(?:'s)? card\b|\bthis model's card\b/],
  // The line the Agent's prompt gets for a hand-back note (`messageLabel`).
  "collaborate.ts": [/^a person handed the card back to you$/],
  // The marker `gates.toml` is recognised by (`SCAFFOLD_GATES_MARKER`): a
  // changed marker would no longer find the file an earlier version wrote.
  "card_zero.ts": [/^# Card zero's gate: replaced by the project's own once card zero is done\.$/],
  // The dossier lesson after a rebase: only the Agent's prompt reads it
  // (`Lesson: …` in card_runner's dossier lines); no screen prints a lesson's
  // text. Model-facing, so frozen by PROMPT_STANDARD until a suite A/B.
  "execute.ts": [/^After its parent was accepted and it was rebased, these gates failed: /],
  // Seshat's prompt: the board digest and the summariser's system prompt it
  // reads, and the Research model's failure as its tool result. Model-facing,
  // frozen by PROMPT_STANDARD until a suite A/B (dashboard item 5, DEC-52).
  "pm/agent.ts": [
    /^cycle\s+\$\{\}\s*$/,
    /^Today: /,
    /^You compress a project manager's conversation/,
    /^The Researcher failed: /,
  ],
  // Seshat's tool descriptions and card one's spec, which the Agent reads:
  // model-facing, under the same rule.
  "pm/pm_copy.ts": [
    // Seshat's prompt when the Agent asks it a question mid-issue
    // (`WORKER_QUESTION_COPY`, moved here from index.ts in C5).
    /^You are Seshat, the project manager\./,
    /^Card:\s+\$\{\}\s+nSpec:/,
    /^Delegate a question that needs evidence/,
    /^Propose moving an issue to ready, backlog or parked\.$/,
    /^Write one test, /,
    /^Card one's test must run and fail at an assertion/,
  ],
  // The front help's line of triage verbs: `park` and `unpark` are command
  // names a person types, which stay (DEC-52); Put on hold is the dashboard's.
  // The line lives in the command registry since T4 moved `accept` there.
  "commands/registry.ts": [/^Accept and merge\. Also: request-changes /],
  // The developers' Research model comparison (`research-bakeoff`): its words,
  // bake-off and golden set, are renamed with the dev help in C5 (FINDINGS_C1
  // R-21, WRD-14), not here.
  "research_bakeoff.ts": [/bake-?off|golden[ -]set/i],
  // A git format string: `Ledger-Head` is the commit trailer's name.
  "ledger_cmds.ts": [/^--format=%\(trailers:key=Ledger-Head/],
};

function hits(): string[] {
  const out: string[] = [];
  for (const f of CLI_FILES) {
    const skip = NOT_COPY[f] ?? [];
    for (const { line, text } of literals(readFileSync(join(SRC, f), "utf8"))) {
      if (skip.some((re) => re.test(text.trim()))) continue;
      // A route pattern (`^/api/cards/…/gate$`) and an SQL query are identifiers.
      if (/^\^\/api\//.test(text.trim())) continue;
      if (/^\s*(?:SELECT|INSERT|UPDATE|DELETE) /.test(text)) continue;
      for (const hit of retiredIn(text)) out.push(`${f}:${line}: ${hit}`);
      // FINDINGS_C1 R-12: no spec, decision or milestone id in what a person
      // reads. API paths and environment switches are a developer's words on
      // the command line, so only the ids are read here.
      for (const hit of rawRetiredIn(text).filter((h) => h.endsWith("the plain sentence alone"))) {
        out.push(`${f}:${line}: ${hit}`);
      }
    }
  }
  return out;
}

describe("DB-N7-4, the CLI and the server: what they say uses DEC-31's words", () => {
  it("no CLI or server module says a retired word", () => {
    expect(hits()).toEqual([]);
  });

  it("offers a start by conversation in checks and issues, never gates or card zero", () => {
    expect(START_BY_CONVERSATION).toBe(
      "Nothing here yet, so there are no checks to find. Start a project by conversation: tell Seshat on the board what you want built, in one sentence. It proposes the plan — a setup issue first runs the ecosystem's own generator, and the checks come from what that makes — and nothing is created until you apply it.",
    );
  });

  it("calls the depth profile the project's Type in `sekhemet depth` (FINDINGS_C1 R-34)", () => {
    const O = DESIGN_COPY.offer;
    expect(O.unknown("Banana")).toBe(
      'No project Type "Banana": one of prototype, internal tool, production, regulated.',
    );
    expect(O.proposed("production", "People sign in to it.")).toBe(
      "Proposed Type: production. People sign in to it.",
    );
    expect(O.inForce("internal tool", true)).toBe("Type: internal tool, chosen.");
    expect(O.chosen("production", 2)).toBe(
      "Type: production, chosen. Added 2 quality checks as Must have.",
    );
    expect(DESIGN_COPY.depth.regulatedNote).toBe(
      "The Regulated Type selects stricter checks and more of your approval. It claims no compliance with any standard or regulation.",
    );
  });

  it("names the roles by their DEC-31 names in the machine's roster note", () => {
    // Models rule 8a (MD-N22-2): the notes are SUPPORTED_HARDWARE's; under 24 GB, rule 6c's.
    expect([16, 24, 48, 128].map((gb) => recommendRoster(gb * 1024 ** 3).note)).toEqual([
      "v1 supports 24 GB of memory and above; you may continue at your own risk. The shipped models do not fit in this much memory.",
      "One large model at a time: the roles swap.",
      "Coding and Planning resident together; Research swaps.",
      "Every shipped role resident.",
    ]);
  });
});
