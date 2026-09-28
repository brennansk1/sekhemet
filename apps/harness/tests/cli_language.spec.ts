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
import { describe, expect, it } from "vitest";
import { literals, retiredIn } from "../../../packages/ui/tests/copy_scan.js";
import { START_BY_CONVERSATION, recommendRoster } from "../src/init.js";

const SRC = join(new URL(".", import.meta.url).pathname, "../src");

/** The modules whose literals are the CLI's output, then the server's person-facing strings. */
const CLI_FILES = [
  "front_door.ts",
  "index.ts",
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
  "rest_extra.ts",
  "pm_api.ts",
  "wave2_server.ts",
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
  "wave2_github.ts",
  "research_bakeoff.ts",
  "research/service.ts",
  "research/reuse.ts",
  "research/cards.ts",
];

/**
 * Literals that are not a person's copy, by file: a model's prompt (changed
 * only through PROMPT_STANDARD's suite A/B), a stored identifier, or the
 * config file's keys.
 */
const NOT_COPY: Record<string, RegExp[]> = {
  "index.ts": [
    // Seshat's prompt when the Agent asks it a question mid-issue, and the
    // question as it is filed in Seshat's thread for the model.
    /^You are Seshat, the project manager\./,
    /^Card:\s+\$\{\}\s+nSpec:/,
    /^\[The Worker asks about/,
    // The paragraph the Worker reads about its team (`teamNote`).
    /^Seshat \(project manager,/,
    /^loaded between cards$/,
    // A command in `sekhemet dev --help`'s usage column.
    /^gates init$/,
  ],
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
};

function hits(): string[] {
  const out: string[] = [];
  for (const f of CLI_FILES) {
    const skip = NOT_COPY[f] ?? [];
    for (const { line, text } of literals(readFileSync(join(SRC, f), "utf8"))) {
      if (skip.some((re) => re.test(text.trim()))) continue;
      // A route pattern (`^/api/cards/…/gate$`) is an identifier.
      if (/^\^\/api\//.test(text.trim())) continue;
      for (const hit of retiredIn(text)) out.push(`${f}:${line}: ${hit}`);
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

  it("names the roles by their DEC-31 names in the machine's roster note", () => {
    expect([16, 48, 128].map((gb) => recommendRoster(gb * 1024 ** 3).note)).toEqual([
      "One large model at a time: the Coding model stays resident; the Planning, Review and Research models swap in by role batch.",
      "The Coding and Planning models resident together; the Review and Research models swap in.",
      "All four roles stay resident; use the Q8_0 Research model (SEKHEMET_RESEARCHER_GGUF).",
    ]);
  });
});
